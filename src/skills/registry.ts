import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { ToolError } from "../utils/errors.ts";
import type { LoadedSkill, SkillMetadata } from "./types.ts";

export const MAX_SKILL_BYTES = 64 * 1024;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_LIMIT = 200;

interface SkillFile {
  filePath: string;
  content: string;
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

    const skillFile = await this.readSkillFile(name);
    return {
      name,
      path: skillFile.filePath,
      description: descriptionFromContent(name, skillFile.content),
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
        const skillFile = await this.readSkillFile(entry.name);
        discovered.push({
          name: entry.name,
          path: skillFile.filePath,
          description: descriptionFromContent(entry.name, skillFile.content),
        });
      } catch {
        // Discovery is tolerant: invalid or incomplete skill directories are ignored.
      }
    }

    discovered.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return discovered;
  }

  private async readSkillFile(name: string): Promise<SkillFile> {
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
    if (file.size > MAX_SKILL_BYTES) {
      throw new ToolError("SKILL_TOO_LARGE", `Skill exceeds the ${MAX_SKILL_BYTES}-byte limit: ${name}`);
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(filePath);
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

    return { filePath, content };
  }
}
