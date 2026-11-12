import type { CSSProperties, ReactNode } from 'react';
import { useThreadIdentity } from './thread-workspaces.js';

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

const badgeShapes: ReactNode[] = [
  <circle key="dot" r="30" />,
  <path key="triangle" d="M0 -34 L34 30 L-34 30 Z" />,
  <rect key="square" x="-30" y="-30" width="60" height="60" rx="12" />,
  <path key="diamond" d="M0 -36 L38 0 L0 36 L-38 0 Z" />,
  <path key="cross" d="M-14 -34 h28 v20 h20 v28 h-20 v20 h-28 v-20 h-20 v-28 h20 Z" />,
  <path key="star" d="M0 -38 L11 -11 L38 0 L11 11 L0 38 L-11 11 L-38 0 L-11 -11 Z" />,
];

export function threadBadgeIndex(threadId: string): number {
  let hash = 5381;
  for (const character of threadId) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 33);
  }
  return (hash >>> 0) % badgeShapes.length;
}

export function ThreadBadge({
  threadId,
  line = false,
  className = '',
}: {
  threadId: string;
  line?: boolean | undefined;
  className?: string | undefined;
}) {
  const identity = useThreadIdentity(threadId);
  const temporary =
    line || (identity !== undefined && !identity.main && identity.workspaceId === undefined);
  const color = temporary ? 'var(--muted)' : threadColor(identity?.workspaceId ?? threadId);
  return (
    <span
      className={`thread-badge${temporary ? ' line' : ''}${className ? ` ${className}` : ''}`}
      data-thread-id={threadId}
      style={{ color }}
      aria-hidden="true"
    >
      <svg
        viewBox="-44 -44 88 88"
        fill={temporary ? 'none' : 'currentColor'}
        stroke={temporary ? 'currentColor' : undefined}
        strokeWidth={temporary ? 14 : undefined}
        strokeLinejoin="round"
      >
        <title>Kairos</title>
        {badgeShapes[threadBadgeIndex(threadId)]}
      </svg>
    </span>
  );
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
  const identity = useThreadIdentity(threadId);
  const temporary = identity !== undefined && !identity.main && identity.workspaceId === undefined;
  const outline = subagent || temporary;
  const color = subagent
    ? '#8b8f96'
    : temporary
      ? 'var(--muted)'
      : mainAgent || !threadId
        ? mainAgentColor
        : threadColor(identity?.workspaceId ?? threadId);
  const style: CSSProperties = {
    color: subagent || temporary ? 'var(--muted)' : mainAgent || !threadId ? 'var(--ink)' : color,
  };
  const badge =
    threadId && !mainAgent && !subagent && identity?.main !== true
      ? badgeShapes[threadBadgeIndex(threadId)]
      : null;
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
        fill={outline ? 'none' : 'currentColor'}
        stroke={outline ? 'currentColor' : undefined}
        strokeWidth={outline ? 12 : undefined}
        strokeLinejoin="round"
      >
        <title>Kairos</title>
        <path fillRule="evenodd" d={entityPath} />
        {badge && !temporary && (
          <g
            transform="translate(204 48)"
            paintOrder="stroke"
            stroke="var(--surface)"
            strokeWidth="14"
            strokeLinejoin="round"
          >
            {badge}
          </g>
        )}
        {badge && temporary && (
          <g transform="translate(204 48)" fill="none" strokeLinejoin="round">
            <g stroke="var(--surface)" strokeWidth="26">
              {badge}
            </g>
            <g stroke="currentColor" strokeWidth="14">
              {badge}
            </g>
          </g>
        )}
      </svg>
    </span>
  );
}
