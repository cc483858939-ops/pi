import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { defineTool, assertObject, assertOnlyKeys, requireString } from "./types.ts";
import { resolveProjectPath, projectRelativePath } from "./path-security.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { ToolError } from "../utils/errors.ts";

export interface EditArgs { path: string; oldText: string; newText: string }
export interface EditResult {
  path: string;
  replacements: 1;
  beforeBytes: number;
  afterBytes: number;
  startLine: number;
  endLine: number;
}

function countOccurrences(content: string, search: string): { count: number; firstIndex: number } {
  let count = 0;
  let firstIndex = -1;
  let index = 0;
  while (index <= content.length - search.length) {
    const found = content.indexOf(search, index);
    if (found === -1) break;
    if (firstIndex === -1) firstIndex = found;
    count += 1;
    index = found + search.length;
  }
  return { count, firstIndex };
}

export const editTool = defineTool<EditArgs, EditResult>({
  name: "edit",
  description: "Replace exactly one unique literal text occurrence in a UTF-8 project file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  parseArgs(input) {
    const value = assertObject(input);
    assertOnlyKeys(value, ["path", "oldText", "newText"]);
    const path = requireString(value, "path", { nonEmpty: true });
    const oldText = requireString(value, "oldText");
    const newText = requireString(value, "newText");
    if (oldText.length === 0) {
      throw new ToolError("INVALID_ARGUMENTS", "oldText must not be empty.");
    }
    if (oldText === newText) {
      throw new ToolError("INVALID_ARGUMENTS", "oldText and newText must be different.");
    }
    return { path, oldText, newText };
  },
  async execute(args, context) {
    const target = await resolveProjectPath(context.rootDir, args.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new ToolError("FILE_READ_FAILED", `Path is not a regular file: ${args.path}`);
    }
    const buffer = await fs.readFile(target);
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
      throw new ToolError("FILE_READ_FAILED", `File appears to be binary: ${args.path}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ToolError("FILE_READ_FAILED", `File is not valid UTF-8: ${args.path}`);
    }

    const match = countOccurrences(content, args.oldText);
    if (match.count === 0) {
      throw new ToolError("EDIT_TEXT_NOT_FOUND", "oldText was not found; the file was not modified.");
    }
    if (match.count > 1) {
      throw new ToolError(
        "EDIT_TEXT_NOT_UNIQUE",
        "oldText matched more than once. Provide longer, unique surrounding context.",
        { matches: match.count },
      );
    }

    const updated = `${content.slice(0, match.firstIndex)}${args.newText}${content.slice(match.firstIndex + args.oldText.length)}`;
    try {
      await atomicWriteFile(target, updated, stat.mode & 0o777);
    } catch (error) {
      throw new ToolError("FILE_WRITE_FAILED", `Could not edit file: ${args.path}`, error instanceof Error ? { cause: error.message } : undefined);
    }

    const startLine = content.slice(0, match.firstIndex).split("\n").length;
    const endLine = startLine + (args.oldText.match(/\n/g)?.length ?? 0);
    return {
      path: await projectRelativePath(context.rootDir, target),
      replacements: 1,
      beforeBytes: buffer.length,
      afterBytes: Buffer.byteLength(updated),
      startLine,
      endLine,
    };
  },
});
