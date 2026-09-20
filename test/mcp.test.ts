import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent } from "../src/agent/agent.ts";
import { loadMcpConfig } from "../src/mcp/config.ts";
import { McpCloseError, McpManager } from "../src/mcp/manager.ts";
import { mcpToolName } from "../src/mcp/names.ts";
import { createMcpTool } from "../src/mcp/tool-adapter.ts";
import type { McpClientLike } from "../src/mcp/types.ts";
import type { ChatClient, ChatCompletionMessage, ChatCompletionMessageToolCall, ChatRequest, ChatResponse } from "../src/llm/client.ts";
import { createLoadSkillTool } from "../src/tools/load-skill.ts";
import { defaultTools } from "../src/tools/index.ts";
import { executeTool, type ToolContext } from "../src/tools/types.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import type { Transport } from "@modelcontextprotocol/client";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "test", "fixtures", "mcp-stdio-server.mjs");

function context(rootDir: string, maxOutputBytes = 4096): ToolContext {
  return { rootDir, bashTimeoutMs: 5000, maxOutputBytes };
}

function assistant(content: string | null, toolCalls: ChatCompletionMessageToolCall[] = []): ChatResponse {
  const message: ChatCompletionMessage = { role: "assistant", content, refusal: null, ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) };
  return { message };
}

class FakeChatClient implements ChatClient {
  readonly calls: ChatRequest[] = [];
  constructor(private readonly responses: ChatResponse[]) {}
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push({ ...request, messages: request.messages.map((message) => structuredClone(message)), tools: request.tools.map((tool) => structuredClone(tool)) });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("fake model ran out of responses");
    return response;
  }
}

class FakeMcpClient implements McpClientLike {
  callCount = 0;
  lastSignal: AbortSignal | undefined;
  closeCount = 0;

  constructor(
    private readonly response: { content: unknown[]; structuredContent?: unknown; isError?: boolean },
    private readonly callError?: Error,
    private readonly closeError?: Error,
  ) {}

  async connect(_transport: Transport): Promise<void> {}

  async listTools(): Promise<{ tools: [] }> {
    return { tools: [] };
  }

  async callTool(_params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal }) {
    this.callCount += 1;
    this.lastSignal = options?.signal;
    if (this.callError !== undefined) throw this.callError;
    return this.response;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

const fakeTransport = {} as Transport;
type NormalizedMcpResult = { server: string; tool: string; content: unknown[]; structuredContent?: unknown; truncated: boolean };

function fakeTool(client: McpClientLike, originalName = "fake"): ReturnType<typeof createMcpTool> {
  return createMcpTool("fake", originalName, "Fake MCP tool", { type: "object" }, client);
}

test("MCP manager discovers namespaced tools, calls original names, bounds output, and closes idempotently", async () => {
  const serverRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-mcp-server-root-"));
  let connected: McpManager | undefined;
  try {
    await writeFile(path.join(serverRoot, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixturePath] } } }), "utf8");
    const configured = await loadMcpConfig(serverRoot);
    connected = new McpManager(configured);
    const result = await connected.connect();
    assert.deepEqual(result.failures, []);
    const echoName = mcpToolName("demo", "echo");
    const echo = result.tools.find((tool) => tool.name === echoName);
    assert.ok(echo);
    assert.equal(echo.name.length <= 64, true);
    assert.match(echo.name, /^mcp__demo__.*__[0-9a-f]{8}$/);
    assert.equal(echo.parameters.type, "object");
    assert.deepEqual(echo.parameters.properties, { text: { type: "string" } });
    assert.deepEqual(echo.parameters.required, ["text"]);
    const echoed = await executeTool(echo, { text: "hello from mini pi" }, context(serverRoot));
    assert.equal(echoed.ok, true);
    if (echoed.ok) assert.deepEqual(echoed.data, { server: "demo", tool: "echo", content: [{ type: "text", text: "hello from mini pi" }], truncated: false });

    const failed = await executeTool(result.tools.find((tool) => tool.name === mcpToolName("demo", "fail"))!, { message: "expected" }, context(serverRoot));
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "MCP_TOOL_ERROR");

    const large = await executeTool(result.tools.find((tool) => tool.name === mcpToolName("demo", "large-output"))!, { size: 10000 }, context(serverRoot, 256));
    assert.equal(large.ok, true);
    if (large.ok) {
      assert.equal((large.data as { truncated: boolean }).truncated, true);
      assert.ok(Buffer.byteLength(JSON.stringify(large.data)) <= 256);
    }
    await connected.close();
    await connected.close();
  } finally {
    try {
      await connected?.close();
    } catch {
      // The close-failure behavior is covered by the deterministic fake-client test below.
    }
    await rm(serverRoot, { recursive: true, force: true });
  }
});

