import assert from "node:assert/strict";
import test from "node:test";
import { buildChatCompletionBody, type ChatRequest } from "../src/llm/client.ts";

const request: ChatRequest = {
  model: "deepseek-flash",
  messages: [],
  tools: [],
};

test("does not add thinking when it is not configured", () => {
  const body = buildChatCompletionBody(request, {});

  assert.equal(Object.hasOwn(body, "thinking"), false);
  assert.deepEqual(body, {
    model: "deepseek-flash",
    messages: [],
    tools: [],
    stream: false,
  });
});

test("adds a top-level disabled thinking parameter", () => {
  const body = buildChatCompletionBody(request, { thinking: "disabled" });

  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(body, "extra_body"), false);
});

test("adds a top-level enabled thinking parameter", () => {
  const body = buildChatCompletionBody(request, { thinking: "enabled" });

  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(Object.hasOwn(body, "extra_body"), false);
});
