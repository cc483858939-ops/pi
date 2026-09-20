import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, DEFAULT_SYSTEM_PROMPT, type AgentEvent } from "./agent/agent.ts";
import { loadConfig } from "./config.ts";
import { createChatClient } from "./llm/client.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { buildSystemPrompt } from "./skills/prompt.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import { createLoadSkillTool } from "./tools/load-skill.ts";
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
  let primaryFailure = false;
  let mcpManager: McpManager | undefined;
  try {
    const config = loadConfig();
    const client = createChatClient({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    const skillRegistry = new SkillRegistry(path.join(process.cwd(), "skills"));
    const skills = await skillRegistry.list();
    const mcpServers = await loadMcpConfig(process.cwd());
    mcpManager = new McpManager(mcpServers);
    const mcp = await mcpManager.connect();
    for (const failure of mcp.failures) {
      console.error(`[mcp:failed] ${failure.server}: ${failure.message}`);
    }
    const agent = new Agent({
      client,
      model: config.model,
      tools: [...defaultTools, createLoadSkillTool(skillRegistry), ...mcp.tools],
      maxRounds: config.maxRounds,
      systemPrompt: buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, skills),
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
    primaryFailure = true;
    if (!fatalEventPrinted) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  } finally {
    if (mcpManager !== undefined) {
      try {
        await mcpManager.close();
      } catch (error: unknown) {
        if (!primaryFailure) {
          console.error(`[mcp:close] ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
    }
  }
}

const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
