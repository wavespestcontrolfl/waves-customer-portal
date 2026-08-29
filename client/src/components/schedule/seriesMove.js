// Collective series moves — client half of the disclosure contract
// (owner ruling 2026-08-28: every staff move of a recurring visit shifts its
// future sister visits; server choke point behind GATE_ADMIN_COLLECTIVE_MOVE).
//
// The server refuses a gated date move that was not acknowledged against
// the previewed OCCURRENCE SET: the surface renders ONE line from
//   GET /admin/dispatch/:id/series-move-preview?newDate=YYYY-MM-DD
// and submits `seriesAck: true` + `seriesAckIds: preview.occurrenceIds`.
// A 409 `COLLECTIVE_MOVE_ACK_REQUIRED` carries a refreshed `preview` (the
// plan changed since, or the surface never showed one) — re-render, confirm
// again. A 409 `SERIES_CHANGED` from inside the series transaction means the
// set moved under the lock — reload and start over.
//
// No client computes N: counts and dates come from the rebooker's own
// sibling selection. Gate off: `enabled: false` on the preview, nothing is
// rendered, no ack is sent, the move stays a single-visit move.

import { useEffect, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export const SERIES_ACK_REQUIRED = 'COLLECTIVE_MOVE_ACK_REQUIRED';
export const SERIES_CHANGED = 'SERIES_CHANGED';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(value) {
  const s = String(value || '').split('T')[0];
  return DATE_RE.test(s) ? s : '';
}

// Is `preview` a collective move the surface must disclose? The server's
// preview says `collective: false` (and no occurrenceIds) for one-time rows,
// same-date moves, and rows outside a plan; `enabled: false` when the gate is
// off (the choke point stays dark — the chooser keeps working as before).
export function isCollectivePreview(preview) {
  return !!(preview
    && preview.enabled === true
    && preview.collective === true
    && Array.isArray(preview.occurrenceIds)
    && preview.occurrenceIds.length > 0);
}

// The ack the server binds to the previewed set. Empty when there is nothing
// to acknowledge, so a caller can always spread it into the request body.
export function seriesAckPayload(preview) {
  if (!isCollectivePreview(preview)) return {};
  return { seriesAck: true, seriesAckIds: preview.occurrenceIds.map(String) };
}

function formatDateShort(dateStr) {
  const m = dateOnly(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The one informational line every surface renders. Singular/plural and the
// span come from the server counts; the caveats (visits that stay put, dates
// that now overlap another appointment) ride the same sentence so the
// operator reads one thing before confirming.
export function seriesMoveSummary(preview) {
  if (!isCollectivePreview(preview)) return '';
  const later = Math.max((Number(preview.movableCount) || 1) - 1, 0);
  const through = formatDateShort(preview.lastAffectedDate);
  let line = later === 0
    ? 'Moves this visit — it is the last one in the recurring plan.'
    : `Moves this visit and ${later} later visit${later === 1 ? '' : 's'} in the recurring plan`
      + (through ? ` (through ${through})` : '')
      + '.';
  const notes = [];
  const skipped = Number(preview.skippedCount) || 0;
  if (skipped > 0) notes.push(`${skipped} visit${skipped === 1 ? '' : 's'} in progress or skipped stay${skipped === 1 ? 's' : ''} put`);
  const conflicts = Number(preview.conflictCount) || 0;
  if (conflicts > 0) notes.push(`${conflicts} landing date${conflicts === 1 ? '' : 's'} overlap${conflicts === 1 ? 's' : ''} another appointment`);
  if (notes.length) line += ` ${notes.join('; ')}.`;
  return line;
}

// Normalise the many adminFetch flavours (raw JSON text in err.message, or
// err.code/err.details from the structured helpers) into one shape.
export function parseSeriesAckError(err) {
  if (!err) return null;
  let body = null;
  if (err.details && typeof err.details === 'object') body = err.details;
  else if (err.code) body = { code: err.code, error: err.message, preview: err.preview || null };
  else if (typeof err.message === 'string' && err.message.trim().startsWith('{')) {
    try { body = JSON.parse(err.message); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return null;
  const code = body.code || err.code || null;
  if (code !== SERIES_ACK_REQUIRED && code !== SERIES_CHANGED) return null;
  return { code, message: body.error || err.message || '', preview: body.preview || null };
}

// Operator-facing text from an adminFetch error whose message may be the raw
// JSON error body (the inline grid helpers throw `new Error(text)`).
export function apiErrorMessage(err, fallback = 'Request failed') {
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (msg.trim().startsWith('{')) {
    try {
      const body = JSON.parse(msg);
      if (body && typeof body.error === 'string' && body.error) return body.error;
    } catch { /* not JSON */ }
  }
  return msg || fallback;
}

export async function fetchSeriesMovePreview(serviceId, newDate, { signal } = {}) {
  const r = await fetch(
    `${API_BASE}/admin/dispatch/${encodeURIComponent(serviceId)}/series-move-preview?newDate=${encodeURIComponent(newDate)}`,
    {
      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
      signal,
    },
  );
  if (!r.ok) {
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(text || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

// Fetches the preview whenever the (service, landing date) pair changes and
// a disclosure could apply. `replace(preview)` lets a surface swap in the
// refreshed preview a 409 handed back without a second round-trip.
//
// `preview` is null while loading, on error, and when disabled — callers
// gate on isCollectivePreview(preview), so a failed preview never hides the
// legacy chooser (the server still refuses an un-acked gated move; the
// operator sees that message and the surface refreshes from it).
export function useSeriesMovePreview({ serviceId, fromDate, newDate, enabled = true }) {
  const from = dateOnly(fromDate);
  const to = dateOnly(newDate);
  const active = !!enabled && !!serviceId && !!to && (!from || from !== to);
  const [state, setState] = useState({ key: null, preview: null, loading: false, error: null });
  const key = active ? `${serviceId}|${to}` : null;
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!key) {
      setState({ key: null, preview: null, loading: false, error: null });
      return undefined;
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let cancelled = false;
    setState({ key, preview: null, loading: true, error: null });
    fetchSeriesMovePreview(serviceId, to, { signal: controller?.signal })
      .then((preview) => {
        if (cancelled || keyRef.current !== key) return;
        setState({ key, preview, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled || keyRef.current !== key) return;
        if (err?.name === 'AbortError') return;
        setState({ key, preview: null, loading: false, error: err });
      });
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [key, serviceId, to]);

  const replace = (preview) => {
    setState((prev) => ({ ...prev, preview: preview || null, loading: false, error: null }));
  };

  return {
    preview: state.key === key ? state.preview : null,
    loading: !!key && state.loading,
    error: state.key === key ? state.error : null,
    replace,
  };
}
