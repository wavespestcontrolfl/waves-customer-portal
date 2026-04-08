import { useState, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';

function apiFetch(path, token, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...opts,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const C = { teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#334155', muted: '#64748b', light: '#f1f5f9', white: '#fff', border: '#e2e8f0' };

const MILESTONE_META = {
  none: { label: 'Getting Started', color: C.muted, next: 'advocate', threshold: 3 },
  advocate: { label: 'Advocate', color: '#06b6d4', next: 'ambassador', threshold: 5 },
  ambassador: { label: 'Ambassador', color: C.amber, next: 'champion', threshold: 10 },
  champion: { label: 'Champion', color: '#f97316', next: null, threshold: null },
};

export default function ReferralTab({ customerId, customerName, token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', phone: '' });
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiFetch('/referrals', token)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  const flash = (m, isErr) => { setMsg({ text: m, err: isErr }); setTimeout(() => setMsg(null), 4000); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.phone) return;
    setSubmitting(true);
    try {
      await apiFetch('/referrals', token, { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', phone: '' });
      flash('Referral sent! Your friend will receive a text.');
      const updated = await apiFetch('/referrals', token);
      setData(updated);
    } catch (err) {
      const body = await err.response?.json?.().catch(() => null);
      flash(body?.error || 'Something went wrong', true);
    }
    setSubmitting(false);
  };

  const copyLink = () => {
    if (data?.referralLink) {
      navigator.clipboard.writeText(data.referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const shareSMS = () => {
    if (data?.referralLink) {
      window.open(`sms:?body=${encodeURIComponent(`Check out Waves Pest Control! Get a free quote: ${data.referralLink}`)}`);
    }
  };

  const shareEmail = () => {
    if (data?.referralLink) {
      window.open(`mailto:?subject=${encodeURIComponent('Try Waves Pest Control!')}&body=${encodeURIComponent(`Hey! I've been using Waves Pest Control and they're great. Use my link to get a discount: ${data.referralLink}`)}`);
    }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: C.muted }}>Loading referral program...</div>;
  if (error) return <div style={{ padding: 40, textAlign: 'center', color: C.red }}>Error loading referral data</div>;
  if (!data) return null;

  const milestone = MILESTONE_META[data.milestoneLevel || 'none'];
  const nextMilestone = data.nextMilestone;
  const progressPct = nextMilestone ? Math.min(100, Math.round((data.stats.converted / nextMilestone.threshold) * 100)) : 100;

  const statusColors = { pending: C.amber, contacted: C.teal, signed_up: C.green, credited: C.green, rejected: C.red, estimated: '#8b5cf6' };

  const sectionStyle = { background: C.white, borderRadius: 12, padding: 20, border: `1px solid ${C.border}`, marginBottom: 16 };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto' }}>
      {msg && <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 16, background: msg.err ? '#fef2f2' : '#f0fdf4', color: msg.err ? C.red : C.green, fontSize: 14 }}>{msg.text}</div>}

      {/* Share Link */}
      <div style={sectionStyle}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>Your Referral Link</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Share this link with friends and neighbors. You both earn rewards!</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1, padding: '10px 14px', background: C.light, borderRadius: 8, fontFamily: 'monospace', fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.referralLink}</div>
          <button onClick={copyLink} style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: copied ? C.green : C.teal, color: C.white, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background 0.2s' }}>{copied ? 'Copied!' : 'Copy'}</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={shareSMS} style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Text a Friend</button>
          <button onClick={shareEmail} style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.text, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Email</button>
        </div>
      </div>

      {/* Milestone Progress */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Milestone Level</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: milestone.color, marginTop: 2 }}>{milestone.label}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>${((data.availableBalance || 0) / 100).toFixed(2)}</div>
            <div style={{ fontSize: 11, color: C.muted }}>Available balance</div>
          </div>
        </div>
        {nextMilestone && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.muted, marginBottom: 4 }}>
              <span>{data.stats.converted} of {nextMilestone.threshold} to {MILESTONE_META[milestone.next]?.label || 'next level'}</span>
              <span>{nextMilestone.remaining} more to go</span>
            </div>
            <div style={{ background: C.light, borderRadius: 6, height: 10, overflow: 'hidden' }}>
              <div style={{ width: `${progressPct}%`, height: '100%', borderRadius: 6, background: `linear-gradient(90deg, ${C.teal}, ${C.green})`, transition: 'width 0.5s' }} />
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Next bonus: ${(nextMilestone.bonus / 100).toFixed(2)}</div>
          </div>
        )}
        {data.pendingEarnings > 0 && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: `${C.amber}11`, borderRadius: 8, fontSize: 13, color: C.amber }}>
            ${(data.pendingEarnings / 100).toFixed(2)} pending (waiting for first service completion)
          </div>
        )}
      </div>

      {/* Stats Row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { label: 'Referrals', value: data.stats.totalReferrals, color: C.teal },
          { label: 'Converted', value: data.stats.converted, color: C.green },
          { label: 'Total Earned', value: `$${((data.totalEarned || 0) / 100).toFixed(2)}`, color: C.green },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Submit Referral */}
      <div style={sectionStyle}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 12 }}>Refer a Friend</div>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="Friend's name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 14, outline: 'none' }} />
            <input placeholder="Phone number" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} required type="tel" style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 14, outline: 'none' }} />
          </div>
          <button type="submit" disabled={submitting} style={{ width: '100%', padding: '12px', borderRadius: 8, border: 'none', background: C.teal, color: C.white, fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: submitting ? 0.6 : 1 }}>{submitting ? 'Sending...' : 'Send Referral'}</button>
        </form>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>We will text your friend an invitation with your referral link.</div>
      </div>

      {/* Referral Tracker */}
      {data.referrals.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 12 }}>Your Referrals</div>
          {data.referrals.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{r.name}</div>
                <div style={{ fontSize: 12, color: C.muted }}>{r.phone} / {new Date(r.createdAt).toLocaleDateString()}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: `${statusColors[r.status] || C.muted}18`, color: statusColors[r.status] || C.muted, textTransform: 'uppercase' }}>{r.status?.replace('_', ' ')}</span>
                {r.rewardStatus === 'earned' && <div style={{ fontSize: 12, color: C.green, marginTop: 2, fontWeight: 600 }}>+${r.rewardAmount.toFixed(2)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* How It Works */}
      <div style={sectionStyle}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 12 }}>How It Works</div>
        {[
          { step: '1', title: 'Share Your Link', desc: 'Send your personal referral link to friends, family, or neighbors.' },
          { step: '2', title: 'They Sign Up', desc: `When they become a Waves customer, you earn $${(data.rewardPerReferral || 50).toFixed(2)} in credit.` },
          { step: '3', title: 'Earn Rewards', desc: 'Credits are applied to your account after their first service. Hit milestones for bonus rewards!' },
        ].map(s => (
          <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: `${C.teal}18`, color: C.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{s.step}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{s.title}</div>
              <div style={{ fontSize: 13, color: C.muted }}>{s.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
