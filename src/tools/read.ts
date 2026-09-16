import fs from "node:fs/promises";
import { TextDecoder } from "node:util";
import { ToolError } from "../utils/errors.ts";
import { truncateUtf8Prefix } from "../utils/truncate.ts";
import { resolveProjectPath, projectRelativePath } from "./path-security.ts";
import { assertObject, assertOnlyKeys, defineTool, requireString } from "./types.ts";

export interface ReadArgs {
  path: string;
}

export interface ReadResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export const readTool = defineTool<ReadArgs, ReadResult>({
  name: "read",
  description: "Read a bounded UTF-8 text file from the project.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative file path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  parseArgs(input) {
    const value = assertObject(input);
    assertOnlyKeys(value, ["path"]);
    return { path: requireString(value, "path", { nonEmpty: true }) };
  },
  async execute(args, context) {
    const target = await resolveProjectPath(context.rootDir, args.path);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(target);
    } catch (error) {
      throw new ToolError(
        "FILE_READ_FAILED",
        `Could not inspect file: ${args.path}`,
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }
    if (!stat.isFile()) {
      throw new ToolError("FILE_READ_FAILED", `Path is not a regular file: ${args.path}`);
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error) {
      throw new ToolError(
        "FILE_READ_FAILED",
        `Could not read file: ${args.path}`,
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }

    // NUL bytes are a conservative, deterministic signal for the text-only
    // file interface.  Validate the complete file before applying the output
    // bound so truncated output never hides invalid UTF-8.
    if (buffer.includes(0)) {
      throw new ToolError("FILE_READ_FAILED", `File appears to be binary: ${args.path}`);
    }

    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ToolError("FILE_READ_FAILED", `File is not valid UTF-8: ${args.path}`);
    }

    const bounded = truncateUtf8Prefix(buffer, context.maxOutputBytes);
    return {
      path: await projectRelativePath(context.rootDir, target),
      content: bounded.text,
      bytes: buffer.length,
      truncated: bounded.truncated,
    };
  },
});
