import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: `teal` + `purple` fold to zinc-900. Semantic accents preserved.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', purple: '#18181B', heading: '#09090B', inputBorder: '#D4D4D8' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function fmtCents(c) { return '$' + (c / 100).toFixed(2); }

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: '16px 20px', flex: '1 1 0', minWidth: 140 }}>
      <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, color: color || D.heading }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = { pending: D.amber, contacted: D.teal, estimated: D.purple, converted: D.green, rejected: D.red, expired: D.muted, active: D.green, paused: D.amber, applied: D.green };
  const c = colors[status] || D.muted;
  return <span style={{ fontSize: 10, fontFamily: MONO, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 6, background: `${c}22`, color: c, letterSpacing: 0.5 }}>{status}</span>;
}

// =========================================================================
export default function ReferralsPage() {
  const [tab, setTab] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [promoters, setPromoters] = useState([]);
  const [queue, setQueue] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);

  // Enroll form
  const [enrollForm, setEnrollForm] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [enrolling, setEnrolling] = useState(false);
  const [enrollResult, setEnrollResult] = useState(null);

  // Submit referral form
  const [refForm, setRefForm] = useState({ promoterPhone: '', firstName: '', lastName: '', phone: '', email: '', address: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(() => {
    Promise.all([
      adminFetch('/admin/referrals/stats').catch(() => null),
      adminFetch('/admin/referrals/promoters').catch(() => ({ promoters: [] })),
      adminFetch('/admin/referrals/queue').catch(() => ({ referrals: [] })),
      adminFetch('/admin/referrals/payouts').catch(() => ({ payouts: [] })),
    ]).then(([s, p, q, pay]) => {
      setStats(s);
      setPromoters(p.promoters || []);
      setQueue(q.referrals || []);
      setPayouts(pay.payouts || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleEnroll = async () => {
    if (!enrollForm.phone || !enrollForm.firstName) return;
    setEnrolling(true);
    try {
      const r = await adminFetch('/admin/referrals/enroll', {
        method: 'POST',
        body: JSON.stringify({ customerPhone: enrollForm.phone, customerEmail: enrollForm.email, firstName: enrollForm.firstName, lastName: enrollForm.lastName }),
      });
      setEnrollResult(r.alreadyEnrolled ? 'Already enrolled' : `Enrolled! Link: ${r.promoter?.clicki_referral_link}`);
      setEnrollForm({ firstName: '', lastName: '', phone: '', email: '' });
      loadData();
    } catch (e) { setEnrollResult('Error: ' + e.message); }
    setEnrolling(false);
  };

  const handleSubmitReferral = async () => {
    if (!refForm.phone || !refForm.firstName) return;
    setSubmitting(true);
    try {
      await adminFetch('/admin/referrals/submit', {
        method: 'POST',
        body: JSON.stringify({
          promoterPhone: refForm.promoterPhone, referralFirstName: refForm.firstName,
          referralLastName: refForm.lastName, referralPhone: refForm.phone,
          referralEmail: refForm.email, referralAddress: refForm.address,
          referralNotes: refForm.notes, source: 'admin',
        }),
      });
      setRefForm({ promoterPhone: '', firstName: '', lastName: '', phone: '', email: '', address: '', notes: '' });
      loadData();
    } catch { /* */ }
    setSubmitting(false);
  };

  const handleStatusChange = async (id, status) => {
    await adminFetch(`/admin/referrals/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    loadData();
  };

  const handleApprovePayout = async (id) => {
    await adminFetch(`/admin/referrals/payouts/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    loadData();
  };

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center' }}>Loading referral program...</div>;

  const thSt = { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: D.muted, borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: '0.5px' };
  const thR = { ...thSt, textAlign: 'right' };
  const tdSt = { padding: '10px 14px', fontSize: 13, color: D.text, borderBottom: `1px solid ${D.border}` };
  const tdR = { ...tdSt, textAlign: 'right', fontFamily: MONO };
  const inputSt = { width: '100%', padding: '8px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.heading, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

  return (
    <div>
      <div style={{ fontSize: 28, fontWeight: 700, color: D.heading, marginBottom: 24 }}>Referrals</div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto' }}>
        {[
          { key: 'dashboard', label: 'Dashboard' },
          { key: 'queue', label: `Queue (${queue.length})` },
          { key: 'promoters', label: 'Promoters' },
          { key: 'payouts', label: 'Payouts' },
          { key: 'enroll', label: 'Enroll' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
            transition: 'all 0.15s', whiteSpace: 'nowrap',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ═══ DASHBOARD ═══ */}
      {tab === 'dashboard' && stats && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatCard label="Active Promoters" value={stats.activePromoters} color={D.green} />
            <StatCard label="Total Referrals" value={stats.totalReferrals} sub={`${stats.convertedReferrals} converted`} color={D.teal} />
            <StatCard label="Pending" value={stats.pendingReferrals} color={D.amber} />
            <StatCard label="Total Clicks" value={stats.totalClicks} color={D.purple} />
            <StatCard label="Total Earned" value={fmtCents(stats.totalReferralRewards + stats.totalClickRewards)} color={D.green} />
            <StatCard label="Paid Out" value={fmtCents(stats.totalPaidOut)} sub={`${stats.pendingPayouts} pending`} />
          </div>

          {/* Recent referrals */}
          <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Recent Referrals</div>
            {queue.length === 0 ? (
              <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No referrals yet</div>
            ) : queue.slice(0, 10).map(r => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${D.border}33` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{r.referral_first_name} {r.referral_last_name}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{r.referral_phone} · from {r.promoter_name || 'unknown'} · {r.source}</div>
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>

          {/* Top promoters */}
          <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Top Promoters</div>
            {promoters.slice(0, 10).map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}33` }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{p.first_name} {p.last_name}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{p.total_referrals_converted} converted · {p.total_clicks} clicks</div>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: D.green }}>{fmtCents(p.total_earned_cents)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ QUEUE ═══ */}
      {tab === 'queue' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Submit referral form */}
          <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Submit Referral</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
              <input placeholder="First name *" value={refForm.firstName} onChange={e => setRefForm(f => ({ ...f, firstName: e.target.value }))} style={inputSt} />
              <input placeholder="Last name" value={refForm.lastName} onChange={e => setRefForm(f => ({ ...f, lastName: e.target.value }))} style={inputSt} />
              <input placeholder="Phone *" value={refForm.phone} onChange={e => setRefForm(f => ({ ...f, phone: e.target.value }))} style={inputSt} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
              <input placeholder="Email" value={refForm.email} onChange={e => setRefForm(f => ({ ...f, email: e.target.value }))} style={inputSt} />
              <input placeholder="Referred by (phone)" value={refForm.promoterPhone} onChange={e => setRefForm(f => ({ ...f, promoterPhone: e.target.value }))} style={inputSt} />
              <input placeholder="Address" value={refForm.address} onChange={e => setRefForm(f => ({ ...f, address: e.target.value }))} style={inputSt} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="Notes" value={refForm.notes} onChange={e => setRefForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inputSt, flex: 1 }} />
              <button onClick={handleSubmitReferral} disabled={submitting} style={{
                padding: '8px 20px', borderRadius: 8, border: 'none', background: D.teal, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              }}>{submitting ? 'Submitting...' : 'Submit'}</button>
            </div>
          </div>

          {/* Queue table */}
          <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Referral Queue ({queue.length})</div>
            {queue.length === 0 ? (
              <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No pending referrals</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={thSt}>Referral</th><th style={thSt}>From</th><th style={thSt}>Status</th><th style={thSt}>Notes</th><th style={thR}>Actions</th></tr></thead>
                  <tbody>
                    {queue.map(r => (
                      <tr key={r.id}>
                        <td style={tdSt}>
                          <div style={{ fontWeight: 600 }}>{r.referral_first_name} {r.referral_last_name}</div>
                          <div style={{ fontSize: 11, color: D.muted }}>{r.referral_phone} {r.referral_email ? `· ${r.referral_email}` : ''}</div>
                        </td>
                        <td style={tdSt}>{r.promoter_name || r.promoter_phone || '--'}</td>
                        <td style={tdSt}><StatusBadge status={r.status} /></td>
                        <td style={{ ...tdSt, maxWidth: 200, fontSize: 12 }}>{r.referral_notes || r.referral_address || '--'}</td>
                        <td style={tdR}>
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                            {r.status === 'pending' && <button onClick={() => handleStatusChange(r.id, 'contacted')} style={{ padding: '3px 8px', borderRadius: 4, border: `1px solid ${D.teal}`, background: 'transparent', color: D.teal, fontSize: 10, cursor: 'pointer' }}>Contacted</button>}
                            {(r.status === 'contacted' || r.status === 'estimated') && <button onClick={() => handleStatusChange(r.id, 'converted')} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: D.green, color: '#fff', fontSize: 10, cursor: 'pointer' }}>Convert</button>}
                            {r.status !== 'converted' && r.status !== 'rejected' && <button onClick={() => handleStatusChange(r.id, 'rejected')} style={{ padding: '3px 8px', borderRadius: 4, border: `1px solid ${D.red}33`, background: 'transparent', color: D.red, fontSize: 10, cursor: 'pointer' }}>Reject</button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ PROMOTERS ═══ */}
      {tab === 'promoters' && (
        <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Promoters ({promoters.length})</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={thSt}>Name</th><th style={thSt}>Phone</th><th style={thSt}>Clicks</th><th style={thSt}>Referrals</th><th style={thR}>Earned</th><th style={thR}>Balance</th><th style={thSt}>Link</th></tr></thead>
              <tbody>
                {promoters.map(p => (
                  <tr key={p.id}>
                    <td style={tdSt}><span style={{ fontWeight: 600 }}>{p.first_name} {p.last_name}</span></td>
                    <td style={{ ...tdSt, fontFamily: MONO, fontSize: 12 }}>{p.customer_phone}</td>
                    <td style={tdR}>{p.total_clicks}</td>
                    <td style={tdR}>{p.total_referrals_converted}/{p.total_referrals_sent}</td>
                    <td style={{ ...tdR, color: D.green }}>{fmtCents(p.total_earned_cents)}</td>
                    <td style={{ ...tdR, color: D.amber }}>{fmtCents(p.click_balance_cents + p.referral_balance_cents)}</td>
                    <td style={tdSt}>{p.clicki_referral_link ? <a href={p.clicki_referral_link} target="_blank" rel="noopener noreferrer" style={{ color: D.teal, fontSize: 11, textDecoration: 'none' }}>Copy</a> : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ PAYOUTS ═══ */}
      {tab === 'payouts' && (
        <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Payouts</div>
          {payouts.length === 0 ? (
            <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No payout requests yet</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={thSt}>Promoter</th><th style={thR}>Amount</th><th style={thSt}>Method</th><th style={thSt}>Status</th><th style={thR}>Actions</th></tr></thead>
                <tbody>
                  {payouts.map(p => (
                    <tr key={p.id}>
                      <td style={tdSt}>{p.first_name} {p.last_name}</td>
                      <td style={{ ...tdR, color: D.green, fontWeight: 700 }}>{fmtCents(p.amount_cents)}</td>
                      <td style={tdSt}>{p.method?.replace('_', ' ')}</td>
                      <td style={tdSt}><StatusBadge status={p.status} /></td>
                      <td style={tdR}>
                        {p.status === 'pending' && <button onClick={() => handleApprovePayout(p.id)} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: D.green, color: '#fff', fontSize: 10, cursor: 'pointer' }}>Approve</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══ ENROLL ═══ */}
      {tab === 'enroll' && (
        <div style={{ background: D.card, borderRadius: 12, padding: 24, border: `1px solid ${D.border}`, maxWidth: 500 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Enroll New Promoter</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input placeholder="First name *" value={enrollForm.firstName} onChange={e => setEnrollForm(f => ({ ...f, firstName: e.target.value }))} style={inputSt} />
            <input placeholder="Last name" value={enrollForm.lastName} onChange={e => setEnrollForm(f => ({ ...f, lastName: e.target.value }))} style={inputSt} />
            <input placeholder="Phone *" value={enrollForm.phone} onChange={e => setEnrollForm(f => ({ ...f, phone: e.target.value }))} style={inputSt} />
            <input placeholder="Email" value={enrollForm.email} onChange={e => setEnrollForm(f => ({ ...f, email: e.target.value }))} style={inputSt} />
            <button onClick={handleEnroll} disabled={enrolling} style={{
              padding: '12px 24px', borderRadius: 8, border: 'none', background: D.teal, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>{enrolling ? 'Enrolling...' : 'Enroll Promoter'}</button>
            {enrollResult && <div style={{ fontSize: 13, color: enrollResult.includes('Error') ? D.red : D.green }}>{enrollResult}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
