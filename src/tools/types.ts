import { ToolError, errorMessage } from "../utils/errors.ts";

export interface ToolContext {
  rootDir: string;
  signal?: AbortSignal;
  bashTimeoutMs: number;
  maxOutputBytes: number;
}

export interface ToolDefinition<TArgs, TResult> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parseArgs(input: unknown): TArgs;
  execute(args: TArgs, context: ToolContext): Promise<TResult>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parseArgs(input: unknown): unknown;
  execute(args: unknown, context: ToolContext): Promise<unknown>;
}

export type ToolExecutionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; details?: unknown };
    };

export function defineTool<TArgs, TResult>(
  definition: ToolDefinition<TArgs, TResult>,
): RegisteredTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    parseArgs: definition.parseArgs,
    execute: (args, context) => definition.execute(args as TArgs, context),
  };
}

export async function executeTool(
  tool: RegisteredTool,
  input: unknown,
  context: ToolContext,
): Promise<ToolExecutionResult<unknown>> {
  try {
    const args = tool.parseArgs(input);
    const data = await tool.execute(args, context);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ToolError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
    }
    return {
      ok: false,
      error: { code: "TOOL_EXECUTION_FAILED", message: errorMessage(error) },
    };
  }
}

export function assertObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolError("INVALID_ARGUMENTS", "Tool arguments must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

export function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new ToolError("INVALID_ARGUMENTS", "Unexpected tool arguments.", {
      unexpected: extras,
    });
  }
}

export function requireString(
  value: Record<string, unknown>,
  key: string,
  options: { nonEmpty?: boolean } = {},
): string {
  const item = value[key];
  if (typeof item !== "string") {
    throw new ToolError("INVALID_ARGUMENTS", `Argument '${key}' must be a string.`);
  }
  if (options.nonEmpty && item.trim().length === 0) {
    throw new ToolError("INVALID_ARGUMENTS", `Argument '${key}' must not be empty.`);
  }
  return item;
}
