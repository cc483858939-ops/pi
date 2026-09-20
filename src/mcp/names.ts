import crypto from "node:crypto";

function safeReadableName(original: string): string {
  const replaced = original.replace(/[^A-Za-z0-9_-]/g, "_");
  return replaced.length === 0 ? "tool" : replaced;
}

export function mcpToolName(server: string, original: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${server}\0${original}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  const prefix = `mcp__${server}__`;
  const suffix = `__${hash}`;
  const maxReadable = Math.max(1, 64 - prefix.length - suffix.length);
  return `${prefix}${safeReadableName(original).slice(0, maxReadable)}${suffix}`;
}

export function isValidMcpServerName(name: string): boolean {
  return name.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
