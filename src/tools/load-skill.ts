import { SkillRegistry } from "../skills/registry.ts";
import { assertObject, assertOnlyKeys, defineTool, requireString, type RegisteredTool } from "./types.ts";

export interface LoadSkillArgs {
  name: string;
}

export interface LoadSkillResult {
  name: string;
  description: string;
  content: string;
}

export function createLoadSkillTool(registry: SkillRegistry): RegisteredTool {
  return defineTool<LoadSkillArgs, LoadSkillResult>({
    name: "load_skill",
    description: "Load the instructions for one available skill by name. Use this when a listed skill is relevant to the current task.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    parseArgs(input) {
      const value = assertObject(input);
      assertOnlyKeys(value, ["name"]);
      return { name: requireString(value, "name", { nonEmpty: true }) };
    },
    async execute(args) {
      const skill = await registry.load(args.name);
      return {
        name: skill.name,
        description: skill.description,
        content: skill.content,
      };
    },
  });
}
