import type { AgentEvent, AgentOptions, AgentRunOptions, AgentRunResult } from "./types.ts";
import { runAgentLoop, AgentRuntimeError, streamAgentLoop, type AgentLoopOptions } from "./loop.ts";

export class Agent {
  private readonly options: AgentOptions;

  constructor(options: AgentOptions) {
    if (!options.client) {
      throw new AgentRuntimeError("INVALID_AGENT_OPTIONS", "A chat client is required.");
    }
    if (options.model.trim().length === 0) {
      throw new AgentRuntimeError("INVALID_AGENT_OPTIONS", "A model name is required.");
    }
    if (!Number.isInteger(options.maxRounds) || options.maxRounds <= 0) {
      throw new AgentRuntimeError("INVALID_MAX_ROUNDS", "maxRounds must be a positive integer.");
    }
    const names = new Set<string>();
    for (const tool of options.tools) {
      if (names.has(tool.name)) {
        throw new AgentRuntimeError("DUPLICATE_TOOL", `Duplicate tool name: ${tool.name}`);
      }
      names.add(tool.name);
    }
    this.options = {
      ...options,
      tools: [...options.tools],
    };
  }

  run(userInput: string, runOptions: AgentRunOptions = {}): Promise<AgentRunResult> {
    return runAgentLoop(this.loopOptions(userInput, runOptions));
  }

  stream(
    userInput: string,
    runOptions: AgentRunOptions = {},
  ): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    return streamAgentLoop(this.loopOptions(userInput, runOptions));
  }

  private loopOptions(userInput: string, runOptions: AgentRunOptions): AgentLoopOptions {
    if (typeof userInput !== "string") {
      throw new AgentRuntimeError("INVALID_ARGUMENTS", "Agent input must be a string.");
    }
    return {
      ...this.options,
      userInput,
      ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
    };
  }
}

export type {
  AgentEvent,
  AgentOptions,
  AgentRunOptions,
  AgentRunResult,
  AgentToolCall,
} from "./types.ts";
export { AgentRuntimeError, DEFAULT_SYSTEM_PROMPT, runAgentLoop, streamAgentLoop } from "./loop.ts";
