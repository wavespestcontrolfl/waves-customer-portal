import { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';

// The Cancel appointment window's "Skip this visit" choice (owner decision
// 2026-11-13): the office can skip one visit of a recurring plan at the
// customer's request. A skip marks the visit Skipped, books no make-up visit
// and sends no customer text. A cancel of the same visit books a make-up
// visit, so the two are separate choices.
//
// The server decides which visit may be skipped (services/visit-skip.js) and
// judges it again when the skip is sent. This file holds what a cancel window
// needs: the verdict (useSkipPreview), the request (skipVisit) and the lines
// the window shows (the default export).

export const SKIP_SCOPE = 'skip';
export const SKIP_LABEL = 'Skip this visit (no make-up visit)';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// YYYY-MM-DD -> 'Oct 1' or, with the weekday, 'Mon, Feb 22, 2027'. Reads the
// date parts directly so the viewer's time zone never shifts the day.
function formatSkipDate(ymd, withWeekday = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const base = `${MONTHS[month - 1]} ${day}`;
  if (!withWeekday) return base;
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}, ${base}, ${year}`;
}

// The server's verdict for one visit: { eligible, code, message,
// nextVisitDate, lawnRound } or null (window closed, not the office, or the
// check failed: the window then offers no skip). `enabled` = the cancel
// window is open for an office user; a technician's window never asks.
export function useSkipPreview(serviceId, { enabled = true } = {}) {
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    // Closed, or another visit: drop the last verdict so a reopen never
    // offers a skip the server has not judged for this visit.
    setPreview(null);
    if (!enabled || !serviceId) return undefined;
    let stale = false;
    adminFetch(`/admin/dispatch/${serviceId}/card-hold?skip=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (!stale) setPreview(json?.skip || null); })
      .catch(() => { if (!stale) setPreview(null); });
    return () => { stale = true; };
  }, [serviceId, enabled]);

  return preview;
}

// Send the skip. `origin` names the screen in the status history note; the
// office's own note is saved with it and is never sent to the customer.
// Throws with the server's sentence when the server refuses.
export async function skipVisit(serviceId, { origin, note = '' }) {
  const trimmed = String(note || '').trim();
  const r = await adminFetch(`/admin/dispatch/${serviceId}/status`, {
    method: 'PUT',
    body: {
      status: 'skipped',
      notes: `Skipped from ${origin}` + (trimmed ? `\nNote: ${trimmed}` : ''),
    },
  });
  if (!r.ok) {
    const json = await r.json().catch(() => ({}));
    throw new Error(json?.error || `HTTP ${r.status}`);
  }
}

// Under the cancel window's choices. A visit that is paid for already says so
// (it is moved, not skipped). With Skip chosen: the plan's next visit and, for
// a lawn plan on rounds, the round the skip drops.
export default function SkipVisitNotice({ preview, chosen }) {
  if (!preview) return null;
  if (!preview.eligible) {
    return preview.code === 'prepaid' && preview.message
      ? <div className="mt-3 text-14 leading-6 text-ink-secondary">{preview.message}</div>
      : null;
  }
  if (!chosen) return null;
  const round = preview.lawnRound;
  return (
    <>
      <div className="mt-3 text-14 leading-6 text-ink-secondary">
        {preview.nextVisitDate
          ? `Next visit: ${formatSkipDate(preview.nextVisitDate, true)}`
          : 'No later visit of this series is booked.'}
      </div>
      {round && (
        <div className="mt-3 text-14 leading-6 text-ink-secondary">
          This skips lawn round {round.round} ({formatSkipDate(round.start)} to {formatSkipDate(round.end)}). Later rounds keep their dates.
        </div>
      )}
    </>
  );
}
