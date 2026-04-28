import { useState, useEffect, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: `teal` + `purple` fold to zinc-900. Semantic green/amber/red preserved.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', purple: '#18181B', heading: '#09090B', inputBorder: '#D4D4D8' };
const MONO = "'JetBrains Mono', monospace";

function af(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const fc = c => '$' + (c / 100).toFixed(2);
const fd = d => '$' + parseFloat(d || 0).toFixed(2);

// Badge colors
const MILESTONE_COLORS = { none: D.muted, advocate: '#22d3ee', ambassador: D.amber, champion: '#f97316' };
const MILESTONE_LABELS = { none: '--', advocate: 'Advocate', ambassador: 'Ambassador', champion: 'Champion' };

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: '16px 20px', flex: '1 1 0', minWidth: 130 }}>
      <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: color || D.heading }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Badge({ status }) {
  const c = { pending: D.amber, contacted: D.teal, estimated: D.purple, signed_up: D.green, credited: D.green, rejected: D.red, expired: D.muted, active: D.green, applied: D.green, pending_service: D.amber, earned: D.green, paid: D.green }[status] || D.muted;
  return <span style={{ fontSize: 10, fontFamily: MONO, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 6, background: `${c}22`, color: c, letterSpacing: 0.5 }}>{status?.replace('_', ' ')}</span>;
}

function MilestoneBadge({ level }) {
  const c = MILESTONE_COLORS[level] || D.muted;
  const label = MILESTONE_LABELS[level] || level;
  if (level === 'none') return <span style={{ color: D.muted, fontSize: 11 }}>--</span>;
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 10, background: `${c}22`, color: c, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>;
}

