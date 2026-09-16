import type {
  ChatClient,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "../llm/client.ts";
import { executeTool, type RegisteredTool, type ToolContext, type ToolExecutionResult } from "../tools/types.ts";
import type { AgentRunResult } from "./types.ts";


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

async function executeCall(
  call: ChatCompletionMessageToolCall,
  tools: Map<string, RegisteredTool>,
  context: ToolContext,
): Promise<ChatCompletionMessageParam> {
  if (call.type !== "function") {
    return toolMessage(
      call.id,
      toolFailure("TOOL_NOT_FOUND", `Unsupported tool call type: ${call.type}`),
    );
  }

  const tool = tools.get(call.function.name);
  if (!tool) {
    return toolMessage(
      call.id,
      toolFailure("TOOL_NOT_FOUND", `Tool is not registered: ${call.function.name}`, {
        name: call.function.name,
      }),
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(call.function.arguments);
  } catch (error) {
    return toolMessage(
      call.id,
      toolFailure(
        "INVALID_ARGUMENTS",
        `Malformed JSON arguments for tool '${call.function.name}'.`,
        { cause: error instanceof Error ? error.message : String(error) },
      ),
    );
  }

  const result = await executeTool(tool, input, context);
  return toolMessage(call.id, result);
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
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
    if (calls.length === 0) {
      return { content: responseContent(assistant), rounds: round };
    }

    for (const call of calls) {
      assertNotAborted(options.signal);
      messages.push(await executeCall(call, tools, context));
    }
    assertNotAborted(options.signal);
  }

  throw new AgentRuntimeError(
    "AGENT_MAX_ROUNDS",
    `Agent reached the maximum of ${options.maxRounds} model rounds without a final answer.`,
  );
}
