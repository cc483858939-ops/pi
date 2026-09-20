export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  rootDir: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface LoadedSkill extends SkillMetadata {
  content: string;
}
