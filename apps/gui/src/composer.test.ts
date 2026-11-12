/// <reference lib="dom" />

import { InputMode } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  addComposerClipboardFiles,
  Composer,
  composerEnterAction,
  composerSlashCommandAction,
  slashCommandCandidates,
} from './composer.js';

const baseEvent = { key: 'Enter', shiftKey: false, repeat: false, isComposing: false };

describe('Composer keyboard contract', () => {
  it('uses Enter for follow_up and preserves newline and IME behavior', () => {
    expect(composerEnterAction(baseEvent)).toBe('send');
    expect(composerEnterAction({ ...baseEvent, shiftKey: true })).toBe('newline');
    expect(composerEnterAction({ ...baseEvent, isComposing: true })).toBe('ignore');
    expect(composerEnterAction({ ...baseEvent, repeat: true })).toBe('ignore');
    expect(composerEnterAction({ ...baseEvent, key: 'a' })).toBe('ignore');
    expect(InputMode.FOLLOW_UP).toBe(1);
  });

  it('navigates and selects visible slash candidates without intercepting IME input', () => {
    expect(composerSlashCommandAction({ ...baseEvent, key: 'ArrowDown' }, 0, 2)).toBe(1);
    expect(composerSlashCommandAction({ ...baseEvent, key: 'ArrowDown' }, 1, 2)).toBe(0);
    expect(composerSlashCommandAction({ ...baseEvent, key: 'ArrowUp' }, 0, 2)).toBe(1);
    expect(composerSlashCommandAction(baseEvent, 1, 2)).toBe('select');
    expect(composerSlashCommandAction({ ...baseEvent, shiftKey: true }, 0, 2)).toBeNull();
    expect(composerSlashCommandAction({ ...baseEvent, isComposing: true }, 0, 2)).toBeNull();
    expect(composerSlashCommandAction(baseEvent, 0, 0)).toBeNull();
  });
});

describe('slash command candidates', () => {
  it('lists every command for a slash and filters by contained text', () => {
    expect(slashCommandCandidates('/').map((command) => command.name)).toEqual([
      '/reload',
      '/compact',
      '/new',
    ]);
    expect(slashCommandCandidates('/load').map((command) => command.name)).toEqual(['/reload']);
    expect(slashCommandCandidates('/c').map((command) => command.name)).toEqual(['/compact']);
    expect(slashCommandCandidates('消息 /')).toEqual([]);
  });

  it('hides a unique exact match and unknown commands', () => {
    expect(slashCommandCandidates('/comp').map((command) => command.name)).toEqual(['/compact']);
    expect(slashCommandCandidates('/compact')).toEqual([]);
    expect(slashCommandCandidates('/reload')).toEqual([]);
    expect(slashCommandCandidates('/unknown')).toEqual([]);
  });
});

describe('Composer actions', () => {
  const render = (text: string, busy = false) =>
    renderToStaticMarkup(
      createElement(Composer, {
        composerOwner: 'main',
        threadId: 'thread-1',
        draft: { id: 'draft-1', text },
        busy,
        unavailable: false,
        onChange: () => {},
        onSend: async () => {},
      }),
    );

  it('adds pasted PNG, JPEG and text files as clipboard attachments only when files exist', () => {
    const calls: Array<{ files: File[]; source: string }> = [];
    const added = addComposerClipboardFiles(
      [
        new File(['png'], '', { type: 'image/png' }),
        new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }),
        new File(['text'], 'note.txt', { type: 'text/plain' }),
      ],
      (files, source) => calls.push({ files, source }),
    );
    expect(added).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe('clipboard');
    expect(calls[0]?.files.map((file) => file.type)).toEqual([
      'image/png',
      'image/jpeg',
      'text/plain',
    ]);
    expect(calls[0]?.files[0]?.name).toMatch(/^pasted-.+\.png$/);
    expect(calls[0]?.files[1]?.name).toBe('photo.jpg');
    expect(calls[0]?.files[2]?.name).toBe('note.txt');
    expect(
      addComposerClipboardFiles([], () => calls.push({ files: [], source: 'clipboard' })),
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('shows the attachment menu and a single icon send button', () => {
    const html = render('待发送');
    expect(html).toContain('aria-label="添加附件或命令"');
    expect(html).toContain('aria-label="发送消息"');
    expect(html).toContain('rows="1"');
    expect(html).not.toContain('中途补充');
    expect(html).not.toContain('Enter 发送');
    expect(html).not.toContain('<select');
  });

  it('disables sending for empty drafts and busy actions', () => {
    for (const html of [render('   '), render('待发送', true)]) {
      expect(html).toMatch(/<button[^>]*class="send-btn"[^>]*disabled=""/);
    }
  });

  it('replaces send with stop while running, including an empty draft', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        composerOwner: 'main',
        threadId: 'thread-1',
        draft: { id: 'draft-1', text: '' },
        busy: false,
        unavailable: false,
        running: true,
        onChange: () => {},
        onSend: async () => {},
        onStop: async () => {},
      }),
    );
    expect(html).toContain('aria-label="停止执行"');
    expect(html).not.toContain('aria-label="发送消息"');
    expect(html).not.toMatch(/stop-btn[^>]*disabled=""/);
  });

  it('marks slash input without a separate mode label or send hint', () => {
    const html = render('/compact');
    expect(html).toContain('class="composer is-command"');
    expect(html).toContain('aria-label="执行命令"');
    expect(html).not.toContain('command-indicator');
    expect(html).not.toContain('composer-hint');
    expect(html).not.toContain('role="listbox"');
  });

  it('renders filtered candidates above slash input with an active option', () => {
    const html = render('/load');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-label="斜杠命令"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('/reload');
    expect(html).not.toContain('/compact');
  });
});
