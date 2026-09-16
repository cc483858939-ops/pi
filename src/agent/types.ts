import type { ChatClient } from "../llm/client.ts";
import type { RegisteredTool, ToolContext, ToolExecutionResult } from "../tools/types.ts";

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

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AgentEvent =
  | {
      type: "round_start";
      round: number;
    }
  | {
      type: "assistant";
      round: number;
      content: string | null;
      toolCalls: AgentToolCall[];
    }
  | {
      type: "tool_start";
      round: number;
      callId: string;
      toolName: string;
      arguments: string;
    }
  | {
      type: "tool_result";
      round: number;
      callId: string;
      toolName: string;
      result: ToolExecutionResult<unknown>;
    }
  | {
      type: "final";
      result: AgentRunResult;
    }
  | {
      type: "error";
      message: string;
      code?: string;
      round?: number;
    };
