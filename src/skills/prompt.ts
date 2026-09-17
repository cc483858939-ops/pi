import type { SkillMetadata } from "./types.ts";

export function buildSystemPrompt(basePrompt: string, skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return basePrompt;
  }

  const catalog = skills
    .slice()
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  return `${basePrompt}\n\nAvailable skills:\n\n${catalog}\n\nIf a skill is relevant, call load_skill with its exact name before relying on its instructions. Do not load unrelated skills.`;
}
