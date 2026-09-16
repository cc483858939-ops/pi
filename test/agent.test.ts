import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, AgentRuntimeError } from "../src/agent/agent.ts";
import type {
  ChatClient,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
  ChatRequest,
  ChatResponse,
} from "../src/llm/client.ts";
import { defineTool, type RegisteredTool, type ToolContext } from "../src/tools/types.ts";
import { defaultTools } from "../src/tools/index.ts";

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
    this.calls.push({
      ...request,
      messages: request.messages.map((message) => structuredClone(message)),
      tools: request.tools.map((tool) => structuredClone(tool)),
    });
    const response = this.responses.shift();
    if (!response) throw new Error("Fake client ran out of responses.");
    return response;
  }
}

function context(rootDir: string, signal?: AbortSignal): ToolContext {
  return {
    rootDir,
    bashTimeoutMs: 5000,
    maxOutputBytes: 4096,
    ...(signal === undefined ? {} : { signal }),
  };
}

test("returns a final answer without executing tools", async () => {
  const client = new FakeClient([assistant("hello")]);
  const agent = new Agent({
    client,
    model: "fake-model",
    tools: [],
    maxRounds: 3,
    toolContext: context(process.cwd()),
  });

  const result = await agent.run("say hello");

  assert.equal(result.content, "hello");
  assert.equal(result.rounds, 1);
  assert.equal(client.calls.length, 1);
});

test("executes a read tool and preserves the full history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-agent-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
    const call = functionCall("call-read", "read", { path: "package.json" });
    const client = new FakeClient([assistant(null, [call]), assistant("fixture")]);
    const agent = new Agent({
      client,
      model: "fake-model",
      tools: defaultTools,
      maxRounds: 3,
      toolContext: context(root),
    });

    const result = await agent.run("what is the package name?");

    assert.equal(result.content, "fixture");
    assert.equal(client.calls.length, 2);
    const secondMessages = client.calls[1]?.messages ?? [];
    const assistantMessage = secondMessages.find(
      (message) => message.role === "assistant" && "tool_calls" in message,
    );
    assert.deepEqual(assistantMessage && "tool_calls" in assistantMessage ? assistantMessage.tool_calls : undefined, [call]);
    const toolMessage = secondMessages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") {
      assert.equal(toolMessage.tool_call_id, "call-read");
      const payload = JSON.parse(toolMessage.content as string) as { ok: boolean; data: { path: string; content: string } };
      assert.equal(payload.ok, true);
      assert.equal(payload.data.path, "package.json");
      assert.equal(payload.data.content, '{"name":"fixture"}\n');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns tool failures to the model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-agent-"));
  try {
    const client = new FakeClient([
      assistant(null, [functionCall("missing", "read", { path: "missing.txt" })]),
      assistant("I could not find it."),
    ]);
    const agent = new Agent({
      client,
      model: "fake-model",
      tools: defaultTools,
      maxRounds: 3,
      toolContext: context(root),
    });
    await agent.run("read the missing file");
    const message = client.calls[1]?.messages.at(-1);
    assert.equal(message?.role, "tool");
    if (message?.role === "tool") {
      const payload = JSON.parse(message.content as string) as { ok: boolean; error: { code: string } };
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "FILE_NOT_FOUND");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handles malformed JSON arguments as a tool result", async () => {
  const client = new FakeClient([
    assistant(null, [functionCall("bad-json", "read", "{" )]),
    assistant("bad arguments seen"),
  ]);
  const agent = new Agent({
    client,
    model: "fake-model",
    tools: defaultTools,
    maxRounds: 3,
    toolContext: context(process.cwd()),
  });
  await agent.run("read a file");
  const message = client.calls[1]?.messages.at(-1);
  assert.equal(message?.role, "tool");
  if (message?.role === "tool") {
    const payload = JSON.parse(message.content as string) as { ok: boolean; error: { code: string } };
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "INVALID_ARGUMENTS");
  }
});

test("returns a controlled failure for an unknown tool", async () => {
  const client = new FakeClient([
    assistant(null, [functionCall("unknown", "does_not_exist", {})]),
    assistant("recovered"),
  ]);
  const agent = new Agent({
    client,
    model: "fake-model",
    tools: [],
    maxRounds: 3,
    toolContext: context(process.cwd()),
  });
  const result = await agent.run("use the unknown tool");
  assert.equal(result.content, "recovered");
  const message = client.calls[1]?.messages.at(-1);
  assert.equal(message?.role, "tool");
  if (message?.role === "tool") {
    const payload = JSON.parse(message.content as string) as { error: { code: string } };
    assert.equal(payload.error.code, "TOOL_NOT_FOUND");
  }
});

test("executes multiple tool calls sequentially and preserves each id", async () => {
  const order: string[] = [];
  const makeTool = (name: string): RegisteredTool =>
    defineTool({
      name,
      description: `test ${name}`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      parseArgs: () => ({}),
      execute: async () => {
        order.push(name);
        return { name };
      },
    });
  const client = new FakeClient([
    assistant(null, [functionCall("one", "first", {}), functionCall("two", "second", {})]),
    assistant("done"),
  ]);
  const agent = new Agent({
    client,
    model: "fake-model",
    tools: [makeTool("first"), makeTool("second")],
    maxRounds: 3,
    toolContext: context(process.cwd()),
  });
  await agent.run("run both");
  assert.deepEqual(order, ["first", "second"]);
  const messages = client.calls[1]?.messages ?? [];
  const results = messages.filter((message) => message.role === "tool");
  assert.deepEqual(results.map((message) => message.role === "tool" ? message.tool_call_id : ""), ["one", "two"]);
});

test("propagates an Agent run AbortSignal to the model and tools", async () => {
  const controller = new AbortController();
  let toolSignal: AbortSignal | undefined;
  const inspectSignal = defineTool({
    name: "inspect_signal",
    description: "inspect cancellation",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    parseArgs: () => ({}),
    execute: async (_args, toolContext) => {
      toolSignal = toolContext.signal;
      return { aborted: toolContext.signal?.aborted ?? false };
    },
  });
  const client = new FakeClient([
    assistant(null, [functionCall("signal", "inspect_signal", {})]),
    assistant("done"),
  ]);
  const agent = new Agent({
    client,
    model: "fake-model",
    tools: [inspectSignal],
    maxRounds: 3,
    toolContext: context(process.cwd()),
  });

  await agent.run("inspect cancellation", { signal: controller.signal });

  assert.equal(client.calls[0]?.signal, controller.signal);
  assert.equal(toolSignal, controller.signal);
});

test("enforces maxRounds before making another model request", async () => {
  const forever = defineTool({
    name: "forever",
    description: "keep going",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    parseArgs: () => ({}),
    execute: async () => ({ ok: true }),
  });
  const client = new FakeClient([
    assistant(null, [functionCall("one", "forever", {})]),
    assistant(null, [functionCall("two", "forever", {})]),
    assistant(null, [functionCall("three", "forever", {})]),
    assistant("must not be called"),
  ]);
  const agent = new Agent({
    client,
    model: "fake-model",
    tools: [forever],
    maxRounds: 3,
    toolContext: context(process.cwd()),
  });
  await assert.rejects(agent.run("loop"), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === "AGENT_MAX_ROUNDS";
  });
  assert.equal(client.calls.length, 3);
});
