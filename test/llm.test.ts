import assert from "node:assert/strict";
import test from "node:test";
import type { ChatRequest } from "../src/llm/client.ts";

test("ChatRequest retains tools for OpenAI-compatible completions", () => {
  const request: ChatRequest = {
    model: "Atria-Dawn-Preview",
    messages: [],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a project file",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };

  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0]?.type, "function");
});
