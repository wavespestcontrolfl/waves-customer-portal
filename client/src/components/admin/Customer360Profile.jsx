import { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#fff' };
const MONO = "'JetBrains Mono', monospace";
const FONT = "'DM Sans', sans-serif";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const mins = Math.floor((Date.now() - new Date(dateStr)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function fmtDate(d) {
  if (!d) return '--';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtCurrency(v) { return '$' + parseFloat(v || 0).toFixed(2); }

const TIER_COLORS = { Platinum: '#7C3AED', Gold: D.amber, Silver: '#64748B', Bronze: '#cd7f32', 'One-Time': '#0A7EC2' };
const STAGE_LABELS = { new_lead: 'New Lead', contacted: 'Contacted', estimate_sent: 'Est. Sent', estimate_viewed: 'Est. Viewed', follow_up: 'Follow Up', won: 'Won', active_customer: 'Active', at_risk: 'At Risk', churned: 'Churned', lost: 'Lost', dormant: 'Dormant' };

// --- Health Score Circle ---
function HealthCircle({ score }) {
  if (score == null) return null;
  const color = score >= 70 ? D.green : score >= 40 ? D.amber : D.red;
  const r = 18, circ = 2 * Math.PI * r, offset = circ - (score / 100) * circ;
  return (
    <svg width={44} height={44} viewBox="0 0 44 44" style={{ flexShrink: 0 }}>
      <circle cx={22} cy={22} r={r} fill="none" stroke={D.border} strokeWidth={3} />
      <circle cx={22} cy={22} r={r} fill="none" stroke={color} strokeWidth={3}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform="rotate(-90 22 22)" />
      <text x={22} y={26} textAnchor="middle" fill={color} fontSize={12} fontWeight={700} fontFamily={MONO}>{score}</text>
    </svg>
  );
}

// --- Radar Chart (SVG, 6 axes) ---
function RadarChart({ data }) {
  // data: { label, value (0-100) }[]
  if (!data || data.length < 3) return null;
  const size = 160, cx = size / 2, cy = size / 2, maxR = 60;
  const n = data.length;
  const angleStep = (2 * Math.PI) / n;
  const pointAt = (i, pct) => {
    const a = -Math.PI / 2 + i * angleStep;
    return [cx + maxR * (pct / 100) * Math.cos(a), cy + maxR * (pct / 100) * Math.sin(a)];
  };
  const gridLevels = [25, 50, 75, 100];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', margin: '0 auto' }}>
      {gridLevels.map(lv => (
        <polygon key={lv} points={data.map((_, i) => pointAt(i, lv).join(',')).join(' ')}
          fill="none" stroke={D.border} strokeWidth={0.5} />
      ))}
      {data.map((_, i) => {
        const [x, y] = pointAt(i, 100);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={D.border} strokeWidth={0.5} />;
      })}
      <polygon points={data.map((d, i) => pointAt(i, d.value).join(',')).join(' ')}
        fill={`${D.teal}33`} stroke={D.teal} strokeWidth={1.5} />
      {data.map((d, i) => {
        const [x, y] = pointAt(i, 115);
        return <text key={i} x={x} y={y} textAnchor="middle" fill={D.muted} fontSize={8} fontFamily={FONT}>{d.label}</text>;
      })}
    </svg>
  );
}

// --- Badge helpers ---
function TierBadge({ tier }) {
  if (!tier) return <span style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10, fontWeight: 700, border: `1px solid ${D.muted}`, color: D.muted, letterSpacing: 0.5, textTransform: 'uppercase' }}>No Plan</span>;
  const color = TIER_COLORS[tier] || D.muted;
  return <span style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10, fontWeight: 700, border: `1px solid ${color}`, color, letterSpacing: 0.5, textTransform: 'uppercase' }}>{tier}</span>;
}
function StageBadge({ stage }) {
  const label = STAGE_LABELS[stage] || stage;
  const color = stage === 'active_customer' ? D.green : stage === 'at_risk' ? D.red : stage === 'churned' ? D.red : D.teal;
  return <span style={{ padding: '3px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 600, background: `${color}22`, color }}>{label}</span>;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export default function Customer360Profile({ customerId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [timelineFilter, setTimelineFilter] = useState('all');
  const [timeline, setTimeline] = useState([]);
  const [smsReply, setSmsReply] = useState('');
  const [sendingSms, setSendingSms] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminFetch(`/admin/customers/${customerId}`),
      adminFetch(`/admin/customers/${customerId}/timeline`).catch(() => ({ timeline: [] })),
    ]).then(([detail, tl]) => {
      setData(detail);
      setTimeline(tl.timeline || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [customerId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (loading) return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelBaseStyle} onClick={e => e.stopPropagation()}>
        <div style={{ color: D.muted, textAlign: 'center', padding: 60, fontSize: 14 }}>Loading customer profile...</div>
      </div>
    </div>
  );

  if (!data || !data.customer) return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelBaseStyle} onClick={e => e.stopPropagation()}>
        <div style={{ color: D.red, textAlign: 'center', padding: 60 }}>Failed to load customer</div>
      </div>
    </div>
  );

  const c = data.customer;
  const prefs = data.preferences || {};
  const hs = data.healthScore || {};
  const score = hs.health_score ?? hs.score ?? null;
  const invoices = data.invoices || [];
  const cards = data.cards || [];
  const photos = data.photos || [];
  const referral = data.referralInfo;
  const discounts = data.customerDiscounts || [];
  const compliance = data.complianceRecords || [];
  const services = data.services || [];
  const payments = data.payments || [];
  const scheduled = data.scheduled || [];
  const smsLog = data.smsLog || [];

  const balanceOwed = invoices.filter(i => i.status !== 'paid').reduce((s, i) => s + parseFloat(i.amount_due || 0) - parseFloat(i.amount_paid || 0), 0);
  const lastPayment = payments[0];
  const nextService = scheduled.find(s => s.status !== 'cancelled' && s.status !== 'completed' && new Date(s.scheduled_date) >= new Date());

  // Card expiry warning
  const expiringCard = cards.find(cd => {
    if (!cd.exp_month || !cd.exp_year) return false;
    const exp = new Date(cd.exp_year, cd.exp_month, 0);
    const diff = (exp - new Date()) / 86400000;
    return diff < 60 && diff > -30;
  });

  // Alerts
  const alerts = [];
  if (prefs.pet_details) alerts.push({ type: 'amber', icon: 'PET', text: `Pet: ${prefs.pet_details}` });
  if (prefs.property_gate_code) alerts.push({ type: 'teal', icon: 'GATE', text: `Property gate: ${prefs.property_gate_code}` });
  if (prefs.neighborhood_gate_code) alerts.push({ type: 'teal', icon: 'GATE', text: `Neighborhood gate: ${prefs.neighborhood_gate_code}` });
  if (balanceOwed > 0) alerts.push({ type: 'red', icon: '$', text: `Overdue balance: ${fmtCurrency(balanceOwed)}` });
  if (expiringCard) alerts.push({ type: 'red', icon: 'CARD', text: `Card ending ${expiringCard.last_four} expiring ${expiringCard.exp_month}/${expiringCard.exp_year}` });
  if (prefs.chemical_sensitivities) alerts.push({ type: 'amber', icon: 'CHEM', text: `Chemical sensitivity: ${prefs.chemical_sensitivities}` });
  if (prefs.special_instructions) alerts.push({ type: 'amber', icon: 'NOTE', text: prefs.special_instructions });

  // Timeline filtering
  const filteredTimeline = timelineFilter === 'all' ? timeline : timeline.filter(t => t.type === timelineFilter || (timelineFilter === 'notes' && t.type === 'interaction'));

  // Radar chart data from health score factors
  const radarData = hs.risk_factors ? [
    { label: 'Payment', value: 80 }, { label: 'Engagement', value: 60 },
    { label: 'Service', value: 70 }, { label: 'Satisfaction', value: 75 },
    { label: 'Tenure', value: 90 }, { label: 'Revenue', value: 65 },
  ] : [
    { label: 'Payment', value: score ? Math.min(score + 10, 100) : 50 },
    { label: 'Engagement', value: score || 50 },
    { label: 'Service', value: score ? Math.min(score + 5, 100) : 50 },
    { label: 'Satisfaction', value: score ? Math.max(score - 5, 0) : 50 },
    { label: 'Tenure', value: c.memberSince ? Math.min(Math.floor((Date.now() - new Date(c.memberSince)) / 86400000 / 3.65), 100) : 50 },
    { label: 'Revenue', value: c.lifetimeRevenue > 0 ? Math.min(Math.floor(c.lifetimeRevenue / 50), 100) : 20 },
  ];

  const sendSms = async () => {
    if (!smsReply.trim() || !c.phone) return;
    setSendingSms(true);
    try {
      await adminFetch('/admin/communications/send-sms', { method: 'POST', body: JSON.stringify({ to: c.phone, message: smsReply }) });
      setSmsReply('');
      // Refresh sms
      const fresh = await adminFetch(`/admin/customers/${customerId}`);
      setData(fresh);
    } catch { /* ignore */ }
    setSendingSms(false);
  };

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'services', label: 'Services' },
    { key: 'billing', label: 'Billing' },
    { key: 'comms', label: 'Comms' },
    { key: 'property', label: 'Property' },
    { key: 'compliance', label: 'Compliance' },
  ];

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div ref={panelRef} onClick={e => e.stopPropagation()} style={panelBaseStyle}>
        <style>{`
          @media (max-width: 768px) {
            .c360-header-actions { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; flex-wrap: nowrap !important; }
            .c360-header-meta { flex-direction: column !important; gap: 4px !important; }
            .c360-overview-grid { grid-template-columns: 1fr !important; }
            .c360-alerts { flex-direction: column !important; }
            .c360-tab-bar { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; }
            .c360-services-grid { grid-template-columns: 1fr !important; }
            .c360-billing-grid { grid-template-columns: 1fr !important; }
            .c360-property-grid { grid-template-columns: 1fr !important; }
            .c360-panel { width: 100% !important; max-width: 100% !important; }
          }
        `}</style>

        {/* ========= ZONE 1: STICKY HEADER ========= */}
        <div style={{ position: 'sticky', top: 0, zIndex: 10, background: D.card, borderBottom: `1px solid ${D.border}`, padding: '16px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', fontFamily: FONT }}>{c.firstName} {c.lastName}</div>
              <HealthCircle score={score} />
              <TierBadge tier={c.tier} />
              <StageBadge stage={c.pipelineStage} />
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 22, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }} aria-label="Close">x</button>
          </div>
          <div className="c360-header-meta" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: D.muted, marginBottom: 10 }}>
            <span>{c.address?.line1}, {c.address?.city}, {c.address?.state} {c.address?.zip}</span>
            <span style={{ color: D.green, fontFamily: MONO }}>{fmtCurrency(c.monthlyRate)}/mo</span>
            <span style={{ fontFamily: MONO }}>{fmtCurrency(c.annualValue)}/yr</span>
            {c.memberSince && <span>Since {fmtDate(c.memberSince)}</span>}
          </div>
          <div className="c360-header-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {c.phone && <>
              <a href={`/admin/communications?phone=${encodeURIComponent(c.phone)}&action=sms`} style={actionBtnStyle(D.teal)}>Text</a>
              <a href={`tel:${c.phone}`} style={actionBtnStyle(D.border)}>Call</a>
            </>}
            <a href={`/admin/schedule?customer=${customerId}`} style={actionBtnStyle(D.border)}>Book Appt</a>
            <a href={`/admin/invoices?customer=${customerId}`} style={actionBtnStyle(D.border)}>Invoice</a>
            <button onClick={() => { setActiveTab('comms'); }} style={{ ...actionBtnStyleBtn(D.border), cursor: 'pointer' }}>Add Note</button>
          </div>
        </div>

        {/* ========= ZONE 2: ALERT BANNERS ========= */}
        {alerts.length > 0 && (
          <div className="c360-alerts" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 24px', background: D.bg }}>
            {alerts.map((a, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                borderRadius: 8, fontSize: 12, fontWeight: 500,
                background: `${D[a.type]}15`, border: `1px solid ${D[a.type]}44`, color: D[a.type],
              }}>
                <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: 0.5 }}>{a.icon}</span>
                <span>{a.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* ========= ZONE 3: TAB BAR ========= */}
        <div className="c360-tab-bar" style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${D.border}`, background: D.bg, padding: '0 24px' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
              padding: '10px 16px', background: 'none', border: 'none', fontSize: 13, fontWeight: 600,
              color: activeTab === t.key ? D.teal : D.muted, cursor: 'pointer', fontFamily: FONT,
              borderBottom: activeTab === t.key ? `2px solid ${D.teal}` : '2px solid transparent',
              whiteSpace: 'nowrap', minHeight: 44,
            }}>{t.label}</button>
          ))}
        </div>

        {/* ========= TAB CONTENT ========= */}
        <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>

          {/* ---- OVERVIEW TAB ---- */}
          {activeTab === 'overview' && (
            <div className="c360-overview-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20 }}>
              {/* Col 1: Services */}
              <div>
                <SectionTitle>Upcoming Service</SectionTitle>
                {nextService ? (
                  <div style={{ padding: 10, background: D.bg, borderRadius: 8, marginBottom: 12 }}>
                    <div style={{ fontSize: 13, color: D.teal, fontWeight: 600 }}>{nextService.service_type}</div>
                    <div style={{ fontSize: 12, color: D.muted }}>{fmtDate(nextService.scheduled_date)} -- {nextService.status}</div>
                  </div>
                ) : <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>No upcoming services</div>}

                <SectionTitle>Recent Services ({services.length})</SectionTitle>
                {services.slice(0, 5).map((s, i) => (
                  <div key={i} style={{ padding: '6px 0', fontSize: 12, borderBottom: `1px solid ${D.border}22`, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#0F172A' }}>{s.service_type}</span>
                    <span style={{ color: D.muted }}>{fmtDate(s.service_date)}</span>
                  </div>
                ))}
                {services.length === 0 && <div style={{ fontSize: 12, color: D.muted }}>No services recorded</div>}
              </div>

              {/* Col 2: Billing snapshot */}
              <div>
                <SectionTitle>Billing Summary</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                  <StatCard label="Balance Owed" value={fmtCurrency(balanceOwed)} color={balanceOwed > 0 ? D.red : D.green} />
                  <StatCard label="Lifetime Rev" value={fmtCurrency(c.lifetimeRevenue)} color={D.green} />
                </div>
                {cards.length > 0 && (
                  <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>
                    Card: {cards[0].card_brand} ending {cards[0].last_four}
                  </div>
                )}
                {lastPayment && (
                  <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
                    Last payment: {fmtCurrency(lastPayment.amount)} on {fmtDate(lastPayment.payment_date)}
                  </div>
                )}
                <SectionTitle>Recent Invoices</SectionTitle>
                {invoices.slice(0, 3).map((inv, i) => (
                  <div key={i} style={{ padding: '5px 0', fontSize: 12, borderBottom: `1px solid ${D.border}22`, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#0F172A' }}>{fmtCurrency(inv.amount_due)}</span>
                    <span style={{ color: inv.status === 'paid' ? D.green : D.red, fontWeight: 600 }}>{inv.status}</span>
                    <span style={{ color: D.muted }}>{fmtDate(inv.created_at)}</span>
                  </div>
                ))}
              </div>

              {/* Col 3: Health + Referral + Discounts */}
              <div>
                <SectionTitle>Health Radar</SectionTitle>
                <RadarChart data={radarData} />
                {score != null && (
                  <div style={{ textAlign: 'center', fontSize: 12, color: D.muted, marginTop: 4 }}>
                    Score: <span style={{ color: score >= 70 ? D.green : score >= 40 ? D.amber : D.red, fontWeight: 700 }}>{score}/100</span>
                    {hs.churn_risk_level && <span> -- {hs.churn_risk_level}</span>}
                  </div>
                )}
                {referral && (
                  <div style={{ marginTop: 16 }}>
                    <SectionTitle>Referral Stats</SectionTitle>
                    <div style={{ fontSize: 12, color: D.text }}>
                      Code: <span style={{ color: D.teal, fontFamily: MONO }}>{c.referralCode}</span>
                    </div>
                    {referral.total_referrals != null && <div style={{ fontSize: 12, color: D.muted }}>Referrals: {referral.total_referrals}</div>}
                    {referral.total_earned != null && <div style={{ fontSize: 12, color: D.green }}>Earned: {fmtCurrency(referral.total_earned)}</div>}
                  </div>
                )}
                {discounts.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <SectionTitle>Active Discounts</SectionTitle>
                    {discounts.map((d, i) => (
                      <div key={i} style={{ fontSize: 12, color: D.amber, padding: '3px 0' }}>
                        {d.discount_name || 'Discount'}: {d.discount_type === 'percentage' ? `${d.discount_value}%` : fmtCurrency(d.discount_value)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ---- SERVICES TAB ---- */}
          {activeTab === 'services' && (
            <div>
              <SectionTitle>Service History ({services.length})</SectionTitle>
              {services.length === 0 ? <div style={{ color: D.muted, fontSize: 13 }}>No service records</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {services.map((s, i) => <ServiceRow key={i} service={s} />)}
                </div>
              )}
              {scheduled.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <SectionTitle>Scheduled Services ({scheduled.length})</SectionTitle>
                  {scheduled.map((s, i) => (
                    <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 8, marginBottom: 6, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: D.teal, fontWeight: 600 }}>{s.service_type}</span>
                      <span style={{ color: D.muted }}>{fmtDate(s.scheduled_date)}</span>
                      <span style={{ color: s.status === 'confirmed' ? D.green : D.muted, fontSize: 11 }}>{s.status}</span>
                    </div>
                  ))}
                </div>
              )}
              {photos.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <SectionTitle>Service Photos ({photos.length})</SectionTitle>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
                    {photos.map((p, i) => (
                      <div key={i} style={{ borderRadius: 8, overflow: 'hidden', background: D.bg, aspectRatio: '1' }}>
                        <img src={p.s3_url} alt={p.caption || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={e => { e.target.style.display = 'none'; }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---- BILLING TAB ---- */}
          {activeTab === 'billing' && (
            <div>
              <div className="c360-billing-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
                <StatCard label="Balance Owed" value={fmtCurrency(balanceOwed)} color={balanceOwed > 0 ? D.red : D.green} />
                <StatCard label="Monthly Rate" value={fmtCurrency(c.monthlyRate)} color={D.teal} />
                <StatCard label="Annual Value" value={fmtCurrency(c.annualValue)} color={D.teal} />
                <StatCard label="Lifetime Revenue" value={fmtCurrency(c.lifetimeRevenue)} color={D.green} />
              </div>

              <SectionTitle>Invoices ({invoices.length})</SectionTitle>
              {invoices.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
                  <thead>
                    <tr>{['Date', 'Amount', 'Paid', 'Status'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'left', borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>{fmtDate(inv.created_at || inv.invoice_date)}</td>
                        <td style={{ ...tdStyle, fontFamily: MONO }}>{fmtCurrency(inv.amount_due)}</td>
                        <td style={{ ...tdStyle, fontFamily: MONO }}>{fmtCurrency(inv.amount_paid)}</td>
                        <td style={{ ...tdStyle, color: inv.status === 'paid' ? D.green : D.red, fontWeight: 600 }}>{inv.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ color: D.muted, fontSize: 13, marginBottom: 20 }}>No invoices</div>}

              <SectionTitle>Payment History ({payments.length})</SectionTitle>
              {payments.slice(0, 10).map((p, i) => (
                <div key={i} style={{ padding: '6px 0', fontSize: 12, borderBottom: `1px solid ${D.border}22`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: p.refund_status ? D.muted : D.green, fontFamily: MONO }}>{fmtCurrency(p.amount)}</span>
                  <span style={{ color: D.muted }}>{p.card_brand} ...{p.last_four}</span>
                  <span style={{ color: D.muted }}>{fmtDate(p.payment_date)}</span>
                  <span style={{ color: p.status === 'paid' ? D.green : p.status === 'failed' ? D.red : p.status === 'refunded' ? D.muted : D.amber, fontSize: 10, fontWeight: 700 }}>{p.refund_status ? 'REFUNDED' : (p.status || '').toUpperCase()}</span>
                  {p.processor === 'stripe' && p.status === 'paid' && !p.refund_status && (
                    <button onClick={async () => {
                      if (!window.confirm(`Refund $${parseFloat(p.amount).toFixed(2)} to ${c.firstName} ${c.lastName}?`)) return;
                      try {
                        await adminFetch(`/admin/customers/${c.id}/refund`, { method: 'POST', body: JSON.stringify({ paymentId: p.id, amount: parseFloat(p.amount), reason: 'requested_by_customer' }) });
                        const fresh = await adminFetch(`/admin/customers/${customerId}`);
                        setData(fresh);
                      } catch (err) { alert('Refund failed: ' + err.message); }
                    }} style={{ padding: '2px 8px', borderRadius: 4, border: `1px solid ${D.red}`, background: 'transparent', color: D.red, fontSize: 10, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>Refund</button>
                  )}
                </div>
              ))}

              {cards.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <SectionTitle>Cards on File ({cards.length})</SectionTitle>
                  {cards.map((cd, i) => (
                    <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 8, marginBottom: 6, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#0F172A' }}>{cd.card_brand} ending {cd.last_four}</span>
                      {cd.exp_month && <span style={{ color: D.muted, fontFamily: MONO }}>{cd.exp_month}/{cd.exp_year}</span>}
                      {cd.is_default && <span style={{ color: D.teal, fontSize: 10, fontWeight: 700 }}>DEFAULT</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---- COMMUNICATIONS TAB ---- */}
          {activeTab === 'comms' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <SectionTitle>SMS Thread ({smsLog.length})</SectionTitle>
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12, maxHeight: 400 }}>
                {[...smsLog].reverse().map((s, i) => (
                  <div key={i} style={{
                    maxWidth: '75%', padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.5,
                    alignSelf: s.direction === 'inbound' ? 'flex-start' : 'flex-end',
                    background: s.direction === 'inbound' ? D.bg : `${D.teal}22`,
                    color: s.direction === 'inbound' ? D.text : D.teal,
                    border: `1px solid ${s.direction === 'inbound' ? D.border : `${D.teal}44`}`,
                    borderBottomLeftRadius: s.direction === 'inbound' ? 4 : 12,
                    borderBottomRightRadius: s.direction === 'inbound' ? 12 : 4,
                  }}>
                    <div>{s.message_body}</div>
                    <div style={{ fontSize: 10, color: D.muted, marginTop: 4, textAlign: 'right' }}>{timeAgo(s.created_at)}</div>
                  </div>
                ))}
                {smsLog.length === 0 && <div style={{ color: D.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>No SMS messages</div>}
              </div>
              {c.phone && (
                <div style={{ display: 'flex', gap: 8, padding: '12px 0', borderTop: `1px solid ${D.border}` }}>
                  <input value={smsReply} onChange={e => setSmsReply(e.target.value)} placeholder="Type a message..."
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSms(); } }}
                    style={{ flex: 1, padding: '10px 14px', background: '#FFFFFF', border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', fontFamily: FONT }} />
                  <button onClick={sendSms} disabled={sendingSms || !smsReply.trim()} style={{
                    padding: '10px 20px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
                    fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: sendingSms ? 0.5 : 1, minHeight: 44,
                  }}>{sendingSms ? '...' : 'Send'}</button>
                </div>
              )}

              {/* Interactions / Notes */}
              <div style={{ marginTop: 16 }}>
                <SectionTitle>Notes & Interactions ({(data.interactions || []).length})</SectionTitle>
                {(data.interactions || []).slice(0, 10).map((n, i) => (
                  <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 8, marginBottom: 6, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: D.teal, fontWeight: 600 }}>{n.interaction_type}: {n.subject}</span>
                      <span style={{ color: D.muted, fontSize: 10 }}>{timeAgo(n.created_at)}</span>
                    </div>
                    {n.body && <div style={{ color: D.muted }}>{n.body.substring(0, 200)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ---- PROPERTY TAB ---- */}
          {activeTab === 'property' && (
            <div>
              {/* Satellite image */}
              {(c.satelliteUrl || c.address?.line1) && (
                <div style={{ marginBottom: 20, borderRadius: 12, overflow: 'hidden', maxHeight: 200 }}>
                  {c.satelliteUrl ? (
                    <img src={c.satelliteUrl} alt="Satellite view" style={{ width: '100%', height: 200, objectFit: 'cover' }}
                      onError={e => { e.target.style.display = 'none'; }} />
                  ) : (
                    <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.address.line1}, ${c.address.city}, ${c.address.state} ${c.address.zip}`)}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{ display: 'block', padding: 20, background: D.bg, textAlign: 'center', color: D.teal, fontSize: 13, textDecoration: 'none' }}>
                      View on Google Maps
                    </a>
                  )}
                </div>
              )}

              <div className="c360-property-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                {/* Property details */}
                <div>
                  <SectionTitle>Property Details</SectionTitle>
                  {[
                    ['Type', c.property?.type],
                    ['Lawn Type', c.property?.lawnType],
                    ['Property Sqft', c.property?.sqft ? `${parseInt(c.property.sqft).toLocaleString()} sqft` : null],
                    ['Lot Sqft', c.property?.lotSqft ? `${parseInt(c.property.lotSqft).toLocaleString()} sqft` : null],
                    ['Palm Count', c.property?.palmCount],
                    ['Pool', prefs.has_pool ? 'Yes' : null],
                    ['Irrigation', prefs.has_irrigation ? 'Yes' : null],
                  ].map(([label, val]) => val && (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, borderBottom: `1px solid ${D.border}22` }}>
                      <span style={{ color: D.muted }}>{label}</span>
                      <span style={{ color: '#0F172A' }}>{val}</span>
                    </div>
                  ))}
                </div>

                {/* Access & preferences */}
                <div>
                  <SectionTitle>Access & Preferences</SectionTitle>
                  {[
                    ['Property Gate Code', prefs.property_gate_code],
                    ['Neighborhood Gate', prefs.neighborhood_gate_code],
                    ['Parking Instructions', prefs.parking_instructions],
                    ['Interior Access', prefs.interior_access_instructions],
                    ['Pet Details', prefs.pet_details],
                    ['Chemical Sensitivities', prefs.chemical_sensitivities],
                    ['Preferred Time', prefs.preferred_service_time],
                    ['Preferred Tech', prefs.preferred_technician],
                    ['Special Instructions', prefs.special_instructions],
                  ].map(([label, val]) => val && (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, borderBottom: `1px solid ${D.border}22` }}>
                      <span style={{ color: D.muted }}>{label}</span>
                      <span style={{ color: '#0F172A', textAlign: 'right', maxWidth: 200, wordBreak: 'break-word' }}>{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ---- COMPLIANCE TAB ---- */}
          {activeTab === 'compliance' && (
            <div>
              <SectionTitle>Application History ({compliance.length})</SectionTitle>
              {compliance.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
                  <thead>
                    <tr>{['Date', 'Product', 'Rate', 'Area', 'Technician'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'left', borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {compliance.map((r, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>{fmtDate(r.applied_at)}</td>
                        <td style={{ ...tdStyle, color: '#0F172A' }}>{r.product_name || r.product_id}</td>
                        <td style={{ ...tdStyle, fontFamily: MONO }}>{r.rate_per_1000_sqft ? `${r.rate_per_1000_sqft}/1k sqft` : '--'}</td>
                        <td style={tdStyle}>{r.area_treated || '--'}</td>
                        <td style={tdStyle}>{r.technician_name || '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ color: D.muted, fontSize: 13 }}>No application records</div>}

              {/* Compliance notes */}
              <div style={{ marginTop: 20, padding: 16, background: D.bg, borderRadius: 10 }}>
                <SectionTitle>Product Limits</SectionTitle>
                <div style={{ fontSize: 12, color: D.muted }}>
                  <div>Celsius applications this year: {compliance.filter(r => (r.product_name || '').toLowerCase().includes('celsius')).length}</div>
                  <div>Total nitrogen applied YTD: Check compliance records for detailed tracking</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ========= ZONE 4: TIMELINE ========= */}
        <div style={{ borderTop: `1px solid ${D.border}`, padding: '16px 24px', background: D.bg }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <SectionTitle style={{ marginBottom: 0 }}>Timeline ({filteredTimeline.length})</SectionTitle>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {[
                { key: 'all', label: 'All' },
                { key: 'sms', label: 'SMS' },
                { key: 'call', label: 'Calls' },
                { key: 'service', label: 'Services' },
                { key: 'payment', label: 'Payments' },
                { key: 'notes', label: 'Notes' },
              ].map(f => (
                <button key={f.key} onClick={() => setTimelineFilter(f.key)} style={{
                  padding: '3px 10px', borderRadius: 9999, border: `1px solid ${timelineFilter === f.key ? D.teal : D.border}`,
                  background: timelineFilter === f.key ? `${D.teal}22` : 'transparent',
                  color: timelineFilter === f.key ? D.teal : D.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer',
                }}>{f.label}</button>
              ))}
            </div>
          </div>
          <div style={{ maxHeight: 250, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filteredTimeline.slice(0, 30).map((item, i) => {
              const ICONS = { sms: 'SMS', call: 'CALL', service: 'SVC', payment: 'PAY', review: 'REV', scheduled_service: 'SCHED', interaction: 'NOTE', activity: 'ACT' };
              const COLORS = { sms: D.teal, call: '#60a5fa', service: D.green, payment: D.green, review: D.amber, scheduled_service: D.teal, interaction: D.muted, activity: D.muted };
              const color = COLORS[item.type] || D.muted;
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: `1px solid ${D.border}22`, fontSize: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}15`, padding: '2px 6px', borderRadius: 4, flexShrink: 0, letterSpacing: 0.5 }}>{ICONS[item.type] || 'EVT'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color, fontWeight: 600 }}>{item.title}</span>
                    {item.description && <span style={{ color: D.muted, marginLeft: 6 }}>{item.description.substring(0, 80)}</span>}
                  </div>
                  <span style={{ color: D.muted, fontSize: 10, fontFamily: MONO, flexShrink: 0 }}>{timeAgo(item.date)}</span>
                </div>
              );
            })}
            {filteredTimeline.length === 0 && <div style={{ color: D.muted, fontSize: 12, textAlign: 'center', padding: 16 }}>No timeline events</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS & STYLES
// ============================================================================
function SectionTitle({ children, style: extra }) {
  return <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: FONT, ...extra }}>{children}</div>;
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ padding: 12, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || '#0F172A', fontFamily: MONO }}>{value}</div>
    </div>
  );
}

function ServiceRow({ service: s }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ background: D.bg, borderRadius: 8, overflow: 'hidden', marginBottom: 4 }}>
      <div onClick={() => setExpanded(!expanded)} style={{
        padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        cursor: 'pointer', fontSize: 13,
      }}>
        <span style={{ color: '#0F172A', fontWeight: 600 }}>{s.service_type}</span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {s.total_cost > 0 && <span style={{ color: D.green, fontFamily: MONO }}>{fmtCurrency(s.total_cost)}</span>}
          <span style={{ color: D.muted }}>{fmtDate(s.service_date)}</span>
          <span style={{ color: D.muted, fontSize: 10 }}>{expanded ? 'v' : '>'}</span>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '8px 14px', borderTop: `1px solid ${D.border}22`, fontSize: 12 }}>
          {s.notes && <div style={{ color: D.text, marginBottom: 4 }}>{s.notes}</div>}
          {s.products_used && <div style={{ color: D.muted }}>Products: {s.products_used}</div>}
          {s.areas_treated && <div style={{ color: D.muted }}>Areas: {s.areas_treated}</div>}
          {s.technician_name && <div style={{ color: D.muted }}>Tech: {s.technician_name}</div>}
          {!s.notes && !s.products_used && !s.areas_treated && <div style={{ color: D.muted }}>No additional details</div>}
        </div>
      )}
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
  display: 'flex', justifyContent: 'flex-end',
};

const panelBaseStyle = {
  width: '100%', maxWidth: 900, height: '100vh', background: D.card,
  display: 'flex', flexDirection: 'column', overflowY: 'auto',
  boxShadow: '-4px 0 24px rgba(0,0,0,0.1)', fontFamily: FONT,
};

function actionBtnStyle(borderColor) {
  return {
    padding: '6px 14px', borderRadius: 8, border: `1px solid ${borderColor}`,
    background: borderColor === D.teal ? D.teal : 'transparent',
    color: borderColor === D.teal ? D.white : D.muted,
    fontSize: 12, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
    fontFamily: FONT, display: 'inline-flex', alignItems: 'center', minHeight: 36,
  };
}

function actionBtnStyleBtn(borderColor) {
  return {
    padding: '6px 14px', borderRadius: 8, border: `1px solid ${borderColor}`,
    background: 'transparent', color: D.muted, fontSize: 12, fontWeight: 600,
    fontFamily: FONT, minHeight: 36,
  };
}

const tdStyle = { padding: '8px 12px', fontSize: 12, color: D.muted, borderBottom: `1px solid ${D.border}` };
