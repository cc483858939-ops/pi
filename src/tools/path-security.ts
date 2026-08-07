import fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../utils/errors.ts";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertInside(root: string, candidate: string, code: string): void {
  if (!isInside(root, candidate)) {
    throw new ToolError(code, "Resolved path is outside the project root.");
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function resolveProjectPath(
  rootDir: string,
  requestedPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  if (requestedPath.length === 0) {
    throw new ToolError("INVALID_ARGUMENTS", "Path must not be empty.");
  }
  if (requestedPath.includes("\0")) {
    throw new ToolError("INVALID_ARGUMENTS", "Path must not contain a NUL character.");
  }
  if (path.isAbsolute(requestedPath)) {
    throw new ToolError("PATH_OUTSIDE_ROOT", "Absolute paths are not allowed.");
  }

  const root = await fs.realpath(rootDir);
  const lexicalTarget = path.resolve(root, requestedPath);
  assertInside(root, lexicalTarget, "PATH_OUTSIDE_ROOT");

  if (await exists(lexicalTarget)) {
    const realTarget = await fs.realpath(lexicalTarget);
    assertInside(root, realTarget, "SYMLINK_OUTSIDE_ROOT");
    return realTarget;
  }

  if (!options.allowMissing) {
    throw new ToolError("FILE_NOT_FOUND", `File does not exist: ${requestedPath}`);
  }

  const missingParts: string[] = [];
  let ancestor = lexicalTarget;
  while (!(await exists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new ToolError("PATH_OUTSIDE_ROOT", "Could not find a safe existing parent directory.");
    }
    missingParts.unshift(path.basename(ancestor));
    ancestor = parent;
  }

  const realAncestor = await fs.realpath(ancestor);
  assertInside(root, realAncestor, "SYMLINK_OUTSIDE_ROOT");
  const resolved = path.join(realAncestor, ...missingParts);
  assertInside(root, resolved, "PATH_OUTSIDE_ROOT");
  return resolved;
}

export async function projectRelativePath(rootDir: string, absolutePath: string): Promise<string> {
  const root = await fs.realpath(rootDir);
  const relative = path.relative(root, absolutePath);
  assertInside(root, absolutePath, "PATH_OUTSIDE_ROOT");
  return relative.split(path.sep).join("/") || ".";
}
