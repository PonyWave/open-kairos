export type SlashCommand = 'reload' | 'compact' | 'new';

export type SlashCommandParseResult =
  | { kind: 'message'; text: string }
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'error'; message: string };

const commands = {
  '/reload': 'reload',
  '/compact': 'compact',
  '/new': 'new',
} as const;

export function parseSlashCommand(text: string): SlashCommandParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message', text };

  const [name = '', ...args] = trimmed.split(/\s+/);
  if (!(name in commands)) {
    return { kind: 'error', message: `未知斜杠命令 ${name}。仅支持 /reload、/compact 和 /new。` };
  }
  if (args.length > 0) return { kind: 'error', message: `${name} 不接受参数。` };
  return { kind: 'command', command: commands[name as keyof typeof commands] };
}
