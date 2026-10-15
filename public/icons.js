/* Print Wallah icon set: one registry of 24px line icons shared by every screen.
   Stroke weight is tuned by size so large status art stays as refined as the small UI glyphs. */
const ICON_PATHS = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5.5H9V20H5a1 1 0 0 1-1-1z"/>',
  orders: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  chart: '<path d="M4 4v15a1 1 0 0 0 1 1h15"/><path d="M8.5 16v-4.5M12.5 16V8M16.5 16v-6.5"/>',
  settings: '<path d="M4 7h8M16 7h4M4 17h4M12 17h8"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  shops: '<path d="M4.5 9.5 6 4.5h12l1.5 5"/><path d="M4.5 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/><path d="M5.5 12.5V20h13v-7.5"/><path d="M10 20v-4h4v4"/>',
  logout: '<path d="M10 4.5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h4"/><path d="M14.5 8.5 18 12l-3.5 3.5M18 12H9.5"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M17.5 14v4.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1H10"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  phone: '<path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7L16 13l4 1.5v3a2 2 0 0 1-2.2 2A14.5 14.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z"/>',
  file: '<path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5V8H18M9 13h6M9 16.5h4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4.2 3.2 19.3a.8.8 0 0 0 .7 1.2h16.2a.8.8 0 0 0 .7-1.2z"/><path d="M12 10v4.2M12 17.3h.01"/>',
  printer: '<path d="M7 9V4.5h10V9"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v5.5H7z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  inbox: '<path d="M4 13.5 6.5 5h11l2.5 8.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13.5h4.5l1 2.5h5l1-2.5H20"/>',
  grip: '<circle cx="8.5" cy="5.5" r="1"/><circle cx="15.5" cy="5.5" r="1"/><circle cx="8.5" cy="12" r="1"/><circle cx="15.5" cy="12" r="1"/><circle cx="8.5" cy="18.5" r="1"/><circle cx="15.5" cy="18.5" r="1"/>',
  upload: '<path d="M12 16V5"/><path d="m7.5 9.5 4.5-4.5 4.5 4.5"/><path d="M5 15.5v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4.5v11"/><path d="m7.5 11.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  pay: '<rect x="3.5" y="6" width="17" height="12.5" rx="2.5"/><path d="M3.5 10.2h17M7 14.8h3"/>',
  photo: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 15.5-4.7-4.7L8 18.7"/>',
  success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.4 12.4 2.5 2.5 4.7-5"/>',
  wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  empty: '<path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5V8H18M10 12.5l4 4M14 12.5l-4 4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  rupee: '<path d="M7 5h10M7 9h10M9 5c5 0 6.3 2 6.3 4S14 13 9 13h-.5l6.7 6.5"/>',
  pin: '<path d="M12 20.5s6.5-5.2 6.5-10.5a6.5 6.5 0 1 0-13 0c0 5.3 6.5 10.5 6.5 10.5z"/><circle cx="12" cy="10" r="2.3"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  'chevron-down': '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  'chevron-right': '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  'chevron-left': '<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  'eye-off': '<path d="M2.5 12S6 5.5 12 5.5c1.7 0 3.2.5 4.5 1.3M21.5 12s-1.2 2.2-3.4 3.9M9.9 18.2c.7.2 1.4.3 2.1.3"/><path d="M9.6 9.6a2.8 2.8 0 0 0 3.9 3.9M4 4l16 16"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.5 7.5 7.5 6 7.5-6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  'rotate-left': '<path d="M5 12a7 7 0 1 0 2.2-5.1"/><path d="M5 4.5V8h3.5"/>',
  'rotate-right': '<path d="M19 12a7 7 0 1 1-2.2-5.1"/><path d="M19 4.5V8h-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12M10 11v5M14 11v5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.5V7H14M6.5 20.5V17H10"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
};
ICON_PATHS.doc = ICON_PATHS.file; ICON_PATHS.store = ICON_PATHS.shops; ICON_PATHS.sliders = ICON_PATHS.settings; ICON_PATHS.clock = ICON_PATHS.wait;

function icon(name, size = 20) {
  const body = ICON_PATHS[name] || ICON_PATHS.info;
  const sw = size >= 56 ? 1.1 : size >= 32 ? 1.4 : 1.7;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
const aicon = icon;
