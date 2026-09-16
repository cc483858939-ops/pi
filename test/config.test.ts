import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("leaves thinking unset when MINI_PI_THINKING is omitted", () => {
  const config = loadConfig({});

  assert.equal(config.thinking, undefined);
  assert.equal(Object.hasOwn(config, "thinking"), false);
});

test("accepts disabled thinking mode", () => {
  const config = loadConfig({ MINI_PI_THINKING: "disabled" });

  assert.equal(config.thinking, "disabled");
});

test("accepts enabled thinking mode", () => {
  const config = loadConfig({ MINI_PI_THINKING: "enabled" });

  assert.equal(config.thinking, "enabled");
});

test("rejects unsupported thinking mode values", () => {
  for (const value of ["false", "foo"]) {
    assert.throws(
      () => loadConfig({ MINI_PI_THINKING: value }),
      /MINI_PI_THINKING must be either "enabled" or "disabled"\./,
    );
  }
});
