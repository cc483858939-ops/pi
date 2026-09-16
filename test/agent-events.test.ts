import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  Agent,
  AgentRuntimeError,
  type AgentEvent,
  type AgentRunResult,
} from "../src/agent/agent.ts";
import type {
  ChatClient,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
  ChatRequest,
  ChatResponse,
} from "../src/llm/client.ts";
import { defaultTools } from "../src/tools/index.ts";
import { defineTool, type RegisteredTool, type ToolContext } from "../src/tools/types.ts";

function assistant(
  content: string | null,
  toolCalls: ChatCompletionMessageToolCall[] = [],
): ChatResponse {
  const message: ChatCompletionMessage = {
    role: "assistant",
    content,
    refusal: null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
  return { message };
}

function functionCall(
  id: string,
  name: string,
  args: string | Record<string, unknown>,
): ChatCompletionMessageToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

class FakeClient implements ChatClient {
  readonly calls: ChatRequest[] = [];

  constructor(private readonly responses: ChatResponse[]) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("Fake client ran out of responses.");
    }
    return response;
  }
}

function context(rootDir = process.cwd()): ToolContext {
  return { rootDir, bashTimeoutMs: 5000, maxOutputBytes: 4096 };
}

function makeAgent(client: ChatClient, tools: RegisteredTool[] = [], maxRounds = 5): Agent {
  return new Agent({
    client,
    model: "fake-model",
    tools,
    maxRounds,
    toolContext: context(),
  });
}

async function consumeStream(
  stream: AsyncGenerator<AgentEvent, AgentRunResult, void>,
): Promise<{ events: AgentEvent[]; result?: AgentRunResult; error?: unknown }> {
  const events: AgentEvent[] = [];
  try {
    while (true) {
      const next = await stream.next();
      if (next.done) {
        return { events, result: next.value };
      }
      events.push(next.value);
    }
  } catch (error) {
    return { events, error };
  }
}

test("stream emits round_start, assistant, and final for a final-only run", async () => {
  const client = new FakeClient([assistant("hello")]);
  const consumed = await consumeStream(makeAgent(client).stream("say hello"));

  assert.deepEqual(consumed.events.map((event) => event.type), ["round_start", "assistant", "final"]);
  assert.deepEqual(consumed.events[0], { type: "round_start", round: 1 });
  assert.deepEqual(consumed.events[1], {
    type: "assistant",
    round: 1,
    content: "hello",
    toolCalls: [],
  });
  const finalEvent = consumed.events[2];
  assert.equal(finalEvent?.type, "final");
  if (finalEvent?.type === "final") {
    assert.equal(finalEvent.result.content, "hello");
    assert.equal(finalEvent.result.rounds, 1);
    assert.deepEqual(consumed.result, finalEvent.result);
  }
  assert.equal(consumed.error, undefined);
});

test("stream emits normalized events for one sequential read tool call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-events-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"event-fixture"}\n', "utf8");
    const call = functionCall("call-read", "read", { path: "package.json" });
    const client = new FakeClient([assistant(null, [call]), assistant("event-fixture")]);
    const agent = new Agent({
      client,
      model: "fake-model",
      tools: defaultTools,
      maxRounds: 5,
      toolContext: context(root),
    });

    const consumed = await consumeStream(agent.stream("read the package"));

    assert.deepEqual(consumed.events.map((event) => event.type), [
      "round_start",
      "assistant",
      "tool_start",
      "tool_result",
      "round_start",
      "assistant",
      "final",
    ]);
    const assistantEvent = consumed.events[1];
    assert.equal(assistantEvent?.type, "assistant");
    if (assistantEvent?.type === "assistant") {
      assert.deepEqual(assistantEvent.toolCalls, [
        { id: "call-read", name: "read", arguments: '{"path":"package.json"}' },
      ]);
    }
    const startEvent = consumed.events[2];
    assert.deepEqual(startEvent, {
      type: "tool_start",
      round: 1,
      callId: "call-read",
      toolName: "read",
      arguments: '{"path":"package.json"}',
    });
    const resultEvent = consumed.events[3];
    assert.equal(resultEvent?.type, "tool_result");
    if (resultEvent?.type === "tool_result") {
      assert.equal(resultEvent.round, 1);
      assert.equal(resultEvent.callId, "call-read");
      assert.equal(resultEvent.toolName, "read");
      assert.equal(resultEvent.result.ok, true);
    }
    assert.equal(consumed.result?.content, "event-fixture");
    assert.equal(consumed.result?.rounds, 2);
    assert.equal(consumed.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple tool calls emit start/result pairs sequentially", async () => {
  const order: string[] = [];
  const makeTool = (name: string): RegisteredTool =>
    defineTool({
      name,
      description: name,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      parseArgs: () => ({}),
      execute: async () => {
        order.push(name);
        return { name };
      },
    });
  const client = new FakeClient([
    assistant(null, [functionCall("a", "first", {}), functionCall("b", "second", {})]),
    assistant("done"),
  ]);
  const consumed = await consumeStream(makeAgent(client, [makeTool("first"), makeTool("second")]).stream("run both"));

  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(
    consumed.events
      .filter((event) => event.type === "tool_start" || event.type === "tool_result")
      .map((event) => `${event.type}:${event.callId}`),
    ["tool_start:a", "tool_result:a", "tool_start:b", "tool_result:b"],
  );
});

