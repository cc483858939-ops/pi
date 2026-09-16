import assert from "node:assert/strict";
import { test } from "node:test";

import { KeywordRecognizer } from "../src/index.ts";

test("finds a single keyword with its position", () => {
  const recognizer = new KeywordRecognizer(["error"]);
  assert.deepEqual(recognizer.find("an error occurred"), [
    { keyword: "error", matched: "error", index: 3, end: 8 },
  ]);
});

test("matching is case-insensitive but reports the registered keyword", () => {
  const recognizer = new KeywordRecognizer(["Error"]);
  const [match] = recognizer.find("ERROR: bad");
  assert.equal(match?.keyword, "Error");
  assert.equal(match?.matched, "ERROR");
  assert.equal(match?.index, 0);
});

test("case-sensitive mode can be enabled", () => {
  const recognizer = new KeywordRecognizer(["error"], { ignoreCase: false });
  assert.equal(recognizer.test("an error"), true);
  assert.equal(recognizer.test("an ERROR"), false);
});

test("whole-word matching is on by default", () => {
  const recognizer = new KeywordRecognizer(["cat"]);
  assert.equal(recognizer.test("a cat sat"), true);
  assert.equal(recognizer.test("category"), false);
  assert.equal(recognizer.test("bobcat"), false);
});

test("substring matching when wholeWord is disabled", () => {
  const recognizer = new KeywordRecognizer(["cat"], { wholeWord: false });
  assert.equal(recognizer.test("category"), true);
});

test("finds multiple keywords ordered by position", () => {
  const recognizer = new KeywordRecognizer(["warn", "error"]);
  const matches = recognizer.find("warn then error then warn");
  assert.deepEqual(
    matches.map((match) => [match.keyword, match.index]),
    [
      ["warn", 0],
      ["error", 10],
      ["warn", 21],
    ],
  );
});

test("matchedKeywords returns distinct keywords only", () => {
  const recognizer = new KeywordRecognizer(["a", "b"]);
  assert.deepEqual(recognizer.matchedKeywords("a b a b"), ["a", "b"]);
});

test("longest keyword wins on overlap", () => {
  const recognizer = new KeywordRecognizer(["log", "log level"]);
  const matches = recognizer.find("check the log level now");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.keyword, "log level");
});

test("keywords containing regex metacharacters are treated literally", () => {
  const recognizer = new KeywordRecognizer(["c++", "a.b"]);
  assert.equal(recognizer.test("i like c++ a lot"), true);
  assert.equal(recognizer.test("i like c# a lot"), false);
  assert.deepEqual(
    recognizer.matchedKeywords("a.b is not axb"),
    ["a.b"],
  );
});

test("empty input, no keywords and blank keywords are handled", () => {
  assert.deepEqual(new KeywordRecognizer(["error"]).find(""), []);
  assert.deepEqual(new KeywordRecognizer([]).find("error"), []);
  assert.deepEqual(new KeywordRecognizer(["  ", ""]).keywords, []);
});

test("duplicate keywords are de-duplicated", () => {
  assert.deepEqual(new KeywordRecognizer(["a", "a", " b "]).keywords, ["a", "b"]);
});

test("highlight wraps every match", () => {
  const recognizer = new KeywordRecognizer(["error", "warn"]);
  assert.equal(
    recognizer.highlight("warn: error"),
    "[warn]: [error]",
  );
  assert.equal(recognizer.highlight("all good"), "all good");
});

test("test returns false for text without keywords", () => {
  const recognizer = new KeywordRecognizer(["fatal"]);
  assert.equal(recognizer.test("everything is fine"), false);
});
