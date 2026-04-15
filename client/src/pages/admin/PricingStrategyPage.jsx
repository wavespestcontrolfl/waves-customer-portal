import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', blue: '#0A7EC2', text: '#334155', muted: '#64748B', white: '#FFFFFF', input: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600 });
const sInput = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const fmt = (n) => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—';

const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

export default function PricingStrategyPage() {
  const [tab, setTab] = useState('money-model');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');

  useEffect(() => {
    adminFetch('/admin/pricing/dashboard').then(setDashboard).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  const tabs = [
    { key: 'money-model', label: 'Money Model' },
    { key: 'value-calc', label: 'Value Equation' },
    { key: 'offers', label: 'Offer Builder' },
    { key: 'upsells', label: 'Upsell Engine' },
    { key: 'ltv', label: 'LTV Analysis' },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: D.heading }}>Pricing Strategy</div>
        <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>Hormozi-style value engineering, offer architecture, and money model</div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
            whiteSpace: 'nowrap', flexShrink: 0, minHeight: 44,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'money-model' && <MoneyModelTab dashboard={dashboard} loading={loading} />}
      {tab === 'value-calc' && <ValueEquationTab />}
      {tab === 'offers' && <OfferBuilderTab showToast={showToast} />}
      {tab === 'upsells' && <UpsellEngineTab showToast={showToast} />}
      {tab === 'ltv' && <LTVAnalysisTab />}

      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MONEY MODEL TAB
// ══════════════════════════════════════════════════════════════
function MoneyModelTab({ dashboard, loading }) {
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading money model...</div>;
  const d = dashboard || {};
  const funnel = d.funnel || {};
  const stages = d.revenueByStage || {};

  return (
    <div>
      {/* KPIs */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Customers', value: d.totalCustomers || 0, color: D.heading },
          { label: 'Avg LTV', value: fmt(d.avgLTV), color: D.green },
          { label: 'Avg CAC', value: fmt(d.avgCAC), color: D.amber },
          { label: 'LTV:CAC Ratio', value: d.ltvCacRatio ? `${d.ltvCacRatio.toFixed(1)}x` : '—', color: d.ltvCacRatio >= 3 ? D.green : d.ltvCacRatio >= 2 ? D.amber : D.red },
          { label: 'Monthly Recurring', value: fmt(d.mrr), color: D.teal },
        ].map(s => (
          <div key={s.label} style={{ ...sCard, flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 140px', minWidth: isMobile ? 0 : 140, marginBottom: 0, textAlign: 'center' }}>
            <div style={{ fontFamily: MONO, fontSize: isMobile ? 18 : 22, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Hormozi Money Model Stages */}
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>$100M Money Model — Revenue by Stage</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? 8 : 12 }}>
          {[
            { stage: 'Stage I: Attraction', desc: 'First service / one-time', value: stages.attraction, color: D.blue, icon: '🧲' },
            { stage: 'Stage II: Core', desc: 'WaveGuard recurring', value: stages.core, color: D.teal, icon: '🔄' },
            { stage: 'Stage III: Upsell', desc: 'Add-ons & upgrades', value: stages.upsell, color: D.purple, icon: '📈' },
            { stage: 'Stage IV: Continuity', desc: 'Retention & renewals', value: stages.continuity, color: D.green, icon: '♻️' },
          ].map(s => (
            <div key={s.stage} style={{ padding: 16, background: D.input, borderRadius: 10, textAlign: 'center', borderLeft: `3px solid ${s.color}` }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>{s.icon}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 2 }}>{s.stage}</div>
              <div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>{s.desc}</div>
              <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: s.color }}>{fmt(s.value)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Conversion Funnel */}
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Conversion Funnel</div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {[
            { label: 'Leads', value: funnel.leads, color: D.muted },
            { label: 'Estimates', value: funnel.estimates, color: D.blue },
            { label: 'Accepted', value: funnel.accepted, color: D.amber },
            { label: 'Active', value: funnel.active, color: D.green },
            { label: 'Retained 6mo+', value: funnel.retained, color: D.teal },
          ].map((s, i) => (
            <div key={s.label} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: s.color }}>{s.value || 0}</div>
              <div style={{ fontSize: 10, color: D.muted, marginTop: 2 }}>{s.label}</div>
              {i < 4 && <div style={{ fontSize: 10, color: D.muted, marginTop: 4 }}>{s.value && funnel.leads ? `${Math.round((s.value / funnel.leads) * 100)}%` : ''}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Top Upsell Opportunities */}
      {(d.upsellOpportunities || []).length > 0 && (
        <div style={sCard}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Top Upsell Opportunities</div>
          {d.upsellOpportunities.slice(0, 5).map((o, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}22` }}>
              <div>
                <span style={{ color: D.heading, fontWeight: 600, fontSize: 13 }}>{o.customerName}</span>
                <span style={{ color: D.muted, marginLeft: 8, fontSize: 12 }}>Currently: {o.currentTier} ({o.serviceCount} services)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: D.green, fontFamily: MONO, fontSize: 13 }}>+{fmt(o.potentialAdd)}/mo</span>
                <span style={sBadge(`${D.purple}22`, D.purple)}>{o.suggestedService}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// VALUE EQUATION TAB
// ══════════════════════════════════════════════════════════════
function ValueEquationTab() {
  const [inputs, setInputs] = useState({ dreamOutcome: 7, perceivedLikelihood: 7, timeDelay: 3, effortSacrifice: 3 });
  const [result, setResult] = useState(null);

  const calculate = async () => {
    try {
      const r = await adminFetch('/admin/pricing/calculate-value', { method: 'POST', body: JSON.stringify(inputs) });
      setResult(r);
    } catch { /* calculate locally */
      const v = (inputs.dreamOutcome * inputs.perceivedLikelihood) / (inputs.timeDelay * inputs.effortSacrifice);
      const score = Math.round(v * 10);
      setResult({ valueScore: score, priceRecommendation: score > 70 ? 'Premium' : score > 40 ? 'Market Rate' : 'Needs Work', positioning: score > 70 ? 'You can charge 2-3x market rate' : score > 40 ? 'Competitive pricing is appropriate' : 'Improve the offer before raising prices' });
    }
  };

  useEffect(() => { calculate(); }, [inputs]);

  const Slider = ({ label, desc, value, onChange, increaseLabel, decreaseLabel }) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <div><span style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{label}</span><span style={{ fontSize: 11, color: D.muted, marginLeft: 8 }}>{desc}</span></div>
        <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: value >= 7 ? D.green : value >= 4 ? D.amber : D.red }}>{value}</span>
      </div>
      <input type="range" min={1} max={10} value={value} onChange={e => onChange(parseInt(e.target.value))} style={{ width: '100%', accentColor: D.teal }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: D.muted }}><span>{decreaseLabel || 'Low'}</span><span>{increaseLabel || 'High'}</span></div>
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 20 }}>
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Value Equation</div>
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 20 }}>Value = (Dream Outcome × Likelihood) ÷ (Time Delay × Effort)</div>

        <div style={{ fontSize: 12, fontWeight: 600, color: D.green, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>↑ Increase These</div>
        <Slider label="Dream Outcome" desc="How life-changing is the result?" value={inputs.dreamOutcome} onChange={v => setInputs(p => ({ ...p, dreamOutcome: v }))} decreaseLabel="Minor improvement" increaseLabel="Life-changing" />
        <Slider label="Perceived Likelihood" desc="Do they believe it'll work?" value={inputs.perceivedLikelihood} onChange={v => setInputs(p => ({ ...p, perceivedLikelihood: v }))} decreaseLabel="Skeptical" increaseLabel="Guaranteed" />

        <div style={{ fontSize: 12, fontWeight: 600, color: D.red, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 8 }}>↓ Decrease These</div>
        <Slider label="Time Delay" desc="How long until they see results?" value={inputs.timeDelay} onChange={v => setInputs(p => ({ ...p, timeDelay: v }))} decreaseLabel="Instant" increaseLabel="Months/years" />
        <Slider label="Effort & Sacrifice" desc="How much work for the customer?" value={inputs.effortSacrifice} onChange={v => setInputs(p => ({ ...p, effortSacrifice: v }))} decreaseLabel="Done-for-you" increaseLabel="DIY" />
      </div>

      <div>
        {result && (
          <div style={{ ...sCard, textAlign: 'center', borderColor: result.valueScore >= 70 ? D.green : result.valueScore >= 40 ? D.amber : D.red }}>
            <div style={{ fontSize: 56, fontWeight: 800, fontFamily: MONO, color: result.valueScore >= 70 ? D.green : result.valueScore >= 40 ? D.amber : D.red }}>{result.valueScore}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginTop: 4 }}>Value Score</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: D.teal, marginTop: 12 }}>{result.priceRecommendation}</div>
            <div style={{ fontSize: 13, color: D.muted, marginTop: 8, lineHeight: 1.6 }}>{result.positioning}</div>
          </div>
        )}

        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Waves Pest Control Value Levers</div>
          {[
            { lever: 'Dream Outcome', current: 'Pest-free, healthy lawn, protected home', improve: 'Frame as "protecting your family\'s health and your biggest investment"' },
            { lever: 'Likelihood', current: 'Licensed, insured, local reputation', improve: 'Add guarantee language, show review count, before/after photos' },
            { lever: 'Time Delay', current: 'Results within first treatment', improve: 'Emphasize "same-week service" and "immediate protection"' },
            { lever: 'Effort', current: 'Fully done-for-you', improve: 'Highlight: "We handle everything — you just unlock the gate"' },
          ].map(l => (
            <div key={l.lever} style={{ padding: '8px 0', borderBottom: `1px solid ${D.border}22`, fontSize: 12 }}>
              <div style={{ color: D.teal, fontWeight: 600 }}>{l.lever}</div>
              <div style={{ color: D.text, marginTop: 2 }}>Now: {l.current}</div>
              <div style={{ color: D.amber, marginTop: 2 }}>↑ {l.improve}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// OFFER BUILDER TAB
// ══════════════════════════════════════════════════════════════
function OfferBuilderTab({ showToast }) {
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/pricing/offers').then(d => setOffers(d.offers || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading offers...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading }}>Grand Slam Offers</div>
        <button style={sBtn(D.teal, D.white)}>+ New Offer</button>
      </div>

      {/* Current WaveGuard tiers as offers */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {[
          { name: 'WaveGuard Bronze', services: 1, discount: '0%', price: '$49-89/mo', anchor: '$120+/mo', guarantee: 'Satisfaction Guarantee', bonuses: ['Digital Service Reports'] },
          { name: 'WaveGuard Silver', services: 2, discount: '10%', price: '$85-140/mo', anchor: '$190+/mo', guarantee: '100% Satisfaction + Free Re-treat', bonuses: ['Digital Reports', 'Priority Scheduling', 'Free Termite Inspection'] },
          { name: 'WaveGuard Gold', services: 3, discount: '15%', price: '$130-200/mo', anchor: '$280+/mo', guarantee: '100% Satisfaction + Free Re-treat + Money Back', bonuses: ['All Silver perks', '15% Off One-Time Treatments', '24hr Response'] },
          { name: 'WaveGuard Platinum', services: '4+', discount: '20%', price: '$180-280/mo', anchor: '$400+/mo', guarantee: 'Unconditional Money Back', bonuses: ['All Gold perks', 'Dedicated Tech', 'Quarterly Property Reviews', 'Loyalty Rewards'] },
        ].map(o => (
          <div key={o.name} style={{ ...sCard, marginBottom: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginBottom: 8 }}>{o.name}</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={sBadge(`${D.teal}22`, D.teal)}>{o.services} service{o.services !== 1 ? 's' : ''}</span>
              <span style={sBadge(`${D.green}22`, D.green)}>{o.discount} off</span>
            </div>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: D.muted }}>Price</span><span style={{ color: D.green, fontFamily: MONO, fontWeight: 700 }}>{o.price}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: D.muted }}>Anchor (without us)</span><span style={{ color: D.red, textDecoration: 'line-through', fontFamily: MONO }}>{o.anchor}</span></div>
            </div>
            <div style={{ fontSize: 11, color: D.amber, fontWeight: 600, marginBottom: 8 }}>🛡️ {o.guarantee}</div>
            <div style={{ fontSize: 11, color: D.muted }}>
              {o.bonuses.map((b, i) => <div key={i}>✓ {b}</div>)}
            </div>
          </div>
        ))}
      </div>

      {/* Custom offers */}
      {offers.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Custom Offer Packages</div>
          {offers.map(o => (
            <div key={o.id} style={{ ...sCard, marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{o.name}</div>
              <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{o.description}</div>
              {o.conversion_rate > 0 && <div style={{ fontSize: 11, color: D.green, marginTop: 4 }}>Conversion: {o.conversion_rate}%</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// UPSELL ENGINE TAB
// ══════════════════════════════════════════════════════════════
function UpsellEngineTab({ showToast }) {
  const [rules, setRules] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/pricing/upsell-rules').catch(() => ({ rules: [] })),
      adminFetch('/admin/pricing/upsell-opportunities').catch(() => ({ opportunities: [] })),
    ]).then(([r, o]) => {
      setRules(r.rules || []);
      setOpportunities(o.opportunities || []);
      setLoading(false);
    });
  }, []);

  const triggerUpsell = async (customerId) => {
    try {
      const r = await adminFetch(`/admin/pricing/trigger-upsell/${customerId}`, { method: 'POST' });
      showToast(r.message || 'Upsell SMS sent!');
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading upsell data...</div>;

  return (
    <div>
      {/* Opportunities */}
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Upsell Opportunities ({opportunities.length})</div>
        {opportunities.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>No upsell opportunities found</div>
        ) : opportunities.slice(0, 10).map((o, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${D.border}22` }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{o.customerName}</div>
              <div style={{ fontSize: 11, color: D.muted }}>Currently: {o.currentTier} · {o.serviceCount} service{o.serviceCount !== 1 ? 's' : ''} · {fmt(o.monthlyRate)}/mo</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, color: D.green, fontFamily: MONO, fontWeight: 700 }}>+{fmt(o.potentialAdd)}/mo</div>
                <div style={{ fontSize: 10, color: D.purple }}>{o.suggestedService}</div>
              </div>
              <button onClick={() => triggerUpsell(o.customerId)} style={sBtn(D.purple, D.white)}>Send Offer</button>
            </div>
          </div>
        ))}
      </div>

      {/* Active Rules */}
      <div style={sCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading }}>Upsell Rules</div>
        </div>
        {rules.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>No upsell rules configured</div>
        ) : rules.map(r => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}22` }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{r.name}</div>
              <div style={{ fontSize: 11, color: D.muted }}>Trigger: {r.trigger_event} · Offer: {r.offer_service}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: D.muted }}>{r.times_triggered || 0} triggered · {r.times_converted || 0} converted</span>
              <span style={sBadge(r.enabled ? `${D.green}22` : `${D.muted}22`, r.enabled ? D.green : D.muted)}>{r.enabled ? 'Active' : 'Disabled'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// LTV ANALYSIS TAB
// ══════════════════════════════════════════════════════════════
function LTVAnalysisTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);

  useEffect(() => {
    adminFetch('/admin/pricing/ltv-analysis').then(setData).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const recalculate = async () => {
    setRecalculating(true);
    try {
      await adminFetch('/admin/pricing/recalculate-ltv', { method: 'POST' });
      const d = await adminFetch('/admin/pricing/ltv-analysis');
      setData(d);
    } catch { /* ignore */ }
    setRecalculating(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading LTV analysis...</div>;
  if (!data) return <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No LTV data yet. Click "Recalculate" to generate.</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading }}>Customer Lifetime Value</div>
        <button onClick={recalculate} disabled={recalculating} style={{ ...sBtn(D.teal, D.white), opacity: recalculating ? 0.5 : 1 }}>{recalculating ? 'Recalculating...' : 'Recalculate All'}</button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Avg LTV', value: fmt(data.avgLTV), color: D.green },
          { label: 'Avg CAC', value: fmt(data.avgCAC), color: D.amber },
          { label: 'LTV:CAC', value: data.ltvCacRatio ? `${data.ltvCacRatio.toFixed(1)}x` : '—', color: data.ltvCacRatio >= 3 ? D.green : D.amber },
          { label: 'Best Channel', value: data.bestChannel || '—', color: D.teal },
          { label: '12mo Retention', value: data.retention12mo ? `${data.retention12mo}%` : '—', color: D.purple },
        ].map(s => (
          <div key={s.label} style={{ ...sCard, flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 130px', minWidth: isMobile ? 0 : 130, marginBottom: 0, textAlign: 'center' }}>
            <div style={{ fontFamily: MONO, fontSize: isMobile ? 16 : 20, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* By Acquisition Source */}
      {data.bySource && (
        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>LTV by Acquisition Channel</div>
          {Object.entries(data.bySource).map(([source, stats]) => (
            <div key={source} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${D.border}22`, fontSize: 12 }}>
              <span style={{ color: D.heading, fontWeight: 500 }}>{source}</span>
              <div style={{ display: 'flex', gap: 16 }}>
                <span style={{ color: D.muted }}>{stats.count} customers</span>
                <span style={{ color: D.green, fontFamily: MONO }}>LTV: {fmt(stats.avgLTV)}</span>
                <span style={{ color: D.amber, fontFamily: MONO }}>CAC: {fmt(stats.avgCAC)}</span>
                <span style={{ color: stats.ratio >= 3 ? D.green : D.amber, fontFamily: MONO }}>{stats.ratio?.toFixed(1)}x</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