test("malformed and unknown tool calls remain controlled tool results", async () => {
  const knownClient = new FakeClient([
    assistant(null, [functionCall("bad", "read", "{" )]),
    assistant("recovered"),
  ]);
  const known = await consumeStream(makeAgent(knownClient, defaultTools).stream("bad read"));
  const malformedResult = known.events.find((event) => event.type === "tool_result");
  assert.equal(malformedResult?.type, "tool_result");
  if (malformedResult?.type === "tool_result") {
    assert.equal(malformedResult.result.ok, false);
    if (!malformedResult.result.ok) assert.equal(malformedResult.result.error.code, "INVALID_ARGUMENTS");
  }
  assert.equal(known.error, undefined);

  const unknownClient = new FakeClient([
    assistant(null, [functionCall("unknown", "does_not_exist", {})]),
    assistant("recovered"),
  ]);
  const unknown = await consumeStream(makeAgent(unknownClient).stream("unknown tool"));
  const unknownResult = unknown.events.find((event) => event.type === "tool_result");
  assert.equal(unknownResult?.type, "tool_result");
  if (unknownResult?.type === "tool_result") {
    assert.equal(unknownResult.result.ok, false);
    if (!unknownResult.result.ok) assert.equal(unknownResult.result.error.code, "TOOL_NOT_FOUND");
  }
  assert.equal(unknown.error, undefined);
});

test("max rounds emits one fatal error event before throwing", async () => {
  const forever = defineTool({
    name: "forever",
    description: "forever",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    parseArgs: () => ({}),
    execute: async () => ({ ok: true }),
  });
  const client = new FakeClient([
    assistant(null, [functionCall("one", "forever", {})]),
    assistant(null, [functionCall("two", "forever", {})]),
    assistant(null, [functionCall("three", "forever", {})]),
  ]);
  const consumed = await consumeStream(makeAgent(client, [forever], 3).stream("loop"));

  assert.deepEqual(
    consumed.events.filter((event) => event.type === "round_start").map((event) => event.round),
    [1, 2, 3],
  );
  const errors = consumed.events.filter(
    (event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "AGENT_MAX_ROUNDS");
  assert.equal(consumed.result, undefined);
  assert.ok(consumed.error instanceof AgentRuntimeError);
  if (consumed.error instanceof AgentRuntimeError) {
    assert.equal(consumed.error.code, "AGENT_MAX_ROUNDS");
  }
});

test("aborted stream emits AGENT_ABORTED and does not start a model round", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient([assistant("must not run")]);
  const consumed = await consumeStream(makeAgent(client).stream("abort" , { signal: controller.signal }));

  assert.deepEqual(consumed.events.map((event) => event.type), ["error"]);
  const errorEvent = consumed.events[0];
  assert.equal(errorEvent?.type, "error");
  if (errorEvent?.type === "error") assert.equal(errorEvent.code, "AGENT_ABORTED");
  assert.equal(client.calls.length, 0);
  assert.ok(consumed.error instanceof AgentRuntimeError);
  if (consumed.error instanceof AgentRuntimeError) {
    assert.equal(consumed.error.code, "AGENT_ABORTED");
  }
});

test("run remains compatible and returns the same result as stream", async () => {
  const runResult = await makeAgent(new FakeClient([assistant("same")])).run("same prompt");
  const streamed = await consumeStream(makeAgent(new FakeClient([assistant("same")])).stream("same prompt"));

  assert.deepEqual(streamed.result, runResult);
});
