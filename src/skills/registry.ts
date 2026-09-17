import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { ToolError } from "../utils/errors.ts";
import type { LoadedSkill, SkillMetadata } from "./types.ts";

export const MAX_SKILL_BYTES = 64 * 1024;
export const SKILL_METADATA_BYTES = 4096;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_LIMIT = 200;

interface SkillFile {
  filePath: string;
  content: string;
}

interface SkillFileStat {
  filePath: string;
  size: number;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function descriptionFromContent(name: string, content: string): string {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const description = line.startsWith("#") ? line.replace(/^#+\s*/, "").trim() : line;
    return (description || name).slice(0, DESCRIPTION_LIMIT);
  }
  return name;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function invalidName(name: string): ToolError {
  return new ToolError("INVALID_SKILL_NAME", `Invalid skill name: ${name}`);
}

export class SkillRegistry {
  private metadataPromise: Promise<SkillMetadata[]> | undefined;

  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async list(): Promise<SkillMetadata[]> {
    this.metadataPromise ??= this.discover();
    const metadata = await this.metadataPromise;
    return metadata.map((skill) => ({ ...skill }));
  }

  async load(name: string): Promise<LoadedSkill> {
    if (!SKILL_NAME.test(name)) {
      throw invalidName(name);
    }

    const metadata = (await this.list()).find((skill) => skill.name === name);
    if (metadata === undefined) {
      throw new ToolError("SKILL_NOT_FOUND", `Skill not found: ${name}`);
    }

    const skillFile = await this.readSkillContent(name);
    return {
      ...metadata,
      content: skillFile.content,
    };
  }

  private async discover(): Promise<SkillMetadata[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) {
        return [];
      }
      throw error;
    }

    const discovered: SkillMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) {
        continue;
      }

      try {
        discovered.push(await this.inspectSkillMetadata(entry.name));
      } catch {
        // Discovery is tolerant: invalid or incomplete skill directories are ignored.
      }
    }

    discovered.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return discovered;
  }

  private async inspectSkillFile(name: string): Promise<SkillFileStat> {
    const skillDir = path.join(this.rootDir, name);
    if (!isInside(this.rootDir, skillDir)) {
      throw invalidName(name);
    }

    let directory: import("node:fs").Stats;
    try {
      directory = await fs.lstat(skillDir);
    } catch (error) {
      if (isMissing(error)) {
        throw new ToolError("SKILL_NOT_FOUND", `Skill not found: ${name}`);
      }
      throw new ToolError("SKILL_LOAD_FAILED", `Could not inspect skill: ${name}`);
    }
    if (!directory.isDirectory()) {
      throw new ToolError("SKILL_NOT_FOUND", `Skill not found: ${name}`);
    }

    const filePath = path.join(skillDir, "SKILL.md");
    let file: import("node:fs").Stats;
    try {
      file = await fs.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) {
        throw new ToolError("SKILL_NOT_FOUND", `Skill not found: ${name}`);
      }
      throw new ToolError("SKILL_LOAD_FAILED", `Could not inspect skill: ${name}`);
    }
    if (!file.isFile()) {
      throw new ToolError("SKILL_NOT_FOUND", `Skill not found: ${name}`);
    }

    return { filePath, size: file.size };
  }

  private async inspectSkillMetadata(name: string): Promise<SkillMetadata> {
    const skillFile = await this.inspectSkillFile(name);
    if (skillFile.size > MAX_SKILL_BYTES) {
      throw new ToolError("SKILL_TOO_LARGE", `Skill exceeds the ${MAX_SKILL_BYTES}-byte limit: ${name}`);
    }

    return {
      name,
      path: skillFile.filePath,
      description: await this.readSkillDescription(name, skillFile),
    };
  }

  private async readSkillDescription(name: string, skillFile: SkillFileStat): Promise<string> {
    const handle = await fs.open(skillFile.filePath, "r");
    try {
      const readLength = Math.min(SKILL_METADATA_BYTES, skillFile.size);
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
      const metadata = buffer.subarray(0, bytesRead);
      if (metadata.includes(0)) {
        throw new ToolError("INVALID_SKILL_CONTENT", `Skill contains binary content: ${name}`);
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const decoded = decoder.decode(metadata, { stream: bytesRead < skillFile.size });
      const content = bytesRead < skillFile.size ? decoded : `${decoded}${decoder.decode()}`;
      return descriptionFromContent(name, content);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError("INVALID_SKILL_CONTENT", `Skill metadata is not valid UTF-8: ${name}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async readSkillContent(name: string): Promise<SkillFile> {
    const skillFile = await this.inspectSkillFile(name);
    if (skillFile.size > MAX_SKILL_BYTES) {
      throw new ToolError("SKILL_TOO_LARGE", `Skill exceeds the ${MAX_SKILL_BYTES}-byte limit: ${name}`);
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(skillFile.filePath);
    } catch {
      throw new ToolError("SKILL_LOAD_FAILED", `Could not read skill: ${name}`);
    }
    if (buffer.length > MAX_SKILL_BYTES) {
      throw new ToolError("SKILL_TOO_LARGE", `Skill exceeds the ${MAX_SKILL_BYTES}-byte limit: ${name}`);
    }
    if (buffer.includes(0)) {
      throw new ToolError("INVALID_SKILL_CONTENT", `Skill contains binary content: ${name}`);
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ToolError("INVALID_SKILL_CONTENT", `Skill is not valid UTF-8: ${name}`);
    }

    return { filePath: skillFile.filePath, content };
  }
}
