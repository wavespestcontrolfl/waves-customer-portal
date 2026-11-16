import { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';

// "Skip this visit" in a cancel window (owner decision 2026-11-13): the office
// can skip one visit of a recurring plan at the customer's request. A skip
// marks the visit Skipped, books no make-up visit and sends no customer text.
// A cancel of the same visit books a make-up visit, so a skip is its own
// action with its own button: it never goes through the cancel request.
//
// The server decides which visit may be skipped (services/visit-skip.js) and
// judges it again when the skip is sent. This component is the whole choice:
// it asks for the verdict, shows what a skip does, and sends it. A cancel
// window renders one element and changes nothing else.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// YYYY-MM-DD -> 'Oct 1' or, with the weekday, 'Mon, Feb 22, 2027'. Reads the
// date parts directly so the viewer's time zone never shifts the day.
function formatSkipDate(ymd, withWeekday = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd));
  if (!m) return String(ymd);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const base = `${MONTHS[month - 1]} ${day}`;
  if (!withWeekday) return base;
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}, ${base}, ${year}`;
}

// The server's verdict for one visit: { eligible, code, message,
// nextVisitDate, lawnRound }, or null while it loads, when the check failed,
// or when `enabled` is false (a technician's window never asks).
function useSkipPreview(serviceId, enabled) {
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    // Another visit: drop the last verdict, so a skip is never offered on a
    // visit the server has not judged.
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
async function skipVisit(serviceId, origin, note) {
  const trimmed = note.trim();
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

// What the skip leaves on the plan: its next visit and, for a lawn plan on
// nine rounds, the round the skip drops.
function SkipEffectLines({ preview }) {
  const round = preview.lawnRound;
  return (
    <>
      <div className="mt-2 text-14 leading-6 text-ink-secondary">
        {preview.nextVisitDate
          ? `Next visit: ${formatSkipDate(preview.nextVisitDate, true)}`
          : 'No later visit of this series is booked.'}
      </div>
      {round && (
        <div className="mt-1 text-14 leading-6 text-ink-secondary">
          This skips lawn round {round.round} ({formatSkipDate(round.start)} to {formatSkipDate(round.end)}). Later rounds keep their dates.
        </div>
      )}
    </>
  );
}

/**
 * The skip choice of a cancel window. Renders nothing until the server says
 * the visit may be skipped; a visit that is paid for already shows the
 * server's sentence instead (it is moved, not skipped).
 *
 * @param {object} props
 * @param {object} props.service      the visit (its `id` is read)
 * @param {boolean} props.enabled     an office login; false for a technician
 * @param {string} props.origin       the screen, for the status history note
 * @param {Function} [props.onSkipped] called with `service` once the skip is saved
 */
export default function SkipVisitOption({ service, enabled, origin, onSkipped }) {
  const preview = useSkipPreview(service?.id, enabled);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!preview) return null;
  if (!preview.eligible) {
    return preview.code === 'prepaid'
      ? <div className="mt-3 text-14 leading-6 text-ink-secondary">{preview.message}</div>
      : null;
  }

  const confirmSkip = async () => {
    setBusy(true);
    try {
      await skipVisit(service.id, origin, note);
      onSkipped?.(service);
    } catch (err) {
      window.alert('Failed to skip visit: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-3">
      <div className="text-14 font-medium text-zinc-900">Or skip this visit</div>
      <div className="mt-1 text-14 leading-6 text-ink-secondary">
        The visit is marked Skipped. No make-up visit is booked. No text is sent to the customer.
      </div>
      <SkipEffectLines preview={preview} />
      <label className="mt-3 block text-14 text-zinc-900" htmlFor="skip-visit-note">
        Note for the office (not sent to the customer)
      </label>
      <input
        id="skip-visit-note"
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
        className="mt-1 w-full rounded-sm border-hairline border-zinc-300 bg-white px-3 py-2 text-14 text-zinc-900 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
      />
      <button
        type="button"
        onClick={confirmSkip}
        disabled={busy}
        className="mt-3 h-10 px-4 rounded-sm bg-zinc-900 text-13 font-medium uppercase tracking-label text-white disabled:opacity-50 u-focus-ring"
      >
        {busy ? 'Skipping...' : 'Skip this visit'}
      </button>
    </div>
  );
}
