import { useState, useEffect, lazy, Suspense } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
const RevenuePage = lazy(() => import('./RevenuePage'));

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };

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
  const [weekBookings, setWeekBookings] = useState([]);
  const [bookingsLoading, setBookingsLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/dashboard').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
    adminFetch('/admin/dashboard/square-bookings?days=7').then(d => { setWeekBookings(d.bookings || []); setBookingsLoading(false); }).catch(() => setBookingsLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontSize: 15 }}>Loading dashboard...</div>;
  if (!data || data.error || !data.kpis) return <div style={{ color: D.red, padding: 60, textAlign: 'center' }}>Failed to load dashboard. <a href="/admin/login" style={{ color: D.teal }}>Try logging in again</a></div>;

  const k = data.kpis;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const [activeKPI, setActiveKPI] = useState(null);

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
          <div style={{ fontSize: 28, fontWeight: 700, color: D.white }}>{greeting()}, Adam</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>{today}</div>
        </div>
      </div>

      {/* KPI Cards — clickable */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        {KPI_CARDS.map((kpi, i) => (
          <div key={i} onClick={() => setActiveKPI(activeKPI === kpi.id ? null : kpi.id)} style={{
            background: D.card, borderRadius: 10, padding: isMobile ? 14 : 20, cursor: 'pointer',
            border: activeKPI === kpi.id ? `2px solid ${D.teal}` : `1px solid ${D.border}`,
            transition: 'all 0.15s',
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: D.muted, marginBottom: 8 }}>
              {kpi.icon} {kpi.label}
            </div>
            <div style={{ fontSize: isMobile ? 22 : 28, fontWeight: 700, color: D.white, fontFamily: "'JetBrains Mono', monospace" }}>
              {kpi.value}
            </div>
            {kpi.change !== undefined && (
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

      {/* Detail Panel — shows content for clicked KPI */}
      {activeKPI === 'revenue' && (
        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.teal}`, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Revenue Breakdown</div>
            <button onClick={() => setActiveKPI(null)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          <Suspense fallback={<div style={{ color: D.muted, padding: 20, textAlign: 'center' }}>Loading...</div>}><RevenuePage /></Suspense>
        </div>
      )}

      {activeKPI === 'customers' && (
        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.teal}`, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Customer Summary</div>
            <button onClick={() => setActiveKPI(null)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          {data.revenueChart?.byTier?.length > 0 ? data.revenueChart.byTier.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${D.border}` }}>
              <span style={{ fontSize: 14, color: D.text }}>{t.tier || 'No Plan'} <span style={{ color: D.muted }}>({t.count})</span></span>
              <span style={{ fontSize: 14, fontWeight: 700, color: D.green, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(t.revenue)}/mo</span>
            </div>
          )) : <div style={{ color: D.muted, padding: 20, textAlign: 'center' }}>No tier data available</div>}
          <a href="/admin/customers" style={{ display: 'block', marginTop: 12, fontSize: 13, color: D.teal, textDecoration: 'none' }}>View all customers →</a>
        </div>
      )}

      {activeKPI === 'estimates' && (
        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.teal}`, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Pending Estimates</div>
            <button onClick={() => setActiveKPI(null)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ fontSize: 13, color: D.muted, marginBottom: 12 }}>{k.estimatesPending} estimates awaiting customer response</div>
          <a href="/admin/estimates" style={{ display: 'inline-block', padding: '10px 20px', borderRadius: 8, background: D.teal, color: D.white, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>View Estimates →</a>
        </div>
      )}

      {activeKPI === 'services' && data.todaysSchedule && (
        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.teal}`, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Today's Services</div>
            <button onClick={() => setActiveKPI(null)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          {data.todaysSchedule.map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${D.border}` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{s.customerName}</div>
                <div style={{ fontSize: 11, color: D.muted }}>{s.serviceType} · {fmtTimeShort(s.windowStart)}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 8, background: `${STATUS_COLORS[s.status] || D.muted}20`, color: STATUS_COLORS[s.status] || D.muted }}>{s.status}</span>
            </div>
          ))}
          <a href="/admin/schedule" style={{ display: 'block', marginTop: 12, fontSize: 13, color: D.teal, textDecoration: 'none' }}>View full schedule →</a>
        </div>
      )}

      {activeKPI === 'reviews' && (
        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.teal}`, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Review Performance</div>
            <button onClick={() => setActiveKPI(null)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div><div style={{ fontSize: 11, color: D.muted }}>Rating</div><div style={{ fontSize: 24, fontWeight: 700, color: D.amber }}>{k.googleReviewRating} ★</div></div>
            <div><div style={{ fontSize: 11, color: D.muted }}>Total Reviews</div><div style={{ fontSize: 24, fontWeight: 700, color: D.white }}>{k.googleReviewCount}</div></div>
          </div>
          <a href="/admin/reviews" style={{ display: 'block', marginTop: 12, fontSize: 13, color: D.teal, textDecoration: 'none' }}>Manage reviews →</a>
        </div>
      )}

      {/* Revenue Chart */}
      <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}`, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Revenue — {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ fontSize: 13, color: D.muted }}>
              MRR: <span style={{ color: D.teal, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{fmtD(data.mrr)}</span>
            </div>
          </div>
        </div>
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.revenueChart.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
              <XAxis dataKey="date" tick={{ fill: D.muted, fontSize: 10 }} tickFormatter={d => new Date(d + 'T12:00:00').getDate()} />
              <YAxis tick={{ fill: D.muted, fontSize: 10 }} tickFormatter={v => `$${v}`} />
              <Tooltip contentStyle={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, color: D.white, fontSize: 13 }} formatter={(v) => fmtD(v)} />
              <Bar dataKey="total" fill={D.teal} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Upcoming Week — Square Appointments */}
      <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}`, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Upcoming Week</div>
          <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 10, background: `${D.teal}20`, color: D.teal }}>
            {bookingsLoading ? '...' : `${weekBookings.length} appointments`}
          </span>
        </div>
        {bookingsLoading ? (
          <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>Loading Square appointments...</div>
        ) : weekBookings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30, color: D.muted }}>
            <div style={{ fontSize: 13 }}>No upcoming Square appointments this week. Appointments will appear here once Square Bookings is active.</div>
          </div>
        ) : (
          <div>
            {/* Group by day */}
            {(() => {
              const byDay = {};
              weekBookings.forEach(b => {
                const key = b.date;
                if (!byDay[key]) byDay[key] = { date: key, dayOfWeek: b.dayOfWeek, bookings: [] };
                byDay[key].bookings.push(b);
              });
              return Object.values(byDay).map(day => (
                <div key={day.date} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: D.teal, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${D.border}` }}>
                    {day.dayOfWeek} — {new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    <span style={{ fontWeight: 500, color: D.muted, marginLeft: 8 }}>({day.bookings.length})</span>
                  </div>
                  {day.bookings.map(b => {
                    const sc = b.status === 'ACCEPTED' ? D.green : b.status === 'PENDING' ? D.amber : b.status?.includes('CANCEL') ? D.red : D.muted;
                    return (
                      <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: `1px solid ${D.border}33` }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: D.teal }}>{b.time}</span>
                            {b.durationMinutes && <span style={{ fontSize: 11, color: D.muted }}>({b.durationMinutes} min)</span>}
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginTop: 2 }}>{b.customerName}</div>
                          {b.note && <div style={{ fontSize: 11, color: D.muted, marginTop: 2, fontStyle: 'italic' }}>{b.note}</div>}
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '3px 8px', borderRadius: 8, background: `${sc}20`, color: sc, flexShrink: 0 }}>
                          {(b.status || '').replace(/_/g, ' ')}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        )}
      </div>

      {/* Two columns: Schedule + Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 14, marginBottom: 20 }}>
        {/* Today's Schedule */}
        <div style={{ background: D.card, borderRadius: 10, padding: 20, border: `1px solid ${D.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>Today's Schedule</div>
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
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginTop: 2 }}>{s.customerName}</div>
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
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white, marginBottom: 14 }}>Recent Activity</div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {data.recentActivity.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: D.muted, fontSize: 13 }}>No recent activity</div>
            ) : (
              data.recentActivity.map(a => (
                <div key={a.id} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: `1px solid ${D.border}`, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 16, flexShrink: 0, marginTop: 2 }}>{ACTIVITY_ICONS[a.action] || '📌'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: D.white, lineHeight: 1.4 }}>{a.description}</div>
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
            <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{a.label}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
