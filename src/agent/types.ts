import type { ChatClient } from "../llm/client.ts";
import type { RegisteredTool, ToolContext } from "../tools/types.ts";

export interface AgentOptions {
  client: ChatClient;
  model: string;
  tools: RegisteredTool[];
  toolContext: ToolContext;
  maxRounds: number;
  systemPrompt?: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
}

export interface AgentRunResult {
  content: string | null;
  rounds: number;
}
