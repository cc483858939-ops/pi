import { KeywordRecognizer } from "./src/keyword.ts";

function show(label, fn) {
  console.log(label, JSON.stringify(fn()));
}

// BUG: exact-case registered keyword should win over case-insensitive alias.
show("exact match preferred? ", () => {
  const r = new KeywordRecognizer(["Error", "error"]);
  return r.find("error");
});

show("order dependence", () => {
  const a = new KeywordRecognizer(["Error", "error"]).find("error")[0].keyword;
  const b = new KeywordRecognizer(["error", "Error"]).find("error")[0].keyword;
  return { a, b, equal: a === b };
});
