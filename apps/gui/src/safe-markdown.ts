import {
  type ComponentPropsWithoutRef,
  createElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

export function safeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? trimmed : '';
  } catch {
    return '';
  }
}

function SafeAnchor({
  node: _node,
  ...properties
}: ComponentPropsWithoutRef<'a'> & { node?: unknown }): ReactElement {
  return createElement('a', { ...properties, target: '_blank', rel: 'noreferrer noopener' });
}

function SafeImage({ alt }: ComponentPropsWithoutRef<'img'>): ReactElement {
  return createElement('span', null, alt ? `[图片：${alt}]` : '[外部图片未加载]');
}

export function SafeMarkdown({ children }: { children?: ReactNode }): ReactElement {
  return createElement(
    'div',
    { className: 'markdown' },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeSanitize],
        skipHtml: true,
        urlTransform: safeMarkdownUrl,
        components: { a: SafeAnchor, img: SafeImage },
      },
      children,
    ),
  );
}
