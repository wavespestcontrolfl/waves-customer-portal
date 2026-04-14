import React, { useState, useEffect, useCallback } from 'react';

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b',
  red: '#ef4444', purple: '#a855f7',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
  input: '#0f172a',
};

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const af = (p, o = {}) =>
  fetch(`${API_BASE}${p}`, {
    ...o,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...o.headers,
    },
  }).then(r => r.json());

// ── Category tabs ──
const TABS = [
  { key: 'global', label: 'Global Constants', icon: '⚙️' },
  { key: 'zone', label: 'Zones', icon: '📍' },
  { key: 'lawn', label: 'Lawn Care', icon: '🌿' },
  { key: 'pest', label: 'Pest Control', icon: '🪲' },
  { key: 'tree_shrub', label: 'Tree & Shrub', icon: '🌳' },
  { key: 'palm', label: 'Palm Injection', icon: '🌴' },
  { key: 'mosquito', label: 'Mosquito', icon: '🦟' },
  { key: 'termite', label: 'Termite', icon: '🐛' },
  { key: 'rodent', label: 'Rodent', icon: '🐀' },
  { key: 'one_time', label: 'One-Time', icon: '⚡' },
  { key: 'waveguard', label: 'WaveGuard', icon: '🛡️' },
  { key: 'products', label: 'Products', icon: '📦' },
];

// ── Reusable inline-edit cell ──
function EditCell({ value, onSave, type = 'number', width = 70 }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { onSave(type === 'number' ? Number(val) : val); setEditing(false); }}
        onKeyDown={e => { if (e.key === 'Enter') { onSave(type === 'number' ? Number(val) : val); setEditing(false); } if (e.key === 'Escape') setEditing(false); }}
        style={{ width, padding: '4px 6px', background: D.input, border: `1px solid ${D.teal}`, borderRadius: 4, color: D.white, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right', outline: 'none' }}
      />
    );
  }
  return (
    <span
      onClick={() => { setVal(value); setEditing(true); }}
      style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 4, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: D.white, display: 'inline-block', minWidth: width, textAlign: 'right' }}
      title="Click to edit"
    >
      {typeof value === 'number' ? (value < 1 && value > 0 ? `${(value * 100).toFixed(1)}%` : value.toLocaleString(undefined, { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 4 })) : value}
    </span>
  );
}

