import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then(r => { if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); } return r.json(); });
}

function Card({ children, style }) {
  return <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, ...style }}>{children}</div>;
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: `1px solid ${D.border}` }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{description}</div>}
      </div>
      <div onClick={() => onChange(!checked)} style={{
        width: 44, height: 24, borderRadius: 12, padding: 2, cursor: 'pointer',
        background: checked ? D.teal : D.border, transition: 'background 0.2s',
      }}>
        <div style={{
          width: 20, height: 20, borderRadius: 10, background: D.white,
          transform: checked ? 'translateX(20px)' : 'translateX(0)',
          transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [health, setHealth] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('general');

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/health`).then(r => r.json()),
      adminFetch('/admin/auth/me'),
    ]).then(([h, u]) => { setHealth(h); setUser(u); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading settings...</div>;

  const gates = health?.gates || {};

  const TABS = [
    { key: 'general', label: 'General' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'gates', label: 'Feature Gates' },
    { key: 'team', label: 'Team' },
    { key: 'system', label: 'System' },
  ];

  return (
    <div>
      <div style={{ fontSize: 28, fontWeight: 700, color: D.heading, marginBottom: 24 }}>Settings</div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── GENERAL ── */}
      {tab === 'general' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Company Info</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { label: 'Company', value: 'Waves Pest Control' },
                { label: 'Main Phone', value: '(941) 318-7612' },
                { label: 'Website', value: 'wavespestcontrol.com' },
                { label: 'Service Area', value: 'Bradenton, Sarasota, Venice, Parrish, LWR, North Port, Port Charlotte' },
              ].map((f, i) => (
                <div key={i} style={{ padding: '10px 14px', background: D.bg, borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{f.label}</div>
                  <div style={{ fontSize: 13, color: D.heading, fontWeight: 500 }}>{f.value}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Logged In As</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{
                width: 48, height: 48, borderRadius: 12,
                background: `linear-gradient(135deg, ${D.teal}, ${D.green})`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: D.heading, fontSize: 20, fontWeight: 700,
              }}>{(user?.name || 'A')[0]}</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{user?.name || 'Unknown'}</div>
                <div style={{ fontSize: 12, color: D.muted }}>{user?.email} · {user?.role}</div>
              </div>
            </div>
          </Card>

          <Card>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>WaveGuard Tiers</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {[
                { tier: 'Bronze', discount: '0%', color: '#CD7F32' },
                { tier: 'Silver', discount: '10%', color: '#90CAF9' },
                { tier: 'Gold', discount: '15%', color: '#FDD835' },
                { tier: 'Platinum', discount: '20%', color: '#E5E4E2' },
              ].map(t => (
                <div key={t.tier} style={{ padding: 14, background: D.bg, borderRadius: 10, textAlign: 'center', borderTop: `3px solid ${t.color}` }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: t.color }}>{t.tier}</div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{t.discount} discount</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── INTEGRATIONS ── */}
      {tab === 'integrations' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[
            { name: 'Twilio', icon: '📱', status: gates.twilioSms, keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], desc: 'SMS notifications, OTP login, voice calls' },
            { name: 'Stripe', icon: '💳', status: true, keys: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], desc: 'Payment processing, invoicing' },
            { name: 'Anthropic (Claude)', icon: '🤖', status: true, keys: ['ANTHROPIC_API_KEY'], desc: 'AI assistant, blog writer, CSR coach, voice agent' },
            { name: 'Google APIs', icon: '🔍', status: true, keys: ['GOOGLE_API_KEY'], desc: 'Maps, Search Console, PageSpeed, Places Autocomplete' },
            { name: 'DataForSEO', icon: '📊', status: gates.seoIntelligence, keys: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'], desc: 'Rank tracking, SERP analysis, backlink monitoring' },
            { name: 'RentCast', icon: '🏠', status: true, keys: ['RENTCAST_API_KEY'], desc: 'Property data lookup for estimates' },
            { name: 'WordPress', icon: '📝', status: gates.wordpressPublish, keys: ['WORDPRESS_URL', 'WORDPRESS_USER'], desc: 'Blog publishing, content sync' },
          ].map((int, i) => (
            <Card key={i}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 24 }}>{int.icon}</span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{int.name}</div>
                    <div style={{ fontSize: 12, color: D.muted }}>{int.desc}</div>
                  </div>
                </div>
                <span style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                  background: int.status ? D.green + '22' : D.red + '15',
                  color: int.status ? D.green : D.red,
                }}>{int.status ? 'Connected' : 'Disabled'}</span>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {int.keys.map(k => (
                  <span key={k} style={{ fontSize: 10, fontFamily: MONO, padding: '2px 8px', borderRadius: 4, background: D.bg, color: D.muted }}>{k}</span>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── FEATURE GATES ── */}
      {tab === 'gates' && (
        <Card>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Feature Gates</div>
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>Control which integrations are active. Set via Railway environment variables.</div>
          {Object.entries(gates).map(([key, enabled]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: `1px solid ${D.border}` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{key}</div>
                <div style={{ fontSize: 11, fontFamily: MONO, color: D.muted }}>GATE_{key.replace(/([A-Z])/g, '_$1').toUpperCase()}</div>
              </div>
              <span style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                background: enabled ? D.green + '22' : D.border + '44',
                color: enabled ? D.green : D.muted,
              }}>{enabled ? 'ENABLED' : 'DISABLED'}</span>
            </div>
          ))}
          <div style={{ marginTop: 16, fontSize: 12, color: D.muted, padding: '10px 14px', background: D.bg, borderRadius: 8 }}>
            {'ℹ️'} Gates are controlled via Railway environment variables. To change: Railway Dashboard → Variables → set GATE_NAME=true or remove the variable.
          </div>
        </Card>
      )}

      {/* ── TEAM ── */}
      {tab === 'team' && (
        <Card>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Team Members</div>
          <TeamList />
        </Card>
      )}

      {/* ── SYSTEM ── */}
      {tab === 'system' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>System Info</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { label: 'Environment', value: health?.environment || '—' },
                { label: 'Status', value: health?.status || '—' },
                { label: 'Server Time', value: health?.timestamp ? new Date(health.timestamp).toLocaleString() : '—' },
                { label: 'Database', value: 'PostgreSQL (Railway)' },
                { label: 'Frontend', value: 'React (Vite)' },
                { label: 'Backend', value: 'Express.js' },
                { label: 'AI Model', value: 'Claude Sonnet 4' },
                { label: 'Migrations', value: '50 migrations' },
              ].map((f, i) => (
                <div key={i} style={{ padding: '10px 14px', background: D.bg, borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{f.label}</div>
                  <div style={{ fontSize: 13, color: D.heading, fontFamily: MONO }}>{f.value}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Cron Jobs</div>
            <div style={{ fontSize: 12, color: gates.cronJobs ? D.green : D.red, fontWeight: 600, marginBottom: 12 }}>
              {gates.cronJobs ? '✅ Cron jobs ENABLED' : '🔒 Cron jobs DISABLED'}
            </div>
            {[
              { time: '1:30 AM Mon', job: 'Site audit', gate: 'seoIntelligence' },
              { time: '2:00 AM', job: 'Rank tracking', gate: 'seoIntelligence' },
              { time: '2:30 AM', job: 'AI Overview check', gate: 'seoIntelligence' },
              { time: '3:00 AM', job: 'Customer intelligence', gate: 'cronJobs' },
              { time: '3:30 AM Sun', job: 'Backlink scan', gate: 'seoIntelligence' },
              { time: '4:00 AM', job: 'WordPress sync', gate: 'cronJobs' },
              { time: '5:00 AM', job: 'Blog auto-generate', gate: 'cronJobs' },
              { time: '5:30 AM Mon', job: 'Content decay check', gate: 'seoIntelligence' },
              { time: '6:00 AM', job: 'GSC data sync', gate: 'cronJobs' },
              { time: '8:00 AM', job: 'Campaign advisor', gate: 'cronJobs' },
              { time: '8:00 AM Fri', job: 'CSR weekly rec', gate: 'cronJobs' },
              { time: 'Every 2hr', job: 'Ad budget adjust', gate: 'cronJobs' },
              { time: ':30 past hr', job: 'Follow-up verify', gate: 'cronJobs' },
            ].map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: `1px solid ${D.border}22` }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: gates[c.gate] ? D.green : D.muted, flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: D.muted, fontFamily: MONO, width: 100 }}>{c.time}</span>
                <span style={{ fontSize: 12, color: D.text }}>{c.job}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

function TeamList() {
  const [team, setTeam] = useState([]);
  useEffect(() => {
    adminFetch('/admin/auth/me').then(me => {
      // Just show current user for now
      setTeam([me]);
    }).catch(() => {});
  }, []);

  return (
    <div>
      {team.map((t, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0', borderBottom: `1px solid ${D.border}` }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: `linear-gradient(135deg, ${D.teal}, ${D.green})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: D.heading, fontSize: 16, fontWeight: 700,
          }}>{(t.name || '?')[0]}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{t.name}</div>
            <div style={{ fontSize: 12, color: D.muted }}>{t.email}</div>
          </div>
          <span style={{
            padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            background: t.role === 'admin' ? D.teal + '22' : D.border,
            color: t.role === 'admin' ? D.teal : D.muted,
            textTransform: 'capitalize',
          }}>{t.role}</span>
        </div>
      ))}
    </div>
  );
}
