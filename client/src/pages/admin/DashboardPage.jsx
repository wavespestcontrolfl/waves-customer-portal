import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import DashboardIntelligenceBar from '../../components/admin/DashboardIntelligenceBar';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then(r => {
    if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    return r.json();
  });
}

function fmt(n) { return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtD(n) { return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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

export default function DashboardPage() {
  const [dashTab, setDashTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch('/admin/dashboard').then(d => { setData(d); setLoading(false); }).catch(err => { console.error('[dashboard] load failed', err); setLoading(false); });
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontSize: 15 }}>Loading dashboard...</div>;
  if (!data || data.error || !data.kpis) return <div style={{ color: D.red, padding: 60, textAlign: 'center' }}>Failed to load dashboard. <a href="/admin/login" style={{ color: D.teal }}>Try logging in again</a></div>;

  const k = data.kpis;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const KPI_CARDS = [
    { id: 'revenue', icon: '💰', label: 'Revenue MTD', value: fmt(k.revenueMTD), change: k.revenueChangePercent, changeSuffix: '% vs last month', color: k.revenueChangePercent >= 0 ? D.green : D.red, detail: 'revenue' },
    { id: 'customers', icon: '👥', label: 'Active Customers', value: k.activeCustomers, change: k.newCustomersThisMonth, changeSuffix: ' new this month', changePrefix: '+', color: D.green, detail: 'customers' },
    { id: 'estimates', icon: '📋', label: 'Estimates Pending', value: k.estimatesPending, sub: 'awaiting response', color: D.amber, detail: 'estimates' },
    { id: 'services', icon: '📅', label: 'Services This Week', value: `${k.servicesThisWeek.completed}/${k.servicesThisWeek.total}`, sub: `${k.servicesThisWeek.total - k.servicesThisWeek.completed} remaining`, color: D.teal, detail: 'schedule' },
    { id: 'response', icon: '⏱️', label: 'Avg Response', value: `${k.avgResponseTimeHours} hrs`, sub: 'sent → accepted', color: D.muted, detail: 'estimates' },
    { id: 'reviews', icon: '⭐', label: 'Google Reviews', value: `${k.googleReviewRating} ★`, sub: `${k.googleReviewCount} reviews`, color: D.amber, detail: 'reviews' },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: D.heading }}>{greeting()}, Adam</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>{today}</div>
        </div>
      </div>

      {/* Intelligence Bar */}
      <DashboardIntelligenceBar kpiData={data} />

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        {KPI_CARDS.map((kpi, i) => (
          <div key={i} style={{
            background: D.card, borderRadius: 10, padding: isMobile ? 14 : 20,
            border: `1px solid ${D.border}`,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: D.muted, marginBottom: 8 }}>
              {kpi.icon} {kpi.label}
            </div>
            <div style={{ fontSize: isMobile ? 22 : 28, fontWeight: 700, color: D.heading, fontFamily: "'JetBrains Mono', monospace" }}>
              {kpi.value}
            </div>
            {kpi.change != null && (
              <div style={{ fontSize: 13, color: kpi.color, marginTop: 4 }}>
                {kpi.change >= 0 ? '↑' : '↓'} {kpi.changePrefix || ''}{Math.abs(kpi.change)}{kpi.changeSuffix}
              </div>
            )}
            {kpi.sub && !kpi.change && (
              <div style={{ fontSize: 13, color: kpi.color || D.muted, marginTop: 4 }}>{kpi.sub}</div>
            )}
          </div>
        ))}
      </div>

      {/* Revenue Chart */}
      <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}`, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Revenue — {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ fontSize: 13, color: D.muted }}>
              MRR: <span style={{ color: D.teal, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{fmtD(data.mrr)}</span>
            </div>
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

      {/* Billing Health */}
      <BillingHealthCard isMobile={isMobile} />

      {/* Two columns: Schedule + Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14, marginBottom: 20 }}>
        {/* Today's Schedule */}
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

        {/* Recent Activity */}
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
            border: `1px solid ${D.border}`, textDecoration: 'none', transition: 'border-color 0.15s',
            cursor: 'pointer',
          }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>{a.icon}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{a.label}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

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
    <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}`, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Billing Health</div>
        <span style={{ fontSize: 11, color: D.muted }}>{h.total_billable} billable customers</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 10 }}>
        {metrics.map(m => (
          <div key={m.label} style={{ background: D.bg, borderRadius: 8, padding: 12 }}>
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
