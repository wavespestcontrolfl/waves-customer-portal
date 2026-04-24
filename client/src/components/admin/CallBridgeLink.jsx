// Click-to-call button that routes through Waves' bridge: the server
// rings Adam's phone first, then connects to the customer once Adam
// presses 1. Use anywhere you'd otherwise render `<a href="tel:...">`.
// Renders as an inline <button> styled like a link by default so the
// caller can pass className / style to match the surrounding text.

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const DEFAULT_FROM = '+19412975749';

export async function callViaBridge(phone, customerName = '') {
  if (!phone) return;
  const who = (customerName || '').trim() || 'this number';
  const confirmMsg = `Call ${who} at ${phone}?\n\nWaves will call your phone first — press 1 to connect.`;
  if (!window.confirm(confirmMsg)) return;
  try {
    const r = await fetch(`${API_BASE}/admin/communications/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: phone, fromNumber: DEFAULT_FROM }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) {
      alert('Call failed: ' + (data?.error || `HTTP ${r.status}`));
    }
  } catch (err) {
    alert('Call failed: ' + err.message);
  }
}

// Match the legacy tel: <a> visual defaults so drop-in replacements
// don't shift layout or color: transparent bg, no border/padding,
// inherit font + cursor pointer.
const BASE_STYLE = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'inherit',
  cursor: 'pointer',
};

export default function CallBridgeLink({
  phone,
  customerName = '',
  className,
  style,
  children,
  title,
  stopPropagation = true,
  ...rest
}) {
  if (!phone) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        callViaBridge(phone, customerName);
      }}
      className={className}
      style={{ ...BASE_STYLE, ...(style || {}) }}
      title={title || `Call via Waves — rings your phone first, press 1 to connect`}
      aria-label={rest['aria-label'] || `Call ${customerName || phone}`}
    >
      {children ?? phone}
    </button>
  );
}
