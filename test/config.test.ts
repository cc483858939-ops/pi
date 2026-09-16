import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("uses Atria defaults when an Atria key is provided", () => {
  const config = loadConfig({ ATRIA_API_KEY: "atria-test-key" });

  assert.equal(config.baseURL, "https://api.atria-asi.ai/v1");
  assert.equal(config.model, "Atria-Dawn-Preview");
  assert.equal(config.apiKey, "atria-test-key");
});

test("uses ATRIA_API_KEY when MINI_PI_API_KEY is unset", () => {
  const config = loadConfig({ ATRIA_API_KEY: "atria-key" });

  assert.equal(config.apiKey, "atria-key");
});

test("MINI_PI_API_KEY takes precedence over ATRIA_API_KEY", () => {
  const config = loadConfig({
    MINI_PI_API_KEY: "mini-key",
    ATRIA_API_KEY: "atria-key",
  });

  assert.equal(config.apiKey, "mini-key");
});

test("rejects missing API keys", () => {
  assert.throws(
    () => loadConfig({}),
    /MINI_PI_API_KEY or ATRIA_API_KEY must be set\./,
  );
});

test("rejects an empty ATRIA_API_KEY", () => {
  assert.throws(
    () => loadConfig({ ATRIA_API_KEY: "" }),
    /MINI_PI_API_KEY or ATRIA_API_KEY must be set\./,
  );
});

test("rejects an empty MINI_PI_API_KEY when no fallback exists", () => {
  assert.throws(
    () => loadConfig({ MINI_PI_API_KEY: "" }),
    /MINI_PI_API_KEY or ATRIA_API_KEY must be set\./,
  );
});

test("falls back to ATRIA_API_KEY when MINI_PI_API_KEY is empty", () => {
  const config = loadConfig({
    MINI_PI_API_KEY: "  ",
    ATRIA_API_KEY: "atria-key",
  });

  assert.equal(config.apiKey, "atria-key");
});

test("preserves generic OpenAI-compatible overrides", () => {
  const config = loadConfig({
    MINI_PI_BASE_URL: "http://127.0.0.1:11434/v1",
    MINI_PI_API_KEY: "ollama",
    MINI_PI_MODEL: "qwen3.5:9b",
  });

  assert.equal(config.baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(config.apiKey, "ollama");
  assert.equal(config.model, "qwen3.5:9b");
});
