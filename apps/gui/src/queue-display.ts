import { ChannelId, ChannelReferenceKind, type Input } from '@kairos/contracts';

export function queuedInputDisplay(input: Input): {
  text: string;
  channelKey: 'wechat' | 'feishu' | undefined;
} {
  const channelKey =
    input.channel?.kind === ChannelReferenceKind.INBOUND
      ? input.channel.channel === ChannelId.WECHAT
        ? ('wechat' as const)
        : ('feishu' as const)
      : undefined;
  const raw = input.text || input.attachments.map((file) => file.fileName).join('、');
  const text = channelKey ? raw.replace(/^\[来自(微信|飞书)\]\n?/, '') : raw;
  return { text, channelKey };
}
