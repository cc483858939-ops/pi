export interface SkillMetadata {
  name: string;
  path: string;
  description: string;
}

export interface LoadedSkill extends SkillMetadata {
  content: string;
}
