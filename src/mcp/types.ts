import type { Tool, Transport } from "@modelcontextprotocol/client";

export type McpVersionNegotiation = "default" | "auto";

export interface McpStdioServerConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  versionNegotiation?: McpVersionNegotiation;
}

export interface McpServerFailure {
  server: string;
  code: string;
  message: string;
}

export interface McpConnectResult {
  tools: import("../tools/types.ts").RegisteredTool[];
  failures: McpServerFailure[];
}

export interface McpClientLike {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<{ tools?: Tool[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<{
    content: unknown[];
    structuredContent?: unknown;
    isError?: boolean | undefined;
    [key: string]: unknown;
  }>;
  close(): Promise<void>;
}

export type McpClientFactory = (
  config: McpStdioServerConfig,
) => { client: McpClientLike; transport: Transport };

export interface McpManagerOptions {
  clientFactory?: McpClientFactory;
}
