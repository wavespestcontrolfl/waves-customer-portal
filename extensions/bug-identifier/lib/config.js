// One place for every URL and limit the extension uses.

// Portal endpoint (server/routes/public-bug-id-extension.js). The manifest's
// host permission for this origin is what lets the extension read the answer.
export const API_URL = 'https://portal.wavespestcontrol.com/api/public/bug-id-extension/identify';

export const SITE = 'https://www.wavespestcontrol.com';
// Species pages the engine links to; anything else is never rendered as a link.
export const SPECIES_PAGE_PREFIX = `${SITE}/pest-identifier/`;
export const QUOTE_URL = `${SITE}/pest-control-quote/`;
export const PRIVACY_URL = `${SITE}/privacy-policy/`;

// Attribution on every link back to the site.
export const UTM = { utm_source: 'chrome-extension', utm_medium: 'bug-identifier' };

// Mirrors the server's limits (MAX_PHOTOS 3, ~4.5 MB per photo); resized
// JPEGs at 1600 px stay far below the byte cap.
export const MAX_PHOTOS = 3;
export const RESIZE_MAX_PX = 1600;
export const JPEG_QUALITY = 0.85;
// Smallest selection worth sending, in screenshot pixels.
export const MIN_CROP_PX = 24;
// The engine runs up to three sequential vision calls.
export const REQUEST_TIMEOUT_MS = 60_000;

export function withUtm(url, content) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(UTM)) u.searchParams.set(key, value);
  if (content) u.searchParams.set('utm_content', content);
  return u.toString();
}
