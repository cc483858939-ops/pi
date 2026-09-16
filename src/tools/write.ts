import fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../utils/errors.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { projectRelativePath, resolveProjectPath } from "./path-security.ts";
import { assertObject, assertOnlyKeys, defineTool, requireString } from "./types.ts";

export interface WriteArgs {
  path: string;
  content: string;
}

export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

export const writeTool = defineTool<WriteArgs, WriteResult>({
  name: "write",
  description: "Atomically create or replace a UTF-8 text file in the project.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative file path." },
      content: { type: "string", description: "UTF-8 text to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  parseArgs(input) {
    const value = assertObject(input);
    assertOnlyKeys(value, ["path", "content"]);
    return {
      path: requireString(value, "path", { nonEmpty: true }),
      content: requireString(value, "content"),
    };
  },
  async execute(args, context) {
    // Resolve before creating directories.  For missing targets this validates
    // the nearest existing ancestor, including symlink escapes.
    let target = await resolveProjectPath(context.rootDir, args.path, { allowMissing: true });
    let created = false;
    try {
      await fs.stat(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        created = true;
      } else {
        throw new ToolError(
          "FILE_WRITE_FAILED",
          `Could not inspect target: ${args.path}`,
          error instanceof Error ? { cause: error.message } : undefined,
        );
      }
    }

    try {
      const root = await fs.realpath(context.rootDir);
      const relativeDirectory = path.relative(root, path.dirname(target));
      const directoryParts = relativeDirectory === "" ? [] : relativeDirectory.split(path.sep);
      let currentDirectory = root;
      for (const part of directoryParts) {
        currentDirectory = path.join(currentDirectory, part);
        try {
          await fs.mkdir(currentDirectory);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
            throw error;
          }
        }
        // Check each segment before creating the next one, so recursive mkdir
        // never traverses an unchecked symlink outside the project.
        const relativeDirectoryPart = path.relative(root, currentDirectory).split(path.sep).join("/");
        await resolveProjectPath(context.rootDir, relativeDirectoryPart);
      }

      // Re-resolve after directory creation so a race that introduces a
      // symlink cannot turn the write into an outside-root operation.
      target = await resolveProjectPath(context.rootDir, args.path, { allowMissing: true });
      const targetStat = await fs.stat(target).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (targetStat && !targetStat.isFile()) {
        throw new ToolError("FILE_WRITE_FAILED", `Path is not a regular file: ${args.path}`);
      }
      await atomicWriteFile(target, args.content, targetStat?.mode === undefined ? undefined : targetStat.mode & 0o777);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "FILE_WRITE_FAILED",
        `Could not write file: ${args.path}`,
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }

    return {
      path: await projectRelativePath(context.rootDir, target),
      bytes: Buffer.byteLength(args.content, "utf8"),
      created,
    };
  },
});
