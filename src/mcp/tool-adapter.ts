import { assertObject, type RegisteredTool, type ToolContext } from "../tools/types.ts";
import { ToolError, errorMessage } from "../utils/errors.ts";
import { truncateUtf8Prefix } from "../utils/truncate.ts";
import { mcpToolName } from "./names.ts";
import type { McpClientLike } from "./types.ts";

function safeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => safeJsonValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "data" && typeof item === "string" && item.length > 1024) continue;
    output[key] = safeJsonValue(item, seen);
  }
  return output;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function textFromContent(content: unknown[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string")
    .map((item) => item.text)
    .join("\n");
}

function compactNonTextContent(content: unknown[]): unknown[] {
  return content.flatMap((item) => {
    if (typeof item !== "object" || item === null || (item as Record<string, unknown>).type === "text") return [];
    const value = item as Record<string, unknown>;
    const compact: Record<string, unknown> = {};
    for (const key of ["type", "mimeType", "uri", "resource", "annotations"]) {
      if (value[key] !== undefined) compact[key] = value[key];
    }
    return Object.keys(compact).length === 0 ? [] : [compact];
  });
}

function boundedResult(base: { server: string; tool: string; content: unknown[]; structuredContent?: unknown }, maxBytes: number): { server: string; tool: string; content: unknown[]; structuredContent?: unknown; truncated: boolean } {
  const full = { ...base, truncated: false };
  if (jsonBytes(full) <= maxBytes) return full;
  const prefix = { server: base.server, tool: base.tool, content: [{ type: "text", text: "" }], truncated: true };
  const source = textFromContent(base.content);
  const compact = compactNonTextContent(base.content);
  const contentFor = (text: string): unknown[] => [
    ...(compact.length === 0 ? [] : compact),
    ...(text.length === 0 ? [] : [{ type: "text", text }]),
  ];
  let low = 0;
  let high = Buffer.byteLength(source);
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = truncateUtf8Prefix(Buffer.from(source), mid).text;
    const value = { ...prefix, content: contentFor(candidate) };
    if (jsonBytes(value) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else high = mid - 1;
  }
  const fallback = { ...prefix, content: contentFor(best) };
  return jsonBytes(fallback) <= maxBytes ? fallback : { server: base.server, tool: base.tool, content: [], truncated: true };
}

function failureMessage(error: unknown): string {
  return (errorMessage(error).split("\n", 1)[0] || "unknown MCP error").slice(0, 300);
}

export function createMcpTool(server: string, originalName: string, description: string | undefined, inputSchema: Record<string, unknown>, client: McpClientLike): RegisteredTool {
  const mappedName = mcpToolName(server, originalName);
  return {
    name: mappedName,
    description: `[MCP: ${server}] ${description?.trim() || `MCP tool \`${originalName}\`.`}`,
    parameters: inputSchema,
    parseArgs: (input: unknown) => assertObject(input),
    execute: async (args: unknown, context: ToolContext) => {
      if (context.signal?.aborted) throw new ToolError("MCP_CALL_FAILED", "MCP tool call was aborted before it started.");
      let result: Awaited<ReturnType<McpClientLike["callTool"]>>;
      try {
        result = await client.callTool({ name: originalName, arguments: args as Record<string, unknown> }, context.signal === undefined ? undefined : { signal: context.signal });
      } catch (error) {
        throw new ToolError("MCP_CALL_FAILED", `MCP call failed: ${failureMessage(error)}`);
      }
      const content = Array.isArray(result.content) ? result.content.map((item) => safeJsonValue(item)) : [];
      if (result.isError === true) {
        throw new ToolError("MCP_TOOL_ERROR", `MCP tool '${originalName}' reported an error.`, { content: boundedResult({ server, tool: originalName, content }, Math.min(context.maxOutputBytes, 4096)).content });
      }
      return boundedResult({ server, tool: originalName, content, ...(result.structuredContent === undefined ? {} : { structuredContent: safeJsonValue(result.structuredContent) }) }, context.maxOutputBytes);
    },
  };
}
