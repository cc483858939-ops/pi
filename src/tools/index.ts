import type { RegisteredTool } from "./types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

/** The standard tool set exposed to the Agent Runtime. */
export const defaultTools: RegisteredTool[] = [readTool, writeTool, editTool, bashTool];

export { bashTool, editTool, readTool, writeTool };
export type { RegisteredTool, ToolContext, ToolExecutionResult } from "./types.ts";
export { defineTool, executeTool } from "./types.ts";