// Shared styles
const thSt = { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: D.muted, borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: '0.5px' };
const thR = { ...thSt, textAlign: 'right' };
const tdSt = { padding: '10px 14px', fontSize: 13, color: D.text, borderBottom: `1px solid ${D.border}` };
const tdR = { ...tdSt, textAlign: 'right', fontFamily: MONO };
const inputSt = { width: '100%', padding: '8px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.heading, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const btnPrimary = { padding: '8px 18px', borderRadius: 8, border: 'none', background: D.teal, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const btnSmall = (color) => ({ padding: '3px 10px', borderRadius: 4, border: 'none', background: color, color: D.heading, fontSize: 10, fontWeight: 600, cursor: 'pointer' });

export default function ReferralsPageV2() {
  const [tab, setTab] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [promoters, setPromoters] = useState([]);
  const [queue, setQueue] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [settings, setSettings] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState(null);

  // Modals
  const [convertModal, setConvertModal] = useState(null);
  const [enrollModal, setEnrollModal] = useState(false);
  const [settingsEditing, setSettingsEditing] = useState(null);

  // Customer search for enroll/convert
  const [custSearch, setCustSearch] = useState('');
  const [custResults, setCustResults] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      af('/admin/referrals/stats').catch(() => null),
      af('/admin/referrals/promoters?status=all').catch(() => ({ promoters: [] })),
      af('/admin/referrals/queue').catch(() => ({ referrals: [] })),
      af('/admin/referrals/payouts').catch(() => ({ payouts: [] })),
    ]).then(([s, p, q, pay]) => {
      setStats(s);
      setPromoters(p.promoters || []);
      setQueue(q.referrals || []);
      setPayouts(pay.payouts || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab === 'settings' && !settings) af('/admin/referrals/settings').then(r => setSettings(r.settings)).catch(() => {});
    if (tab === 'analytics' && !analytics) af('/admin/referrals/analytics').then(r => setAnalytics(r)).catch(() => {});
  }, [tab]);

  const searchCustomers = async (q) => {
    setCustSearch(q);
    if (q.length < 2) { setCustResults([]); return; }
    try {
      const r = await af(`/admin/customers?search=${encodeURIComponent(q)}&limit=8`);
      setCustResults(r.customers || []);
    } catch { setCustResults([]); }
  };

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(null), 3000); };

  const handleEnroll = async (customerId) => {
    try {
      await af('/admin/referrals/enroll', { method: 'POST', body: JSON.stringify({ customerId }) });
      flash('Promoter enrolled');
      setEnrollModal(false);
      setCustSearch(''); setCustResults([]);
      load();
    } catch (e) { flash('Error: ' + e.message); }
  };

  const handleStatusChange = async (id, status) => {
    await af(`/admin/referrals/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    load();
  };

  const handleConvert = async () => {
    if (!convertModal) return;
    try {
      await af(`/admin/referrals/${convertModal.id}/convert`, {
        method: 'POST',
        body: JSON.stringify({ customerId: convertModal.customerId, tier: convertModal.tier, monthlyValue: convertModal.monthlyValue }),
      });
      flash('Referral converted');
      setConvertModal(null);
      load();
    } catch (e) { flash('Error: ' + e.message); }
  };

  const handleApprovePayout = async (id) => {
    await af(`/admin/referrals/payouts/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    flash('Payout approved');
    load();
  };

  const handleSaveSettings = async () => {
    if (!settingsEditing) return;
    try {
      const r = await af('/admin/referrals/settings', { method: 'PUT', body: JSON.stringify(settingsEditing) });
      setSettings(r.settings);
      setSettingsEditing(null);
      flash('Settings saved');
    } catch (e) { flash('Error: ' + e.message); }
  };

  const copyLink = (link) => { navigator.clipboard.writeText(link); flash('Copied'); };

  // Submit referral form state
  const [refForm, setRefForm] = useState({ promoterId: '', name: '', phone: '', email: '', address: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const handleSubmitRef = async () => {
    if (!refForm.name || !refForm.phone) return;
    setSubmitting(true);
    try {
      await af('/admin/referrals/submit', { method: 'POST', body: JSON.stringify(refForm) });
      setRefForm({ promoterId: '', name: '', phone: '', email: '', address: '', notes: '' });
      flash('Referral submitted');
      load();
    } catch (e) { flash('Error: ' + e.message); }
    setSubmitting(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center' }}>Loading referral program...</div>;

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'queue', label: `Queue (${queue.length})` },
    { key: 'promoters', label: 'Promoters' },
    { key: 'payouts', label: 'Payouts' },
    { key: 'settings', label: 'Settings' },
    { key: 'analytics', label: 'Analytics' },
  ];

  const filteredPromoters = search
    ? promoters.filter(p => `${p.first_name} ${p.last_name} ${p.customer_phone} ${p.referral_code}`.toLowerCase().includes(search.toLowerCase()))
    : promoters;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>
          <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>Referral</span>
          <span className="hidden md:inline">Referral</span>
        </h1>
        {msg && <div style={{ padding: '6px 16px', borderRadius: 8, background: msg.includes('Error') ? `${D.red}33` : `${D.green}33`, color: msg.includes('Error') ? D.red : D.green, fontSize: 13 }}>{msg}</div>}
      </div>

      {/* Tabs */}
      <div className="tab-pill-scroll" style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
        <div className="tab-pill-scroll-inner" style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, background: '#F4F4F5', borderRadius: 10, padding: 4, border: '1px solid #E4E4E7' }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: tab === t.key ? '#18181B' : 'transparent',
              color: tab === t.key ? '#FFFFFF' : '#A1A1AA',
              fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
              fontFamily: "'DM Sans', sans-serif",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* DASHBOARD */}
      {tab === 'dashboard' && stats && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat label="Active Promoters" value={stats.activePromoters} color={D.green} />
            <Stat label="Referrals" value={stats.totalReferrals} sub={`${stats.convertedReferrals} converted`} color={D.teal} />
            <Stat label="Pending" value={stats.pendingReferrals} color={D.amber} />
            <Stat label="Total Rewards" value={fd(stats.totalRewardsDollars)} color={D.green} />
            <Stat label="Paid Out" value={fc(stats.totalPaidOutCents)} sub={`${stats.pendingPayouts} pending`} />
            <Stat label="Program ROI" value={`${stats.programROI}%`} color={stats.programROI > 0 ? D.green : D.red} />
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 300, background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Recent Activity</div>
              {queue.length === 0 ? <div style={{ color: D.muted, padding: 20, textAlign: 'center', fontSize: 13 }}>No referrals yet</div> : queue.slice(0, 8).map(r => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}33` }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{r.referee_name || `${r.referral_first_name || ''} ${r.referral_last_name || ''}`.trim()}</div>
                    <div style={{ fontSize: 11, color: D.muted }}>from {r.promoter_first ? `${r.promoter_first} ${r.promoter_last}` : '--'} / {r.source || 'portal'}</div>
                  </div>
                  <Badge status={r.status} />
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 300, background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Top Promoters</div>
              {promoters.filter(p => p.total_referrals_converted > 0).slice(0, 8).map(p => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}33` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{p.first_name} {p.last_name}</div>
                      <div style={{ fontSize: 11, color: D.muted }}>{p.total_referrals_converted} converted / {p.total_referrals_sent} sent</div>
                    </div>
                    <MilestoneBadge level={p.milestone_level || 'none'} />
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: D.green }}>{fc(p.total_earned_cents)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* QUEUE */}
      {tab === 'queue' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Submit form */}
          <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Submit Referral</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8, marginBottom: 8 }}>
              <input placeholder="Friend's name *" value={refForm.name} onChange={e => setRefForm(f => ({ ...f, name: e.target.value }))} style={inputSt} />
              <input placeholder="Phone *" value={refForm.phone} onChange={e => setRefForm(f => ({ ...f, phone: e.target.value }))} style={inputSt} />
              <input placeholder="Email" value={refForm.email} onChange={e => setRefForm(f => ({ ...f, email: e.target.value }))} style={inputSt} />
              <input placeholder="Promoter ID" value={refForm.promoterId} onChange={e => setRefForm(f => ({ ...f, promoterId: e.target.value }))} style={inputSt} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="Address" value={refForm.address} onChange={e => setRefForm(f => ({ ...f, address: e.target.value }))} style={{ ...inputSt, flex: 1 }} />
              <input placeholder="Notes" value={refForm.notes} onChange={e => setRefForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inputSt, flex: 1 }} />
              <button onClick={handleSubmitRef} disabled={submitting} style={btnPrimary}>{submitting ? '...' : 'Submit'}</button>
            </div>
          </div>
          {/* Queue table */}
          <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Referral Queue ({queue.length})</div>
            {queue.length === 0 ? <div style={{ color: D.muted, padding: 20, textAlign: 'center', fontSize: 13 }}>No pending referrals</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={thSt}>Referral</th><th style={thSt}>From</th><th style={thSt}>Source</th><th style={thSt}>Status</th><th style={thR}>Actions</th></tr></thead>
                  <tbody>{queue.map(r => (
                    <tr key={r.id}>
                      <td style={tdSt}>
                        <div style={{ fontWeight: 600 }}>{r.referee_name || `${r.referral_first_name || ''} ${r.referral_last_name || ''}`.trim()}</div>
                        <div style={{ fontSize: 11, color: D.muted }}>{r.referee_phone || r.referral_phone} {r.referee_email || r.referral_email ? `/ ${r.referee_email || r.referral_email}` : ''}</div>
                      </td>
                      <td style={tdSt}>{r.promoter_first ? `${r.promoter_first} ${r.promoter_last}` : '--'}</td>
                      <td style={{ ...tdSt, fontSize: 11 }}>{r.source || 'portal'}</td>
                      <td style={tdSt}><Badge status={r.status} /></td>
                      <td style={tdR}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          {r.status === 'pending' && <button onClick={() => handleStatusChange(r.id, 'contacted')} style={btnSmall(D.teal)}>Contacted</button>}
                          {['contacted', 'estimated', 'pending'].includes(r.status) && (
                            <button onClick={() => setConvertModal({ id: r.id, name: r.referee_name || r.referral_first_name, customerId: '', tier: '', monthlyValue: '' })} style={btnSmall(D.green)}>Convert</button>
                          )}
                          {!['signed_up', 'credited', 'rejected'].includes(r.status) && <button onClick={() => handleStatusChange(r.id, 'rejected')} style={btnSmall(`${D.red}aa`)}>Reject</button>}
                        </div>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PROMOTERS */}
      {tab === 'promoters' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder="Search promoters..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputSt, maxWidth: 300 }} />
            <button onClick={() => setEnrollModal(true)} style={btnPrimary}>Enroll Customer</button>
          </div>
          <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}`, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={thSt}>Name</th><th style={thSt}>Code</th><th style={thSt}>Link</th><th style={thR}>Clicks</th><th style={thR}>Referrals</th><th style={thSt}>Milestone</th><th style={thR}>Available</th><th style={thR}>Pending</th></tr></thead>
              <tbody>{filteredPromoters.map(p => (
                <tr key={p.id}>
                  <td style={tdSt}><span style={{ fontWeight: 600 }}>{p.first_name} {p.last_name}</span><br /><span style={{ fontSize: 11, color: D.muted }}>{p.customer_phone}</span></td>
                  <td style={{ ...tdSt, fontFamily: MONO, fontSize: 12 }}>{p.referral_code || '--'}</td>
                  <td style={tdSt}>{p.referral_link ? <button onClick={() => copyLink(p.referral_link)} style={{ background: 'none', border: `1px solid ${D.teal}33`, color: D.teal, fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer' }}>Copy Link</button> : '--'}</td>
                  <td style={tdR}>{p.total_clicks}</td>
                  <td style={tdR}>{p.total_referrals_converted}/{p.total_referrals_sent}</td>
                  <td style={tdSt}><MilestoneBadge level={p.milestone_level || 'none'} /></td>
                  <td style={{ ...tdR, color: D.green }}>{fc(p.available_balance_cents || 0)}</td>
                  <td style={{ ...tdR, color: D.amber }}>{fc(p.pending_earnings_cents || 0)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* PAYOUTS */}
      {tab === 'payouts' && (
        <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Payouts</div>
          {payouts.length === 0 ? <div style={{ color: D.muted, padding: 20, textAlign: 'center', fontSize: 13 }}>No payout requests</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={thSt}>Promoter</th><th style={thR}>Amount</th><th style={thSt}>Method</th><th style={thSt}>Status</th><th style={thSt}>1099</th><th style={thR}>Actions</th></tr></thead>
                <tbody>{payouts.map(p => (
                  <tr key={p.id}>
                    <td style={tdSt}>{p.first_name} {p.last_name}</td>
                    <td style={{ ...tdR, color: D.green, fontWeight: 700 }}>{fc(p.amount_cents)}</td>
                    <td style={tdSt}>{(p.payout_method || p.method || '').replace('_', ' ')}</td>
                    <td style={tdSt}><Badge status={p.status} /></td>
                    <td style={tdSt}>{p.requires_1099 ? <span style={{ color: D.amber, fontSize: 11 }}>Yes</span> : '--'}</td>
                    <td style={tdR}>{p.status === 'pending' && <button onClick={() => handleApprovePayout(p.id)} style={btnSmall(D.green)}>Approve</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* SETTINGS */}
      {tab === 'settings' && settings && (() => {
        const s = settingsEditing || settings;
        const upd = (k, v) => setSettingsEditing({ ...(settingsEditing || settings), [k]: v });
        const isEditing = !!settingsEditing;
        const fields = [
          { section: 'Rewards', items: [
            { key: 'referrer_reward_cents', label: 'Referrer Reward (cents)', type: 'number' },
            { key: 'referee_discount_cents', label: 'Referee Discount (cents)', type: 'number' },
          ]},
          { section: 'Tier Bonuses', items: [
            { key: 'bonus_silver_cents', label: 'Silver Bonus (cents)', type: 'number' },
            { key: 'bonus_gold_cents', label: 'Gold Bonus (cents)', type: 'number' },
            { key: 'bonus_platinum_cents', label: 'Platinum Bonus (cents)', type: 'number' },
          ]},
          { section: 'Milestones', items: [
            { key: 'milestone_3_bonus_cents', label: '3 Referrals Bonus (cents)', type: 'number' },
            { key: 'milestone_5_bonus_cents', label: '5 Referrals Bonus (cents)', type: 'number' },
            { key: 'milestone_10_bonus_cents', label: '10 Referrals Bonus (cents)', type: 'number' },
          ]},
          { section: 'Fraud Prevention', items: [
            { key: 'max_referrals_per_month', label: 'Max Referrals / Month', type: 'number' },
            { key: 'cooldown_days', label: 'Cooldown Days', type: 'number' },
            { key: 'min_payout_cents', label: 'Min Payout (cents)', type: 'number' },
          ]},
          { section: 'Program', items: [
            { key: 'program_active', label: 'Program Active', type: 'boolean' },
            { key: 'auto_credit_enabled', label: 'Auto Credit', type: 'boolean' },
            { key: 'require_service_completion', label: 'Require 1st Service', type: 'boolean' },
            { key: 'base_url', label: 'Base URL', type: 'text' },
          ]},
          { section: 'SMS Templates', items: [
            { key: 'invite_sms_template', label: 'Invite SMS', type: 'textarea' },
            { key: 'reward_sms_template', label: 'Reward SMS', type: 'textarea' },
            { key: 'milestone_sms_template', label: 'Milestone SMS', type: 'textarea' },
          ]},
        ];
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {!isEditing && <button onClick={() => setSettingsEditing({ ...settings })} style={btnPrimary}>Edit Settings</button>}
              {isEditing && <button onClick={handleSaveSettings} style={{ ...btnPrimary, background: D.green }}>Save</button>}
              {isEditing && <button onClick={() => setSettingsEditing(null)} style={{ ...btnPrimary, background: 'transparent', border: `1px solid ${D.border}`, color: D.muted }}>Cancel</button>}
            </div>
            {fields.map(section => (
              <div key={section.section} style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>{section.section}</div>
                <div style={{ display: 'grid', gridTemplateColumns: section.items[0]?.type === 'textarea' ? '1fr' : 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                  {section.items.map(f => (
                    <div key={f.key}>
                      <div style={{ fontSize: 11, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{f.label}</div>
                      {f.type === 'boolean' ? (
                        <button onClick={() => isEditing && upd(f.key, !s[f.key])} disabled={!isEditing} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.border}`, background: s[f.key] ? `${D.green}33` : `${D.red}33`, color: s[f.key] ? D.green : D.red, fontSize: 12, cursor: isEditing ? 'pointer' : 'default' }}>{s[f.key] ? 'Enabled' : 'Disabled'}</button>
                      ) : f.type === 'textarea' ? (
                        <textarea value={s[f.key] || ''} onChange={e => upd(f.key, e.target.value)} disabled={!isEditing} rows={2} style={{ ...inputSt, resize: 'vertical', opacity: isEditing ? 1 : 0.6 }} />
                      ) : (
                        <input type={f.type} value={s[f.key] ?? ''} onChange={e => upd(f.key, f.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value)} disabled={!isEditing} style={{ ...inputSt, opacity: isEditing ? 1 : 0.6 }} />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* ANALYTICS */}
      {tab === 'analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!analytics ? <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading analytics...</div> : (<>
            {/* Funnel */}
            <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Conversion Funnel</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Stat label="Clicks" value={analytics.funnel.clicks} sub={`${analytics.funnel.uniqueClicks} unique`} color={D.purple} />
                <Stat label="Referrals" value={analytics.funnel.referrals} sub={`${analytics.funnel.clickToReferralRate}% click-to-ref`} color={D.teal} />
                <Stat label="Converted" value={analytics.funnel.converted} sub={`${analytics.funnel.conversionRate}% rate`} color={D.green} />
                <Stat label="Lost" value={analytics.funnel.lost} color={D.red} />
                <Stat label="Pending" value={analytics.funnel.pending} color={D.amber} />
              </div>
            </div>
            {/* Financial */}
            <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Financial / ROI</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Stat label="Rewards Issued" value={fd(analytics.financial.totalRewardsDollars)} color={D.amber} />
                <Stat label="Paid Out" value={fc(analytics.financial.totalPaidOutCents)} />
                <Stat label="Monthly Value" value={fd(analytics.financial.totalMonthlyValue)} sub="from converted refs" color={D.teal} />
                <Stat label="Est. Annual Rev" value={fd(analytics.financial.estimatedAnnualRevenue)} color={D.green} />
                <Stat label="ROI" value={`${analytics.financial.roi}%`} color={analytics.financial.roi > 0 ? D.green : D.red} />
              </div>
            </div>
            {/* Top promoters bar chart */}
            <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Top Promoters</div>
              {analytics.topPromoters.length === 0 ? <div style={{ color: D.muted, fontSize: 13 }}>No conversions yet</div> : analytics.topPromoters.map((p, i) => {
                const maxConv = analytics.topPromoters[0].conversions || 1;
                const pct = Math.round((p.conversions / maxConv) * 100);
                return (
                  <div key={p.id} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontSize: 13, color: D.text }}>{i + 1}. {p.name} <MilestoneBadge level={p.milestone || 'none'} /></span>
                      <span style={{ fontFamily: MONO, fontSize: 12, color: D.green }}>{p.conversions} conv / {fc(p.earned)}</span>
                    </div>
                    <div style={{ background: D.bg, borderRadius: 4, height: 8 }}>
                      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: `linear-gradient(90deg, ${D.teal}, ${D.green})` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </>)}
        </div>
      )}

      {/* CONVERT MODAL */}
      {convertModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }} onClick={() => setConvertModal(null)}>
          <div style={{ background: D.card, borderRadius: 16, padding: 28, width: 420, border: `1px solid ${D.border}` }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 16 }}>Convert Referral</div>
            <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>Converting: {convertModal.name}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Customer Search</div>
                <input placeholder="Search customer name or phone..." value={custSearch} onChange={e => searchCustomers(e.target.value)} style={inputSt} />
                {custResults.length > 0 && (
                  <div style={{ background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, marginTop: 4, maxHeight: 150, overflow: 'auto' }}>
                    {custResults.map(c => (
                      <div key={c.id} onClick={() => { setConvertModal(m => ({ ...m, customerId: c.id })); setCustSearch(`${c.first_name} ${c.last_name}`); setCustResults([]); }}
                        style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}33`, fontSize: 13, color: D.text }}>
                        {c.first_name} {c.last_name} <span style={{ color: D.muted }}>({c.phone})</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>WaveGuard Tier</div>
                <select value={convertModal.tier} onChange={e => setConvertModal(m => ({ ...m, tier: e.target.value }))} style={{ ...inputSt, appearance: 'auto' }}>
                  <option value="">Select tier...</option>
                  <option value="Platinum">Platinum</option>
                  <option value="Gold">Gold</option>
                  <option value="Silver">Silver</option>
                  <option value="Bronze">Bronze</option>
                  <option value="One-Time">One-Time</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Monthly Value ($)</div>
                <input type="number" placeholder="e.g. 79" value={convertModal.monthlyValue} onChange={e => setConvertModal(m => ({ ...m, monthlyValue: e.target.value }))} style={inputSt} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button onClick={handleConvert} style={{ ...btnPrimary, background: D.green, flex: 1 }}>Convert</button>
                <button onClick={() => setConvertModal(null)} style={{ ...btnPrimary, background: 'transparent', border: `1px solid ${D.border}`, color: D.muted }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ENROLL MODAL */}
      {enrollModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }} onClick={() => setEnrollModal(false)}>
          <div style={{ background: D.card, borderRadius: 16, padding: 28, width: 400, border: `1px solid ${D.border}` }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 16 }}>Enroll Customer as Promoter</div>
            <input placeholder="Search customer name or phone..." value={custSearch} onChange={e => searchCustomers(e.target.value)} style={{ ...inputSt, marginBottom: 8 }} />
            {custResults.length > 0 && (
              <div style={{ background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, maxHeight: 200, overflow: 'auto' }}>
                {custResults.map(c => (
                  <div key={c.id} onClick={() => handleEnroll(c.id)} style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}33`, fontSize: 13, color: D.text }}>
                    {c.first_name} {c.last_name} <span style={{ color: D.muted }}>({c.phone})</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => { setEnrollModal(false); setCustSearch(''); setCustResults([]); }} style={{ ...btnPrimary, background: 'transparent', border: `1px solid ${D.border}`, color: D.muted, marginTop: 12, width: '100%' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
