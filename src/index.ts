import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent } from "./agent/agent.ts";
import { loadConfig } from "./config.ts";
import { createChatClient } from "./llm/client.ts";
import { defaultTools } from "./tools/index.ts";

function formatProgressEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "round_start":
      return `[round ${event.round}]`;
    case "tool_start":
      return `[tool:start] ${event.toolName}`;
    case "tool_result":
      return event.result.ok
        ? `[tool:done] ${event.toolName} ok`
        : `[tool:done] ${event.toolName} failed: ${event.result.error.code}`;
    case "error":
      return `[agent:error]${event.code === undefined ? "" : ` ${event.code}:`} ${event.message}`;
    case "assistant":
    case "final":
      return null;
  }
}

function printProgress(event: AgentEvent): void {
  const line = formatProgressEvent(event);
  if (line !== null) {
    console.error(line);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let fatalEventPrinted = false;
  try {
    const config = loadConfig();
    const client = createChatClient({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
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
    const stream = agent.stream(question);
    while (true) {
      const next = await stream.next();
      if (next.done) {
        if (next.value.content !== null) {
          console.log(next.value.content);
        }
        break;
      }
      if (next.value.type === "error") {
        fatalEventPrinted = true;
      }
      printProgress(next.value);
    }
  } catch (error: unknown) {
    if (!fatalEventPrinted) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
