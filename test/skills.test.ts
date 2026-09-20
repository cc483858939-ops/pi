import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Agent, type AgentEvent, type AgentRunResult } from "../src/agent/agent.ts";
import type {
  ChatClient,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
  ChatRequest,
  ChatResponse,
} from "../src/llm/client.ts";
import { parseSkillDocument } from "../src/skills/parser.ts";
import { SkillRegistry, MAX_SKILL_BYTES } from "../src/skills/registry.ts";
import { buildSystemPrompt } from "../src/skills/prompt.ts";
import { createLoadSkillTool } from "../src/tools/load-skill.ts";
import { executeTool, type ToolContext } from "../src/tools/types.ts";

function context(rootDir: string): ToolContext {
  return { rootDir, bashTimeoutMs: 5000, maxOutputBytes: 4096 };
}

function skillDocument(name: string, description: string, body = `# ${name}\n`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

async function skipIfSymlinksUnavailable(t: TestContext, target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
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

function assistant(
  content: string | null,
  toolCalls: ChatCompletionMessageToolCall[] = [],
): ChatResponse {
  const message: ChatCompletionMessage = {
    role: "assistant",
    content,
    refusal: null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
  return { message };
}

function functionCall(id: string, name: string, args: Record<string, unknown>): ChatCompletionMessageToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

class FakeClient implements ChatClient {
  readonly calls: ChatRequest[] = [];

  constructor(private readonly responses: ChatResponse[]) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push({
      ...request,
      messages: request.messages.map((message) => structuredClone(message)),
      tools: request.tools.map((tool) => structuredClone(tool)),
    });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("Fake client ran out of responses.");
    }
    return response;
  }
}

async function consumeStream(
  stream: AsyncGenerator<AgentEvent, AgentRunResult, void>,
): Promise<{ events: AgentEvent[]; result?: AgentRunResult; error?: unknown }> {
  const events: AgentEvent[] = [];
  try {
    while (true) {
      const next = await stream.next();
      if (next.done) return { events, result: next.value };
      events.push(next.value);
    }
  } catch (error) {
    return { events, error };
  }
}

test("discovers valid direct skills in deterministic order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    await mkdir(path.join(root, "code-review"));
    await mkdir(path.join(root, "missing-file"));
    await mkdir(path.join(root, "code_review"));
    await mkdir(path.join(root, "backend", "testing"), { recursive: true });
    await writeFile(path.join(root, "testing", "SKILL.md"), skillDocument("testing", "Validate changes.", "# Testing\n"), "utf8");
    await writeFile(path.join(root, "code-review", "SKILL.md"), skillDocument("code-review", "Review changes.", "# Code Review\n"), "utf8");
    await writeFile(path.join(root, "backend", "testing", "SKILL.md"), skillDocument("testing", "Nested.", "# Nested\n"), "utf8");
    await writeFile(path.join(root, "random.txt"), "ignore me", "utf8");

    const skills = await new SkillRegistry(root).list();

    assert.deepEqual(skills.map((skill) => skill.name), ["code-review", "testing"]);
    assert.deepEqual(skills.map((skill) => skill.description), ["Review changes.", "Validate changes."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores missing, malformed, and mismatched Skill documents during discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "valid"));
    await mkdir(path.join(root, "malformed"));
    await mkdir(path.join(root, "missing-name"));
    await mkdir(path.join(root, "missing-description"));
    await mkdir(path.join(root, "mismatch"));
    await mkdir(path.join(root, "missing-file"));
    await writeFile(path.join(root, "valid", "SKILL.md"), skillDocument("valid", "Valid Skill."), "utf8");
    await writeFile(path.join(root, "malformed", "SKILL.md"), "---\nname: [broken\ndescription: Bad\n---\n", "utf8");
    await writeFile(path.join(root, "missing-name", "SKILL.md"), "---\ndescription: Missing name.\n---\n", "utf8");
    await writeFile(path.join(root, "missing-description", "SKILL.md"), "---\nname: missing-description\n---\n", "utf8");
    await writeFile(path.join(root, "mismatch", "SKILL.md"), skillDocument("other", "Wrong directory."), "utf8");

    const skills = await new SkillRegistry(root).list();

    assert.deepEqual(skills.map((skill) => skill.name), ["valid"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses YAML metadata instead of Markdown headings", () => {
  const content = `---
name: testing
description: Correct YAML description.
license: Apache-2.0
compatibility: Requires git
metadata:
  author: example
  version: "1.0"
allowed-tools: "Bash(git:*) Read"
future-field: preserved-for-forward-compatibility
---

# Completely Different Heading
`;

  assert.deepEqual(parseSkillDocument(content, "testing"), {
    name: "testing",
    description: "Correct YAML description.",
    license: "Apache-2.0",
    compatibility: "Requires git",
    metadata: { author: "example", version: "1.0" },
    allowedTools: "Bash(git:*) Read",
    content,
  });
});

test("rejects invalid frontmatter and standard metadata", () => {
  const invalidDocuments = [
    "# Testing\nDo stuff.\n",
    "---\nname: [broken\ndescription: Bad\n---\n",
    "---\ndescription: Missing name.\n---\n",
    "---\nname: testing\n---\n",
    "---\nname: testing\ndescription: \"\"\n---\n",
    "---\nname: testing\ndescription: [not a string]\n---\n",
    "---\nname: testing\ndescription: *missing\n---\n",
  ];
  for (const content of invalidDocuments) {
    assert.throws(
      () => parseSkillDocument(content, "testing"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_METADATA",
    );
  }

  const spaced = parseSkillDocument("---\nname: testing\ndescription: \"  Keep spaces  \"\n---\n", "testing");
  assert.equal(spaced.description, "  Keep spaces  ");
});

test("validates Skill names, descriptions, compatibility, and metadata mappings", () => {
  const validName = "a".repeat(64);
  assert.equal(parseSkillDocument(skillDocument(validName, "Valid."), validName).name, validName);
  for (const name of ["Testing", "-test", "test-", "test--foo", "test_foo"]) {
    assert.throws(
      () => parseSkillDocument(skillDocument(name, "Invalid."), name),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_METADATA",
    );
  }
  assert.throws(
    () => parseSkillDocument(skillDocument("code-review", "Wrong directory."), "testing"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_METADATA",
  );
  assert.throws(
    () => parseSkillDocument(skillDocument("a".repeat(65), "Too long."), "a".repeat(65)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_METADATA",
  );

  assert.equal(parseSkillDocument(skillDocument("testing", "x".repeat(1024)), "testing").description.length, 1024);
  assert.equal(parseSkillDocument(skillDocument("testing", "😀".repeat(1024)), "testing").description, "😀".repeat(1024));
  assert.throws(() => parseSkillDocument(skillDocument("testing", "x".repeat(1025)), "testing"));
  assert.throws(() => parseSkillDocument(skillDocument("testing", "😀".repeat(1025)), "testing"));
  assert.equal(parseSkillDocument(skillDocument("testing", "Testing."), "testing").name, "testing");
  for (const compatibility of ["", " ", "x".repeat(501)]) {
    assert.throws(
      () => parseSkillDocument(`---\nname: testing\ndescription: Testing.\ncompatibility: ${JSON.stringify(compatibility)}\n---\n`, "testing"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_METADATA",
    );
  }
  for (const metadata of ["version: 1", "nested:\n    key: value", "items:\n  - value"]) {
    assert.throws(
      () => parseSkillDocument(`---\nname: testing\ndescription: Testing.\nmetadata:\n  ${metadata}\n---\n`, "testing"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_METADATA",
    );
  }
});

test("returns an empty list when the skills root is missing", async () => {
  const root = path.join(os.tmpdir(), `mini-pi-missing-skills-${Date.now()}-${Math.random()}`);
  assert.deepEqual(await new SkillRegistry(root).list(), []);
});

test("returns an empty list when the skills root is not a directory", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-parent-"));
  try {
    const root = path.join(parent, "skills");
    await writeFile(root, "not a directory", "utf8");

    assert.deepEqual(await new SkillRegistry(root).list(), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("does not discover Skills through a symlinked skills root", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-project-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-external-skills-"));
  try {
    await mkdir(path.join(externalRoot, "malicious"));
    await writeFile(
      path.join(externalRoot, "malicious", "SKILL.md"),
      skillDocument("malicious", "External Skill that must not be discovered.", "# Malicious\n"),
      "utf8",
    );
    if (await skipIfSymlinksUnavailable(t, externalRoot, path.join(projectRoot, "skills"))) return;

    const skills = await new SkillRegistry(path.join(projectRoot, "skills")).list();

    assert.deepEqual(skills, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("does not follow a symlinked Skill directory", async (t) => {
  const skillsRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-external-skill-"));
  try {
    await mkdir(path.join(externalRoot, "malicious"));
    await writeFile(path.join(externalRoot, "malicious", "SKILL.md"), skillDocument("malicious", "External."), "utf8");
    if (await skipIfSymlinksUnavailable(t, path.join(externalRoot, "malicious"), path.join(skillsRoot, "malicious"))) return;

    const skills = await new SkillRegistry(skillsRoot).list();

    assert.deepEqual(skills, []);
  } finally {
    await rm(skillsRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("does not follow a symlinked SKILL.md", async (t) => {
  const skillsRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-external-skill-"));
  try {
    await mkdir(path.join(skillsRoot, "testing"));
    const externalFile = path.join(externalRoot, "SKILL.md");
    await writeFile(externalFile, skillDocument("testing", "External."), "utf8");
    if (await skipIfSymlinksUnavailable(t, externalFile, path.join(skillsRoot, "testing", "SKILL.md"))) return;

    const skills = await new SkillRegistry(skillsRoot).list();

    assert.deepEqual(skills, []);
  } finally {
    await rm(skillsRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("loads a skill body and metadata on demand", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    const content = skillDocument("testing", "Validate changes.", "# Testing\n");
    await mkdir(path.join(root, "testing"));
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");

    const loaded = await new SkillRegistry(root).load("testing");

    assert.equal(loaded.name, "testing");
    assert.equal(loaded.description, "Validate changes.");
    assert.equal(loaded.content, content);
    assert.equal(loaded.path, path.join(root, "testing", "SKILL.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid and missing skill names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    const registry = new SkillRegistry(root);
    for (const name of ["../testing", "/testing", "Testing", "a/b"]) {
      await assert.rejects(
        () => registry.load(name),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_NAME",
      );
    }
    await assert.rejects(
      () => registry.load("does-not-exist"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "SKILL_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes oversized skills and rejects invalid full content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "large"));
    await mkdir(path.join(root, "binary"));
    await mkdir(path.join(root, "invalid"));
    await writeFile(path.join(root, "large", "SKILL.md"), Buffer.alloc(MAX_SKILL_BYTES + 1, 0x61));
    await writeFile(path.join(root, "binary", "SKILL.md"), skillDocument("binary", "Binary."), "utf8");
    await writeFile(path.join(root, "invalid", "SKILL.md"), skillDocument("invalid", "Invalid."), "utf8");
    const registry = new SkillRegistry(root);

    const discovered = await registry.list();
    assert.deepEqual(discovered.map((skill) => skill.name), ["binary", "invalid"]);

    await assert.rejects(
      () => registry.load("large"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "SKILL_NOT_FOUND",
    );

    await writeFile(path.join(root, "binary", "SKILL.md"), Buffer.from([0x23, 0x20, 0x00, 0x0a]));
    await writeFile(path.join(root, "invalid", "SKILL.md"), Buffer.from([0xc3, 0x28]));
    for (const name of ["binary", "invalid"] as const) {
      await assert.rejects(
        () => registry.load(name),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_CONTENT",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers a large valid skill from bounded metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    const prefix = "---\nname: testing\ndescription: Testing.\npadding: ";
    const content = `${prefix}${"x".repeat(5000)}\n---\n# Testing\n`;
    assert.ok(Buffer.byteLength(content) > 4096);
    assert.ok(Buffer.byteLength(content) < MAX_SKILL_BYTES);
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");

    const skills = await new SkillRegistry(root).list();

    assert.deepEqual(skills.map((skill) => skill.name), ["testing"]);
    assert.equal(skills[0]?.description, "Testing.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a UTF-8 character split at the metadata boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    const metadataBoundary = 4096;
    const prefix = "---\nname: testing\ndescription: Testing.\npadding: ";
    const filler = "a".repeat(metadataBoundary - Buffer.byteLength(prefix) - 1);
    const content = `${prefix}${filler}你\n---\n# Testing\n`;
    assert.equal(Buffer.byteLength(prefix + filler), metadataBoundary - 1);
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");

    const skills = await new SkillRegistry(root).list();

    assert.deepEqual(skills.map((skill) => skill.name), ["testing"]);
    assert.equal(skills[0]?.description, "Testing.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not load a Skill added after discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    const registry = new SkillRegistry(root);
    assert.deepEqual(await registry.list(), []);
    await mkdir(path.join(root, "later"));
    await writeFile(path.join(root, "later", "SKILL.md"), skillDocument("later", "Later."), "utf8");

    await assert.rejects(
      () => registry.load("later"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "SKILL_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns a controlled not-found failure when a discovered Skill is deleted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    const filePath = path.join(root, "testing", "SKILL.md");
    await writeFile(filePath, skillDocument("testing", "Testing."), "utf8");
    const registry = new SkillRegistry(root);
    assert.deepEqual((await registry.list()).map((skill) => skill.name), ["testing"]);
    await rm(filePath);

    await assert.rejects(
      () => registry.load("testing"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "SKILL_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads modified content for a Skill discovered earlier", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    const filePath = path.join(root, "testing", "SKILL.md");
    await writeFile(filePath, skillDocument("testing", "Testing.", "# Testing\nVersion A\n"), "utf8");
    const registry = new SkillRegistry(root);
    await registry.list();
    await writeFile(filePath, skillDocument("testing", "Testing.", "# Testing\nVersion B\n"), "utf8");

    const loaded = await registry.load("testing");

    assert.equal(loaded.content, skillDocument("testing", "Testing.", "# Testing\nVersion B\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializes discovery when load is called directly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    await writeFile(path.join(root, "testing", "SKILL.md"), skillDocument("testing", "Testing."), "utf8");

    const loaded = await new SkillRegistry(root).load("testing");

    assert.equal(loaded.content, skillDocument("testing", "Testing."));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_skill uses the normal tool abstraction and returns controlled failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    const content = skillDocument("testing", "Testing utilities.", "# Testing\nUse tests.\n");
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");
    const tool = createLoadSkillTool(new SkillRegistry(root));

    const success = await executeTool(tool, { name: "testing" }, context(root));
    assert.equal(success.ok, true);
    if (success.ok) {
      assert.deepEqual(success.data, {
        name: "testing",
        description: "Testing utilities.",
        root: "testing",
        content,
      });
    }

    const missing = await executeTool(tool, { name: "does-not-exist" }, context(root));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "SKILL_NOT_FOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_skill returns a project-relative Skill root", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-project-"));
  try {
    const skillsRoot = path.join(projectRoot, "skills");
    await mkdir(path.join(skillsRoot, "testing"), { recursive: true });
    const content = skillDocument("testing", "Testing utilities.", "# Testing\n");
    await writeFile(path.join(skillsRoot, "testing", "SKILL.md"), content, "utf8");
    const tool = createLoadSkillTool(new SkillRegistry(skillsRoot));

    const result = await executeTool(tool, { name: "testing" }, context(projectRoot));

    assert.equal(result.ok, true);
    if (result.ok) {
      const data = result.data as { root: string };
      assert.equal(data.root, "skills/testing");
      assert.ok(!data.root.includes("\\"));
      assert.ok(!data.root.includes(projectRoot));
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects a Skill root outside the current project", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-project-"));
  const skillsRoot = await mkdtemp(path.join(os.tmpdir(), "mini-pi-external-skills-"));
  try {
    await mkdir(path.join(skillsRoot, "testing"));
    await writeFile(path.join(skillsRoot, "testing", "SKILL.md"), skillDocument("testing", "Testing."), "utf8");
    const tool = createLoadSkillTool(new SkillRegistry(skillsRoot));

    const result = await executeTool(tool, { name: "testing" }, context(projectRoot));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SKILL_OUTSIDE_PROJECT");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(skillsRoot, { recursive: true, force: true });
  }
});

test("revalidates metadata when a discovered Skill changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    const filePath = path.join(root, "testing", "SKILL.md");
    await writeFile(filePath, skillDocument("testing", "Testing."), "utf8");
    const registry = new SkillRegistry(root);
    await registry.list();
    await writeFile(filePath, skillDocument("wrong-name", "Testing."), "utf8");

    await assert.rejects(
      () => registry.load("testing"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SKILL_METADATA",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds a compact lazy-loading skill catalog", () => {
  const base = "Base instructions.";
  const body = "# Testing\nFull skill instructions.";
  const prompt = buildSystemPrompt(base, [
    { name: "testing", path: "testing/SKILL.md", rootDir: "testing", description: "Testing" },
    { name: "code-review", path: "code-review/SKILL.md", rootDir: "code-review", description: "Code Review" },
  ]);

  assert.ok(prompt.startsWith(base));
  assert.ok(prompt.includes("Available skills:"));
  assert.ok(prompt.indexOf("- code-review: Code Review") < prompt.indexOf("- testing: Testing"));
  assert.ok(prompt.includes("resolve it relative to the root returned by load_skill"));
  assert.ok(prompt.includes("skills/testing/references/TESTING.md"));
  assert.ok(!prompt.includes(body));
  assert.equal(buildSystemPrompt(base, []), base);
});

test("loads a Skill through Agent events and the next model history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    const content = skillDocument("testing", "Testing utilities.", "# Testing\nUse tests before completion.\n");
    await mkdir(path.join(root, "testing"));
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");
    const registry = new SkillRegistry(root);
    const loadSkill = createLoadSkillTool(registry);
    const client = new FakeClient([
      assistant(null, [functionCall("skill-call", "load_skill", { name: "testing" })]),
      assistant("done"),
    ]);
    const agent = new Agent({
      client,
      model: "fake-model",
      tools: [loadSkill],
      maxRounds: 3,
      systemPrompt: buildSystemPrompt("Base instructions.", await registry.list()),
      toolContext: context(root),
    });

    const consumed = await consumeStream(agent.stream("validate this change"));

    assert.deepEqual(consumed.events.map((event) => event.type), [
      "round_start",
      "assistant",
      "tool_start",
      "tool_result",
      "round_start",
      "assistant",
      "final",
    ]);
    assert.equal(client.calls.length, 2);
    const firstSystem = client.calls[0]?.messages[0];
    assert.equal(firstSystem?.role, "system");
    if (firstSystem?.role === "system") {
      const systemContent = typeof firstSystem.content === "string" ? firstSystem.content : JSON.stringify(firstSystem.content);
      assert.ok(systemContent.includes("- testing: Testing utilities."));
      assert.ok(!systemContent.includes("Use tests before completion."));
    }
    const toolMessage = client.calls[1]?.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") {
      const payload = JSON.parse(toolMessage.content as string) as { ok: boolean; data: { content: string; root: string } };
      assert.equal(payload.ok, true);
      assert.equal(payload.data.content, content);
      assert.equal(payload.data.root, "testing");
    }
    assert.equal(consumed.result?.content, "done");
    assert.equal(consumed.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
