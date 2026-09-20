import { parseDocument } from "yaml";
import { ToolError } from "../utils/errors.ts";

export interface ParsedSkillDocument {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  content: string;
}

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_PATTERN.test(name);
}

function invalidMetadata(skillName: string | undefined, reason: string): ToolError {
  const suffix = skillName === undefined ? "" : ` for '${skillName}'`;
  return new ToolError("INVALID_SKILL_METADATA", `Invalid Skill metadata${suffix}: ${reason}`);
}

function frontmatterYaml(content: string, skillName?: string): string {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (match === null) {
    throw invalidMetadata(skillName, "SKILL.md must begin with YAML frontmatter.");
  }
  return match[1] ?? "";
}

function requireString(value: unknown, field: string, skillName?: string): string {
  if (typeof value !== "string") {
    throw invalidMetadata(skillName, `${field} must be a string.`);
  }
  return value;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

export function validateSkillName(name: string, expectedDirectoryName?: string): void {
  if (!isValidSkillName(name)) {
    throw invalidMetadata(expectedDirectoryName ?? name, "name must be 1-64 lowercase ASCII characters, numbers, or hyphens without leading, trailing, or consecutive hyphens.");
  }
  if (expectedDirectoryName !== undefined && name !== expectedDirectoryName) {
    throw invalidMetadata(expectedDirectoryName, "name must match the Skill directory name.");
  }
}

function stringMap(value: unknown, field: string, skillName?: string): Record<string, string> {
  if (!(value instanceof Map)) {
    throw invalidMetadata(skillName, `${field} must be a YAML mapping of strings.`);
  }

  const result: Record<string, string> = {};
  for (const [key, item] of value.entries()) {
    if (typeof key !== "string" || typeof item !== "string") {
      throw invalidMetadata(skillName, `${field} must contain only string keys and values.`);
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return result;
}

export function parseSkillDocument(content: string, expectedDirectoryName?: string): ParsedSkillDocument {
  const yamlText = frontmatterYaml(content, expectedDirectoryName);
  let parsed: unknown;
  try {
    const document = parseDocument(yamlText, { prettyErrors: false });
    if (document.errors.length > 0) {
      throw invalidMetadata(expectedDirectoryName, "frontmatter YAML is malformed.");
    }
    parsed = document.toJS({ mapAsMap: true }) as unknown;
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw invalidMetadata(expectedDirectoryName, "frontmatter YAML is malformed.");
  }

  if (!(parsed instanceof Map)) {
    throw invalidMetadata(expectedDirectoryName, "frontmatter must be a YAML mapping.");
  }

  const name = requireString(parsed.get("name"), "name", expectedDirectoryName);
  validateSkillName(name, expectedDirectoryName);
  const description = requireString(parsed.get("description"), "description", expectedDirectoryName);
  if (description.trim().length === 0) {
    throw invalidMetadata(expectedDirectoryName, "description must not be empty.");
  }
  if (characterCount(description) > 1024) {
    throw invalidMetadata(expectedDirectoryName, "description must not exceed 1024 characters.");
  }

  const licenseValue = parsed.get("license");
  const compatibilityValue = parsed.get("compatibility");
  const metadataValue = parsed.get("metadata");
  const allowedToolsValue = parsed.get("allowed-tools");
  const license = licenseValue === undefined ? undefined : requireString(licenseValue, "license", expectedDirectoryName);
  const compatibility = compatibilityValue === undefined
    ? undefined
    : requireString(compatibilityValue, "compatibility", expectedDirectoryName);
  if (compatibility !== undefined && (compatibility.trim().length === 0 || characterCount(compatibility) > 500)) {
    throw invalidMetadata(expectedDirectoryName, "compatibility must be non-empty and no more than 500 characters.");
  }
  const metadata = metadataValue === undefined ? undefined : stringMap(metadataValue, "metadata", expectedDirectoryName);
  const allowedTools = allowedToolsValue === undefined
    ? undefined
    : requireString(allowedToolsValue, "allowed-tools", expectedDirectoryName);

  return {
    name,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    content,
  };
}
