/**
 * One icon family: 24x24, geometric, stroked, no fills.
 *
 * Stroke width and line joins come from the `svg` rule in base.css so every
 * icon in the product matches without repeating attributes here.
 */

const svg = (paths: string, size = 24): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${paths}</svg>`;

export const icons = {
  // --- Brand ---------------------------------------------------------------
  logo: svg(
    '<path d="M4 8a4 4 0 0 1 4-4h4a4 4 0 0 1 0 8H8"/><path d="M20 16a4 4 0 0 1-4 4h-4a4 4 0 0 1 0-8h4"/>'
  ),

  // --- Navigation ----------------------------------------------------------
  home: svg('<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.5 20v-6h5v6"/>'),
  rooms: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  files: svg('<path d="M4 6a2 2 0 0 1 2-2h3.4a2 2 0 0 1 1.6.8l1 1.2H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>'),
  settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 7l1.9 1.1M17.9 15.9l1.9 1.1M4.2 17l1.9-1.1M17.9 8.1 19.8 7"/>'
  ),

  // --- Media controls ------------------------------------------------------
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>'),
  micOff: svg(
    '<path d="M9 5a3 3 0 0 1 6 0v5m-6 .8V11a3 3 0 0 0 4.6 2.5"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10 5.5M18.5 11.5v.4M12 18v3"/><path d="m4 3 16 18"/>'
  ),
  camera: svg('<rect x="3" y="6" width="12" height="12" rx="2.5"/><path d="m15 10.5 5-2.8v8.6l-5-2.8z"/>'),
  cameraOff: svg(
    '<path d="M15 10.4V8.5A2.5 2.5 0 0 0 12.5 6H8.4M3.2 7.4A2.5 2.5 0 0 0 3 8.5v7A2.5 2.5 0 0 0 5.5 18h7c.5 0 1-.15 1.4-.4"/><path d="m20 8-5 2.8v2.4l5 2.8z"/><path d="m4 3 16 18"/>'
  ),
  screen: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 13V8m0 0-2 2m2-2 2 2"/>'),
  screenOff: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="m4 3 16 18"/>'),
  reactions: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.7 14.2a4.2 4.2 0 0 0 6.6 0"/><path d="M9.2 9.6h.01M14.8 9.6h.01"/>'),
  hand: svg(
    '<path d="M8.5 11V5.6a1.3 1.3 0 0 1 2.6 0V11m0-.6V4.3a1.3 1.3 0 0 1 2.6 0V11m0-.6V6a1.3 1.3 0 0 1 2.6 0v7.4a6.6 6.6 0 0 1-6.6 6.6h-.5a5.2 5.2 0 0 1-4-1.9L3.9 15a1.4 1.4 0 0 1 2-1.9l2.6 2.2"/>'
  ),
  leave: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8 6 12l4 4M6 12h9"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>'),

  // --- Panel ---------------------------------------------------------------
  chat: svg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/>'),
  people: svg(
    '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 5.9M17.8 14.6a5.5 5.5 0 0 1 2.7 4.9"/>'
  ),
  send: svg('<path d="m4.5 12 15.5-7-4.6 15.5-3.4-6z"/><path d="m12 14.5 8-9.5"/>'),
  attach: svg('<path d="M20 11.5 12.6 19a4.6 4.6 0 0 1-6.5-6.5l7.7-7.7a3 3 0 0 1 4.3 4.3l-7.7 7.7a1.5 1.5 0 0 1-2.1-2.1l7-7"/>'),
  close: svg('<path d="M6 6 18 18M18 6 6 18"/>'),
  chevronRight: svg('<path d="m9 5 7 7-7 7"/>'),
  pin: svg('<path d="M9 4h6l-.7 5.2 3 2.6V14H6.7v-2.2l3-2.6z"/><path d="M12 14v6"/>'),

  // --- Status --------------------------------------------------------------
  shield: svg('<path d="M12 3.2 19 6v5.4c0 4-2.9 7.6-7 9-4.1-1.4-7-5-7-9V6z"/><path d="m9.2 12 2 2 3.6-4"/>'),
  link: svg('<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.4 1.4"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.4-1.4"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  alert: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2M12 7.8h.01"/>'),
  signal: svg('<path d="M4 13.5a11 11 0 0 1 16 0"/><path d="M7.5 16.8a6.2 6.2 0 0 1 9 0"/><path d="M12 20h.01"/>'),
  spinner: svg('<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" opacity=".9"/>'),

  // --- Whiteboard and polls ------------------------------------------------
  board: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M7.5 12.6c1.6-3.4 3-4.8 4-4.2.9.6-1.6 3.5-.6 4.4.9.9 3.4-1.6 5.6-2.4"/>'),
  eraser: svg('<path d="m9.5 19.5-4.7-4.7a1.6 1.6 0 0 1 0-2.3l7.8-7.8a1.6 1.6 0 0 1 2.3 0l4.7 4.7a1.6 1.6 0 0 1 0 2.3l-7 7z"/><path d="M9.5 19.5H20M8.6 9.4l6 6"/>'),
  undo: svg('<path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8"/><path d="M7.5 5 3.5 9l4 4"/>'),
  lock: svg('<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/>'),
  unlock: svg('<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.3-1.3"/>'),
  trash: svg('<path d="M4.5 7h15"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.5 7l.9 12.1A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/>'),
  poll: svg('<path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),

  // --- Reactions -----------------------------------------------------------
  thumbsup: svg('<path d="M7 21V10l4.2-6.4a1.5 1.5 0 0 1 2.7 1.1L13 10h5.2a2 2 0 0 1 2 2.4l-1.4 6.6a2 2 0 0 1-2 1.6z"/><path d="M7 10H4.8A1.8 1.8 0 0 0 3 11.8v7.4A1.8 1.8 0 0 0 4.8 21H7"/>'),
  clap: svg('<path d="M8.4 12.8 5.6 10a1.6 1.6 0 0 1 2.3-2.3l2.5 2.5"/><path d="m11 8.6-2-2a1.6 1.6 0 0 1 2.3-2.3l4.9 4.9"/><path d="M13.6 6.6a1.6 1.6 0 1 1 2.3-2.2l4 4a6.4 6.4 0 0 1-9 9L7 13.5"/>'),
  heart: svg('<path d="M12 20s-7.5-4.4-7.5-9.4A4.1 4.1 0 0 1 12 8.2a4.1 4.1 0 0 1 7.5 2.4C19.5 15.6 12 20 12 20"/>'),
  smile: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.7 14.2a4.2 4.2 0 0 0 6.6 0"/><path d="M9.2 9.6h.01M14.8 9.6h.01"/>'),
  surprised: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="14.6" r="1.9"/><path d="M9.2 9.2h.01M14.8 9.2h.01"/>'),
  question: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.6a2.4 2.4 0 0 1 4.6.8c0 1.6-2.3 2-2.3 3.4"/><path d="M12 17h.01"/>'),
} as const;

export type IconName = keyof typeof icons;

/** Reaction vocabulary. Must match REACTIONS in the server's signaling.rs. */
export const REACTIONS = [
  { kind: "thumbsup", label: "Thumbs up" },
  { kind: "clap", label: "Applause" },
  { kind: "heart", label: "Heart" },
  { kind: "smile", label: "Smile" },
  { kind: "surprised", label: "Surprised" },
  { kind: "question", label: "Question" },
] as const;
