import { ChannelId, ChannelReferenceKind, type Input } from '@kairos/contracts';

const inboundMarkerPrefix =
  /^<system-reminder>\nThe following user message arrived from the (?:WeChat|Feishu) IM channel \((?:wechat|feishu)\)\.\n<\/system-reminder>\n\n?/;
const legacyInboundPrefix = /^\[来自(微信|飞书)\]\n?/;

export function stripChannelInboundMarker(text: string): string {
  return text.replace(inboundMarkerPrefix, '').replace(legacyInboundPrefix, '');
}

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
  const text = channelKey ? stripChannelInboundMarker(raw) : raw;
  return { text, channelKey };
}
