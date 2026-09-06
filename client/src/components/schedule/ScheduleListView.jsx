import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Badge, Button, cn } from '../ui';
import { addETDays, etDateString } from '../../lib/timezone';
import { useBulkSlotConflicts } from './useSlotConflicts';
import { fetchSeriesMovePreview, isCollectivePreview } from './seriesMove';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).split('T')[0].split('-');
  return `${Number(m)}/${Number(day)}`;
}

function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hr} ${ampm}` : `${hr}:${String(m).padStart(2, '0')} ${ampm}`;
}

const STATUS_LABELS = {
  pending: 'Pending', confirmed: 'Confirmed', en_route: 'En Route',
  on_site: 'On Site', completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled',
};

export default function ScheduleListView({ technicians = [], onEdit, onRefresh, refreshKey = 0, lastSave = null }) {
  const [services, setServices] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState(new Set());
  // Scheduling metadata for every selected id, captured at selection time —
  // the selection survives pagination/filter changes while `services` only
  // holds the current page, and Apply submits EVERY selected id, so the
  // bulk conflict check must cover rows no longer loaded. Entries follow
  // the selection: deleted on deselect, cleared when it empties.
  const selectedMetaRef = useRef(new Map());
  const rememberSelectedMeta = useCallback((s) => {
    selectedMetaRef.current.set(s.id, {
      id: s.id,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      durationMinutes: s.estimatedDuration,
      // The bulk reschedule pre-flight below needs these for rows selected
      // on other pages.
      scheduledDate: s.scheduledDate ? String(s.scheduledDate).split('T')[0] : '',
      isRecurring: !!(s.isRecurring ?? s.is_recurring),
      // Plan membership for the bulk-cancel notice: boosters are stored
      // is_recurring=false but carry recurring_parent_id, and legacy series
      // rows carry only recurring_pattern (the shape #3857 handles in the
      // mobile sheet); cancelling either alone leaves its plan running just
      // the same (Codex #3868 r1 + r4).
      inPlan: !!(s.isRecurring ?? s.is_recurring) || !!(s.recurringParentId ?? s.recurring_parent_id) || !!(s.recurringPattern ?? s.recurring_pattern),
    });
  }, []);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sortCol, setSortCol] = useState('scheduledDate');
  const [sortDir, setSortDir] = useState('asc');

  const today = useMemo(() => {
    return etDateString();
  }, []);
  const thirtyDaysOut = useMemo(() => {
    return etDateString(addETDays(new Date(), 30));
  }, []);

  const [filterFrom, setFilterFrom] = useState(today);
  const [filterTo, setFilterTo] = useState(thirtyDaysOut);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterTech, setFilterTech] = useState('');
  const [filterService, setFilterService] = useState('');
  const [filterPrepaid, setFilterPrepaid] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [bulkAction, setBulkAction] = useState('');
  const [bulkTechId, setBulkTechId] = useState('');
  const [bulkDate, setBulkDate] = useState('');
  const [bulkPrepaidAmount, setBulkPrepaidAmount] = useState('');
  const [bulkPrepaidMethod, setBulkPrepaidMethod] = useState('cash');
  // Business-initiated bulk cancels can waive the one-time card-hold
  // late-cancel fee. Default OFF: unchecked keeps today's behavior (an
  // in-window cancel of a held-card visit charges the disclosed fee).
  const [bulkWaiveCardHoldFee, setBulkWaiveCardHoldFee] = useState(false);
  // Whether the batch texts each customer. Seeded per action when it's
  // picked: reschedule defaults silent (matching the drag-and-drop modal),
  // cancel defaults to texting (matching the appointment sidebar).
  const [bulkNotify, setBulkNotify] = useState('none');

  // Only the newest request commits rows, meta and loading: a slower
  // filter/page response landing after the save-driven refresh must not
  // restore pre-edit meta (pre-push hook P1).
  const fetchSeqRef = useRef(0);
  const pendingSaveRef = useRef(null);
  const fetchList = useCallback(async (editedId = null) => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setLoadError(false);
    const params = new URLSearchParams();
    if (filterFrom) params.set('from', filterFrom);
    if (filterTo) params.set('to', filterTo);
    if (filterStatus) params.set('status', filterStatus);
    if (filterTech) params.set('techId', filterTech);
    if (filterService) params.set('serviceType', filterService);
    if (filterPrepaid) params.set('prepaid', filterPrepaid);
    if (filterSearch) params.set('search', filterSearch);
    params.set('page', page);
    params.set('limit', 50);
    // Failed rows remain unverifiable for saved-row selection cleanup,
    // but the rendered error must stay distinct from successful zero matches.
    const data = await adminFetch(`/admin/schedule/list?${params}`).catch(() => null);
    if (seq !== fetchSeqRef.current) return;
    setLoadError(data === null);
    const rows = data?.services || [];
    setServices(rows);
    setTotal(data?.total || 0);
    // A selected row edited meanwhile (e.g. made recurring in the Edit
    // modal) comes back changed — refresh its meta from the fresh page
    // so the bulk pre-flights read the saved row (Codex #3868 r2 P2).
    rows.forEach((s) => { if (selectedMetaRef.current.has(s.id)) rememberSelectedMeta(s); });
    // The row the host just saved may have left the filtered page
    // (date/status/tech/service changed) or the refresh may have failed.
    // Its cached meta is then unverifiable, so drop it from the selection
    // rather than bulk-act on a pre-edit snapshot (Codex #3868 r3 P2).
    // Other-page selections are untouched: only the saved id is checked.
    if (editedId) {
      pendingSaveRef.current = null;
      if (selectedMetaRef.current.has(editedId) && !rows.some((s) => s.id === editedId)) {
        selectedMetaRef.current.delete(editedId);
        setSelected((prev) => { const next = new Set(prev); next.delete(editedId); return next; });
      }
    }
    setLoading(false);
  }, [filterFrom, filterTo, filterStatus, filterTech, filterService, filterPrepaid, filterSearch, page, rememberSelectedMeta]);

  // refreshKey: the host bumps it after any mutation (edit, create,
  // completion, payment…) so the list re-reads rows it did not itself
  // change. lastSave: the host names the visit its Edit / prepay modal
  // just saved (a fresh object per save, so a nested Mark prepaid save
  // followed by the real edit counts twice); only that row is re-verified
  // against the fresh page — a generic bump or a dismissed modal never
  // drops a selection (Codex r3/r5 + pre-push hook P1s).
  // The saved id stays pending until a request carrying it commits: a
  // filter/page fetch started during the save-driven refresh supersedes
  // it (fetchSeqRef) and must verify the row instead (Codex r6).
  const seenSaveRef = useRef(lastSave);
  useEffect(() => {
    if (lastSave && lastSave !== seenSaveRef.current) pendingSaveRef.current = lastSave.id;
    seenSaveRef.current = lastSave;
    fetchList(pendingSaveRef.current);
  }, [fetchList, refreshKey, lastSave]);

  const sorted = useMemo(() => {
    const arr = [...services];
    arr.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [services, sortCol, sortDir]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        selectedMetaRef.current.delete(id);
      } else {
        next.add(id);
        const row = services.find((s) => s.id === id);
        if (row) rememberSelectedMeta(row);
      }
      return next;
    });
  };

  const allVisibleSelected = sorted.length > 0 && sorted.every(s => selected.has(s.id));
  const someVisibleSelected = sorted.some(s => selected.has(s.id));

  const toggleAll = () => {
    if (allVisibleSelected) setSelected(new Set());
    else {
      selectedMetaRef.current.clear();
      sorted.forEach(rememberSelectedMeta);
      setSelected(new Set(sorted.map(s => s.id)));
    }
  };

  // A checked waive must never outlive the selection it was decided for:
  // Clear, deselecting the last row, and Apply all empty the selection and
  // drop the flag here (Apply also resets it explicitly on success).
  useEffect(() => {
    if (selected.size === 0) {
      setBulkWaiveCardHoldFee(false);
      selectedMetaRef.current.clear();
    }
  }, [selected]);

  // Advisory overlap summary for a bulk reschedule — each selected visit
  // keeps its own window on the new date, all selected ids excluded so
  // intra-selection overlap isn't noise. Sourced from the captured metadata,
  // not the current page's rows, so selections retained from other pages are
  // still checked. Warn-only: Apply never disables.
  const bulkConflicts = useBulkSlotConflicts({
    date: bulkDate,
    services: Array.from(selected)
      .map((id) => selectedMetaRef.current.get(id))
      .filter(Boolean),
    enabled: bulkAction === 'reschedule' && !!bulkDate,
  });

  // Bulk cancel writes one row per selected id — the bulk-action route
  // has no scope, so a selected visit of a recurring plan is cancelled
  // alone and its plan keeps generating visits. Say so in the bar while
  // Cancel is chosen, and once more on Apply. Ending a plan stays with the
  // scoped cancel (appointment sidebar / Edit appointment modal). Computed
  // per render (not memoised on `selected`) so a meta refresh after an
  // edit is picked up without a version counter.
  const inPlanSelectedCount = Array.from(selected).filter((id) => selectedMetaRef.current.get(id)?.inPlan).length;
  const bulkCancelPlanNotice = bulkAction === 'cancel' && inPlanSelectedCount > 0
    ? `Selected visits that belong to a recurring plan: ${inPlanSelectedCount}. Only those visits are cancelled and each plan continues. To end a plan, cancel it from the appointment sidebar or the Edit appointment modal.`
    : '';

  const executeBulkAction = async () => {
    if (!bulkAction || selected.size === 0) return;
    if (bulkCancelPlanNotice && !window.confirm(`${bulkCancelPlanNotice}\n\nCancel ${selected.size} selected?`)) return;
    setBulkBusy(true);
    try {
      // Collective series moves (GATE_ADMIN_COLLECTIVE_MOVE): this bulk mover
      // writes one row per visit and cannot shift a recurring plan's later
      // visits — the server refuses those rows (failed[]) while the one-time
      // rows commit. Read each recurring plan first and refuse the WHOLE
      // batch before anything moves, naming where the plan can be moved
      // (GH codex P1). Gate off: previews say collective:false, nothing
      // changes.
      if (bulkAction === 'reschedule') {
        const recurring = Array.from(selected)
          .map((id) => selectedMetaRef.current.get(id))
          .filter((m) => m && m.isRecurring && m.scheduledDate !== bulkDate);
        if (recurring.length > 0) {
          const previews = await Promise.allSettled(recurring.map((m) => fetchSeriesMovePreview(m.id, bulkDate)));
          const unreadable = previews.filter((p) => p.status !== 'fulfilled').length;
          if (unreadable > 0) {
            window.alert(`Couldn't read the recurring plan for ${unreadable} selected visit${unreadable === 1 ? '' : 's'} — nothing was moved. Try again.`);
            setBulkBusy(false);
            return;
          }
          const collective = previews.filter((p) => isCollectivePreview(p.value)).length;
          if (collective > 0) {
            window.alert(
              `${collective} selected visit${collective === 1 ? ' is' : 's are'} part of a recurring plan — with collective moves on, each moves with its later visits, which this list can't do. Nothing was moved. Move ${collective === 1 ? 'it' : 'them'} from the Day/Week grid or the Edit appointment modal, then bulk-move the rest.`,
            );
            setBulkBusy(false);
            return;
          }
        }
      }
      let payload = {};
      if (bulkAction === 'reassign') payload = { technicianId: bulkTechId || null };
      else if (bulkAction === 'reschedule') payload = { scheduledDate: bulkDate, notifyCustomer: bulkNotify === 'text' };
      else if (bulkAction === 'cancel') payload = { waiveCardHoldFee: bulkWaiveCardHoldFee, notifyCustomer: bulkNotify === 'text' };
      else if (bulkAction === 'mark_prepaid') payload = { totalAmount: Number(bulkPrepaidAmount), method: bulkPrepaidMethod };

      const res = await adminFetch('/admin/schedule/bulk-action', {
        method: 'POST',
        body: JSON.stringify({ action: bulkAction, serviceIds: Array.from(selected), payload }),
      });
      // The batch itself committed, but some requested texts didn't go out —
      // tell the operator before the selection (and its context) is cleared.
      if (bulkNotify === 'text' && Array.isArray(res?.notificationFailures) && res.notificationFailures.length > 0) {
        const lines = res.notificationFailures.slice(0, 8).map(f => `• ${f.reason}`);
        window.alert(
          `${bulkAction === 'cancel' ? 'Cancelled' : 'Rescheduled'}, but ${res.notificationFailures.length} customer(s) were not texted:\n${lines.join('\n')}`,
        );
      }
      // Rows the server refused (a recurring plan under the collective gate,
      // a terminal row, …) — say so before the selection is cleared instead
      // of reading the HTTP 200 as a full success.
      if (Array.isArray(res?.failed) && res.failed.length > 0) {
        const lines = res.failed.slice(0, 8).map((f) => `• ${f.reason}`);
        window.alert(
          `${res.updatedCount ?? 0} updated, ${res.failed.length} not updated:\n${lines.join('\n')}`,
        );
      }
      // Advisory schedule-overlap notes — the moves committed (conflicts no
      // longer block staff saves); say which rows now stack before the
      // selection is cleared.
      if (Array.isArray(res?.overlapWarnings) && res.overlapWarnings.length > 0) {
        window.alert(
          `Moved. ${res.overlapWarnings.length} visit(s) now overlap another appointment on the schedule — all are kept on the calendar.`,
        );
      }
      setSelected(new Set());
      setBulkAction('');
      // One decision per bulk cancel: never let a checked waive leak into
      // the next batch and silently forfeit disclosed fees.
      setBulkWaiveCardHoldFee(false);
      fetchList();
      onRefresh?.();
    } catch (e) {
      window.alert('Bulk action failed: ' + e.message);
    }
    setBulkBusy(false);
  };

  const thClass = 'text-left text-11 uppercase tracking-label font-medium text-zinc-500 px-3 py-2 border-b border-hairline border-zinc-200 cursor-pointer hover:text-zinc-900 select-none whitespace-nowrap';
  const tdClass = 'px-3 py-2.5 text-13 border-b border-hairline border-zinc-100';

  const SortIndicator = ({ col }) => {
    if (sortCol !== col) return null;
    return <span className="ml-0.5 text-zinc-400">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2 px-1">
        <label className="flex flex-col gap-0.5">
          <span className="text-10 uppercase tracking-label text-zinc-500 font-medium">From</span>
          <input type="date" value={filterFrom} onChange={e => { setFilterFrom(e.target.value); setPage(1); }}
            className="text-12 u-nums px-2 py-1.5 border-hairline border-zinc-300 rounded-sm" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-10 uppercase tracking-label text-zinc-500 font-medium">To</span>
          <input type="date" value={filterTo} onChange={e => { setFilterTo(e.target.value); setPage(1); }}
            className="text-12 u-nums px-2 py-1.5 border-hairline border-zinc-300 rounded-sm" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-10 uppercase tracking-label text-zinc-500 font-medium">Status</span>
          <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
            className="text-12 px-2 py-1.5 border-hairline border-zinc-300 rounded-sm">
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="en_route">En Route</option>
            <option value="on_site">On Site</option>
            <option value="completed">Completed</option>
            <option value="skipped">Skipped</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-10 uppercase tracking-label text-zinc-500 font-medium">Tech</span>
          <select value={filterTech} onChange={e => { setFilterTech(e.target.value); setPage(1); }}
            className="text-12 px-2 py-1.5 border-hairline border-zinc-300 rounded-sm">
            <option value="">All</option>
            <option value="unassigned">Unassigned</option>
            {technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-10 uppercase tracking-label text-zinc-500 font-medium">Prepaid</span>
          <select value={filterPrepaid} onChange={e => { setFilterPrepaid(e.target.value); setPage(1); }}
            className="text-12 px-2 py-1.5 border-hairline border-zinc-300 rounded-sm">
            <option value="">All</option>
            <option value="true">Prepaid</option>
            <option value="false">Not prepaid</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-10 uppercase tracking-label text-zinc-500 font-medium">Search</span>
          <input type="text" value={filterSearch} onChange={e => { setFilterSearch(e.target.value); setPage(1); }}
            placeholder="Name or service…"
            className="text-12 px-2 py-1.5 border-hairline border-zinc-300 rounded-sm w-36" />
        </label>
        <div className="flex-1" />
        {!loading && !loadError && <span className="text-12 text-zinc-500 u-nums self-end pb-1.5">{total} results</span>}
      </div>

      {/* Bulk actions toolbar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-zinc-900 text-white rounded-sm text-12">
          <span className="u-nums font-medium">{selected.size} selected</span>
          <span className="text-zinc-500">·</span>
          <select value={bulkAction}
            onChange={e => { setBulkAction(e.target.value); setBulkWaiveCardHoldFee(false); setBulkNotify(e.target.value === 'cancel' ? 'text' : 'none'); }}
            className="text-12 px-2 py-1 rounded-sm bg-zinc-800 text-white border border-zinc-600">
            <option value="">Choose action…</option>
            <option value="reassign">Reassign tech</option>
            <option value="reschedule">Reschedule</option>
            <option value="cancel">Cancel</option>
            <option value="mark_prepaid">Mark prepaid</option>
          </select>
          {bulkAction === 'reassign' && (
            <select value={bulkTechId} onChange={e => setBulkTechId(e.target.value)}
              className="text-12 px-2 py-1 rounded-sm bg-zinc-800 text-white border border-zinc-600">
              <option value="">Unassign</option>
              {technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {bulkAction === 'reschedule' && (
            <input type="date" value={bulkDate} onChange={e => setBulkDate(e.target.value)}
              className="text-12 u-nums px-2 py-1 rounded-sm bg-zinc-800 text-white border border-zinc-600" />
          )}
          {(bulkAction === 'reschedule' || bulkAction === 'cancel') && (
            <select value={bulkNotify} onChange={e => setBulkNotify(e.target.value)}
              className="text-12 px-2 py-1 rounded-sm bg-zinc-800 text-white border border-zinc-600">
              <option value="text">Text each customer</option>
              <option value="none">Don&rsquo;t send notifications</option>
            </select>
          )}
          {bulkAction === 'cancel' && (
            <label className="flex items-center gap-1.5 text-12 text-zinc-300 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={bulkWaiveCardHoldFee}
                onChange={e => setBulkWaiveCardHoldFee(e.target.checked)}
                className="accent-white"
              />
              Waive card-hold late-cancel fees (Waves-initiated)
            </label>
          )}
          {bulkAction === 'mark_prepaid' && (
            <>
              <input type="number" value={bulkPrepaidAmount} onChange={e => setBulkPrepaidAmount(e.target.value)}
                placeholder="$" min="0" step="0.01"
                className="text-12 u-nums px-2 py-1 rounded-sm bg-zinc-800 text-white border border-zinc-600 w-20" />
              <select value={bulkPrepaidMethod} onChange={e => setBulkPrepaidMethod(e.target.value)}
                className="text-12 px-2 py-1 rounded-sm bg-zinc-800 text-white border border-zinc-600">
                <option value="cash">Cash</option>
                <option value="zelle">Zelle</option>
                <option value="venmo">Venmo</option>
                <option value="paypal">PayPal</option>
                <option value="check">Check</option>
                <option value="card_over_phone">Card</option>
              </select>
            </>
          )}
          {bulkAction && (
            // variant=secondary, not primary + white overrides: cn() is plain
            // clsx, so the old bg-white/text-zinc-900 overrides lost the
            // stylesheet-order conflict and rendered Apply black-on-black.
            <Button
              size="sm"
              variant="secondary"
              onClick={executeBulkAction}
              // loading: a bulk action must not read selection meta while
              // the save-driven refresh is still in flight (Codex #3868 r4).
              disabled={bulkBusy || loading || loadError || (bulkAction === 'reschedule' && !bulkDate) || (bulkAction === 'mark_prepaid' && !bulkPrepaidAmount)}
              className="rounded-sm"
            >
              {bulkBusy ? 'Applying…' : 'Apply'}
            </Button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={() => setSelected(new Set())}
            className="text-11 text-zinc-400 hover:text-white">Clear</button>
          {bulkAction === 'reschedule' && (bulkConflicts.conflictCount > 0 || bulkConflicts.truncated) && (
            <span className="basis-full text-11" style={{ color: '#FDE68A' }}>
              {bulkConflicts.conflictCount > 0
                ? `⚠️ ${bulkConflicts.conflictCount} of the selected visits overlap existing appointments on ${bulkDate}.`
                : '⚠️ Overlap check covered only the first 25 selected visits.'}
              {bulkConflicts.conflictCount > 0 && bulkConflicts.truncated ? ' (checked first 25)' : ''}
            </span>
          )}
          {bulkCancelPlanNotice && (
            <span className="basis-full text-11" style={{ color: '#FDE68A' }}>
              ⚠️ {bulkCancelPlanNotice}
            </span>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[700px]">
          <thead>
            <tr>
              <th className={cn(thClass, 'w-8')}>
                <input type="checkbox" checked={allVisibleSelected}
                  aria-label="Select all visible appointments"
                  ref={node => { if (node) node.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                  disabled={loading || loadError || sorted.length === 0}
                  onChange={toggleAll}
                  className="w-4 h-4" style={{ accentColor: '#18181B' }} />
              </th>
              <th className={thClass} onClick={() => toggleSort('customerName')}>Customer<SortIndicator col="customerName" /></th>
              <th className={thClass} onClick={() => toggleSort('serviceType')}>Service<SortIndicator col="serviceType" /></th>
              <th className={thClass} onClick={() => toggleSort('scheduledDate')}>Date<SortIndicator col="scheduledDate" /></th>
              <th className={thClass}>Time</th>
              <th className={thClass} onClick={() => toggleSort('technicianName')}>Tech<SortIndicator col="technicianName" /></th>
              <th className={thClass} onClick={() => toggleSort('status')}>Status<SortIndicator col="status" /></th>
              <th className={thClass}>Prepaid</th>
              <th className={cn(thClass, 'text-right')} onClick={() => toggleSort('estimatedPrice')}>Price<SortIndicator col="estimatedPrice" /></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-zinc-400 text-13">Loading…</td></tr>
            )}
            {!loading && loadError && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-14">
                <div role="alert" className="text-alert-fg mb-3">Failed to load appointments</div>
                <Button onClick={() => fetchList(pendingSaveRef.current)}>Retry</Button>
              </td></tr>
            )}
            {!loading && !loadError && sorted.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-zinc-400 text-13">No appointments match your filters</td></tr>
            )}
            {!loading && sorted.map(s => {
              const isSelected = selected.has(s.id);
              return (
                <tr
                  key={s.id}
                  className={cn('hover:bg-zinc-50 cursor-pointer', isSelected && 'bg-zinc-50')}
                  onClick={() => onEdit?.(s)}
                >
                  <td className={tdClass} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={isSelected}
                      onChange={() => toggleSelect(s.id)}
                      className="w-4 h-4" style={{ accentColor: '#18181B' }} />
                  </td>
                  <td className={cn(tdClass, 'font-medium text-zinc-900')}>
                    {s.customerName || 'Unassigned'}
                    {s.tier && <Badge tone="neutral" className="ml-1.5">{s.tier}</Badge>}
                  </td>
                  <td className={tdClass}>{s.serviceType}</td>
                  <td className={cn(tdClass, 'u-nums')}>{fmtDate(s.scheduledDate)}</td>
                  <td className={cn(tdClass, 'u-nums')}>{fmtTime(s.windowStart)}{s.windowEnd ? `–${fmtTime(s.windowEnd)}` : ''}</td>
                  <td className={tdClass}>{s.technicianName || <span className="text-zinc-400">—</span>}</td>
                  <td className={tdClass}>
                    <Badge tone={s.status === 'completed' ? 'neutral' : s.status === 'cancelled' || s.status === 'skipped' ? 'alert' : 'strong'}>
                      {STATUS_LABELS[s.status] || s.status}
                    </Badge>
                  </td>
                  <td className={tdClass}>
                    {s.prepaidAmount > 0 ? (
                      <span
                        className="inline-flex items-center rounded-full uppercase tracking-label font-medium"
                        style={{ height: 18, padding: '0 8px', background: '#DCFCE7', color: '#166534', fontSize: 10 }}
                      >Paid</span>
                    ) : <span className="text-zinc-300">—</span>}
                  </td>
                  <td className={cn(tdClass, 'text-right u-nums')}>
                    {s.estimatedPrice != null ? `$${s.estimatedPrice.toFixed(2)}` : <span className="text-zinc-300">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 50 && (
        <div className="flex items-center justify-center gap-3 py-2">
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="text-12 px-3 py-1 border-hairline border-zinc-300 rounded-sm disabled:opacity-40">Prev</button>
          <span className="text-12 u-nums text-zinc-500">Page {page} of {Math.ceil(total / 50)}</span>
          <button type="button" disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(p => p + 1)}
            className="text-12 px-3 py-1 border-hairline border-zinc-300 rounded-sm disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  );
}
