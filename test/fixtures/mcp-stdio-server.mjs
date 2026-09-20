import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "mini-pi-test-server", version: "1.0.0" });

server.registerTool("echo", { description: "Echoes text back to the caller.", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
server.registerTool("fail", { description: "Returns an MCP tool error.", inputSchema: { message: z.string().optional() } }, async ({ message }) => ({ isError: true, content: [{ type: "text", text: message ?? "fixture failure" }] }));
server.registerTool("large-output", { description: "Returns a large text block.", inputSchema: { size: z.number().int().positive().max(1000000) } }, async ({ size }) => ({ content: [{ type: "text", text: "x".repeat(size) }] }));
server.registerTool("punctuation tool/日本語", { description: "A tool with punctuation in its name.", inputSchema: { value: z.string().optional() } }, async ({ value }) => ({ content: [{ type: "text", text: value ?? "ok" }] }));

await server.connect(new StdioServerTransport());
