import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../tools/path-security.ts";
import { errorMessage } from "../utils/errors.ts";
import { isValidMcpServerName } from "./names.ts";
import type { McpStdioServerConfig } from "./types.ts";

const MCP_CONFIG_FILE = ".mcp.json";
const MAX_CONFIG_BYTES = 64 * 1024;

export class McpConfigError extends Error {
  constructor(message: string) {
    super(`Invalid MCP configuration: ${message}`);
    this.name = "McpConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new McpConfigError(message);
}

function rejectDotDot(value: string): void {
  if (value.split(/[\\/]+/u).includes("..")) invalid("cwd must not contain '..'.");
}

function resolveEnvironment(value: unknown, env: NodeJS.ProcessEnv, server: string): string {
  if (typeof value !== "string") invalid(`env value for '${server}' must be a string.`);
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
  if (match !== null) {
    const variableName = match[1];
    if (variableName === undefined) invalid(`environment reference for '${server}' is invalid.`);
    const resolved = env[variableName];
    if (resolved === undefined) invalid(`environment reference '${match[1]}' for '${server}' is not set.`);
    return resolved;
  }
  if (value.includes("${")) invalid(`environment references for '${server}' must be exactly \${NAME}.`);
  return value;
}

async function readConfigFile(projectRoot: string): Promise<unknown | undefined> {
  const configPath = path.join(projectRoot, MCP_CONFIG_FILE);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(configPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new McpConfigError(errorMessage(error));
  }
  if (stat.isSymbolicLink()) throw new McpConfigError(`${MCP_CONFIG_FILE} must not be a symlink.`);
  if (!stat.isFile()) throw new McpConfigError(`${MCP_CONFIG_FILE} must be a regular file.`);
  if (stat.size > MAX_CONFIG_BYTES) throw new McpConfigError(`${MCP_CONFIG_FILE} exceeds ${MAX_CONFIG_BYTES} bytes.`);
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new McpConfigError(`could not parse ${MCP_CONFIG_FILE}: ${errorMessage(error)}`);
  }
}

export async function loadMcpConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpStdioServerConfig[]> {
  const parsed = await readConfigFile(projectRoot);
  if (parsed === undefined) return [];
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) invalid("mcpServers must be an object.");
  const servers: McpStdioServerConfig[] = [];
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    if (!isValidMcpServerName(name)) invalid(`server name '${name}' must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and be at most 32 characters.`);
    if (!isRecord(raw)) invalid(`server '${name}' must be an object.`);
    const command = raw.command;
    if (typeof command !== "string" || command.trim().length === 0) invalid(`server '${name}' command must be a non-empty string.`);
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) invalid(`server '${name}' args must be an array of strings.`);
    const cwdValue = raw.cwd === undefined ? "." : raw.cwd;
    if (typeof cwdValue !== "string" || cwdValue.trim().length === 0) invalid(`server '${name}' cwd must be a non-empty project-relative path.`);
    if (path.isAbsolute(cwdValue)) invalid(`server '${name}' cwd must be project-relative.`);
    rejectDotDot(cwdValue);
    let cwd: string;
    try {
      cwd = await resolveProjectPath(projectRoot, cwdValue, { allowMissing: false });
    } catch (error) {
      invalid(`server '${name}' cwd is not a safe project path: ${errorMessage(error)}`);
    }
    let envConfig: Record<string, string> = {};
    if (raw.env !== undefined) {
      if (!isRecord(raw.env)) invalid(`server '${name}' env must be an object.`);
      envConfig = Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, resolveEnvironment(value, env, name)]));
    }
    const versionNegotiation = raw.versionNegotiation === undefined ? "default" : raw.versionNegotiation;
    if (versionNegotiation !== "default" && versionNegotiation !== "auto") invalid(`server '${name}' versionNegotiation must be 'default' or 'auto'.`);
    servers.push({ name, command, args, cwd, env: envConfig, versionNegotiation });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}
