import { create, ToolCallSchema } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SubagentCard } from './subagent-card.js';

it('anchors the subagent card so origin location can find and highlight it', () => {
  const html = renderToStaticMarkup(
    createElement(SubagentCard, {
      call: create(ToolCallSchema, {
        toolCallId: 'call-1',
        toolName: 'subagent',
        argumentsJson: '{"task":"调查"}',
      }),
      view: undefined,
      onOpen: () => {},
    }),
  );
  expect(html).toContain('id="origin-call-1"');
  expect(html).toContain('class="subagent-card"');
});
