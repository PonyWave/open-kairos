import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import type { AgentEnvironmentRuntime } from '../sessions/environment-runtime.js';
import type { RunRecord } from '../sessions/records.js';

const skillInputSchema = z
  .object({
    name: z.string().min(1).max(64),
  })
  .strict();

export function createSkillTool(
  runtime: AgentEnvironmentRuntime,
  run: RunRecord,
): AgentTool<z.infer<typeof skillInputSchema>> {
  return {
    name: 'skill',
    description:
      'Load the full instructions of a Skill listed in the workspace-skills catalog. Returns the SKILL.md body and the Skill path; read referenced supporting files with the read tool using env_id main.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'The Skill name from the workspace-skills catalog.',
        },
      },
    },
    concurrent: true,
    validate: (value) => skillInputSchema.parse(value),
    execute: async (input) => runtime.loadSkill(run, input.name),
  };
}
