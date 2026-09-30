import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Input, Select } from '../ui';
import { adminFetch } from '../../utils/admin-fetch';

const AREA_LABELS = { beds: 'Ornamental beds', lawn: 'Treatable lawn', mosquito: 'Mosquito coverage' };
const SOURCES = { imagery: 'Satellite estimate', field: 'Field measurement', recorded: 'Recorded area', computed: 'Property estimate' };
const SERVICE_AREAS = { tree_shrub: 'beds', lawn: 'lawn', mosquito: 'mosquito' };
const controlClass = 'min-h-11 text-14 normal-case tracking-normal';
const displayArea = value => Number(value).toLocaleString('en-US');
// Which property a response describes. `addressKey` is compared once the
// server exposes it; until then a reassigned visit shows as a new propertyId.
const identityOf = result => [result?.customerId ?? '', result?.propertyId ?? '', result?.addressKey ?? ''].join('|');
const draftFrom = result => Object.fromEntries(Object.keys(AREA_LABELS).map(key => [key, {
  sqft: result.areas[key]?.sqft ?? '', source: result.areas[key]?.source || 'field', reviewed: false,
}]));

/** Shared property editor. The parent owns this visit's coverage and product
 * actuals; only an explicit reviewed-area save writes the property. */
export default function PropertyServiceAreas({ serviceId, serviceLine, customerId, propertyId,
  visitArea, onVisitAreaChange, onMeasurements, onUnavailable, refreshToken, disabled = false }) {
  const endpoint = serviceId ? `/admin/schedule/${serviceId}/property-areas`
    : customerId && propertyId ? `/admin/customers/${customerId}/properties/${propertyId}/areas` : null;
  const activeKey = SERVICE_AREAS[serviceLine];
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [message, setMessage] = useState('');
  const [stale, setStale] = useState(false);
  const epoch = useRef(0);
  const current = useRef({ endpoint, onMeasurements, onUnavailable });
  current.current = { endpoint, onMeasurements, onUnavailable };

  useEffect(() => {
    const generation = ++epoch.current;
    let alive = true;
    setData(null); setError(''); setOpen(false); setBusy(false); setMessage(''); setStale(false);
    current.current.onMeasurements?.(null);
    if (!endpoint || (serviceId && !activeKey)) return undefined;
    adminFetch(endpoint).then(result => {
      if (!alive || generation !== epoch.current) return;
      if (!result?.enabled) { current.current.onUnavailable?.(); return; }
      setData(result); current.current.onMeasurements?.(result);
    }).catch(err => {
      if (!alive || generation !== epoch.current) return;
      current.current.onUnavailable?.();
      if (err.status !== 404) setError('Property areas are unavailable. Enter the area treated for this visit.');
    });
    return () => { alive = false; };
  }, [endpoint, serviceId, activeKey, refreshToken]);

  function editAreas() {
    setDraft(Object.fromEntries(Object.keys(AREA_LABELS).map(key => [key, {
      sqft: data.areas[key]?.sqft ?? '', source: data.areas[key]?.source || 'field', reviewed: false,
    }])));
    setError(''); setStale(false); setOpen(true);
  }

  async function refreshLookup() {
    setBusy(true); setError('');
    const startedFor = endpoint;
    const generation = epoch.current;
    try {
      const result = await adminFetch(`${endpoint}/lookup`, { method: 'POST', body: '{}' });
      if (current.current.endpoint !== startedFor || generation !== epoch.current) return;
      setData(result); current.current.onMeasurements?.(result);
      setMessage('Property estimates updated. Reviewed measurements were kept.');
    } catch (err) {
      if (current.current.endpoint === startedFor && generation === epoch.current) setError(err.message || 'The property lookup could not finish. Retry or enter a measured area.');
    } finally { if (current.current.endpoint === startedFor && generation === epoch.current) setBusy(false); }
  }

  async function saveAreas(event) {
    event.preventDefault();
    const areas = {};
    for (const [key, value] of Object.entries(draft)) {
      if (!value.reviewed) continue;
      const sqft = value.sqft === '' ? NaN : Number(value.sqft);
      if (!Number.isInteger(sqft) || sqft < 0 || sqft > 1000000) {
        setError('Enter a whole number from 0 to 1,000,000 sq ft for each reviewed area.'); return;
      }
      areas[key] = { sqft, source: value.source };
    }
    if (!Object.keys(areas).length) { setError('Select the areas you reviewed.'); return; }
    setBusy(true); setError('');
    const startedFor = endpoint;
    const generation = epoch.current;
    try {
      const result = await adminFetch(endpoint, { method: 'PUT', body: JSON.stringify({ areas, version: data.version }) });
      if (current.current.endpoint !== startedFor || generation !== epoch.current) return;
      setData(result); current.current.onMeasurements?.(result); setOpen(false);
      setMessage('Reviewed property areas saved for future visits.');
    } catch (err) {
      if (current.current.endpoint === startedFor && generation === epoch.current) {
        setError(err.message || 'Areas could not be saved. Your edits are still here.');
        setStale(err.status === 409);
      }
    } finally { if (current.current.endpoint === startedFor && generation === epoch.current) setBusy(false); }
  }

  async function reloadSavedAreas() {
    setBusy(true);
    const startedFor = endpoint;
    const generation = epoch.current;
    try {
      const result = await adminFetch(endpoint);
      if (current.current.endpoint !== startedFor || generation !== epoch.current) return;
      setData(result); current.current.onMeasurements?.(result);
      let notice = '';
      if (identityOf(result) !== identityOf(data)) {
        // The visit now points at a different property (or address): the
        // measurements typed for the former one must not be saved onto it.
        setDraft(draftFrom(result));
        notice = 'This visit\'s property changed. The areas shown are the current property\'s; review them before saving.';
      } else {
        // Ordinary concurrent measurement edit: keep the correction, but
        // require another review against the new saved values before
        // replacing someone else's change.
        setDraft(previous => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, { ...value, reviewed: false }])));
      }
      setStale(false); setError(notice);
    } catch (err) {
      if (current.current.endpoint === startedFor && generation === epoch.current) setError(err.message || 'Could not reload the saved areas.');
    } finally { if (current.current.endpoint === startedFor && generation === epoch.current) setBusy(false); }
  }

  if (!data) return error ? <p role="status" className="text-14 text-zinc-600 my-3">{error}</p> : null;
  const shownKeys = activeKey ? [activeKey] : Object.keys(AREA_LABELS);
  const savedArea = activeKey ? data.areas[activeKey] : null;
  const effectiveVisitArea = visitArea ?? (savedArea?.reviewedAt ? savedArea.sqft : '');
  return <>
    <Card className="my-4 p-4 text-14 text-zinc-900">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-14 font-medium">Property areas</h3>
        <Button variant="ghost" className={controlClass} onClick={editAreas} disabled={disabled || busy}>Review areas</Button>
      </div>
      <div className="flex flex-wrap gap-4">
        {shownKeys.map(key => <div key={key} className="flex-1 min-w-[220px] max-w-full">
          <div className="flex items-baseline justify-between gap-3"><span className="text-zinc-600">{AREA_LABELS[key]}</span>
            <span className="font-medium tabular-nums whitespace-nowrap">{data.areas[key] ? `${displayArea(data.areas[key].sqft)} sq ft` : 'Not recorded'}</span></div>
          {data.areas[key] && <p className="text-zinc-600 mt-1">{SOURCES[data.areas[key].source]} · {data.areas[key].reviewedAt ? 'Reviewed' : 'Not reviewed'}</p>}
        </div>)}
      </div>
      {activeKey && onVisitAreaChange && <div className="mt-4 pt-3 border-t border-zinc-200">
        <label className="block">Area treated today (sq ft)
          <Input className="mt-1 min-h-11 text-16" type="number" min="0" max="1000000" step="1" inputMode="numeric"
            value={effectiveVisitArea} disabled={disabled} onChange={event => onVisitAreaChange(event.target.value)} />
        </label>
        {visitArea != null && savedArea?.reviewedAt && <Button variant="ghost" className={controlClass} disabled={disabled}
          onClick={() => onVisitAreaChange(null)}>Use property area</Button>}
      </div>}
      {['beds', 'lawn'].some(key => !data.areas[key]) && <Button variant="ghost" className={controlClass}
        disabled={disabled || busy} onClick={refreshLookup}>{busy ? 'Looking up property…' : 'Get area estimate'}</Button>}
      {message && <p role="status" className="text-zinc-600 mt-2">{message}</p>}
      {error && !open && <p role="alert" className="text-alert-fg mt-2">{error}</p>}
    </Card>
    <Dialog open={open} onClose={() => !busy && setOpen(false)} layer={1300}>
      <form onSubmit={saveAreas} className="flex flex-col min-h-0 h-full">
        <DialogHeader><DialogTitle>Review property areas</DialogTitle></DialogHeader>
        <DialogBody className="overflow-y-auto text-14">
          {Object.keys(AREA_LABELS).map(key => <div key={key} className="py-3 border-b border-zinc-200">
            <h3 className="text-14 font-medium">{AREA_LABELS[key]}</h3>
            {data.areas[key] && (String(draft[key]?.sqft) !== String(data.areas[key].sqft) || draft[key]?.source !== data.areas[key].source)
              && <p className="text-zinc-600 mt-1">Current: {displayArea(data.areas[key].sqft)} sq ft · {SOURCES[data.areas[key].source]}</p>}
            <div className="grid sm:grid-cols-2 gap-3 mt-2">
              <label>Area (sq ft)<Input className="mt-1 min-h-11 text-16" aria-label={`${AREA_LABELS[key]} square feet`}
                type="number" min="0" max="1000000" step="1" value={draft[key]?.sqft ?? ''} disabled={busy}
                onChange={event => setDraft(prev => ({ ...prev, [key]: { ...prev[key], sqft: event.target.value, reviewed: false } }))} /></label>
              <label>Measurement source<Select className="mt-1 min-h-11 text-14" value={draft[key]?.source || 'field'} disabled={busy}
                onChange={event => setDraft(prev => ({ ...prev, [key]: { ...prev[key], source: event.target.value, reviewed: false } }))}>
                {Object.entries(SOURCES).map(([value,label]) => <option value={value} key={value}>{label}</option>)}
              </Select></label>
            </div>
            <label className="flex items-center gap-3 min-h-11 mt-1"><input type="checkbox" className="h-5 w-5 accent-zinc-900"
              checked={draft[key]?.reviewed || false} disabled={busy} onChange={event => setDraft(prev => ({ ...prev, [key]: { ...prev[key], reviewed: event.target.checked } }))} />Reviewed for this property</label>
          </div>)}
          {error && <p role="alert" className="text-alert-fg mt-3">{error}</p>}
          {stale && <Button variant="secondary" className={controlClass} disabled={busy} onClick={reloadSavedAreas}>Load latest saved areas</Button>}
        </DialogBody>
        <DialogFooter><Button variant="secondary" className={controlClass} disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" className={controlClass} disabled={busy}>{busy ? 'Saving…' : 'Save reviewed areas'}</Button></DialogFooter>
      </form>
    </Dialog>
  </>;
}
