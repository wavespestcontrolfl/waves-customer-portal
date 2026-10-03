import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAdminAuthToken } from '../../lib/adminAuth';

// Schedule changes on the Today page (owner ruling 2026-10-03). A change that
// touches today or tomorrow keeps its own card; every other one folds into a
// single summary ("Auto-dispatch moved 20 visits") with Review and Clear all.
// The server marks `soon` (routes/tech-notifications.js /schedule-changes).

const API = import.meta.env.VITE_API_URL || '';
const POLL_MS = 60_000;
const VERB = { visit_assigned: 'Assigned', visit_unassigned: 'Reassigned', visit_rescheduled: 'Moved', visit_cancelled: 'Cancelled' };
const AUTO_DISPATCH = 'by auto-dispatch';

async function api(path, options = {}) {
  const res = await fetch(`${API}/api/tech/notifications${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAdminAuthToken()}` },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function shortDay(iso) {
  if (!iso) return null;
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// EARLIER / LATER / SAME DAY for a move both of whose days are known.
function direction(change) {
  const { date, previous_date: before } = change.payload || {};
  if (change.type !== 'visit_rescheduled' || !date || !before) return null;
  if (date < before) return 'EARLIER';
  if (date > before) return 'LATER';
  return 'SAME DAY';
}

// Two visits that traded slots name each other.
function swapPartners(changes) {
  const partners = new Map();
  for (const a of changes) {
    const pa = a.payload || {};
    if (a.type !== 'visit_rescheduled' || !pa.previous_when) continue;
    const b = changes.find((c) => c !== a && c.type === 'visit_rescheduled'
      && c.payload?.when === pa.previous_when && c.payload?.previous_when === pa.when);
    if (b) partners.set(a.id, b.payload?.customer_name || 'another visit');
  }
  return partners;
}

function detailLines(change) {
  const p = change.payload || {};
  const lines = [];
  if (change.type === 'visit_rescheduled') {
    if (p.service_type) lines.push({ text: p.service_type });
    if (p.previous_when) lines.push({ text: `Was ${p.previous_when}`, struck: true });
    if (p.when) lines.push({ text: `Now ${p.when}` });
  } else {
    lines.push({ text: [p.service_type, p.when].filter(Boolean).join(' · ') });
    if (change.type === 'visit_assigned' && p.address) lines.push({ text: p.address });
    if (change.type === 'visit_unassigned') lines.push({ text: p.ended ? `Now ${p.ended}` : (p.now_with ? `Now with ${p.now_with}` : 'Now unassigned') });
  }
  if (p.actor) lines.push({ text: `${VERB[change.type]} ${p.actor}` });
  return lines.filter((line) => line.text);
}

// One today/tomorrow change: its own card with Got it.
function SoonCard({ change, onDismiss, busy }) {
  const p = change.payload || {};
  return (
    <article className="tf-card" data-testid="schedule-change-soon">
      <div className="tf-card-top">{p.headline || 'Schedule change'}</div>
      <div className="tf-card-main">
        <h2>{p.customer_name || 'Customer'}</h2>
        {detailLines(change).map((line, i) => (
          <p key={i} className={line.struck ? 'tf-muted tf-struck' : 'tf-muted'}>{line.text}</p>
        ))}
        <div className="tf-actions"><button type="button" className="tf-button" onClick={() => onDismiss(change)} disabled={busy}>Got it</button></div>
      </div>
    </article>
  );
}

function summaryOf(changes) {
  const n = changes.length;
  const allAuto = changes.every((c) => c.type === 'visit_rescheduled' && c.payload?.actor === AUTO_DISPATCH);
  const title = allAuto ? `Auto-dispatch moved ${plural(n, 'visit')}` : plural(n, 'schedule change');
  const services = new Set(changes.map((c) => c.payload?.service_type).filter(Boolean));
  const days = changes.map((c) => c.payload?.date).filter(Boolean).sort();
  const counts = { EARLIER: 0, LATER: 0 };
  for (const c of changes) { const d = direction(c); if (d in counts) counts[d] += 1; }
  const parts = [];
  if (n > 1 && services.size === 1) parts.push(`All ${[...services][0]}`);
  if (days.length) parts.push(days[0] === days[days.length - 1] ? shortDay(days[0]) : `${shortDay(days[0])} – ${shortDay(days[days.length - 1])}`);
  const moved = [counts.EARLIER && `${counts.EARLIER} earlier`, counts.LATER && `${counts.LATER} later`].filter(Boolean).join(', ');
  if (moved) parts.push(moved);
  const allMoves = changes.every((c) => c.type === 'visit_rescheduled');
  return { title, detail: parts.join(' · '), counts, reviewLabel: allMoves ? 'Review moves' : 'Review changes' };
}

const FILTERS = [['ALL', 'All'], ['EARLIER', 'Earlier'], ['LATER', 'Later']];

function ReviewList({ changes, summary, onClearAll, onBack, busy, canOpenDispatch }) {
  const [filter, setFilter] = useState('ALL');
  const partners = useMemo(() => swapPartners(changes), [changes]);
  const shown = filter === 'ALL' ? changes : changes.filter((c) => direction(c) === filter);
  const count = { ALL: changes.length, ...summary.counts };
  return (
    <section className="tf-card" aria-label="Review schedule changes" data-testid="schedule-changes-review">
      <div className="tf-card-top tf-review-top">
        <button type="button" className="tf-button tf-ghost" onClick={onBack}>Back</button>
        <span>{summary.title}</span>
      </div>
      <div className="tf-card-main">
        {summary.detail && <p className="tf-muted">{summary.detail}</p>}
        {(count.EARLIER > 0 || count.LATER > 0) && (
          <div className="tf-chips" role="group" aria-label="Filter moves">
            {FILTERS.filter(([key]) => key === 'ALL' || count[key] > 0).map(([key, label]) => (
              <button key={key} type="button" className="tf-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label} {count[key]}
              </button>
            ))}
          </div>
        )}
        <ul className="tf-change-list">
          {shown.map((c) => {
            const p = c.payload || {};
            const dir = direction(c);
            return (
              <li key={c.id} className="tf-change-row">
                <div className="tf-change-head"><strong>{p.customer_name || 'Customer'}</strong>{dir && <span className="tf-dir">{dir}</span>}</div>
                {c.type === 'visit_rescheduled' && p.previous_when
                  ? <div className="tf-change-when"><span className="tf-struck">{p.previous_when}</span><span aria-hidden="true"> → </span><strong>{p.when}</strong></div>
                  : <div className="tf-change-when">{p.headline}{p.when ? ` · ${p.when}` : ''}</div>}
                <div className="tf-muted">{[p.service_type, partners.has(c.id) && `Swapped with ${partners.get(c.id)}`].filter(Boolean).join(' · ')}</div>
              </li>
            );
          })}
        </ul>
        <div className="tf-actions">
          {canOpenDispatch && <Link className="tf-button" to="/admin/dispatch?tab=schedule">Open in Dispatch</Link>}
          <button type="button" className="tf-button tf-primary" onClick={onClearAll} disabled={busy}>
            {busy ? 'Clearing…' : `Got it, clear all ${changes.length}`}
          </button>
        </div>
      </div>
    </section>
  );
}

export default function TechScheduleChanges({ canOpenDispatch = false }) {
  const [changes, setChanges] = useState([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api('/schedule-changes');
      setChanges(Array.isArray(data.changes) ? data.changes : []);
    } catch {
      // A failed poll keeps what is on screen; the next one retries.
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    return () => { clearInterval(id); window.removeEventListener('focus', load); };
  }, [load]);

  const soon = changes.filter((c) => c.soon);
  const later = changes.filter((c) => !c.soon);
  const summary = useMemo(() => summaryOf(later), [later]);

  const dismissOne = async (change) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/${change.id}/dismiss`, { method: 'POST' });
      setChanges((prev) => prev.filter((c) => c.id !== change.id));
    } catch {
      setError('Could not clear that card. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = later.map((c) => c.id);
      await api('/dismiss-batch', { method: 'POST', body: JSON.stringify({ ids }) });
      setChanges((prev) => prev.filter((c) => !ids.includes(c.id)));
      setReviewing(false);
    } catch {
      setError('Could not clear the schedule changes. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!changes.length) return null;
  return (
    <div className="tf-changes">
      {error && <div role="alert" className="tf-alert tf-error">{error}</div>}
      {soon.map((c) => <SoonCard key={c.id} change={c} onDismiss={dismissOne} busy={busy} />)}
      {later.length > 0 && (reviewing
        ? <ReviewList changes={later} summary={summary} onClearAll={clearAll} onBack={() => setReviewing(false)} busy={busy} canOpenDispatch={canOpenDispatch} />
        : (
          <section className="tf-card" aria-label="Schedule changes" data-testid="schedule-changes-summary">
            <div className="tf-card-top"><span className="tf-dot" aria-hidden="true" />Schedule changes</div>
            <div className="tf-card-main">
              <h2>{summary.title}</h2>
              {summary.detail && <p className="tf-muted">{summary.detail}</p>}
              <div className="tf-actions">
                <button type="button" className="tf-button" onClick={() => setReviewing(true)}>{summary.reviewLabel}</button>
                <button type="button" className="tf-button tf-ghost" onClick={clearAll} disabled={busy}>Clear all</button>
              </div>
            </div>
          </section>
        ))}
    </div>
  );
}