test("MCP discovery isolates a broken server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-mcp-isolation-"));
  try {
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { broken: { command: process.execPath, args: [path.join(root, "missing-server.mjs")] }, demo: { command: process.execPath, args: [fixturePath] } } }), "utf8");
    const manager = new McpManager(await loadMcpConfig(root));
    const result = await manager.connect();
    assert.ok(result.failures.some((failure) => failure.server === "broken"));
    assert.ok(result.tools.some((tool) => tool.name === mcpToolName("demo", "echo")));
    await manager.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent exposes mapped MCP tools and preserves the MCP result in the next model round", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-mcp-agent-"));
  let manager: McpManager | undefined;
  try {
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixturePath] } } }), "utf8");
    manager = new McpManager(await loadMcpConfig(root));
    const connected = await manager.connect();
    const mapped = mcpToolName("demo", "echo");
    const fake = new FakeChatClient([
      assistant(null, [{ id: "mcp-call", type: "function", function: { name: mapped, arguments: JSON.stringify({ text: "from agent" }) } }]),
      assistant("done"),
    ]);
    const agent = new Agent({ client: fake, model: "fake", tools: connected.tools, maxRounds: 3, toolContext: context(root) });
    const result = await agent.run("echo text");
    assert.equal(result.content, "done");
    assert.ok(fake.calls[0]?.tools.some((tool) => tool.type === "function" && tool.function.name === mapped));
    const toolMessage = fake.calls[1]?.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") assert.match(toolMessage.content as string, /from agent/);
  } finally {
    await manager?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two healthy MCP servers with the same tool name coexist under distinct namespaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-mcp-namespace-"));
  let manager: McpManager | undefined;
  try {
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "server-a": { command: process.execPath, args: [fixturePath] },
        "server-b": { command: process.execPath, args: [fixturePath] },
      },
    }), "utf8");
    manager = new McpManager(await loadMcpConfig(root));
    const result = await manager.connect();
    assert.deepEqual(result.failures, []);
    assert.ok(result.tools.some((tool) => tool.name === mcpToolName("server-a", "echo")));
    assert.ok(result.tools.some((tool) => tool.name === mcpToolName("server-b", "echo")));
    assert.notEqual(mcpToolName("server-a", "echo"), mcpToolName("server-b", "echo"));
  } finally {
    await manager?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("punctuation and Unicode MCP tool names remain callable through safe mapped names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-mcp-punctuation-"));
  let manager: McpManager | undefined;
  try {
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixturePath] } } }), "utf8");
    manager = new McpManager(await loadMcpConfig(root));
    const result = await manager.connect();
    const original = "punctuation tool/日本語";
    const mapped = mcpToolName("demo", original);
    const tool = result.tools.find((candidate) => candidate.name === mapped);
    assert.ok(tool);
    assert.match(mapped, /^mcp__demo__[A-Za-z0-9_-]+__[0-9a-f]{8}$/);
    assert.ok(mapped.length <= 64);
    const called = await executeTool(tool, { value: "original name reached" }, context(root));
    assert.equal(called.ok, true);
    if (called.ok) assert.deepEqual(called.data, { server: "demo", tool: original, content: [{ type: "text", text: "original name reached" }], truncated: false });
  } finally {
    await manager?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP adapter rejects an already aborted call without invoking the client and propagates active signals", async () => {
  const abortedClient = new FakeMcpClient({ content: [] });
  const abortedTool = fakeTool(abortedClient);
  const aborted = new AbortController();
  aborted.abort();
  const blockedWithSignal = await executeTool(abortedTool, {}, { ...context(process.cwd(), 1024), signal: aborted.signal });
  assert.equal(blockedWithSignal.ok, false);
  if (!blockedWithSignal.ok) assert.equal(blockedWithSignal.error.code, "MCP_CALL_FAILED");
  assert.equal(abortedClient.callCount, 0);

  const activeClient = new FakeMcpClient({ content: [{ type: "text", text: "ok" }] });
  const activeTool = fakeTool(activeClient);
  const controller = new AbortController();
  const active = await executeTool(activeTool, {}, { ...context(process.cwd(), 1024), signal: controller.signal });
  assert.equal(active.ok, true);
  assert.equal(activeClient.lastSignal, controller.signal);
});

test("MCP call exceptions become bounded MCP_CALL_FAILED tool results", async () => {
  const client = new FakeMcpClient({ content: [] }, new Error("remote failure\n    at secret-stack-frame"));
  const result = await executeTool(fakeTool(client), {}, context(process.cwd()));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "MCP_CALL_FAILED");
    assert.equal(result.error.message.includes("secret-stack-frame"), false);
  }
});

