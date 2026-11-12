import { create, RunSchema, RunStatus } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditedMarker, RunOutcomeCard } from './response-components.js';

function run(status: RunStatus) {
  return create(RunSchema, {
    runId: 'run-1',
    threadId: 'thread-1',
    status,
    usage: { inputTokens: 100n, outputTokens: 200n },
    ...(status === RunStatus.FAILED
      ? { error: { code: 13, message: '模型请求失败', retryable: true } }
      : {}),
  });
}

describe('Run failure controls', () => {
  it('shows failure details and retry without usage or internal identifiers', () => {
    const html = renderToStaticMarkup(
      createElement(RunOutcomeCard, {
        run: run(RunStatus.FAILED),
        busy: false,
        onContinue: async () => {},
      }),
    );
    expect(html).toContain('模型请求失败');
    expect(html).toContain('重试');
    expect(html).not.toContain('run-1');
    expect(html).not.toContain('token');
    expect(html).not.toContain('Run 诊断');
  });
  it('offers continue after cancellation and no controls after completion', () => {
    const render = (status: RunStatus) =>
      renderToStaticMarkup(
        createElement(RunOutcomeCard, {
          run: run(status),
          busy: false,
          onContinue: async () => {},
        }),
      );
    expect(render(RunStatus.CANCELLED)).toContain('已停止');
    expect(render(RunStatus.CANCELLED)).toContain('继续');
    expect(render(RunStatus.COMPLETED)).toBe('');
  });

  it('disables failure retry and cancelled Run continuation while busy', () => {
    const render = (status: RunStatus) =>
      renderToStaticMarkup(
        createElement(RunOutcomeCard, {
          run: run(status),
          busy: true,
          onContinue: async () => {},
        }),
      );

    for (const status of [RunStatus.FAILED, RunStatus.INTERRUPTED]) {
      expect(render(status)).toContain('class="text-button failure-retry" disabled=""');
    }
    expect(render(RunStatus.CANCELLED)).toContain('class="text-button" disabled=""');
  });
});

describe('Edited marker', () => {
  it('uses the unified edited marker only when a revision exists', () => {
    const revised = renderToStaticMarkup(createElement(EditedMarker, { revisionId: 'revision-1' }));
    const original = renderToStaticMarkup(createElement(EditedMarker, { revisionId: undefined }));
    expect(revised).toBe('<span class="edited-marker">（已编辑）</span>');
    expect(original).toBe('');
  });
});
