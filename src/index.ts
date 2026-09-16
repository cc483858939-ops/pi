import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent/agent.ts";
import { loadConfig } from "./config.ts";
import { createChatClient } from "./llm/client.ts";
import { defaultTools } from "./tools/index.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig();
  const client = createChatClient({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  const agent = new Agent({
    client,
    model: config.model,
    tools: defaultTools,
    maxRounds: config.maxRounds,
    toolContext: {
      rootDir: process.cwd(),
      bashTimeoutMs: config.bashTimeoutMs,
      maxOutputBytes: config.maxToolOutputBytes,
    },
  });

  const question = argv.join(" ") || "读取 package.json，告诉我这个项目叫什么";
  const result = await agent.run(question);
  if (result.content !== null) {
    console.log(result.content);
  }
}

const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
