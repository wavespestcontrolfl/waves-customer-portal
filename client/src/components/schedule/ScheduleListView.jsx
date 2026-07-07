import { useState, useEffect, useCallback, useMemo } from 'react';
import { Badge, Button, cn } from '../ui';
import { addETDays, etDateString } from '../../lib/timezone';

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

export default function ScheduleListView({ technicians = [], onEdit, onRefresh }) {
  const [services, setServices] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
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

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
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
      const data = await adminFetch(`/admin/schedule/list?${params}`);
      setServices(data.services || []);
      setTotal(data.total || 0);
    } catch { setServices([]); setTotal(0); }
    setLoading(false);
  }, [filterFrom, filterTo, filterStatus, filterTech, filterService, filterPrepaid, filterSearch, page]);

  useEffect(() => { fetchList(); }, [fetchList]);

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
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === sorted.length) setSelected(new Set());
    else setSelected(new Set(sorted.map(s => s.id)));
  };

  const executeBulkAction = async () => {
    if (!bulkAction || selected.size === 0) return;
    setBulkBusy(true);
    try {
      let payload = {};
      if (bulkAction === 'reassign') payload = { technicianId: bulkTechId || null };
      else if (bulkAction === 'reschedule') payload = { scheduledDate: bulkDate };
      else if (bulkAction === 'cancel') payload = { waiveCardHoldFee: bulkWaiveCardHoldFee };
      else if (bulkAction === 'mark_prepaid') payload = { totalAmount: Number(bulkPrepaidAmount), method: bulkPrepaidMethod };

      await adminFetch('/admin/schedule/bulk-action', {
        method: 'POST',
        body: JSON.stringify({ action: bulkAction, serviceIds: Array.from(selected), payload }),
      });
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
        <span className="text-12 text-zinc-500 u-nums self-end pb-1.5">{total} results</span>
      </div>

      {/* Bulk actions toolbar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-zinc-900 text-white rounded-sm text-12">
          <span className="u-nums font-medium">{selected.size} selected</span>
          <span className="text-zinc-500">·</span>
          <select value={bulkAction} onChange={e => setBulkAction(e.target.value)}
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
              disabled={bulkBusy || (bulkAction === 'reschedule' && !bulkDate) || (bulkAction === 'mark_prepaid' && !bulkPrepaidAmount)}
              className="rounded-sm"
            >
              {bulkBusy ? 'Applying…' : 'Apply'}
            </Button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={() => setSelected(new Set())}
            className="text-11 text-zinc-400 hover:text-white">Clear</button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[700px]">
          <thead>
            <tr>
              <th className={cn(thClass, 'w-8')}>
                <input type="checkbox" checked={selected.size > 0 && selected.size === sorted.length}
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
            {!loading && sorted.length === 0 && (
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
