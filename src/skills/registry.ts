import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isValidSkillName, parseSkillDocument, type ParsedSkillDocument, validateSkillName } from "./parser.ts";
import { ToolError } from "../utils/errors.ts";
import type { LoadedSkill, SkillMetadata } from "./types.ts";

export const MAX_SKILL_BYTES = 64 * 1024;

interface SkillFileStat {
  filePath: string;
  rootDir: string;
  size: number;
}

interface LoadedSkillFile {
  filePath: string;
  rootDir: string;
  document: ParsedSkillDocument;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function invalidName(name: string): ToolError {
  return new ToolError("INVALID_SKILL_NAME", `Invalid skill name: ${name}`);
}

function metadataFromDocument(document: ParsedSkillDocument, filePath: string, rootDir: string): SkillMetadata {
  return {
    name: document.name,
    description: document.description,
    path: filePath,
    rootDir,
    ...(document.license === undefined ? {} : { license: document.license }),
    ...(document.compatibility === undefined ? {} : { compatibility: document.compatibility }),
    ...(document.metadata === undefined ? {} : { metadata: { ...document.metadata } }),
    ...(document.allowedTools === undefined ? {} : { allowedTools: document.allowedTools }),
  };
}

function closingFrontmatterOffset(buffer: Buffer, atEnd: boolean): number | undefined {
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a || buffer[index + 1] !== 0x2d || buffer[index + 2] !== 0x2d || buffer[index + 3] !== 0x2d) {
      continue;
    }

    let end = index + 4;
    while (end < buffer.length && (buffer[end] === 0x20 || buffer[end] === 0x09)) {
      end += 1;
    }
    if (end === buffer.length) {
      return atEnd ? end : undefined;
    }
    if (buffer[end] === 0x0a) {
      return end + 1;
    }
    if (buffer[end] === 0x0d && end + 1 < buffer.length && buffer[end + 1] === 0x0a) {
      return end + 2;
    }
  }
  return undefined;
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
    return metadata.map((skill) => ({
      ...skill,
      ...(skill.metadata === undefined ? {} : { metadata: { ...skill.metadata } }),
    }));
  }

  async load(name: string): Promise<LoadedSkill> {
    if (!isValidSkillName(name)) {
      throw invalidName(name);
    }

    const metadata = (await this.list()).find((skill) => skill.name === name);
    if (metadata === undefined) {
      throw new ToolError("SKILL_NOT_FOUND", `Skill not found: ${name}`);
    }

    const skillFile = await this.readSkillContent(name);
    const currentMetadata = metadataFromDocument(skillFile.document, skillFile.filePath, skillFile.rootDir);
    return {
      ...currentMetadata,
      content: skillFile.document.content,
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
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        validateSkillName(entry.name);
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

    return { filePath, rootDir: skillDir, size: file.size };
  }

  private async inspectSkillMetadata(name: string): Promise<SkillMetadata> {
    const skillFile = await this.inspectSkillFile(name);
    if (skillFile.size > MAX_SKILL_BYTES) {
      throw new ToolError("SKILL_TOO_LARGE", `Skill exceeds the ${MAX_SKILL_BYTES}-byte limit: ${name}`);
    }

    const document = await this.readSkillFrontmatter(name, skillFile);
    return metadataFromDocument(document, skillFile.filePath, skillFile.rootDir);
  }

  private async readSkillFrontmatter(name: string, skillFile: SkillFileStat): Promise<ParsedSkillDocument> {
    const handle = await fs.open(skillFile.filePath, "r");
    try {
      let position = 0;
      let buffer = Buffer.alloc(0);
      while (position < skillFile.size) {
        const readLength = Math.min(4096, skillFile.size - position);
        const chunk = Buffer.alloc(readLength);
        const { bytesRead } = await handle.read(chunk, 0, readLength, position);
        if (bytesRead === 0) {
          break;
        }
        position += bytesRead;
        buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
        const end = closingFrontmatterOffset(buffer, position >= skillFile.size);
        if (end !== undefined) {
          const frontmatter = buffer.subarray(0, end);
          if (frontmatter.includes(0)) {
            throw new ToolError("INVALID_SKILL_CONTENT", `Skill contains binary content: ${name}`);
          }
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(frontmatter);
          } catch {
            throw new ToolError("INVALID_SKILL_CONTENT", `Skill is not valid UTF-8: ${name}`);
          }
          return parseSkillDocument(text, name);
        }
      }

      if (buffer.includes(0)) {
        throw new ToolError("INVALID_SKILL_CONTENT", `Skill contains binary content: ${name}`);
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new ToolError("INVALID_SKILL_CONTENT", `Skill is not valid UTF-8: ${name}`);
      }
      return parseSkillDocument(text, name);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError("SKILL_LOAD_FAILED", `Could not inspect Skill metadata: ${name}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async readSkillContent(name: string): Promise<LoadedSkillFile> {
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

    return {
      filePath: skillFile.filePath,
      rootDir: skillFile.rootDir,
      document: parseSkillDocument(content, name),
    };
  }
}
