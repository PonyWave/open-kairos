import { describe, expect, it } from 'vitest';
import { parseSlashCommand } from './slash-commands.js';

describe('parseSlashCommand', () => {
  it.each([
    ['/reload', 'reload'],
    ['/compact', 'compact'],
    ['/new', 'new'],
    ['  /reload  ', 'reload'],
    ['\n/compact\t', 'compact'],
  ])('recognizes exact no-argument command %s', (text, command) => {
    expect(parseSlashCommand(text)).toEqual({ kind: 'command', command });
  });

  it.each(['/reload now', '/compact  now', '/reload\nnow', '/compact\tnow', '/new now'])(
    'rejects arguments for %s',
    (text) => {
      expect(parseSlashCommand(text)).toEqual({
        kind: 'error',
        message: `${text.split(/\s+/)[0]} 不接受参数。`,
      });
    },
  );

  it.each(['/unknown', '/reloads', '/Reload', '/reload/extra', '//reload', '/'])(
    'rejects unknown slash input %s',
    (text) => {
      expect(parseSlashCommand(text)).toEqual({
        kind: 'error',
        message: `未知斜杠命令 ${text}。仅支持 /reload、/compact 和 /new。`,
      });
    },
  );

  it.each(['hello', '  hello  ', 'hello /reload', '请执行 /compact', '第一行\n/reload', '', '   '])(
    'preserves ordinary message content for %j',
    (text) => {
      expect(parseSlashCommand(text)).toEqual({ kind: 'message', text });
    },
  );
});
