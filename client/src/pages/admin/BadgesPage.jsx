import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal folded to zinc-900. Semantic green/amber/red preserved.
// CAT_COLORS below uses explicit hexes for category distinction (sky/amber/violet/emerald/blue) — left as-is.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', white: '#FFFFFF', muted: '#71717A', text: '#27272A', heading: '#09090B', inputBorder: '#D4D4D8' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, { ...opts, headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json', ...opts.headers } }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const CAT_COLORS = { getting_started: '#0ea5e9', loyalty: '#f59e0b', referral: '#a855f7', service: '#10b981', tier: '#3b82f6' };
const CAT_LABELS = { getting_started: 'Getting Started', loyalty: 'Loyalty', referral: 'Referrals', service: 'Service Milestones', tier: 'WaveGuard Tier' };

export default function BadgesPage() {
  const [badges, setBadges] = useState([]);
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerBadges, setCustomerBadges] = useState(null);

  useEffect(() => {
    Promise.all([
      adminFetch('/badges/admin/definitions').catch(() => ({ badges: [] })),
      adminFetch('/badges/admin/stats').catch(() => null),
    ]).then(([defs, s]) => {
      setBadges(defs.badges || defs || []);
      setStats(s);
      setLoading(false);
    });
  }, []);

  const searchCustomers = async (q) => {
    setCustomerSearch(q);
    if (q.length >= 2) {
      const r = await adminFetch(`/admin/customers?search=${encodeURIComponent(q)}&limit=5`).catch(() => ({ customers: [] }));
      setCustomerResults(r.customers || []);
    } else setCustomerResults([]);
  };

  const selectCustomer = async (c) => {
    setSelectedCustomer(c);
    setCustomerResults([]);
    setCustomerSearch(`${c.firstName} ${c.lastName}`);
    try {
      const r = await adminFetch(`/badges/admin/customer/${c.id}`);
      setCustomerBadges(r);
    } catch { setCustomerBadges(null); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading badges...</div>;

  // Group by category
  const grouped = {};
  (Array.isArray(badges) ? badges : []).forEach(b => {
    const cat = b.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(b);
  });

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 400, color: D.heading, margin: '0 0 20px' }}>Badge Management</h1>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Total Badges', value: stats.totalDefinitions || badges.length, color: D.teal },
            { label: 'Badges Earned', value: stats.totalEarned || 0, color: D.green },
            { label: 'With Rewards', value: (Array.isArray(badges) ? badges : []).filter(b => b.reward).length, color: D.amber },
            { label: 'Customers with Badges', value: stats.customersWithBadges || 0, color: D.heading },
          ].map(s => (
            <div key={s.label} style={{ flex: '1 1 120px', background: D.card, borderRadius: 10, padding: '12px 16px', border: `1px solid ${D.border}`, textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Customer Badge Lookup */}
      <div style={{ background: D.card, borderRadius: 12, padding: 16, border: `1px solid ${D.border}`, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 10 }}>Check Customer Badges</div>
        <div style={{ position: 'relative' }}>
          <input type="text" value={customerSearch} onChange={e => searchCustomers(e.target.value)} placeholder="Search customer by name or phone..." style={{ width: '100%', padding: '10px 14px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.heading, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
          {customerResults.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: '0 0 8px 8px', zIndex: 20, maxHeight: 200, overflowY: 'auto' }}>
              {customerResults.map(c => (
                <div key={c.id} onClick={() => selectCustomer(c)} style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 13, color: D.heading }}>
                  <strong>{c.firstName} {c.lastName}</strong> <span style={{ color: D.muted }}>{c.phone}</span>
                  {c.tier && <span style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: `${D.teal}22`, color: D.teal }}>{c.tier}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        {customerBadges && selectedCustomer && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 8 }}>{selectedCustomer.firstName} {selectedCustomer.lastName}'s Badges</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(customerBadges.earned || []).length === 0 && <div style={{ color: D.muted, fontSize: 13 }}>No badges earned yet</div>}
              {(customerBadges.earned || []).map((b, i) => (
                <div key={i} style={{ background: D.bg, borderRadius: 8, padding: '8px 12px', border: `1px solid ${D.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 18 }}>{b.icon}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: D.heading }}>{b.title}</div>
                    <div style={{ fontSize: 10, color: D.muted }}>{b.earnedAt ? new Date(b.earnedAt).toLocaleDateString() : 'Earned'}</div>
                  </div>
                </div>
              ))}
            </div>
            {(customerBadges.progress || []).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 6 }}>In Progress</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {customerBadges.progress.map((b, i) => (
                    <div key={i} style={{ background: D.bg, borderRadius: 6, padding: '4px 8px', border: `1px solid ${D.border}`, fontSize: 11, color: D.muted, opacity: 0.6 }}>
                      {b.icon} {b.title} — {b.progressLabel || `${b.current || 0}/${b.target || '?'}`}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Badge Catalog by Category */}
      {Object.entries(grouped).map(([cat, catBadges]) => (
        <div key={cat} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: CAT_COLORS[cat] || D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{CAT_LABELS[cat] || cat}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {catBadges.map(b => (
              <div key={b.type} style={{ background: D.card, borderRadius: 10, padding: '14px 16px', border: `1px solid ${D.border}`, borderLeft: `3px solid ${CAT_COLORS[cat] || D.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 26 }}>{b.icon}</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>{b.title}</div>
                    <div style={{ fontSize: 11, color: D.muted }}>{b.description}</div>
                  </div>
                </div>
                {b.reward && (
                  <div style={{ marginTop: 6, padding: '4px 8px', background: `${D.green}15`, borderRadius: 6, fontSize: 11, color: D.green }}>
                    🎁 Reward: {b.reward.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
