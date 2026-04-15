import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import DashboardIntelligenceBar from '../../components/admin/DashboardIntelligenceBar';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', tealDark: '#065A8C', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#FFFFFF', heading: '#0F172A', subtle: '#F8FAFC' };

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then(r => {
    if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    return r.json();
  });
}

function fmt(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtD(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(n) { return n == null ? '—' : `${n}%`; }

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function fmtTimeShort(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const ACTIVITY_ICONS = {
  estimate_created: '📋', estimate_sent: '📤', estimate_viewed: '👁️', estimate_accepted: '✅',
  estimate_declined: '❌', customer_created: '👤', customer_onboarded: '🎉',
  service_completed: '✓', payment_processed: '💰', payment_failed: '⚠️',
  review_requested: '⭐', sms_sent: '💬', sms_received: '📱',
};

const STATUS_COLORS = {
  confirmed: D.green, pending: D.amber, en_route: D.teal, completed: D.green, cancelled: D.red,
};

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'wtd', label: 'WTD' },
  { id: 'mtd', label: 'MTD' },
  { id: 'ytd', label: 'YTD' },
];

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('mtd');

  useEffect(() => {
    adminFetch('/admin/dashboard')
      .then(d => { setData(d); setLoading(false); })
      .catch(err => { console.error('[dashboard] load failed', err); setLoading(false); });
  }, []);

  useEffect(() => {
    adminFetch(`/admin/dashboard/core-kpis?period=${period}`)
      .then(d => setKpis(d))
      .catch(err => console.error('[dashboard] core-kpis failed', err));
  }, [period]);

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontSize: 15 }}>Loading dashboard...</div>;
  if (!data || data.error || !data.kpis) return <div style={{ color: D.red, padding: 60, textAlign: 'center' }}>Failed to load dashboard. <a href="/admin/login" style={{ color: D.teal }}>Try logging in again</a></div>;

  const k = data.kpis;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Hero KPI tiles — the "above-the-fold" 4
  const HERO_KPIS = [
    { label: 'Revenue MTD', value: fmt(k.revenueMTD), delta: k.revenueChangePercent, deltaSuffix: '% vs last month', icon: '💰' },
    { label: 'Active Customers', value: k.activeCustomers, delta: k.newCustomersThisMonth, deltaPrefix: '+', deltaSuffix: ' new MTD', icon: '👥' },
    { label: 'MRR', value: fmt(data.mrr), sub: `ARR: ${fmt(data.mrr * 12)}`, icon: '📈' },
    { label: 'Google Rating', value: `${k.googleReviewRating} ★`, sub: `${k.googleReviewCount} reviews · ${k.googleUnresponded || 0} unreplied`, icon: '⭐' },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: D.heading, fontFamily: "'DM Sans', sans-serif" }}>{greeting()}, Adam</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>{today}</div>
        </div>
      </div>

      <DashboardIntelligenceBar kpiData={data} />

      {/* HERO KPI ROW */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        {HERO_KPIS.map((h, i) => (
          <div key={i} style={{
            background: D.card, borderRadius: 10, padding: isMobile ? 16 : 20,
            border: `1px solid ${D.border}`, borderTop: `3px solid ${D.teal}`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: D.muted, marginBottom: 8 }}>
              {h.icon} {h.label}
            </div>
            <div style={{ fontSize: isMobile ? 24 : 30, fontWeight: 700, color: D.heading, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.1 }}>
              {h.value}
            </div>
            {h.delta != null && (
              <div style={{ fontSize: 12, color: h.delta >= 0 ? D.green : D.red, marginTop: 6, fontWeight: 600 }}>
                {h.delta >= 0 ? '↑' : '↓'} {h.deltaPrefix || ''}{Math.abs(h.delta)}{h.deltaSuffix}
              </div>
            )}
            {h.sub && h.delta == null && (
              <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>{h.sub}</div>
            )}
          </div>
        ))}
      </div>

      {/* CORE OPERATIONAL KPIS — ServiceTitan style */}
      <div style={{ background: D.card, borderRadius: 10, border: `1px solid ${D.border}`, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: `1px solid ${D.border}`, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Core KPIs</div>
            <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{kpis?.periodLabel || 'Month to Date'}</div>
          </div>
          <div style={{ display: 'flex', background: D.subtle, borderRadius: 8, padding: 3, border: `1px solid ${D.border}` }}>
            {PERIODS.map(p => (
              <button key={p.id} onClick={() => setPeriod(p.id)} style={{
                background: period === p.id ? D.teal : 'transparent',
                color: period === p.id ? D.white : D.text,
                border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                fontFamily: "'DM Sans', sans-serif",
              }}>{p.label}</button>
            ))}
          </div>
        </div>

        {!kpis ? (
          <div style={{ padding: 40, textAlign: 'center', color: D.muted, fontSize: 13 }}>Loading KPIs...</div>
        ) : (
          <div style={{ padding: isMobile ? 14 : 20 }}>
            {/* OPS KPIs */}
            <SectionLabel>Operations</SectionLabel>
            <KpiGrid isMobile={isMobile}>
              <KpiTile label="Service Completion" value={pct(kpis.service.completionRate)} sub={`${kpis.service.completed}/${kpis.service.scheduled} jobs`} color={kpis.service.completionRate >= 95 ? D.green : kpis.service.completionRate >= 85 ? D.amber : D.red} />
              <KpiTile label="Callback Rate" value={kpis.service.callbackRate != null ? `${kpis.service.callbackRate}%` : '—'} sub={`${kpis.service.callbacks} callbacks`} color={kpis.service.callbackRate == null ? D.muted : kpis.service.callbackRate < 3 ? D.green : kpis.service.callbackRate < 6 ? D.amber : D.red} />
              <KpiTile label="Tech Utilization" value={pct(kpis.financial.utilization)} sub={`${kpis.financial.laborHours}h billable`} color={kpis.financial.utilization >= 65 ? D.green : kpis.financial.utilization >= 45 ? D.amber : D.red} />
              <KpiTile label="Stops / Hour" value={kpis.financial.stopsPerHour != null ? kpis.financial.stopsPerHour.toFixed(1) : '—'} sub="route efficiency" color={D.teal} />
            </KpiGrid>

            {/* FINANCIAL KPIs */}
            <SectionLabel>Financial</SectionLabel>
            <KpiGrid isMobile={isMobile}>
              <KpiTile label="Revenue / Job" value={kpis.financial.revPerJob != null ? fmt(kpis.financial.revPerJob) : '—'} sub={`${kpis.financial.jobsDone} completed`} color={D.teal} />
              <KpiTile label="Revenue / Man-Hour" value={kpis.financial.rpmh != null ? fmt(kpis.financial.rpmh) : '—'} sub="target $120" color={kpis.financial.rpmh >= 120 ? D.green : kpis.financial.rpmh >= 90 ? D.amber : D.red} />
              <KpiTile label="Gross Margin" value={kpis.financial.grossMargin != null ? `${Math.round(kpis.financial.grossMargin)}%` : '—'} sub="target 55%" color={kpis.financial.grossMargin >= 55 ? D.green : kpis.financial.grossMargin >= 40 ? D.amber : D.red} />
              <KpiTile label="AR Days" value={kpis.ar.days != null ? `${kpis.ar.days}d` : '—'} sub={`${fmt(kpis.ar.open)} open · ${kpis.ar.overdueCount} overdue`} color={kpis.ar.days == null ? D.muted : kpis.ar.days <= 15 ? D.green : kpis.ar.days <= 30 ? D.amber : D.red} />
            </KpiGrid>

            {/* SALES & QUALITY */}
            <SectionLabel>Sales & Customer</SectionLabel>
            <KpiGrid isMobile={isMobile}>
              <KpiTile label="Lead → Booked" value={kpis.sales.conversion != null ? `${kpis.sales.conversion}%` : '—'} sub={`${kpis.sales.booked}/${kpis.sales.leads} leads`} color={kpis.sales.conversion >= 30 ? D.green : kpis.sales.conversion >= 20 ? D.amber : D.red} />
              <KpiTile label="Response Speed" value={kpis.sales.avgResponseMin != null ? `${kpis.sales.avgResponseMin}m` : '—'} sub="lead → first contact" color={kpis.sales.avgResponseMin == null ? D.muted : kpis.sales.avgResponseMin <= 15 ? D.green : kpis.sales.avgResponseMin <= 60 ? D.amber : D.red} />
              <KpiTile label="CSAT" value={kpis.quality.csatAvg != null ? `${kpis.quality.csatAvg}/10` : '—'} sub={kpis.quality.nps != null ? `NPS ${kpis.quality.nps}` : `${kpis.quality.csatResponses} responses`} color={kpis.quality.csatAvg >= 9 ? D.green : kpis.quality.csatAvg >= 8 ? D.amber : D.red} />
              <KpiTile label="Retention" value={kpis.retention.pct != null ? `${kpis.retention.pct}%` : '—'} sub={`${kpis.retention.churned} churned`} color={kpis.retention.pct >= 95 ? D.green : kpis.retention.pct >= 85 ? D.amber : D.red} />
            </KpiGrid>
          </div>
        )}
      </div>

      {/* TECH LEADERBOARD */}
      {kpis?.leaderboard?.length > 0 && (
        <div style={{ background: D.card, borderRadius: 10, border: `1px solid ${D.border}`, marginBottom: 18 }}>
          <div style={{ padding: '16px 20px', borderBottom: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Tech Leaderboard</div>
            <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{kpis.periodLabel}</div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: D.subtle }}>
                  <th style={th}>Rank</th>
                  <th style={th}>Technician</th>
                  <th style={{ ...th, textAlign: 'right' }}>Jobs</th>
                  <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
                  <th style={{ ...th, textAlign: 'right' }}>RPMH</th>
                  <th style={{ ...th, textAlign: 'right' }}>Margin</th>
                  <th style={{ ...th, textAlign: 'right' }}>Callbacks</th>
                </tr>
              </thead>
              <tbody>
                {kpis.leaderboard.map((t, i) => (
                  <tr key={t.techId || i} style={{ borderTop: `1px solid ${D.border}` }}>
                    <td style={{ ...td, fontWeight: 700, color: i === 0 ? D.amber : D.muted }}>{i + 1}</td>
                    <td style={{ ...td, fontWeight: 600, color: D.heading }}>{t.name}</td>
                    <td style={{ ...tdNum }}>{t.jobs}</td>
                    <td style={{ ...tdNum, color: D.heading, fontWeight: 600 }}>{fmt(t.revenue)}</td>
                    <td style={{ ...tdNum, color: t.rpmh >= 120 ? D.green : t.rpmh >= 90 ? D.amber : D.red }}>{fmt(t.rpmh)}</td>
                    <td style={{ ...tdNum, color: t.margin >= 55 ? D.green : t.margin >= 40 ? D.amber : D.red }}>{t.margin}%</td>
                    <td style={{ ...tdNum, color: t.callbackRate < 3 ? D.green : t.callbackRate < 6 ? D.amber : D.red }}>{t.callbacks} ({t.callbackRate}%)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Revenue Chart */}
      <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}`, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Revenue — {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
          <div style={{ fontSize: 13, color: D.muted }}>
            MRR: <span style={{ color: D.teal, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{fmtD(data.mrr)}</span>
          </div>
        </div>
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.revenueChart?.daily || []}>
              <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
              <XAxis dataKey="date" tick={{ fill: D.muted, fontSize: 10 }} tickFormatter={d => {
                if (!d) return '';
                const s = String(d).slice(0, 10);
                const parsed = new Date(s + 'T12:00:00');
                return isNaN(parsed) ? '' : parsed.getDate();
              }} />
              <YAxis tick={{ fill: D.muted, fontSize: 10 }} tickFormatter={v => `$${v}`} />
              <Tooltip contentStyle={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, color: D.heading, fontSize: 13 }} formatter={(v) => fmtD(v)} />
              <Bar dataKey="total" fill={D.teal} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <BillingHealthCard isMobile={isMobile} />

      {/* Two columns: Schedule + Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Today's Schedule</div>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 10, background: `${D.teal}20`, color: D.teal }}>
              {data.todaysSchedule.length} services
            </span>
          </div>
          {data.todaysSchedule.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 30, color: D.muted }}>
              <div style={{ fontSize: 28 }}>📅</div>
              <div style={{ marginTop: 6, fontSize: 13 }}>No services scheduled today</div>
            </div>
          ) : (
            data.todaysSchedule.map(s => (
              <div key={s.id} style={{
                padding: '12px 0', borderBottom: `1px solid ${D.border}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              }}>
                <div>
                  <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: D.teal }}>
                    {fmtTimeShort(s.windowStart)} – {fmtTimeShort(s.windowEnd)}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginTop: 2 }}>{s.customerName}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{s.address}</div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{s.serviceType} · {s.technicianName}</div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '3px 8px', borderRadius: 8,
                  background: `${STATUS_COLORS[s.status] || D.muted}20`, color: STATUS_COLORS[s.status] || D.muted,
                }}>{s.status}</span>
              </div>
            ))
          )}
        </div>

        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading, marginBottom: 14 }}>Recent Activity</div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {data.recentActivity.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: D.muted, fontSize: 13 }}>No recent activity</div>
            ) : (
              data.recentActivity.map(a => (
                <div key={a.id} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: `1px solid ${D.border}`, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 16, flexShrink: 0, marginTop: 2 }}>{ACTIVITY_ICONS[a.action] || '📌'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: D.heading, lineHeight: 1.4 }}>{a.description}</div>
                  </div>
                  <span style={{ fontSize: 11, color: D.muted, flexShrink: 0, whiteSpace: 'nowrap' }}>{timeAgo(a.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { icon: '⚡', label: 'New Estimate', path: '/admin/estimates' },
          { icon: '👤', label: 'New Customer', path: '/admin/customers' },
          { icon: '⭐', label: 'Review Request', path: '/admin/reviews' },
          { icon: '🔍', label: 'Property Lookup', path: '/admin/estimates' },
        ].map((a, i) => (
          <a key={i} href={a.path} style={{
            background: D.card, borderRadius: 10, padding: '18px 16px', textAlign: 'center',
            border: `1px solid ${D.border}`, textDecoration: 'none',
          }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>{a.icon}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{a.label}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2, color: D.muted, margin: '14px 0 10px', paddingBottom: 6, borderBottom: `1px solid ${D.border}` }}>
      {children}
    </div>
  );
}

