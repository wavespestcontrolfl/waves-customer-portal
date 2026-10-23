// The truck check (GATE_TRUCK_KIT, docs/tool-inventory-tracker-scope.md PR 1):
// every item on the signed-in technician's truck, each Here by default (or
// Missing / Damaged when a previous check already reported it), one tap per
// problem, one save. Under a minute when nothing is wrong: "Everything's here".
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, RefreshCw } from 'lucide-react';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { useTechBasePath } from '../../components/tech/techBasePath';
import useTruckKit, { lastCheckedLabel } from '../../components/tech/useTruckKit';

const API = import.meta.env.VITE_API_URL || '';
const STATES = [
  { key: 'present', label: 'Here' },
  { key: 'missing', label: 'Missing' },
  { key: 'damaged', label: 'Damaged' },
];
const CATEGORY_LABELS = { tool: 'Tools', safety: 'Safety', sprayer: 'Sprayers', backpack: 'Backpacks', spreader: 'Spreaders', pump: 'Pumps', reel: 'Reels', dethatcher: 'Dethatchers', other: 'Other' };
const categoryLabel = (category) => CATEGORY_LABELS[category] || (category ? category.charAt(0).toUpperCase() + category.slice(1) : 'Other');

export function groupKit(kit) {
  const groups = new Map();
  for (const item of kit || []) {
    const key = item.category || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, label: categoryLabel(category), items }));
}

export default function TechTruckCheckPage() {
  const navigate = useNavigate();
  const base = useTechBasePath();
  const [searchParams] = useSearchParams();
  const visit = searchParams.get('visit');
  const backTo = visit ? `${base}?visit=${encodeURIComponent(visit)}` : base;
  const { loading, data, error, reload } = useTruckKit();
  const [marks, setMarks] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(null);

  const kit = data?.kit || [];
  // One idempotency key per loaded list AND payload: a retry of the same
  // answers after a lost response sends the same key and gets the saved check
  // back; answers changed before the retry get a new key and a new check.
  const loadKey = useMemo(() => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 18) : `tc${Date.now().toString(36)}`), [data]);
  const digest = (text) => { let h = 5381; for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); };
  const groups = useMemo(() => groupKit(kit), [kit]);
  const stateOf = (item) => marks[item.id]?.state || item.open_issue || 'present';
  const noteOf = (item) => marks[item.id]?.note || '';
  const setItemState = (item, state) => setMarks((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] || {}), state } }));
  const setItemNote = (item, note) => setMarks((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] || {}), note } }));
  const issues = kit.filter((item) => stateOf(item) !== 'present').length;

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      // A note typed for a missing or damaged item and then switched back
      // to Here never rides along on a present result.
      const results = kit.map((item) => ({ equipmentId: item.id, state: stateOf(item), note: stateOf(item) === 'present' ? '' : noteOf(item) }));
      const clientKey = `${loadKey}-${digest(JSON.stringify(results))}`;
      const res = await fetch(`${API}/api/tech/truck-check`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAdminAuthToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey, results }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.code === 'kit_changed') {
        setMarks({});
        setSaveError('The office changed your truck list. It has been reloaded; look it over and save again.');
        await reload();
        return;
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSaved({ ...body.check, issues });
    } catch (err) {
      setSaveError(err?.message || 'Could not save the check');
    } finally {
      setSaving(false);
    }
  };

  const heading = (
    <div className="tf-page-heading">
      <div>
        <h1>Truck check</h1>
        {data?.truck && <p className="tf-muted">{[data.truck.asset_tag, data.truck.name].filter(Boolean).join(' · ')} · {lastCheckedLabel(data.lastCheck?.checked_at)}</p>}
      </div>
      <Link className="tf-button" to={backTo}><ArrowLeft aria-hidden="true" />Back</Link>
    </div>
  );

  if (loading) return <div className="tf-page">{heading}<p role="status" className="tf-muted">Loading your truck…</p></div>;
  if (error) return (
    <div className="tf-page">{heading}
      <div role="alert" className="tf-alert tf-error">{error}<div><button type="button" className="tf-button" onClick={() => reload()}><RefreshCw aria-hidden="true" />Retry</button></div></div>
    </div>
  );
  if (!data?.enabled) return <div className="tf-page">{heading}<div className="tf-card tf-card-main"><p>Truck checks are not turned on yet.</p></div></div>;
  if (!data.truck) return (
    <div className="tf-page">{heading}
      <div className="tf-card tf-card-main"><h2>No truck assigned to you</h2><p className="tf-muted">Ask the office to put you on a truck under Equipment, then come back here.</p></div>
    </div>
  );
  if (saved) return (
    <div className="tf-page">{heading}
      <div className="tf-card tf-card-main">
        <h2><CheckCircle2 size={20} aria-hidden="true" /> Check saved</h2>
        <p className="tf-muted">{saved.issues === 0 ? 'Everything is on the truck.' : `${saved.issues} ${saved.issues === 1 ? 'item needs' : 'items need'} the office's attention; they have been told.`}</p>
        <div className="tf-actions"><button type="button" className="tf-button tf-primary" onClick={() => navigate(backTo)}>Back to Today</button></div>
      </div>
    </div>
  );
  if (kit.length === 0) return (
    <div className="tf-page">{heading}
      <div className="tf-card tf-card-main"><h2>Nothing on the list yet</h2><p className="tf-muted">The office adds the tools that ride on this truck under Equipment → Assets. Once they are there, the check shows them here.</p></div>
    </div>
  );

  return (
    <div className="tf-page">
      {heading}
      <p className="tf-muted">Tap Missing or Damaged on anything that is not on the truck as it should be. Everything else counts as here.</p>
      {groups.map((group) => (
        <section key={group.category}>
          <h2 className="tf-overline tf-section-title">{group.label}</h2>
          <div className="tf-route">
            {group.items.map((item) => {
              const state = stateOf(item);
              return (
                <div key={item.id} className="tf-card tf-card-main">
                  <strong>{item.name}</strong>
                  {(item.asset_tag || item.serial_number) && <p className="tf-muted">{[item.asset_tag, item.serial_number && `Serial ${item.serial_number}`].filter(Boolean).join(' · ')}</p>}
                  {item.open_issue && <p className="tf-muted">Reported {item.open_issue} on an earlier check</p>}
                  <div className="tf-chips" role="group" aria-label={item.name}>
                    {STATES.map((option) => (
                      <button key={option.key} type="button" className="tf-chip" aria-pressed={state === option.key} onClick={() => setItemState(item, option.key)} disabled={saving}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {state !== 'present' && (
                    <input className="tf-input" type="text" maxLength={300} placeholder="Note for the office (optional)" aria-label={`Note about ${item.name}`} value={noteOf(item)} onChange={(event) => setItemNote(item, event.target.value)} disabled={saving} />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {saveError && <div role="alert" className="tf-alert tf-error">{saveError}</div>}
      <div className="tf-actions">
        <button type="button" className="tf-button tf-primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : issues === 0 ? "Everything's here" : `Save check (${issues} ${issues === 1 ? 'issue' : 'issues'})`}
        </button>
      </div>
    </div>
  );
}