// ── Config card for key-value JSON data ──
function ConfigCard({ config, onUpdate }) {
  const data = config.data;
  const isSimple = typeof data === 'object' && !Array.isArray(data) && data !== null;
  const [expanded, setExpanded] = useState(false);
  const [rawEdit, setRawEdit] = useState(false);
  const [rawText, setRawText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleFieldUpdate = async (key, newVal) => {
    const updated = { ...data, [key]: newVal };
    setSaving(true);
    await af(`/admin/pricing-config/${config.config_key}`, { method: 'PUT', body: JSON.stringify({ data: updated }) });
    onUpdate(config.config_key, updated);
    setSaving(false);
  };

  const handleRawSave = async () => {
    try {
      const parsed = JSON.parse(rawText);
      setSaving(true);
      await af(`/admin/pricing-config/${config.config_key}`, { method: 'PUT', body: JSON.stringify({ data: parsed }) });
      onUpdate(config.config_key, parsed);
      setRawEdit(false);
      setSaving(false);
    } catch (e) { alert('Invalid JSON: ' + e.message); }
  };

  // Render nested objects (like WaveGuard tiers)
  const renderValue = (key, val) => {
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      return (
        <div key={key} style={{ marginBottom: 8, paddingLeft: 12, borderLeft: `2px solid ${D.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.teal, marginBottom: 4, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</div>
          {Object.entries(val).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
              <span style={{ fontSize: 12, color: D.muted, textTransform: 'capitalize' }}>{k.replace(/_/g, ' ')}</span>
              <EditCell value={v} onSave={newV => { const nested = { ...val, [k]: newV }; handleFieldUpdate(key, nested); }} type={typeof v === 'number' ? 'number' : 'text'} />
            </div>
          ))}
        </div>
      );
    }
    return (
      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${D.border}22` }}>
        <span style={{ fontSize: 12, color: D.muted, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</span>
        <EditCell value={val} onSave={newV => handleFieldUpdate(key, newV)} type={typeof val === 'number' ? 'number' : 'text'} />
      </div>
    );
  };

  // Handle array data (breakpoints, brackets)
  const renderArray = (arr) => {
    if (arr.length === 0) return <div style={{ color: D.muted, fontSize: 12 }}>Empty</div>;
    const first = arr[0];
    if (typeof first === 'object' && !Array.isArray(first)) {
      const cols = Object.keys(first);
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>{cols.map(c => <th key={c} style={{ padding: '4px 8px', textAlign: 'left', color: D.muted, borderBottom: `1px solid ${D.border}`, fontSize: 11, textTransform: 'capitalize' }}>{c.replace(/_/g, ' ')}</th>)}</tr>
            </thead>
            <tbody>
              {arr.map((row, i) => (
                <tr key={i}>
                  {cols.map(c => (
                    <td key={c} style={{ padding: '3px 8px', color: D.white, fontFamily: "'JetBrains Mono', monospace" }}>{typeof row[c] === 'number' ? row[c].toLocaleString() : String(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    // Array of arrays (bracket data)
    return <pre style={{ fontSize: 11, color: D.muted, margin: 0, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'pre-wrap' }}>{JSON.stringify(arr, null, 2)}</pre>;
  };

  return (
    <div style={{ background: D.card, borderRadius: 10, border: `1px solid ${D.border}`, marginBottom: 8, overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', cursor: 'pointer' }}
      >
        <div>
          <span style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{config.name}</span>
          {saving && <span style={{ marginLeft: 8, fontSize: 10, color: D.green }}>Saving...</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {expanded && (
            <button
              onClick={e => { e.stopPropagation(); setRawEdit(!rawEdit); if (!rawEdit) setRawText(JSON.stringify(data, null, 2)); }}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, cursor: 'pointer' }}
            >{rawEdit ? 'Structured' : 'Raw JSON'}</button>
          )}
          <span style={{ fontSize: 12, color: D.muted }}>{expanded ? '▼' : '▶'}</span>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '0 16px 14px' }}>
          {rawEdit ? (
            <div>
              <textarea
                value={rawText}
                onChange={e => setRawText(e.target.value)}
                rows={Math.min(20, rawText.split('\n').length + 1)}
                style={{ width: '100%', padding: 10, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.white, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button onClick={handleRawSave} disabled={saving} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', background: D.green, color: D.white }}>{saving ? '...' : 'Save'}</button>
                <button onClick={() => setRawEdit(false)} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', background: 'transparent', color: D.muted, border: `1px solid ${D.border}` }}>Cancel</button>
              </div>
            </div>
          ) : isSimple ? (
            <div>{Object.entries(data).map(([k, v]) => renderValue(k, v))}</div>
          ) : Array.isArray(data) ? (
            renderArray(data)
          ) : (
            <pre style={{ fontSize: 11, color: D.muted, margin: 0, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'pre-wrap' }}>{JSON.stringify(data, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lawn Brackets Tab ──
function LawnBracketsTab() {
  const [tracks, setTracks] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeTrack, setActiveTrack] = useState('st_augustine');
  const [saving, setSaving] = useState(false);
  const tiers = ['basic', 'standard', 'enhanced', 'premium'];
  const trackLabels = { st_augustine: 'St. Augustine', bermuda: 'Bermuda', zoysia: 'Zoysia', bahia: 'Bahia' };

  useEffect(() => {
    af('/admin/pricing-config/lawn-brackets').then(d => { setTracks(d.tracks || {}); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleCellUpdate = async (sqft, tier, newPrice) => {
    const trackData = tracks[activeTrack] || [];
    const updated = trackData.map(r =>
      r.sqft_bracket === sqft && r.tier === tier ? { ...r, monthly_price: newPrice } : r
    );
    setTracks(prev => ({ ...prev, [activeTrack]: updated }));
    setSaving(true);
    await af(`/admin/pricing-config/lawn-brackets/${activeTrack}`, {
      method: 'PUT',
      body: JSON.stringify({ brackets: [{ sqft_bracket: sqft, tier, monthly_price: newPrice }] }),
    });
    setSaving(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 20 }}>Loading brackets...</div>;

  const trackKeys = Object.keys(tracks);
  if (trackKeys.length === 0) return <div style={{ color: D.muted, padding: 20 }}>No bracket data found. Run the pricing_config migration first.</div>;

  const trackData = tracks[activeTrack] || [];
  // Group by sqft_bracket
  const sqftBrackets = [...new Set(trackData.map(r => r.sqft_bracket))].sort((a, b) => a - b);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {trackKeys.map(tk => (
          <button
            key={tk}
            onClick={() => setActiveTrack(tk)}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: activeTrack === tk ? D.green : D.card,
              color: activeTrack === tk ? D.white : D.muted,
              border: `1px solid ${activeTrack === tk ? D.green : D.border}`,
            }}
          >{trackLabels[tk] || tk}</button>
        ))}
        {saving && <span style={{ fontSize: 11, color: D.green, padding: '6px 0' }}>Saving...</span>}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Lawn SqFt</th>
              {tiers.map(t => (
                <th key={t} style={{ padding: '8px 12px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>
                  {t} ({t === 'basic' ? '4x' : t === 'standard' ? '6x' : t === 'enhanced' ? '9x' : '12x'})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sqftBrackets.map(sqft => (
              <tr key={sqft} style={{ borderBottom: `1px solid ${D.border}22` }}>
                <td style={{ padding: '6px 12px', color: D.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                  {sqft === 0 ? '0' : sqft.toLocaleString()}
                </td>
                {tiers.map(tier => {
                  const row = trackData.find(r => r.sqft_bracket === sqft && r.tier === tier);
                  const price = row ? Number(row.monthly_price) : 0;
                  return (
                    <td key={tier} style={{ padding: '4px 12px', textAlign: 'right' }}>
                      <span style={{ color: D.muted, fontSize: 12 }}>$</span>
                      <EditCell value={price} onSave={v => handleCellUpdate(sqft, tier, v)} width={50} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Discount Rules Tab ──
function DiscountRulesTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/pricing-config/discount-rules').then(d => { setRules(d.rules || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleUpdate = async (serviceKey, field, value) => {
    setRules(prev => prev.map(r => r.service_key === serviceKey ? { ...r, [field]: value } : r));
    await af(`/admin/pricing-config/discount-rules/${serviceKey}`, {
      method: 'PUT',
      body: JSON.stringify({ [field]: value }),
    });
  };

  if (loading) return <div style={{ color: D.muted, padding: 20 }}>Loading...</div>;
  if (rules.length === 0) return <div style={{ color: D.muted, padding: 20 }}>No discount rules found. Run the pricing_config migration.</div>;

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Service Discount Rules</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ padding: '8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Service</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Tier Qualifier</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Max Discount</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Exclude %</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Flat Credit</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Min Tier</th>
              <th style={{ padding: '8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.service_key} style={{ borderBottom: `1px solid ${D.border}22` }}>
                <td style={{ padding: '8px', color: D.text, fontWeight: 600, textTransform: 'capitalize', fontSize: 12 }}>
                  {r.service_key.replace(/_/g, ' ')}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={r.tier_qualifier}
                    onChange={e => handleUpdate(r.service_key, 'tier_qualifier', e.target.checked)}
                    style={{ accentColor: D.teal, width: 16, height: 16, cursor: 'pointer' }}
                  />
                </td>
                <td style={{ padding: '8px', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace" }}>
                  {r.max_discount_pct !== null && r.max_discount_pct !== undefined ? (
                    <EditCell value={Number(r.max_discount_pct)} onSave={v => handleUpdate(r.service_key, 'max_discount_pct', v)} width={50} />
                  ) : (
                    <span style={{ color: D.muted, fontSize: 11 }}>—</span>
                  )}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={r.exclude_from_pct_discount}
                    onChange={e => handleUpdate(r.service_key, 'exclude_from_pct_discount', e.target.checked)}
                    style={{ accentColor: D.red, width: 16, height: 16, cursor: 'pointer' }}
                  />
                </td>
                <td style={{ padding: '8px', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace" }}>
                  {r.flat_credit ? (
                    <EditCell value={Number(r.flat_credit)} onSave={v => handleUpdate(r.service_key, 'flat_credit', v)} width={50} />
                  ) : (
                    <span style={{ color: D.muted, fontSize: 11 }}>—</span>
                  )}
                </td>
                <td style={{ padding: '8px', textAlign: 'center', color: D.muted, fontSize: 11, textTransform: 'capitalize' }}>
                  {r.flat_credit_min_tier || '—'}
                </td>
                <td style={{ padding: '8px', color: D.muted, fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.notes || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Products Tab ──
function ProductsTab() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/inventory?limit=200').then(d => { setProducts(d.products || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 20 }}>Loading products...</div>;

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>Product Cost Reference</div>
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>
        {products.length} products loaded. Full catalog available under Inventory tab.
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 500, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: D.card }}>
            <tr>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Product</th>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Category</th>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Active Ingredient</th>
              <th style={{ padding: '6px 8px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Best Price</th>
              <th style={{ padding: '6px 8px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Unit Price</th>
            </tr>
          </thead>
          <tbody>
            {products.filter(p => p.best_price > 0).sort((a, b) => (a.category || '').localeCompare(b.category || '')).map(p => (
              <tr key={p.id} style={{ borderBottom: `1px solid ${D.border}22` }}>
                <td style={{ padding: '5px 8px', color: D.text, fontSize: 12 }}>{p.product_name || p.name}</td>
                <td style={{ padding: '5px 8px', color: D.muted, fontSize: 11 }}>{p.category}</td>
                <td style={{ padding: '5px 8px', color: D.muted, fontSize: 11, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.active_ingredient || '—'}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: D.green }}>${Number(p.best_price || 0).toFixed(2)}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: D.muted }}>{p.unit_price ? `$${Number(p.unit_price).toFixed(4)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Audit Log ──
function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/pricing-config/audit-log?limit=30').then(d => { setLogs(d.logs || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (logs.length === 0) return null;

  return (
    <div style={{ marginTop: 24, background: D.card, borderRadius: 10, border: `1px solid ${D.border}`, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 12 }}>Recent Changes</div>
      {logs.map((l, i) => (
        <div key={i} style={{ fontSize: 11, color: D.muted, padding: '4px 0', borderBottom: `1px solid ${D.border}22` }}>
          <span style={{ color: D.teal }}>{l.config_key}</span>
          <span style={{ margin: '0 6px' }}>changed by</span>
          <span style={{ color: D.text }}>{l.changed_by || 'admin'}</span>
          <span style={{ margin: '0 6px' }}>—</span>
          <span>{new Date(l.changed_at).toLocaleString()}</span>
          {l.reason && <span style={{ marginLeft: 8, color: D.amber }}>({l.reason})</span>}
        </div>
      ))}
    </div>
  );
}

// ── Main Panel ──
export default function PricingLogicPanel() {
  const [activeTab, setActiveTab] = useState('global');
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/pricing-config').then(d => { setConfigs(d.configs || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleConfigUpdate = useCallback((key, newData) => {
    setConfigs(prev => prev.map(c => c.config_key === key ? { ...c, data: newData } : c));
  }, []);

  const filteredConfigs = configs.filter(c => c.category === activeTab);

  return (
    <div>
      {/* Tab strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 20, padding: '4px 0', borderBottom: `1px solid ${D.border}` }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '6px 12px', borderRadius: '6px 6px 0 0', fontSize: 11, fontWeight: 600,
              border: 'none', cursor: 'pointer',
              background: activeTab === t.key ? D.teal : 'transparent',
              color: activeTab === t.key ? D.white : D.muted,
              borderBottom: activeTab === t.key ? `2px solid ${D.teal}` : '2px solid transparent',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading pricing configuration...</div>
      ) : (
        <>
          {/* Lawn tab has special bracket grid */}
          {activeTab === 'lawn' && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Monthly Price Brackets</div>
              <LawnBracketsTab />
            </div>
          )}

          {/* WaveGuard tab has discount rules */}
          {activeTab === 'waveguard' && (
            <div style={{ marginBottom: 20 }}>
              <DiscountRulesTab />
              <div style={{ height: 20 }} />
            </div>
          )}

          {/* Products tab */}
          {activeTab === 'products' && <ProductsTab />}

          {/* Config cards for this category */}
          {activeTab !== 'products' && filteredConfigs.length > 0 && (
            <div>
              {activeTab !== 'lawn' && activeTab !== 'waveguard' && (
                <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>
                  {TABS.find(t => t.key === activeTab)?.label || activeTab} Configuration
                </div>
              )}
              {activeTab === 'waveguard' && <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12, marginTop: 12 }}>Tier Configuration</div>}
              {activeTab === 'lawn' && <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12, marginTop: 12 }}>Lawn Pricing Config</div>}
              {filteredConfigs.map(c => (
                <ConfigCard key={c.config_key} config={c} onUpdate={handleConfigUpdate} />
              ))}
            </div>
          )}

          {activeTab !== 'products' && filteredConfigs.length === 0 && activeTab !== 'lawn' && activeTab !== 'waveguard' && (
            <div style={{ color: D.muted, padding: 20, textAlign: 'center', fontSize: 13 }}>
              No configuration data for this category yet. Run the pricing_config migration to seed data.
            </div>
          )}

          {/* Audit log on relevant tabs */}
          {['global', 'waveguard'].includes(activeTab) && <AuditLog />}
        </>
      )}
    </div>
  );
}
