import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent } from "../src/agent/agent.ts";
import { loadMcpConfig } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { mcpToolName } from "../src/mcp/names.ts";
import type { ChatClient, ChatCompletionMessage, ChatCompletionMessageToolCall, ChatRequest, ChatResponse } from "../src/llm/client.ts";
import { executeTool, type ToolContext } from "../src/tools/types.ts";

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
  } finally {
    await connected?.close();
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
