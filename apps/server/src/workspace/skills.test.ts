import { describe, expect, it } from 'vitest';
import { parseSkillDocument, SKILL_DESCRIPTION_MAX_LENGTH, skillNameFromPath } from './skills.js';

describe('skillNameFromPath', () => {
  it('extracts the directory name from a Skill resource path', () => {
    expect(skillNameFromPath('.agents/skills/review-pr/SKILL.md')).toBe('review-pr');
    expect(skillNameFromPath('.agents/skills/a/SKILL.md')).toBe('a');
  });

  it('returns undefined for non-Skill paths', () => {
    expect(skillNameFromPath('AGENTS.md')).toBeUndefined();
    expect(skillNameFromPath('.agents/skills/review-pr/references/checklist.md')).toBeUndefined();
    expect(skillNameFromPath('.agents/skills/Bad Name/SKILL.md')).toBeUndefined();
    expect(skillNameFromPath('.agents/skills/review-pr/SKILL.md.bak')).toBeUndefined();
  });
});

describe('parseSkillDocument', () => {
  it('parses frontmatter name and description and strips it from the body', () => {
    const document = parseSkillDocument(
      '.agents/skills/review/SKILL.md',
      '---\nname: review\ndescription: Review code changes\ntype: prompt\n---\nReview the diff.\n',
    );
    expect(document).toEqual({
      name: 'review',
      description: 'Review code changes',
      body: 'Review the diff.\n',
    });
  });

  it('falls back to the directory name and first body line without frontmatter', () => {
    const document = parseSkillDocument(
      '.agents/skills/review/SKILL.md',
      '\n# Review skill\n\nMore detail.\n',
    );
    expect(document).toEqual({
      name: 'review',
      description: '# Review skill',
      body: '\n# Review skill\n\nMore detail.\n',
    });
  });

  it('falls back to the first body line when frontmatter has no description', () => {
    const document = parseSkillDocument(
      '.agents/skills/review/SKILL.md',
      '---\nname: review\n---\n\nSummarize changes.\n',
    );
    expect(document.description).toBe('Summarize changes.');
    expect(document.body).toBe('\nSummarize changes.\n');
  });

  it('collapses whitespace and truncates long descriptions', () => {
    const document = parseSkillDocument(
      '.agents/skills/review/SKILL.md',
      `---\ndescription: >\n  ${'a'.repeat(300)}\n---\nbody`,
    );
    expect(document.description).toBe('a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH));
  });

  it('returns an empty description when neither frontmatter nor body provide one', () => {
    const document = parseSkillDocument(
      '.agents/skills/review/SKILL.md',
      '---\nname: review\n---\n',
    );
    expect(document.description).toBe('');
    expect(document.body).toBe('');
  });

  it.each([
    {
      label: 'a name differing from the directory',
      content: '---\nname: other\n---\nbody',
      error: /does not match its directory/,
    },
    {
      label: 'invalid YAML',
      content: '---\ndescription: [unclosed\n---\nbody',
      error: /not valid YAML/,
    },
    {
      label: 'a non-string field',
      content: '---\nname: 42\n---\nbody',
      error: /frontmatter is invalid/,
    },
  ])('rejects $label', ({ content, error }) => {
    expect(() => parseSkillDocument('.agents/skills/review/SKILL.md', content)).toThrow(error);
  });

  it('rejects a non-Skill resource path', () => {
    expect(() => parseSkillDocument('AGENTS.md', 'content')).toThrow(/Invalid Skill resource path/);
  });
});
