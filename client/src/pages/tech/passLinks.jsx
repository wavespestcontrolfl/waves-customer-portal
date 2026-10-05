// A visitor or QR pass is a link the technician opens, never raw text (owner
// ruling 2026-10-05): an https link in an access line becomes one button that
// opens in a new tab; the rest of the line stays as written. Only https links
// qualify, so a javascript: or plain http address stays text.
const PASS_LINK = /https:\/\/[^\s<>"']+/g;

function passLinkOf(raw) {
  const link = raw.replace(/[.,;:!?)\]]+$/, '');
  try { return new URL(link).protocol === 'https:' ? link : null; } catch { return null; }
}

// `buttonProps` ({ style } or { className }) styles the button for the caller's theme.
export function withPassLinks(text, buttonProps = {}) {
  const value = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const m of value.matchAll(PASS_LINK)) {
    const link = passLinkOf(m[0]);
    if (!link) continue;
    if (m.index > last) parts.push(value.slice(last, m.index));
    parts.push(
      <a key={m.index} href={link} target="_blank" rel="noopener noreferrer" {...buttonProps}>
        Open visitor pass
      </a>,
    );
    last = m.index + link.length;
  }
  if (!parts.length) return value;
  if (last < value.length) parts.push(value.slice(last));
  return parts;
}
