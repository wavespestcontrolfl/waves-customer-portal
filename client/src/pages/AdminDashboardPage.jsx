import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { FONTS, BUTTON_BASE } from '../theme';

const EstimatePage = lazy(() => import('./admin/EstimatePage'));

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
const D = { bg: '#0f1923', card: '#1e293b', cardHover: '#253348', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', wavesRed: '#A83B34' };

function adminFetch(path, opts = {}) {
  const token = localStorage.getItem('waves_admin_token');
  return fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    ...opts,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const TIER_COLORS = { Bronze: '#CD7F32', Silver: '#C0C0C0', Gold: '#FDD835', Platinum: '#E5E4E2' };

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background: D.card, borderRadius: 14, padding: '18px 20px', border: `1px solid ${D.border}`, flex: '1 1 200px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: D.muted, fontFamily: FONTS.ui }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: color || D.white, fontFamily: FONTS.ui, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function DashboardView() {
  const [stats, setStats] = useState(null);
  useEffect(() => { adminFetch('/admin/dashboard').then(setStats).catch(console.error); }, []);

  if (!stats) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading dashboard...</div>;

  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 800, color: D.white, fontFamily: FONTS.heading, marginBottom: 20 }}>Dashboard</div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatCard label="Active Customers" value={stats.activeCustomers} color={D.teal} />
        <StatCard label="Monthly Revenue" value={`$${stats.monthlyRecurringRevenue.toLocaleString()}`} color={D.green} />
        <StatCard label="New This Month" value={stats.newCustomersThisMonth} color={D.amber} />
        <StatCard label="Avg Satisfaction" value={stats.avgSatisfaction ? `${stats.avgSatisfaction}/10` : '—'} color={D.teal} />
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatCard label="Today's Services" value={stats.todayServiceCount} />
        <StatCard label="Referrals (Month)" value={stats.referralsThisMonth} color={D.amber} />
        <StatCard label="Outstanding" value={`$${stats.outstandingBalance.toFixed(2)}`} color={stats.outstandingBalance > 0 ? D.red : D.green} />
      </div>

      {/* Revenue by tier */}
      <div style={{ background: D.card, borderRadius: 14, padding: 20, border: `1px solid ${D.border}`, marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: D.white, fontFamily: FONTS.heading, marginBottom: 14 }}>Revenue by Tier</div>
        {stats.revenueByTier.map(t => (
          <div key={t.tier} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: TIER_COLORS[t.tier] || D.muted }} />
              <span style={{ fontSize: 13, color: D.text }}>{t.tier}</span>
              <span style={{ fontSize: 11, color: D.muted }}>({t.count} customers)</span>
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: D.green, fontFamily: FONTS.ui }}>${t.revenue.toLocaleString()}/mo</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomersView() {
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [noteText, setNoteText] = useState('');

  const fetchCustomers = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (tierFilter) params.set('tier', tierFilter);
    adminFetch(`/admin/customers?${params}`).then(d => setCustomers(d.customers)).catch(console.error);
  }, [search, tierFilter]);

  useEffect(() => { fetchCustomers(); }, [fetchCustomers]);

  const loadDetail = async (id) => {
    setSelected(id);
    const d = await adminFetch(`/admin/customers/${id}`);
    setDetail(d);
  };

  const addNote = async () => {
    if (!noteText.trim() || !selected) return;
    await adminFetch(`/admin/customers/${selected}/add-note`, { method: 'POST', body: JSON.stringify({ note: noteText.trim() }) });
    setNoteText('');
    loadDetail(selected);
  };

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 80px)' }}>
      {/* List */}
      <div style={{ flex: '1 1 400px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: D.white, fontFamily: FONTS.heading, marginBottom: 14 }}>Customers</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, phone, address..."
            style={{ flex: 1, padding: '10px 14px', borderRadius: 10, border: `1px solid ${D.border}`, background: D.bg, color: D.white, fontSize: 14, fontFamily: FONTS.body, outline: 'none' }} />
          <select value={tierFilter} onChange={e => setTierFilter(e.target.value)}
            style={{ padding: '10px 14px', borderRadius: 10, border: `1px solid ${D.border}`, background: D.bg, color: D.white, fontSize: 13, fontFamily: FONTS.body }}>
            <option value="">All Tiers</option>
            <option value="Bronze">Bronze</option><option value="Silver">Silver</option>
            <option value="Gold">Gold</option><option value="Platinum">Platinum</option>
          </select>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {customers.map(c => (
            <div key={c.id} onClick={() => loadDetail(c.id)} style={{
              background: selected === c.id ? D.cardHover : D.card,
              borderRadius: 10, padding: '12px 14px', marginBottom: 6, cursor: 'pointer',
              border: `1px solid ${selected === c.id ? D.teal : D.border}`,
              transition: 'all 0.15s',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{c.firstName} {c.lastName}</div>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: `${TIER_COLORS[c.tier] || D.muted}22`, color: TIER_COLORS[c.tier] || D.muted }}>{c.tier}</span>
              </div>
              <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{c.address}</div>
              <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                ${c.monthlyRate}/mo · {c.servicesCount} visits · {c.phone}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      {detail && (
        <div style={{ flex: '1 1 400px', overflowY: 'auto', background: D.card, borderRadius: 14, border: `1px solid ${D.border}`, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: D.white, fontFamily: FONTS.heading }}>{detail.customer.firstName} {detail.customer.lastName}</div>
              <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>{detail.customer.phone} · {detail.customer.email}</div>
              <div style={{ fontSize: 13, color: D.muted }}>{detail.customer.address.line1}, {detail.customer.address.city} {detail.customer.address.zip}</div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 8, background: `${TIER_COLORS[detail.customer.tier]}22`, color: TIER_COLORS[detail.customer.tier] }}>
              WaveGuard {detail.customer.tier}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            {[
              { label: 'Monthly', value: `$${detail.customer.monthlyRate}` },
              { label: 'Member Since', value: detail.customer.memberSince ? new Date(detail.customer.memberSince + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—' },
              { label: 'Badges', value: detail.badges.length },
              { label: 'Referrals', value: detail.referrals.length },
              { label: 'Satisfaction', value: detail.satisfaction.length ? `${(detail.satisfaction.reduce((s, r) => s + r.rating, 0) / detail.satisfaction.length).toFixed(1)}/10` : '—' },
            ].map(s => (
              <div key={s.label} style={{ padding: '6px 12px', borderRadius: 8, background: D.bg, border: `1px solid ${D.border}` }}>
                <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: D.teal, fontFamily: FONTS.ui }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Property info */}
          {detail.customer.property?.lawnType && (
            <div style={{ marginTop: 14, fontSize: 12, color: D.muted }}>
              🌿 {detail.customer.property.lawnType} · {detail.customer.property.sqft?.toLocaleString()} sq ft
            </div>
          )}

          {/* Recent services */}
          <div style={{ fontSize: 14, fontWeight: 700, color: D.white, fontFamily: FONTS.heading, marginTop: 18, marginBottom: 8 }}>Recent Services</div>
          {detail.services.slice(0, 5).map(s => (
            <div key={s.id} style={{ fontSize: 12, color: D.text, padding: '6px 0', borderBottom: `1px solid ${D.border}` }}>
              <span style={{ color: D.teal }}>{s.service_date}</span> · {s.service_type}
            </div>
          ))}

          {/* Admin notes */}
          <div style={{ fontSize: 14, fontWeight: 700, color: D.white, fontFamily: FONTS.heading, marginTop: 18, marginBottom: 8 }}>Internal Notes</div>
          {detail.notes.map(n => (
            <div key={n.id} style={{ padding: '8px 0', borderBottom: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 12, color: D.text }}>{n.note_text}</div>
              <div style={{ fontSize: 10, color: D.muted, marginTop: 2 }}>{n.author_name} · {new Date(n.created_at).toLocaleDateString()}</div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Add internal note..."
              onKeyDown={e => e.key === 'Enter' && addNote()}
              style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1px solid ${D.border}`, background: D.bg, color: D.white, fontSize: 12, outline: 'none' }} />
            <button onClick={addNote} style={{ ...BUTTON_BASE, padding: '8px 14px', fontSize: 11, background: D.teal, color: D.white }}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ComingSoonView({ title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>🚧</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: D.white, fontFamily: FONTS.heading, marginTop: 12 }}>{title}</div>
        <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>Coming soon</div>
      </div>
    </div>
  );
}

export default function AdminDashboardPage() {
  const navigate = useNavigate();
  const [activeView, setActiveView] = useState('dashboard');
  const [user, setUser] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('waves_admin_token');
    if (!token) { navigate('/admin/login', { replace: true }); return; }
    const u = localStorage.getItem('waves_admin_user');
    if (u) setUser(JSON.parse(u));
  }, [navigate]);

  const handleLogout = () => {
    localStorage.removeItem('waves_admin_token');
    localStorage.removeItem('waves_admin_user');
    navigate('/admin/login', { replace: true });
  };

  const NAV = [
    { id: 'dashboard', icon: '📊', label: 'Dashboard' },
    { id: 'customers', icon: '👥', label: 'Customers' },
    { id: 'estimates', icon: '📋', label: 'Estimates' },
    { id: 'schedule', icon: '📅', label: 'Schedule' },
    { id: 'dispatch', icon: '🗺️', label: 'Dispatch' },
    { id: 'revenue', icon: '💰', label: 'Revenue' },
    { id: 'comms', icon: '📱', label: 'Communications' },
    { id: 'reviews', icon: '⭐', label: 'Reviews' },
    { id: 'referrals', icon: '🎁', label: 'Referrals' },
    { id: 'settings', icon: '⚙️', label: 'Settings' },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: D.bg, fontFamily: FONTS.body }}>
      {/* Sidebar */}
      <div style={{ width: 220, background: D.card, borderRight: `1px solid ${D.border}`, padding: '16px 12px', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 20px' }}>
          <img src="/waves-logo.png" alt="" style={{ height: 28 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: D.white, fontFamily: FONTS.heading }}>WAVES ADMIN</div>
            <div style={{ fontSize: 10, color: D.muted }}>{user?.name || 'Staff'}</div>
          </div>
        </div>

        {NAV.map(n => (
          <div key={n.id} onClick={() => setActiveView(n.id)} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
            background: activeView === n.id ? `${D.teal}15` : 'transparent',
            color: activeView === n.id ? D.teal : D.muted,
            transition: 'all 0.15s',
          }}>
            <span style={{ fontSize: 16 }}>{n.icon}</span>
            <span style={{ fontSize: 13, fontWeight: activeView === n.id ? 600 : 400 }}>{n.label}</span>
          </div>
        ))}

        <div style={{ marginTop: 'auto', paddingTop: 16 }}>
          <a href="/" style={{ fontSize: 12, color: D.teal, textDecoration: 'none', display: 'block', padding: '8px 12px' }}>← Customer Portal</a>
          <div onClick={handleLogout} style={{ fontSize: 12, color: D.red, cursor: 'pointer', padding: '8px 12px' }}>Sign Out</div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto' }}>
        {activeView === 'dashboard' && <DashboardView />}
        {activeView === 'customers' && <CustomersView />}
        {activeView === 'estimates' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading estimator...</div>}><EstimatePage /></Suspense>}
        {activeView === 'schedule' && <ComingSoonView title="Schedule" />}
        {activeView === 'dispatch' && <ComingSoonView title="Dispatch Board" />}
        {activeView === 'revenue' && <ComingSoonView title="Revenue Reports" />}
        {activeView === 'comms' && <ComingSoonView title="Communications" />}
        {activeView === 'reviews' && <ComingSoonView title="Reviews & Satisfaction" />}
        {activeView === 'referrals' && <ComingSoonView title="Referral Management" />}
        {activeView === 'settings' && <ComingSoonView title="Settings" />}
      </div>
    </div>
  );
}
