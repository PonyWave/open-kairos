import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SKILL_DESCRIPTION_MAX_LENGTH = 240;

const skillPathPattern = /^\.agents\/skills\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/SKILL\.md$/;

const frontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export interface SkillDocument {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export function skillNameFromPath(resourcePath: string): string | undefined {
  return skillPathPattern.exec(resourcePath)?.[1];
}

export function parseSkillDocument(resourcePath: string, content: string): SkillDocument {
  const directoryName = skillNameFromPath(resourcePath);
  if (directoryName === undefined) {
    throw new Error(`Invalid Skill resource path: ${resourcePath}.`);
  }
  const sections = splitFrontmatter(content);
  if (sections === undefined) {
    return Object.freeze({
      name: directoryName,
      description: normalizeDescription(firstBodyLine(content)),
      body: content,
    });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(sections.data);
  } catch (error) {
    throw new Error(`Workspace Skill frontmatter is not valid YAML: ${resourcePath}.`, {
      cause: error,
    });
  }
  const result = frontmatterSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new Error(`Workspace Skill frontmatter is invalid: ${resourcePath}.`, {
      cause: result.error,
    });
  }
  const name = result.data.name ?? directoryName;
  if (name !== directoryName) {
    throw new Error(
      `Workspace Skill name ${name} does not match its directory ${directoryName}: ${resourcePath}.`,
    );
  }
  return Object.freeze({
    name,
    description: normalizeDescription(result.data.description ?? firstBodyLine(sections.body)),
    body: sections.body,
  });
}

function splitFrontmatter(content: string): { data: string; body: string } | undefined {
  const openingBreak = content.indexOf('\n');
  if (openingBreak === -1 || content.slice(0, openingBreak).trimEnd() !== '---') return undefined;
  let offset = openingBreak + 1;
  while (offset <= content.length) {
    const nextBreak = content.indexOf('\n', offset);
    const lineEnd = nextBreak === -1 ? content.length : nextBreak;
    if (content.slice(offset, lineEnd).trimEnd() === '---') {
      return {
        data: content.slice(openingBreak + 1, offset),
        body: nextBreak === -1 ? '' : content.slice(nextBreak + 1),
      };
    }
    if (nextBreak === -1) return undefined;
    offset = nextBreak + 1;
  }
  return undefined;
}

function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function normalizeDescription(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > SKILL_DESCRIPTION_MAX_LENGTH
    ? collapsed.slice(0, SKILL_DESCRIPTION_MAX_LENGTH)
    : collapsed;
}