test("MCP tool errors keep their details bounded", async () => {
  const client = new FakeMcpClient({ isError: true, content: [{ type: "text", text: "x".repeat(10000) }] });
  const result = await executeTool(fakeTool(client), {}, context(process.cwd(), 256));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "MCP_TOOL_ERROR");
    assert.ok(Buffer.byteLength(JSON.stringify(result.error.details)) <= 256);
  }
});

test("MCP result normalization preserves arbitrary structured data when it fits", async () => {
  const structuredContent = { data: "x".repeat(200), count: 12, nested: { value: true } };
  const client = new FakeMcpClient({ content: [], structuredContent });
  const result = await executeTool(fakeTool(client), {}, context(process.cwd(), 1024));
  assert.equal(result.ok, true);
  if (result.ok) {
    const data = result.data as NormalizedMcpResult;
    assert.equal(data.truncated, false);
    assert.deepEqual(data.structuredContent, structuredContent);
  }
});

test("oversized structured and binary MCP content is explicitly bounded", async () => {
  const structuredClient = new FakeMcpClient({ content: [], structuredContent: { data: "x".repeat(10000) } });
  const structured = await executeTool(fakeTool(structuredClient), {}, context(process.cwd(), 256));
  assert.equal(structured.ok, true);
  if (structured.ok) {
    const data = structured.data as NormalizedMcpResult;
    assert.equal(data.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 256);
  }

  const binary = { type: "image", data: "A".repeat(10000), mimeType: "image/png" };
  const binaryClient = new FakeMcpClient({ content: [binary] });
  const boundedBinary = await executeTool(fakeTool(binaryClient), {}, context(process.cwd(), 256));
  assert.equal(boundedBinary.ok, true);
  if (boundedBinary.ok) {
    const data = boundedBinary.data as NormalizedMcpResult;
    const serialized = JSON.stringify(data);
    assert.equal(data.truncated, true);
    assert.ok(Buffer.byteLength(serialized) <= 256);
    assert.equal(serialized.includes(binary.data), false);
    assert.match(serialized, /image\/png/);
  }

  const smallBinary = { type: "image", data: "AAAA", mimeType: "image/png" };
  const smallBinaryClient = new FakeMcpClient({ content: [smallBinary] });
  const intact = await executeTool(fakeTool(smallBinaryClient), {}, context(process.cwd(), 256));
  assert.equal(intact.ok, true);
  if (intact.ok) {
    const data = intact.data as NormalizedMcpResult;
    assert.equal(data.truncated, false);
    assert.deepEqual(data.content, [smallBinary]);
  }
});

test("MCP manager attempts every close, reports failures, then stays idempotently closed", async () => {
  const clients = [
    new FakeMcpClient({ content: [] }),
    new FakeMcpClient({ content: [] }, undefined, new Error("close A")),
    new FakeMcpClient({ content: [] }),
  ];
  const manager = new McpManager(
    ["server-1", "server-2", "server-3"].map((name) => ({ name, command: "fake", args: [], env: {} })),
    { clientFactory: (config) => ({ client: clients[Number(config.name.at(-1)) - 1]!, transport: fakeTransport }) },
  );
  await manager.connect();
  await assert.rejects(manager.close(), (error: unknown) => error instanceof McpCloseError && error.message === "Failed to close 1 MCP client.");
  assert.deepEqual(clients.map((client) => client.closeCount), [1, 1, 1]);
  await manager.close();
  assert.deepEqual(clients.map((client) => client.closeCount), [1, 1, 1]);
});

test("Skill and MCP tools coexist in one Agent tool list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skill-mcp-"));
  let manager: McpManager | undefined;
  try {
    await mkdir(path.join(root, "skills", "testing"), { recursive: true });
    await writeFile(path.join(root, "skills", "testing", "SKILL.md"), "---\nname: testing\ndescription: Test skill\n---\n\n# Testing\n", "utf8");
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fixturePath] } } }), "utf8");
    const registry = new SkillRegistry(path.join(root, "skills"));
    await registry.list();
    manager = new McpManager(await loadMcpConfig(root));
    const connected = await manager.connect();
    const fake = new FakeChatClient([assistant("ready")]);
    const agent = new Agent({ client: fake, model: "fake", tools: [...defaultTools, createLoadSkillTool(registry), ...connected.tools], maxRounds: 2, toolContext: context(root) });
    await agent.run("list available tools");
    const names = fake.calls[0]?.tools.map((tool) => tool.type === "function" ? tool.function.name : "") ?? [];
    assert.ok(names.includes("load_skill"));
    assert.ok(names.some((name) => name.startsWith("mcp__demo__")));
  } finally {
    await manager?.close();
    await rm(root, { recursive: true, force: true });
  }
});
