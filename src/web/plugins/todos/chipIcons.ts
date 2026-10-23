const svg = (paths: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** The icons of the Todos page's chips (calendar, repeat and flag in icons.tsx), as markup for chips drawn in a note, which aren't React's. */
export const CHIP_ICONS = {
  due: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>'),
  every: svg('<path d="M12.5 6.5A4.75 4.75 0 0 0 4 4.75M3.5 2.5v2.5H6M3.5 9.5A4.75 4.75 0 0 0 12 11.25M12.5 13.5V11H10"/>'),
  importance: svg('<path d="M4 14V2.75h8l-1.5 3 1.5 3H4"/>'),
  close: svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>'),
} as const;
