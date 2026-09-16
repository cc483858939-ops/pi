import type {
  ChatClient,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "../llm/client.ts";
import { executeTool, type RegisteredTool, type ToolContext, type ToolExecutionResult } from "../tools/types.ts";
import type { AgentEvent, AgentRunResult, AgentToolCall } from "./types.ts";


export const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent working in a local project.\n\nUse tools when you need information or need to modify the project.\nDo not guess file contents.\nInspect relevant files before editing them.\nAfter making changes, run appropriate validation commands when useful.";

export class AgentRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
  }
}

export interface AgentLoopOptions {
  client: ChatClient;
  model: string;
  tools: RegisteredTool[];
  toolContext: ToolContext;
  maxRounds: number;
  userInput: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}

function modelTools(tools: RegisteredTool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  })) as ChatCompletionTool[];
}

function validateTools(tools: RegisteredTool[]): Map<string, RegisteredTool> {
  const byName = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new AgentRuntimeError("DUPLICATE_TOOL", `Duplicate tool name: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }
  return byName;
}

function toolFailure(code: string, message: string, details?: unknown): ToolExecutionResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function serializeToolResult(result: ToolExecutionResult<unknown>): string {
  try {
    if (result.ok && result.data === undefined) {
      return JSON.stringify({ ok: true, data: null });
    }
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify(
      toolFailure(
        "TOOL_RESULT_SERIALIZATION_FAILED",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AgentRuntimeError("AGENT_ABORTED", "Agent run was aborted.");
  }
}

function responseContent(message: ChatCompletionMessage): string | null {
  if (message.content === null || message.content === undefined) return null;
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toolMessage(callId: string, result: ToolExecutionResult<unknown>): ChatCompletionMessageParam {
  return {
    role: "tool",
    tool_call_id: callId,
    content: serializeToolResult(result),
  };
}

interface ExecutedToolCall {
  message: ChatCompletionMessageParam;
  result: ToolExecutionResult<unknown>;
  toolName: string;
}

function normalizeToolCall(call: ChatCompletionMessageToolCall): AgentToolCall {
  if (call.type === "function") {
    return {
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    };
  }
  return {
    id: call.id,
    name: call.custom.name,
    arguments: call.custom.input,
  };
}

async function executeCall(
  call: ChatCompletionMessageToolCall,
  tools: Map<string, RegisteredTool>,
  context: ToolContext,
): Promise<ExecutedToolCall> {
  const normalized = normalizeToolCall(call);
  let result: ToolExecutionResult<unknown>;

  if (call.type !== "function") {
    result = toolFailure("TOOL_NOT_FOUND", `Unsupported tool call type: ${call.type}`);
  } else {
    const tool = tools.get(call.function.name);
    if (!tool) {
      result = toolFailure("TOOL_NOT_FOUND", `Tool is not registered: ${call.function.name}`, {
        name: call.function.name,
      });
    } else {
      try {
        const input = JSON.parse(call.function.arguments) as unknown;
        result = await executeTool(tool, input, context);
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        result = toolFailure(
          "INVALID_ARGUMENTS",
          `Malformed JSON arguments for tool '${call.function.name}'.`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    }
  }

  return {
    message: toolMessage(call.id, result),
    result,
    toolName: normalized.name,
  };
}

export async function* streamAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent, AgentRunResult, void> {
  let currentRound: number | undefined;
  try {
    if (!Number.isInteger(options.maxRounds) || options.maxRounds <= 0) {
      throw new AgentRuntimeError("INVALID_MAX_ROUNDS", "maxRounds must be a positive integer.");
    }

    const tools = validateTools(options.tools);
    const availableTools = modelTools(options.tools);
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      },
      { role: "user", content: options.userInput },
    ];
    const context: ToolContext =
      options.signal === undefined
        ? options.toolContext
        : { ...options.toolContext, signal: options.signal };

    for (let round = 1; round <= options.maxRounds; round += 1) {
      assertNotAborted(options.signal);
      currentRound = round;
      yield { type: "round_start", round };

      assertNotAborted(options.signal);
      const response = await options.client.complete({
        model: options.model,
        messages,
        tools: availableTools,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      assertNotAborted(options.signal);
      const assistant: ChatCompletionMessage = response.message;
      messages.push(assistant);

      const calls = assistant.tool_calls ?? [];
      const toolCalls = calls.map(normalizeToolCall);
      yield {
        type: "assistant",
        round,
        content: responseContent(assistant),
        toolCalls,
      };
      assertNotAborted(options.signal);

      if (calls.length === 0) {
        const result = { content: responseContent(assistant), rounds: round };
        yield { type: "final", result };
        return result;
      }

      for (const call of calls) {
        const normalized = normalizeToolCall(call);
        assertNotAborted(options.signal);
        yield {
          type: "tool_start",
          round,
          callId: normalized.id,
          toolName: normalized.name,
          arguments: normalized.arguments,
        };
        assertNotAborted(options.signal);
        const executed = await executeCall(call, tools, context);
        messages.push(executed.message);
        yield {
          type: "tool_result",
          round,
          callId: normalized.id,
          toolName: executed.toolName,
          result: executed.result,
        };
      }
      assertNotAborted(options.signal);
    }

    throw new AgentRuntimeError(
      "AGENT_MAX_ROUNDS",
      `Agent reached the maximum of ${options.maxRounds} model rounds without a final answer.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof AgentRuntimeError
        ? error.code
        : options.signal?.aborted
          ? "AGENT_ABORTED"
          : undefined;
    yield {
      type: "error",
      message,
      ...(code === undefined ? {} : { code }),
      ...(currentRound === undefined ? {} : { round: currentRound }),
    };
    throw error;
  }
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const stream = streamAgentLoop(options);
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return next.value;
    }
  }
}
