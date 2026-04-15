import React, { useState, useEffect } from 'react';
import PricingLogicPanel from '../../components/admin/PricingLogicPanel';

const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500',
  red: '#C0392B', purple: '#7C3AED',
  text: '#334155', muted: '#64748B', white: '#FFFFFF',
  heading: '#0F172A', input: '#FFFFFF',
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

// ── Margin Calculator ──
export function MarginCalculator() {
  const [lotSqFt, setLotSqFt] = useState(10000);
  const [homeSqFt, setHomeSqFt] = useState(2000);
  const [lawnSqFt, setLawnSqFt] = useState(5000);
  const [bedArea, setBedArea] = useState(1500);
  const [tier, setTier] = useState('gold');
  const [margins, setMargins] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchMargins = async () => {
    setLoading(true);
    try {
      const data = await af('/admin/pricing-config/margin-check', {
        method: 'POST',
        body: JSON.stringify({ lotSqFt, homeSqFt, lawnSqFt, bedArea, waveguardTier: tier }),
      });
      setMargins(data);
    } catch { setMargins(null); }
    setLoading(false);
  };

  useEffect(() => { fetchMargins(); }, []);

  const marginColor = (m) => {
    if (m >= 0.45) return D.green;
    if (m >= 0.35) return D.amber;
    return D.red;
  };

  const marginLabel = (m) => {
    if (m >= 0.45) return 'Healthy';
    if (m >= 0.35) return 'Acceptable';
    return 'Below Floor';
  };

  const inputStyle = {
    padding: '6px 10px', background: D.input, border: `1px solid ${D.border}`,
    borderRadius: 6, color: D.heading, fontSize: 13, width: 90, textAlign: 'right',
    fontFamily: "'JetBrains Mono', monospace", outline: 'none',
  };

  return (
    <div style={{ background: D.card, borderRadius: 12, border: `1px solid ${D.border}`, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>Margin Calculator</div>
        <button onClick={fetchMargins} disabled={loading} style={{
          padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
          fontSize: 12, fontWeight: 600, background: D.teal, color: D.white,
        }}>{loading ? 'Calculating...' : 'Calculate'}</button>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: D.muted }}>
          Lot SqFt
          <input type="number" value={lotSqFt} onChange={e => setLotSqFt(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 12, color: D.muted }}>
          Home SqFt
          <input type="number" value={homeSqFt} onChange={e => setHomeSqFt(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 12, color: D.muted }}>
          Lawn SqFt
          <input type="number" value={lawnSqFt} onChange={e => setLawnSqFt(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 12, color: D.muted }}>
          Bed Area
          <input type="number" value={bedArea} onChange={e => setBedArea(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={{ fontSize: 12, color: D.muted }}>
          WaveGuard
          <select value={tier} onChange={e => setTier(e.target.value)} style={{ ...inputStyle, width: 110, textAlign: 'left' }}>
            <option value="bronze">Bronze</option>
            <option value="silver">Silver</option>
            <option value="gold">Gold</option>
            <option value="platinum">Platinum</option>
          </select>
        </label>
      </div>

      {margins?.services && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Service</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Annual Price</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Est. Cost</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>After Discount</th>
                <th style={{ padding: '8px 10px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Margin</th>
                <th style={{ padding: '8px 10px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {margins.services.map(s => (
                <tr key={s.service} style={{ borderBottom: `1px solid ${D.border}22` }}>
                  <td style={{ padding: '8px 10px', color: D.text, fontWeight: 600, fontSize: 12, textTransform: 'capitalize' }}>{s.service.replace(/_/g, ' ')}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>${s.annual?.toLocaleString() || '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: D.muted }}>${s.estimatedCost?.toLocaleString() || '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>${s.afterDiscount?.toLocaleString() || '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700, color: marginColor(s.margin) }}>
                    {s.margin != null ? `${(s.margin * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    {s.margin != null && (
                      <span style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                        background: `${marginColor(s.margin)}18`, color: marginColor(s.margin),
                      }}>{marginLabel(s.margin)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {margins?.error && <div style={{ color: D.red, fontSize: 12, padding: 10 }}>{margins.error}</div>}
    </div>
  );
}

function SpecServicesPanel() {
  const SPEC_SERVICES = [
    { key: 'rodentPlugging',        fn: 'calculatePluggingPrice',         name: 'Rodent Plugging',          desc: 'Entry-point sealing tiered by 1–5 / 6–15 / 16+ pts. $95 standalone, $45 add-on. 65% margin target.' },
    { key: 'termiteFoam',           fn: 'calculateFoamPrice',             name: 'Termite Foam',             desc: 'Termidor Foam spot treatment per app point + cans (~$30/can). $125 min. 15% bundle discount with liquid barrier.' },
    { key: 'stingingV2',            fn: 'calculateStingingPrice',         name: 'Stinging Insect',          desc: 'Multiplier stack: nest type × location × urgency / after-hours. Mins: $95 / $125 / $175.' },
    { key: 'exclusionV2',           fn: 'calculateExclusionPrice',        name: 'Exclusion (Full)',         desc: 'sqft tiers $395 / $595 / $895 / $1,295. Tile roof 1.4×, 2-story 1.3×. multiVisit flag at >4hr.' },
    { key: 'rodentGuaranteeCombo',  fn: 'calculateRodentGuaranteeCombo',  name: 'Rodent Guarantee Combo',   desc: 'Exclusion + Bait Stations + 12/24-mo guarantee. 10% bundle discount, 15–25% guarantee premium. Min $695 / $995. Auto-applies postExclusion modifier on bait stations (~28% off standalone, $55/mo floor).' },
  ];
  return (
    <div style={{ background: D.card, borderRadius: 12, border: `1px solid ${D.border}`, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>Missing-Services Pricing Spec</div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12, background: D.green + '22', color: D.green, border: `1px solid ${D.green}55` }}>
          ✓ Linked to Estimator Engine
        </span>
      </div>
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 14 }}>
        These five services are wired into <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>generateEstimate()</code> via the <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>services.&lt;key&gt;</code> input. Spec doc: <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>missing-services-pricing-spec.md</code>.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
        {SPEC_SERVICES.map(s => (
          <div key={s.key} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 14, padding: 12, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: D.heading }}>{s.name}</div>
              <div style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>services.{s.key}</div>
              <div style={{ fontSize: 10, color: D.teal, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>{s.fn}()</div>
            </div>
            <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PricingLogicPage() {
  return (
    <div style={{ padding: '24px 24px 60px' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: D.heading, margin: 0 }}>Pricing Logic</h1>
        </div>

        <MarginCalculator />
        <SpecServicesPanel />
        <PricingLogicPanel />
      </div>
    </div>
  );
}
