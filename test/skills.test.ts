import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, type AgentEvent, type AgentRunResult } from "../src/agent/agent.ts";
import type {
  ChatClient,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
  ChatRequest,
  ChatResponse,
} from "../src/llm/client.ts";
import { SkillRegistry, MAX_SKILL_BYTES, SKILL_METADATA_BYTES } from "../src/skills/registry.ts";
import { buildSystemPrompt } from "../src/skills/prompt.ts";
import { createLoadSkillTool } from "../src/tools/load-skill.ts";
import { executeTool, type ToolContext } from "../src/tools/types.ts";

function context(rootDir: string): ToolContext {
  return { rootDir, bashTimeoutMs: 5000, maxOutputBytes: 4096 };
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
    await writeFile(path.join(root, "testing", "SKILL.md"), "# Testing\n\nValidate changes.\n", "utf8");
    await writeFile(path.join(root, "code-review", "SKILL.md"), "# Code Review\n\nReview changes.\n", "utf8");
    await writeFile(path.join(root, "backend", "testing", "SKILL.md"), "# Nested\n", "utf8");
    await writeFile(path.join(root, "random.txt"), "ignore me", "utf8");

    const skills = await new SkillRegistry(root).list();

    assert.deepEqual(skills.map((skill) => skill.name), ["code-review", "testing"]);
    assert.deepEqual(skills.map((skill) => skill.description), ["Code Review", "Testing"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns an empty list when the skills root is missing", async () => {
  const root = path.join(os.tmpdir(), `mini-pi-missing-skills-${Date.now()}-${Math.random()}`);
  assert.deepEqual(await new SkillRegistry(root).list(), []);
});

test("loads a skill body and metadata on demand", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    const content = "# Testing\n\nValidate changes.\n";
    await mkdir(path.join(root, "testing"));
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");

    const loaded = await new SkillRegistry(root).load("testing");

    assert.equal(loaded.name, "testing");
    assert.equal(loaded.description, "Testing");
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
    await writeFile(path.join(root, "binary", "SKILL.md"), "# Binary\n", "utf8");
    await writeFile(path.join(root, "invalid", "SKILL.md"), "# Invalid\n", "utf8");
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
    const content = `# Testing\n\n${"x".repeat(SKILL_METADATA_BYTES * 2)}`;
    assert.ok(Buffer.byteLength(content) > SKILL_METADATA_BYTES);
    assert.ok(Buffer.byteLength(content) < MAX_SKILL_BYTES);
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");

    const skills = await new SkillRegistry(root).list();

    assert.deepEqual(skills.map((skill) => skill.name), ["testing"]);
    assert.equal(skills[0]?.description, "Testing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a UTF-8 character split at the metadata boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    const prefix = "# Testing\n\n";
    const filler = "a".repeat(SKILL_METADATA_BYTES - Buffer.byteLength(prefix) - 1);
    const content = `${prefix}${filler}你\n`;
    assert.equal(Buffer.byteLength(prefix + filler), SKILL_METADATA_BYTES - 1);
    await writeFile(path.join(root, "testing", "SKILL.md"), content, "utf8");

    const skills = await new SkillRegistry(root).list();

    assert.deepEqual(skills.map((skill) => skill.name), ["testing"]);
    assert.equal(skills[0]?.description, "Testing");
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
    await writeFile(path.join(root, "later", "SKILL.md"), "# Later\n", "utf8");

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
    await writeFile(filePath, "# Testing\n", "utf8");
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
    await writeFile(filePath, "# Testing\nVersion A\n", "utf8");
    const registry = new SkillRegistry(root);
    await registry.list();
    await writeFile(filePath, "# Testing\nVersion B\n", "utf8");

    const loaded = await registry.load("testing");

    assert.equal(loaded.content, "# Testing\nVersion B\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializes discovery when load is called directly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    await writeFile(path.join(root, "testing", "SKILL.md"), "# Testing\n", "utf8");

    const loaded = await new SkillRegistry(root).load("testing");

    assert.equal(loaded.content, "# Testing\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_skill uses the normal tool abstraction and returns controlled failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    await mkdir(path.join(root, "testing"));
    await writeFile(path.join(root, "testing", "SKILL.md"), "# Testing\nUse tests.\n", "utf8");
    const tool = createLoadSkillTool(new SkillRegistry(root));

    const success = await executeTool(tool, { name: "testing" }, context(root));
    assert.equal(success.ok, true);
    if (success.ok) {
      assert.deepEqual(success.data, {
        name: "testing",
        description: "Testing",
        content: "# Testing\nUse tests.\n",
      });
    }

    const missing = await executeTool(tool, { name: "does-not-exist" }, context(root));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "SKILL_NOT_FOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds a compact lazy-loading skill catalog", () => {
  const base = "Base instructions.";
  const body = "# Testing\nFull skill instructions.";
  const prompt = buildSystemPrompt(base, [
    { name: "testing", path: "testing/SKILL.md", description: "Testing" },
    { name: "code-review", path: "code-review/SKILL.md", description: "Code Review" },
  ]);

  assert.ok(prompt.startsWith(base));
  assert.ok(prompt.includes("Available skills:"));
  assert.ok(prompt.indexOf("- code-review: Code Review") < prompt.indexOf("- testing: Testing"));
  assert.ok(!prompt.includes(body));
  assert.equal(buildSystemPrompt(base, []), base);
});

test("loads a Skill through Agent events and the next model history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-pi-skills-"));
  try {
    const content = "# Testing\nUse tests before completion.\n";
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
      assert.ok(systemContent.includes("- testing: Testing"));
      assert.ok(!systemContent.includes("Use tests before completion."));
    }
    const toolMessage = client.calls[1]?.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    if (toolMessage?.role === "tool") {
      const payload = JSON.parse(toolMessage.content as string) as { ok: boolean; data: { content: string } };
      assert.equal(payload.ok, true);
      assert.equal(payload.data.content, content);
    }
    assert.equal(consumed.result?.content, "done");
    assert.equal(consumed.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
