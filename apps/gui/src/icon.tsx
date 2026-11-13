import type { CSSProperties } from 'react';

const shapes = {
  wechat: (
    <>
      <path d="M12 4C6.8 4 2.5 7.4 2.5 11.6c0 2.4 1.3 4.5 3.3 5.9l-.8 2.9 3.2-1.7c1.2.4 2.5.6 3.8.6 5.2 0 9.5-3.4 9.5-7.7S17.2 4 12 4Z" />
      <path d="M8.5 10.5h.01M15.5 10.5h.01" />
    </>
  ),
  feishu: (
    <>
      <path d="M21 3 3 10.8l6.2 2.4L21 3Z" />
      <path d="m21 3-5.2 18-4.6-7.8" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M14 4v16" />
    </>
  ),
  pin: (
    <>
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />
    </>
  ),
  chat: (
    <>
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6A8.4 8.4 0 0 1 12.5 3h.5a8.5 8.5 0 0 1 8 8z" />
    </>
  ),
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="17" rx="3" />
      <path d="M9 3h6v3H9zM8 11l1.5 1.5L12 10M14 11h3M8 16h2M14 16h3" />
    </>
  ),
  files: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />
    </>
  ),
  memory: (
    <>
      <path d="M12 20s-4-2-9-1V4c5-1 9 1 9 1s4-2 9-1v15c-5-1-9 1-9 1zM12 5v15" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 16v5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </>
  ),
  up: (
    <>
      <path d="M12 19V5m-5 5 5-5 5 5" />
    </>
  ),
  chevron: (
    <>
      <path d="m9 5 7 7-7 7" />
    </>
  ),
  down: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  check: (
    <>
      <path d="m5 12 4 4L19 6" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  cloud: (
    <>
      <path d="M20 16.7A5 5 0 0 0 18 7a6 6 0 0 0-11.4-.4A5 5 0 0 0 6 17h12" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  moon: (
    <>
      <path d="M20.9 13.1A9 9 0 0 1 10.9 3a9 9 0 1 0 10 10.1z" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  external: (
    <>
      <path d="M15 3h6v6m0-6L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
    </>
  ),
  expand: (
    <>
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" />
    </>
  ),
  edit: (
    <>
      <path d="m16 3 5 5L8 21H3v-5zM14 5l5 5" />
    </>
  ),
  clip: (
    <>
      <path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" />
    </>
  ),
  pause: (
    <>
      <path d="M9 5v14M15 5v14" />
    </>
  ),
  stop: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </>
  ),
  play: (
    <>
      <path d="m7 4 14 8-14 8z" />
    </>
  ),
  plane: (
    <>
      <path d="m22 2-7 20-4-9-9-4zM22 2 11 13" />
    </>
  ),
  code: (
    <>
      <path d="m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  spark: (
    <>
      <path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8z" />
    </>
  ),
  leaf: (
    <>
      <path d="M20 3C10 2 3 7 4 14c1 7 10 8 14 1 2-4 2-8 2-12zM5 20 15 9" />
    </>
  ),
  link: (
    <>
      <path
        d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"
        transform="translate(1 0)"
      />
    </>
  ),
  folder: (
    <>
      <path d="M3 7V4h6l3 3h9v13H3z" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" />,
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </>
  ),
  back: (
    <>
      <path d="M19 12H5m5-5-5 5 5 5" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </>
  ),
  history: (
    <>
      <path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2" />
    </>
  ),
  grip: (
    <>
      <circle cx="9" cy="5" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="19" r="1" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 17h.01" />
    </>
  ),
  retry: (
    <>
      <path d="M3 10a9 9 0 1 1 1.6 8M3 4v6h6" />
    </>
  ),
  spinner: (
    <>
      <path d="M21 12a9 9 0 1 1-9-9" />
    </>
  ),
  settings: (
    <>
      <path d="M10.06 4.76L10.68 2.59h2.64l.62 2.17a7.5 7.5 0 0 1 1.81.74l1.97-1.09 1.87 1.87-1.09 1.97a7.5 7.5 0 0 1 .74 1.81l2.17.62v2.64l-2.17.62a7.5 7.5 0 0 1-.74 1.81l1.09 1.97-1.87 1.87-1.97-1.09a7.5 7.5 0 0 1-1.81.74l-.62 2.17h-2.64l-.62-2.17a7.5 7.5 0 0 1-1.81-.74l-1.97 1.09-1.87-1.87 1.09-1.97a7.5 7.5 0 0 1-.74-1.81l-2.17-.62v-2.64l2.17-.62a7.5 7.5 0 0 1 .74-1.81L4.41 6.28l1.87-1.87L8.25 5.5a7.5 7.5 0 0 1 1.81-.74Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export type IconName = keyof typeof shapes;

export function Icon({
  name,
  className = '',
  style,
}: {
  name: IconName;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      {shapes[name]}
    </svg>
  );
}
