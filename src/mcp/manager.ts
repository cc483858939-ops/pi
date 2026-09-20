import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { createMcpTool } from "./tool-adapter.ts";
import type { McpClientFactory, McpClientLike, McpConnectResult, McpManagerOptions, McpServerFailure, McpStdioServerConfig } from "./types.ts";

function messageOf(error: unknown): string {
  const firstLine = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "";
  return firstLine.slice(0, 300) || "unknown MCP error";
}

function defaultClientFactory(config: McpStdioServerConfig): { client: McpClientLike; transport: import("@modelcontextprotocol/client").Transport } {
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd ?? process.cwd(), env: { ...getDefaultEnvironment(), ...config.env }, stderr: "ignore" });
  const client = new Client({ name: "mini-pi", version: "0.2.0" }, { inputRequired: { autoFulfill: false }, ...(config.versionNegotiation === "auto" ? { versionNegotiation: { mode: "auto" as const } } : {}) });
  return { client, transport };
}

export class McpManager {
  private readonly servers: McpStdioServerConfig[];
  private readonly clientFactory: McpClientFactory;
  private readonly clients = new Set<McpClientLike>();
  private closed = false;

  constructor(servers: McpStdioServerConfig[], options: McpManagerOptions = {}) {
    this.servers = [...servers].sort((a, b) => a.name.localeCompare(b.name));
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  async connect(): Promise<McpConnectResult> {
    const tools: import("../tools/types.ts").RegisteredTool[] = [];
    const failures: McpServerFailure[] = [];
    for (const server of this.servers) {
      let client: McpClientLike | undefined;
      try {
        const created = this.clientFactory(server);
        client = created.client;
        await client.connect(created.transport);
        const listed = await client.listTools();
        for (const tool of listed.tools ?? []) {
          if (typeof tool.name !== "string" || tool.name.length === 0 || typeof tool.inputSchema !== "object" || tool.inputSchema === null || Array.isArray(tool.inputSchema)) {
            failures.push({ server: server.name, code: "MCP_INVALID_TOOL", message: "Skipped a tool with an invalid input schema." });
            continue;
          }
          tools.push(createMcpTool(server.name, tool.name, tool.description, tool.inputSchema as Record<string, unknown>, client));
        }
        this.clients.add(client);
      } catch (error) {
        if (client !== undefined) {
          try { await client.close(); } catch { /* discovery failure remains primary */ }
        }
        failures.push({ server: server.name, code: "MCP_DISCOVERY_FAILED", message: messageOf(error) });
      }
    }
    return { tools, failures };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients = [...this.clients];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}
