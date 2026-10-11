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
  folders: <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  edit: <path d="M9.75 3.75 12.25 6.25M3 13l.6-2.85 7.4-7.4a1.2 1.2 0 0 1 1.7 0l.55.55a1.2 1.2 0 0 1 0 1.7l-7.4 7.4z" />,
  close: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
  chevron: <path d="m6 4.5 3.5 3.5L6 11.5" />,
  inspector: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </>
  ),
  writing: <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5M6.75 7v4M9.25 7v4" />,
  share: (
    <>
      <circle cx="6" cy="5.75" r="2.25" />
      <path d="M2 13c.4-2.2 1.9-3.4 4-3.4s3.6 1.2 4 3.4M12 4.5v4M10 6.5h4" />
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
