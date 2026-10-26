import { unsafeRaw } from '../lib/html.js';

// Iconos SVG en línea (trazos de 24x24, estilo "outline"). Solo constantes del código.
const PATHS = {
  projects: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7M22 20c0-3-2-5-5-5.4"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1117 0"/>',
  audit: '<path d="M9 4h6l1 2h3v15H5V6h3z"/><path d="M9 12h6M9 16h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  theme: '<path d="M21 13A9 9 0 1111 3a7 7 0 0010 10z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logs: '<path d="M4 5h16v14H4z"/><path d="M8 10l2 2-2 2M12 14h4"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  rocket: '<path d="M5 15c-1 1-1.5 4-1.5 4.5S7 19 8 18"/><path d="M9 15l-3-3c1-4 4-8 10-9 0 6-4 9-8 10z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  money: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2"/>',
};

export function icon(name, { label } = {}) {
  const a11y = label ? `role="img" aria-label="${label.replace(/[^\p{L}\p{N} .,:-]/gu, '')}"` : 'aria-hidden="true"';
  return unsafeRaw(
    `<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${a11y} focusable="false">${PATHS[name] || ''}</svg>`,
  );
}
