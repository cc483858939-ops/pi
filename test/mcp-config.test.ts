import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadMcpConfig, McpConfigError } from "../src/mcp/config.ts";

async function fixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mini-pi-mcp-config-"));
}

async function writeConfig(root: string, value: unknown): Promise<void> {
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify(value), "utf8");
}

async function skipSymlink(t: TestContext, target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === "win32" ? "file" : undefined);
    return false;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
      t.skip("symbolic links are unavailable in this environment");
      return true;
    }
    throw error;
  }
}

test("missing MCP config is empty and valid config resolves safely", async () => {
  const root = await fixture();
  try {
    assert.deepEqual(await loadMcpConfig(root), []);
    await mkdir(path.join(root, "runtime"));
    await writeConfig(root, {
      mcpServers: {
        demo: {
          command: "node",
          args: ["fixture.mjs"],
          cwd: "runtime",
          env: { TOKEN: "${MCP_TEST_TOKEN}", MODE: "safe" },
          versionNegotiation: "auto",
        },
      },
    });
    const configs = await loadMcpConfig(root, { MCP_TEST_TOKEN: "secret-value" });
    assert.equal(configs.length, 1);
    assert.equal(configs[0]?.name, "demo");
    assert.equal(configs[0]?.cwd, path.join(root, "runtime"));
    assert.deepEqual(configs[0]?.env, { TOKEN: "secret-value", MODE: "safe" });
    assert.equal(configs[0]?.versionNegotiation, "auto");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP config rejects malformed structure, unsafe paths, names, and missing env", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["not an object", [], "mcpServers"],
    ["bad name", { mcpServers: { "Bad_Name": { command: "node" } } }, "server name"],
    ["empty command", { mcpServers: { demo: { command: " " } } }, "command"],
    ["bad args", { mcpServers: { demo: { command: "node", args: [1] } } }, "args"],
    ["absolute cwd", { mcpServers: { demo: { command: "node", cwd: path.parse(process.cwd()).root } } }, "project-relative"],
    ["parent cwd", { mcpServers: { demo: { command: "node", cwd: "../outside" } } }, ".."],
    ["missing env", { mcpServers: { demo: { command: "node", env: { TOKEN: "${MISSING_MCP_TEST_TOKEN}" } } } }, "not set"],
  ];
  for (const [, value, expected] of cases) {
    const root = await fixture();
    try {
      await writeConfig(root, value);
      await assert.rejects(loadMcpConfig(root), (error: unknown) => error instanceof McpConfigError && error.message.includes("Invalid MCP configuration:") && error.message.includes(expected));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("MCP config bounds and parses the root file before discovery", async () => {
  const malformed = await fixture();
  try {
    await writeFile(path.join(malformed, ".mcp.json"), "{", "utf8");
    await assert.rejects(loadMcpConfig(malformed), (error: unknown) => error instanceof McpConfigError && error.message.startsWith("Invalid MCP configuration:"));
  } finally {
    await rm(malformed, { recursive: true, force: true });
  }
  const oversized = await fixture();
  try {
    await writeFile(path.join(oversized, ".mcp.json"), " ".repeat(64 * 1024 + 1), "utf8");
    await assert.rejects(loadMcpConfig(oversized), (error: unknown) => error instanceof McpConfigError && error.message.includes("exceeds"));
  } finally {
    await rm(oversized, { recursive: true, force: true });
  }
});

test("MCP config symlink is rejected without reading its target", async (t) => {
  const root = await fixture();
  const external = await fixture();
  try {
    await writeConfig(external, { mcpServers: { malicious: { command: "node" } } });
    if (await skipSymlink(t, path.join(external, ".mcp.json"), path.join(root, ".mcp.json"))) return;
    await assert.rejects(loadMcpConfig(root), (error: unknown) => error instanceof McpConfigError && error.message.includes("must not be a symlink"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("MCP cwd symlink escaping the project is rejected", async (t) => {
  const root = await fixture();
  const external = await fixture();
  try {
    if (await skipSymlink(t, external, path.join(root, "escape"))) return;
    await writeConfig(root, { mcpServers: { demo: { command: "node", cwd: "escape" } } });
    await assert.rejects(loadMcpConfig(root), (error: unknown) => error instanceof McpConfigError && error.message.includes("safe project path"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
