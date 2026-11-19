import React, { useEffect, useState } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Select } from '../ui';
import { adminFetch } from '../../utils/admin-fetch';
import { formatETDateTime } from '../../lib/timezone';
import layout from '../../../../shared/fertilizer-map.json';

const blank = '.'.repeat(layout.rows * layout.columns);
const fills = { '.': '#fff', L: '#dcfce7', T: '#cffafe', X: '#e4e4e7' };

function MapDialog({ endpoint, request, close }) {
  const [record, setRecord] = useState(null);
  const [cells, setCells] = useState(blank);
  const [landmarks, setLandmarks] = useState('');
  const [brush, setBrush] = useState('L');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setError(''); setRecord(null); setStale(false);
    request(endpoint).then(result => {
      if (active) {
        setCells(result.map?.cells || blank);
        setLandmarks(result.map?.landmarks || '');
        setRecord(result);
      }
    }).catch(err => { if (active) setError(err.message || 'Could not load this property’s map.'); });
    return () => { active = false; };
  }, [endpoint, request, revision]);

  const dirty = record && (cells !== (record.map?.cells || blank) || landmarks !== (record.map?.landmarks || ''));
  async function save() {
    setBusy(true); setError('');
    try {
      await request(endpoint, { method: 'PUT', body: JSON.stringify({ cells, landmarks, version: record.version }) });
      close();
    } catch (err) {
      setError(err.message || 'Could not save the map.');
      setStale(err.status === 409);
    } finally { setBusy(false); }
  }

  return <Dialog open onClose={() => { if (!busy) close(); }} layer={1300}>
    <DialogHeader><DialogTitle>Property fertilizer map</DialogTitle></DialogHeader>
    <DialogBody>
      {!record && !error && <p role="status">Loading map…</p>}
      {error && <p role="alert">{error}</p>}
      {error && (!record || stale) && <Button variant="secondary" onClick={() => setRevision(v => v + 1)}>Reload saved map</Button>}
      {record && <div className="space-y-3 text-14">
        <p>Each square has one fertilizer assignment. Hold unmapped areas until both crews agree on the boundary. Measure buffers on site and record the area your crew will actually feed.</p>
        {record.map?.reviewedAt && <p>Last reviewed {formatETDateTime(record.map.reviewedAt)}.</p>}
        <label className="block">Assign squares to
          <Select disabled={busy || stale} value={brush} onChange={e => setBrush(e.target.value)}>
            {Object.entries(layout.assignments).map(([code, label]) => <option value={code} key={code}>{code} · {label}</option>)}
          </Select>
        </label>
        <div>
          <div className="grid gap-px" style={{ gridTemplateColumns: 'repeat(' + layout.columns + ', minmax(0, 1fr))' }}>
            {[...cells].map((code, i) => <button type="button" key={i} disabled={busy || stale}
              className="min-h-11 border text-14 font-bold" style={{ backgroundColor: fills[code], color: '#18181b' }}
              aria-label={'Row ' + (Math.floor(i / layout.columns) + 1) + ', column ' + (i % layout.columns + 1) + ', ' + layout.assignments[code]}
              onClick={() => setCells(previous => previous.slice(0, i) + brush + previous.slice(i + 1))}>{code}</button>)}
          </div>
          <p className="text-center text-14">Street / front edge</p>
          <p className="text-14">L · Lawn &nbsp; T · Trees and shrubs &nbsp; X · Fertilizer-free &nbsp; . · Unmapped</p>
        </div>
        <label className="block">Boundary landmarks
          <textarea className="block w-full rounded border p-2" rows={3} value={landmarks} maxLength={600}
            disabled={busy || stale} placeholder="Identify beds, turf edges and fertilizer-free areas."
            onChange={e => setLandmarks(e.target.value)} />
        </label>
      </div>}
    </DialogBody>
    <DialogFooter>
      <Button variant="secondary" disabled={busy} onClick={close}>{dirty ? 'Discard changes' : 'Close'}</Button>
      <Button disabled={!dirty || busy || stale || (cells !== blank && !landmarks.trim())} onClick={save}>{busy ? 'Saving…' : 'Save map'}</Button>
    </DialogFooter>
  </Dialog>;
}

export default function PropertyFertilizerMap({ endpoint, request = adminFetch, disabled = false }) {
  const [openFor, setOpenFor] = useState(null);
  return <div className="my-2">
    <Button variant="secondary" className="min-h-11" disabled={disabled} onClick={() => setOpenFor(endpoint)}>Open fertilizer map</Button>
    {openFor === endpoint && <MapDialog key={endpoint} endpoint={endpoint} request={request} close={() => setOpenFor(null)} />}
  </div>;
}
