import fs from "node:fs/promises";
import path from "node:path";

/**
 * Replace a file by writing the new contents beside it and then renaming the
 * temporary file into place.  Path authorization deliberately lives in
 * resolveProjectPath(); this helper only deals with the write itself.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  mode?: number,
): Promise<void> {
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");

  let effectiveMode = mode;
  if (effectiveMode === undefined) {
    try {
      const existing = await fs.stat(targetPath);
      effectiveMode = existing.mode & 0o777;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  let temporaryPath: string | undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // O_EXCL prevents two concurrent writes from selecting the same temporary
    // path.  A short retry loop keeps the helper independent of third-party
    // temporary-file packages.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const candidate = path.join(directory, `.${baseName}.${suffix}.tmp`);
      try {
        handle = await fs.open(candidate, "wx", effectiveMode ?? 0o666);
        temporaryPath = candidate;
        break;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }

    if (!handle || !temporaryPath) {
      throw new Error("Could not create a temporary file for atomic write.");
    }

    await handle.writeFile(bytes);
    if (effectiveMode !== undefined) {
      await handle.chmod(effectiveMode & 0o777);
    }
    await handle.close();
    handle = undefined;

    await fs.rename(temporaryPath, targetPath);
    temporaryPath = undefined;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (temporaryPath) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