function KpiGrid({ children, isMobile }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12 }}>
      {children}
    </div>
  );
}

function KpiTile({ label, value, sub, color }) {
  return (
    <div style={{ background: D.subtle, borderRadius: 8, padding: 14, border: `1px solid ${D.border}`, borderLeft: `3px solid ${color || D.teal}` }}>
      <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || D.heading, fontFamily: "'JetBrains Mono', monospace", marginTop: 4, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const th = { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: D.muted };
const td = { padding: '12px 14px', color: D.text };
const tdNum = { padding: '12px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: D.text };

function BillingHealthCard({ isMobile }) {
  const [h, setH] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch('/admin/billing-health')
      .then(d => setH(d?.summary || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  if (loading || !h) return null;

  const metrics = [
    { label: 'Autopay active', value: h.autopay_active, color: D.green },
    { label: 'Paused', value: h.autopay_paused, color: D.amber },
    { label: 'No method', value: h.no_payment_method, color: h.no_payment_method > 0 ? D.red : D.muted },
    { label: 'Charged this month', value: h.charged_this_month, color: D.teal },
    { label: 'Failed (30d)', value: h.failed_last_30_days, color: h.failed_last_30_days > 0 ? D.red : D.muted },
    { label: 'In retry', value: h.in_retry_queue, color: h.in_retry_queue > 0 ? D.amber : D.muted },
    { label: 'Escalated (30d)', value: h.escalated_last_30_days, color: h.escalated_last_30_days > 0 ? D.red : D.muted },
    { label: 'Cards expiring 60d', value: h.expiring_cards_60_days, color: h.expiring_cards_60_days > 0 ? D.amber : D.muted },
  ];

  return (
    <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}`, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Billing Health</div>
        <span style={{ fontSize: 11, color: D.muted }}>{h.total_billable} billable customers</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 10 }}>
        {metrics.map(m => (
          <div key={m.label} style={{ background: D.subtle, borderRadius: 8, padding: 12, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{m.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: m.color, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
              {m.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
