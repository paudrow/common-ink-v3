const PATHS = {
  dashboard: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.25 3.25" />
    </>
  ),
  todos: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="m5.5 8 1.75 1.75L10.5 6.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  today: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
      <circle cx="8" cy="10" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  contacts: (
    <>
      <circle cx="8" cy="5.75" r="2.5" />
      <path d="M3.5 13.5c.5-2.5 2.25-3.75 4.5-3.75s4 1.25 4.5 3.75" />
    </>
  ),
  uploads: <path d="M8 10.5V2.5M5 5.5l3-3 3 3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  history: (
    <>
      <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.8M2.5 2.5v2.25h2.25" />
      <path d="M8 5.25V8l2 1.5" />
    </>
  ),
  backlinks: <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />,
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.25v3.5M8 5.25v.01" />
    </>
  ),
  more: <path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth="2.25" />,
  agent: (
    <>
      <rect x="3" y="5.5" width="10" height="7.5" rx="2" />
      <path d="M8 5.5V3M6 9h.01M10 9h.01" />
    </>
  ),
  back: <path d="M9.5 3.5 5 8l4.5 4.5" />,
  folders: <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  edit: <path d="M9.75 3.75 12.25 6.25M3 13l.6-2.85 7.4-7.4a1.2 1.2 0 0 1 1.7 0l.55.55a1.2 1.2 0 0 1 0 1.7l-7.4 7.4z" />,
  close: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
  chevron: <path d="m6 4.5 3.5 3.5L6 11.5" />,
  sidebar: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </>
  ),
  inspector: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </>
  ),
  focus: <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="5.75" r="2.25" />
      <path d="M2 13c.4-2.2 1.9-3.4 4-3.4s3.6 1.2 4 3.4M12 4.5v4M10 6.5h4" />
    </>
  ),
  plugin: <path d="M6.5 3.5a1.5 1.5 0 0 1 3 0v1h2.5a1 1 0 0 1 1 1V8h-1a1.5 1.5 0 0 0 0 3h1v1.5a1 1 0 0 1-1 1H9.5v-1a1.5 1.5 0 0 0-3 0v1H4a1 1 0 0 1-1-1V10h1a1.5 1.5 0 0 0 0-3H3V5.5a1 1 0 0 1 1-1h2.5z" />,
  settings: (
    <>
      <path d="M2.5 5h5M10.5 5h3M2.5 11h3M8.5 11h5" />
      <circle cx="9" cy="5" r="1.5" />
      <circle cx="7" cy="11" r="1.5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 6.75h.01M6.67 6.75h.01M9.33 6.75h.01M12 6.75h.01M5 9.5h6" />
    </>
  ),
  code: <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3M9 3.5l-2 9" />,
  table: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M2.5 9.75h11M6.5 3v10" />
    </>
  ),
  tag: (
    <>
      <path d="M2.5 3.5v4.25l6 6 4.75-4.75-6-6H3a.5.5 0 0 0-.5.5z" />
      <path d="M5.25 5.75v.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  stopwatch: (
    <>
      <circle cx="8" cy="9" r="4.75" />
      <path d="M8 6.5V9M6.5 2h3M8 2v2.25M12 4.5l.75-.75" />
    </>
  ),
  link: <path d="M5 4.5H3.5v7H5M11 4.5h1.5v7H11M6.5 6.5V4.5H8M9.5 9.5v2H8M5.5 8h5" />,
  at: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M10.25 5.75v3a1.6 1.6 0 0 0 3.25 0V8a5.5 5.5 0 1 0-2.25 4.45" />
    </>
  ),
  list: <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01M5.5 4h8M5.5 8h8M5.5 12h8" />,
  board: (
    <>
      <rect x="2.5" y="3" width="3" height="10" rx="1" />
      <rect x="6.5" y="3" width="3" height="6.5" rx="1" />
      <rect x="10.5" y="3" width="3" height="8.5" rx="1" />
    </>
  ),
  math: <path d="M11.5 4.5V3.5h-7L8 8l-3.5 4.5h7v-1" />,
  tabs: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.25h11M7 3v3.25" />
    </>
  ),
  command: <path d="m3.5 5.5 3 2.5-3 2.5M8.5 11h4" />,
  members: (
    <>
      <circle cx="6" cy="6" r="2.25" />
      <path d="M2 13c.4-2.2 1.9-3.4 4-3.4s3.6 1.2 4 3.4M10.5 4a2.25 2.25 0 0 1 0 4.25M12 10c1.1.5 1.8 1.5 2 3" />
    </>
  ),
  text: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  numbers: <path d="M3 4.5 4 4v4M6.5 4h7M6.5 8h7M6.5 12h7M3 10.5h1.25v1.5H3" />,
  play: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="2" />
      <path d="m7 6.25 2.75 1.75L7 9.75z" />
    </>
  ),
  outline: <path d="M3 4h.01M6 8h.01M6 12h.01M5.5 4h8M8.5 8h5M8.5 12h5" />,
  slash: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="m9.5 5-3 6" />
    </>
  ),
  markdown: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M4 10V6l1.75 2L7.5 6v4M11 6v4M9.5 8.5 11 10l1.5-1.5" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
