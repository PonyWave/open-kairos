import type { CSSProperties } from 'react';

const entityPath =
  'M97 45C110 39 125 38 140 40L181 47C191 49 200 54 206 62L229 94C237 106 240 121 236 135L225 174C220 191 208 202 191 205L111 219C93 222 75 217 63 205L35 178C24 167 18 153 20 137L24 105C25 88 35 73 50 65L97 45ZM107 110.5C104.79 110.5 103 112.29 103 114.5V136.5C103 138.71 104.79 140.5 107 140.5H119C121.21 140.5 123 138.71 123 136.5V114.5C123 112.29 121.21 110.5 119 110.5H107ZM151 110.5C148.79 110.5 147 112.29 147 114.5V136.5C147 138.71 148.79 140.5 151 140.5H163C165.21 140.5 167 138.71 167 136.5V114.5C167 112.29 165.21 110.5 163 110.5H151Z';

export const mainAgentColor = '#25292f';

export function threadColor(threadId: string): string {
  const palette = ['#8b70ad', '#4b8a68', '#a87532', '#4f79a7', '#3f8585'];
  let hash = 2166136261;
  for (const character of threadId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return palette[(hash >>> 0) % palette.length] ?? palette[0] ?? mainAgentColor;
}

export function EntityMark({
  threadId,
  mainAgent = false,
  subagent = false,
  className = '',
}: {
  threadId?: string | undefined;
  mainAgent?: boolean | undefined;
  subagent?: boolean | undefined;
  className?: string | undefined;
}) {
  const color = subagent
    ? '#8b8f96'
    : mainAgent || !threadId
      ? mainAgentColor
      : threadColor(threadId);
  const style: CSSProperties = {
    color: subagent ? 'var(--muted)' : mainAgent || !threadId ? 'var(--ink)' : color,
  };
  return (
    <span
      className={`entity-mark${mainAgent || !threadId ? ' entity-main' : ''}${className ? ` ${className}` : ''}`}
      data-thread-id={threadId}
      data-thread-color={color}
      style={style}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 256 256"
        fill={subagent ? 'none' : 'currentColor'}
        stroke={subagent ? 'currentColor' : undefined}
        strokeWidth={subagent ? 12 : undefined}
        strokeLinejoin="round"
      >
        <title>Kairos</title>
        <path fillRule="evenodd" d={entityPath} />
      </svg>
    </span>
  );
}
