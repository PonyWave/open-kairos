import type { ModelEvent, ModelRequest } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { expect, it } from 'vitest';
import { buildThreadTitleRequest, ThreadTitleGenerator } from './title-generation.js';

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function response(content: string): ModelEvent[] {
  return [{ type: 'response', message: { role: 'assistant', content }, usage }];
}

function generator(
  provider: ScriptedProvider,
  countTokens: (request: ModelRequest) => number = () => 800,
) {
  return new ThreadTitleGenerator(provider, { contextWindowTokens: 1000, countTokens });
}

it('builds a separate bounded title request and normalizes the plain-text result', async () => {
  const prompt = '请规划季度产品路线图';
  const provider = new ScriptedProvider([response('  季度\n产品规划  ')]);
  const output = await generator(provider).generate(prompt, new AbortController().signal);

  expect(output).toBe('季度 产品规划');
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]?.tools).toEqual([]);
  expect(provider.requests[0]?.messages[1]?.content).toContain(JSON.stringify(prompt));
  expect(buildThreadTitleRequest('x'.repeat(12_100)).messages[1]?.content.length).toBeLessThan(
    12_100,
  );
});

it('checks the 80 percent input limit before calling the provider', async () => {
  const provider = new ScriptedProvider([response('不会使用')]);
  await expect(
    generator(provider, () => 801).generate('long prompt', new AbortController().signal),
  ).rejects.toThrow('input capacity');
  expect(provider.requests).toHaveLength(0);
});

it.each(['', 'x'.repeat(41)])('rejects an invalid title response %j', async (content) => {
  const provider = new ScriptedProvider([response(content)]);
  await expect(
    generator(provider).generate('prompt', new AbortController().signal),
  ).rejects.toThrow();
});
