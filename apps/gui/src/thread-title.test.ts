import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleEditor } from './thread-title.js';

const captured = vi.hoisted(() => ({
  form: undefined as { onSubmit: (event: { preventDefault: () => void }) => void } | undefined,
  input: undefined as
    | {
        onBlur: () => void;
        onKeyDown: (event: {
          key: string;
          stopPropagation: () => void;
          preventDefault: () => void;
        }) => void;
      }
    | undefined,
}));

vi.mock('react/jsx-runtime', () => ({
  jsx: (type: string, props: Record<string, unknown>) => {
    if (type === 'form') captured.form = props as typeof captured.form;
    if (type === 'input') captured.input = props as typeof captured.input;
    return null;
  },
  jsxs: () => null,
  Fragment: Symbol.for('react.fragment'),
}));

vi.mock('react/jsx-dev-runtime', () => ({
  jsxDEV: (type: string, props: Record<string, unknown>) => {
    if (type === 'form') captured.form = props as typeof captured.form;
    if (type === 'input') captured.input = props as typeof captured.input;
    return null;
  },
  Fragment: Symbol.for('react.fragment'),
}));

beforeEach(() => {
  captured.form = undefined;
  captured.input = undefined;
});

function render(options: {
  title?: string;
  busy?: boolean;
  onSave: (title: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  renderToStaticMarkup(
    createElement(TitleEditor, {
      title: options.title ?? '原标题',
      busy: options.busy ?? false,
      onSave: options.onSave,
      onCancel: options.onCancel ?? (() => {}),
    }),
  );
  if (!captured.form || !captured.input) throw new Error('标题编辑控件未渲染。');
  return { form: captured.form, input: captured.input };
}

describe('TitleEditor', () => {
  it('saves the trimmed title on blur', async () => {
    const saved: string[] = [];
    const { input } = render({
      title: '  新标题  ',
      onSave: async (title) => {
        saved.push(title);
        return true;
      },
    });

    await input.onBlur();
    expect(saved).toEqual(['新标题']);
  });

  it('deduplicates Enter and blur while the same save is pending', async () => {
    let release = () => {};
    const pending = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const onSave = vi.fn(() => pending);
    const { form, input } = render({ onSave });

    form.onSubmit({ preventDefault: () => {} });
    await input.onBlur();
    expect(onSave).toHaveBeenCalledTimes(1);
    release();
    await pending;
  });

  it('cancels Escape without saving on a later blur', async () => {
    const onSave = vi.fn(async () => true);
    const onCancel = vi.fn();
    const { input } = render({ onSave, onCancel });

    input.onKeyDown({ key: 'Escape', stopPropagation: () => {}, preventDefault: () => {} });
    await input.onBlur();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('leaves an empty title unsaved and exits editing on blur', async () => {
    const onSave = vi.fn(async () => true);
    const onCancel = vi.fn();
    const { input } = render({ title: '   ', onSave, onCancel });

    await input.onBlur();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
