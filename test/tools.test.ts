import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { executeTool, type ToolContext } from "../src/tools/types.ts";

function context(rootDir: string, maxOutputBytes = 4096): ToolContext {
  return { rootDir, bashTimeoutMs: 5000, maxOutputBytes };
}

async function executeRead(root: string, input: unknown, maxOutputBytes = 4096) {
  return executeTool(readTool, input, context(root, maxOutputBytes));
}

async function executeWrite(root: string, input: unknown) {
  return executeTool(writeTool, input, context(root));
}

async function makeFixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mini-pi-tools-"));
}

async function skipIfSymlinksUnavailable(t: TestContext, target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === "win32" ? "junction" : "file");
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

test("read returns bounded UTF-8 content and metadata", async () => {
  const root = await makeFixture();
  try {
    await writeFile(path.join(root, "hello.txt"), "你好，mini pi\n", "utf8");
    const result = await executeRead(root, { path: "hello.txt" });
    assert.deepEqual(result.ok && result.data, {
      path: "hello.txt",
      content: "你好，mini pi\n",
      bytes: Buffer.byteLength("你好，mini pi\n"),
      truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read rejects missing files and directories", async () => {
  const root = await makeFixture();
  try {
    const missing = await executeRead(root, { path: "missing.txt" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "FILE_NOT_FOUND");
    await mkdir(path.join(root, "folder"));
    const directory = await executeRead(root, { path: "folder" });
    assert.equal(directory.ok, false);
    if (!directory.ok) assert.equal(directory.error.code, "FILE_READ_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read rejects NUL-containing and invalid UTF-8 files", async () => {
  const root = await makeFixture();
  try {
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(path.join(root, "invalid.bin"), Buffer.from([0xc3, 0x28]));
    const binary = await executeRead(root, { path: "binary.bin" });
    const invalid = await executeRead(root, { path: "invalid.bin" });
    assert.equal(binary.ok, false);
    assert.equal(invalid.ok, false);
    if (!binary.ok) assert.equal(binary.error.code, "FILE_READ_FAILED");
    if (!invalid.ok) assert.equal(invalid.error.code, "FILE_READ_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read rejects escapes and truncates oversized output", async () => {
  const root = await makeFixture();
  try {
    await writeFile(path.join(root, "large.txt"), "0123456789", "utf8");
    const truncated = await executeRead(root, { path: "large.txt" }, 4);
    assert.equal(truncated.ok, true);
    if (truncated.ok) {
      assert.deepEqual(truncated.data, {
        path: "large.txt",
        content: "0123",
        bytes: 10,
        truncated: true,
      });
    }
    const parent = await executeRead(root, { path: "../outside.txt" });
    const absolute = await executeRead(root, { path: path.join(root, "large.txt") });
    assert.equal(parent.ok, false);
    assert.equal(absolute.ok, false);
    if (!parent.ok) assert.equal(parent.error.code, "PATH_OUTSIDE_ROOT");
    if (!absolute.ok) assert.equal(absolute.error.code, "PATH_OUTSIDE_ROOT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read rejects a symlink that resolves outside the project", async (t) => {
  const root = await makeFixture();
  const outside = await makeFixture();
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    if (await skipIfSymlinksUnavailable(t, outside, path.join(root, "link"))) return;
    const result = await executeRead(root, { path: "link/secret.txt" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SYMLINK_OUTSIDE_ROOT");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("write creates directories, replaces files, and preserves UTF-8", async () => {
  const root = await makeFixture();
  try {
    const created = await executeWrite(root, { path: "nested/你好.txt", content: "first" });
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.deepEqual(created.data, { path: "nested/你好.txt", bytes: 5, created: true });
    }
    assert.equal(await readFile(path.join(root, "nested/你好.txt"), "utf8"), "first");
    const replaced = await executeWrite(root, { path: "nested/你好.txt", content: "第二次" });
    assert.equal(replaced.ok, true);
    if (replaced.ok) {
      assert.deepEqual(replaced.data, {
        path: "nested/你好.txt",
        bytes: Buffer.byteLength("第二次"),
        created: false,
      });
    }
    assert.equal(await readFile(path.join(root, "nested/你好.txt"), "utf8"), "第二次");
    const leftovers = (await readdir(path.join(root, "nested"))).filter((entry) => entry.includes(".你好.txt.") && entry.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write rejects escapes and outside symlink parents", async (t) => {
  const root = await makeFixture();
  const outside = await makeFixture();
  try {
    const parent = await executeWrite(root, { path: "../outside.txt", content: "no" });
    const absolute = await executeWrite(root, { path: path.join(root, "absolute.txt"), content: "no" });
    assert.equal(parent.ok, false);
    assert.equal(absolute.ok, false);
    if (!parent.ok) assert.equal(parent.error.code, "PATH_OUTSIDE_ROOT");
    if (!absolute.ok) assert.equal(absolute.error.code, "PATH_OUTSIDE_ROOT");

    if (await skipIfSymlinksUnavailable(t, outside, path.join(root, "external"))) return;
    const symlinked = await executeWrite(root, { path: "external/new.txt", content: "no" });
    assert.equal(symlinked.ok, false);
    if (!symlinked.ok) assert.equal(symlinked.error.code, "SYMLINK_OUTSIDE_ROOT");
    assert.equal((await lstat(path.join(outside, "new.txt")).catch(() => undefined)), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
