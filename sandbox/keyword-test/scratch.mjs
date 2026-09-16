import { KeywordRecognizer } from "./src/keyword.ts";

const r = new KeywordRecognizer(["Error", "error"]);
console.log("find('error') ->", JSON.stringify(r.find("error")));
console.log("find('ERROR') ->", JSON.stringify(r.find("ERROR")));
console.log("find('Error') ->", JSON.stringify(r.find("Error")));

const a = new KeywordRecognizer(["Error", "error"]).find("error")[0].keyword;
const b = new KeywordRecognizer(["error", "Error"]).find("error")[0].keyword;
console.log("order dependence:", { a, b, equal: a === b });
