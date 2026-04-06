import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600 });
const sInput = { width: '100%', padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

const TYPE_COLORS = { pest_control: D.teal, exterminator: D.red, lawn_care: D.green };
const TYPE_ICONS = { pest_control: '🐛', exterminator: '🔫', lawn_care: '🌿' };
const WH_COLORS = { portal: D.green, zapier: D.amber, mixed: D.purple, unknown: D.muted };

const ZAPIER_URL = 'https://hooks.zapier.com/hooks/catch/18868815/24az9vq/';
const PORTAL_URL = 'https://waves-customer-portal-production.up.railway.app/api/webhooks/lead';

export default function WordPressSitesPage() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [creds, setCreds] = useState({ wp_username: '', wp_app_password: '' });
  const [testing, setTesting] = useState(null);
  const [scanning, setScanning] = useState(null);
  const [swapping, setSwapping] = useState(false);
  const [toast, setToast] = useState('');

  const [migrationPending, setMigrationPending] = useState(false);

  const loadSites = () => {
    adminFetch('/admin/wordpress/sites').then(d => {
      setSites(d.sites || []);
      setMigrationPending(d.migrationPending || false);
      setLoading(false);
    }).catch(() => setLoading(false));
  };
  useEffect(loadSites, []);
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 4000); };

  const saveCreds = async (siteId) => {
    try {
      await adminFetch(`/admin/wordpress/sites/${siteId}/credentials`, { method: 'POST', body: JSON.stringify(creds) });
      showToast('Credentials saved');
      setEditingId(null);
      loadSites();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  const testConnection = async (siteId) => {
    setTesting(siteId);
    try {
      const r = await adminFetch(`/admin/wordpress/sites/${siteId}/test`, { method: 'POST' });
      showToast(r.connected ? `Connected as ${r.user}` : `Failed: ${r.error}`);
      loadSites();
    } catch (e) { showToast(`Test failed: ${e.message}`); }
    setTesting(null);
  };

  const scanSite = async (siteId) => {
    setScanning(siteId);
    try {
      const r = await adminFetch(`/admin/wordpress/sites/${siteId}/scan`, { method: 'POST' });
      showToast(`Scan: ${r.formsFound || 0} forms found, ${r.zapierForms || 0} still on Zapier`);
      loadSites();
    } catch (e) { showToast(`Scan failed: ${e.message}`); }
    setScanning(null);
  };

  const swapSite = async (siteId) => {
    try {
      const r = await adminFetch(`/admin/wordpress/sites/${siteId}/swap`, { method: 'POST', body: JSON.stringify({ oldUrl: ZAPIER_URL, newUrl: PORTAL_URL }) });
      showToast(`Swapped: ${r.formsUpdated || 0} forms updated`);
      loadSites();
    } catch (e) { showToast(`Swap failed: ${e.message}`); }
  };

  const swapAll = async () => {
    if (!confirm(`Swap ALL Zapier webhooks to the portal URL across ${sites.filter(s => s.wp_username).length} connected sites?`)) return;
    setSwapping(true);
    try {
      const r = await adminFetch('/admin/wordpress/swap-all', { method: 'POST', body: JSON.stringify({ oldUrl: ZAPIER_URL, newUrl: PORTAL_URL }) });
      const results = r.results || [];
      const success = results.filter(r => r.formsUpdated > 0).length;
      const total = results.reduce((s, r) => s + (r.formsUpdated || 0), 0);
      showToast(`Done! ${total} forms updated across ${success} sites`);
      loadSites();
    } catch (e) { showToast(`Swap failed: ${e.message}`); }
    setSwapping(false);
  };

  const connected = sites.filter(s => s.wp_username).length;
  const onZapier = sites.filter(s => s.webhook_status === 'zapier' || s.webhook_status === 'mixed').length;
  const onPortal = sites.filter(s => s.webhook_status === 'portal').length;

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading WordPress sites...</div>;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: D.white }}>WordPress Sites</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>Manage webhook URLs across all 15 domains</div>
        </div>
        <button onClick={swapAll} disabled={swapping || connected === 0} style={{ ...sBtn(D.green, D.white), padding: '12px 24px', fontSize: 15, opacity: swapping || connected === 0 ? 0.5 : 1 }}>
          {swapping ? 'Swapping All...' : `🔄 Swap All to Portal (${connected} sites)`}
        </button>
      </div>

      {/* Migration pending banner */}
      {migrationPending && (
        <div style={{ ...sCard, borderColor: D.amber, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20 }}>⚠️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.amber }}>Database migration pending</div>
            <div style={{ fontSize: 12, color: D.muted }}>The wordpress_sites table hasn't been created yet. Sites are shown from a static list. Credential saving requires the migration to run — try redeploying on Railway or running migrations manually.</div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Sites', value: sites.length, color: D.white },
          { label: 'Connected', value: connected, color: D.green },
          { label: 'On Zapier', value: onZapier, color: D.amber },
          { label: 'On Portal', value: onPortal, color: D.green },
          { label: 'Need Credentials', value: sites.length - connected, color: sites.length - connected > 0 ? D.red : D.muted },
        ].map(s => (
          <div key={s.label} style={{ ...sCard, flex: '1 1 120px', minWidth: 120, marginBottom: 0, textAlign: 'center' }}>
            <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Sites Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 12 }}>
        {sites.map(site => (
          <div key={site.id} style={{ ...sCard, marginBottom: 0, borderLeft: `3px solid ${TYPE_COLORS[site.site_type] || D.muted}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{TYPE_ICONS[site.site_type] || '🌐'} {site.name}</div>
                <a href={`https://${site.domain}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: D.teal, textDecoration: 'none' }}>{site.domain}</a>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <span style={sBadge(`${TYPE_COLORS[site.site_type]}22`, TYPE_COLORS[site.site_type])}>{site.site_type?.replace('_', ' ')}</span>
                <span style={sBadge(`${WH_COLORS[site.webhook_status]}22`, WH_COLORS[site.webhook_status])}>{site.webhook_status || 'unknown'}</span>
              </div>
            </div>

            <div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>Area: {site.area} · Forms: {site.forms_count || '?'}</div>

            {/* Connection status */}
            {site.wp_username ? (
              <div style={{ fontSize: 11, color: D.green, marginBottom: 8 }}>● Connected as {site.wp_username}</div>
            ) : (
              <div style={{ fontSize: 11, color: D.amber, marginBottom: 8 }}>○ Not connected — add credentials</div>
            )}

            {/* Credential editing */}
            {editingId === site.id ? (
              <div style={{ padding: 12, background: D.input, borderRadius: 8, marginBottom: 8 }}>
                <div style={{ marginBottom: 6 }}>
                  <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>WP Username</label>
                  <input value={creds.wp_username} onChange={e => setCreds(p => ({ ...p, wp_username: e.target.value }))} placeholder="admin" style={sInput} />
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Application Password</label>
                  <input value={creds.wp_app_password} onChange={e => setCreds(p => ({ ...p, wp_app_password: e.target.value }))} placeholder="xxxx xxxx xxxx xxxx" type="password" style={sInput} />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => saveCreds(site.id)} style={sBtn(D.teal, D.white)}>Save</button>
                  <button onClick={() => setEditingId(null)} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}` }}>Cancel</button>
                </div>
              </div>
            ) : null}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!site.wp_username || editingId === site.id ? null : (
                <>
                  <button onClick={() => testConnection(site.id)} disabled={testing === site.id} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}`, padding: '4px 10px', fontSize: 11, opacity: testing === site.id ? 0.5 : 1 }}>
                    {testing === site.id ? 'Testing...' : 'Test'}
                  </button>
                  <button onClick={() => scanSite(site.id)} disabled={scanning === site.id} style={{ ...sBtn('transparent', D.teal), border: `1px solid ${D.teal}33`, padding: '4px 10px', fontSize: 11, opacity: scanning === site.id ? 0.5 : 1 }}>
                    {scanning === site.id ? 'Scanning...' : 'Scan Forms'}
                  </button>
                  {(site.webhook_status === 'zapier' || site.webhook_status === 'mixed') && (
                    <button onClick={() => swapSite(site.id)} style={{ ...sBtn(D.green, D.white), padding: '4px 10px', fontSize: 11 }}>Swap to Portal</button>
                  )}
                </>
              )}
              <button onClick={() => { setEditingId(editingId === site.id ? null : site.id); setCreds({ wp_username: site.wp_username || '', wp_app_password: '' }); }} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}`, padding: '4px 10px', fontSize: 11 }}>
                {editingId === site.id ? 'Cancel' : site.wp_username ? 'Update Creds' : 'Add Credentials'}
              </button>
            </div>

            {site.last_error && <div style={{ fontSize: 10, color: D.red, marginTop: 6 }}>{site.last_error}</div>}
          </div>
        ))}
      </div>

      {/* Webhook URLs reference */}
      <div style={{ ...sCard, marginTop: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 8 }}>Webhook URLs</div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>
          <span style={{ color: D.amber }}>Old (Zapier):</span>
          <code style={{ fontFamily: MONO, fontSize: 11, color: D.muted, marginLeft: 8, background: D.input, padding: '2px 6px', borderRadius: 4 }}>{ZAPIER_URL}</code>
        </div>
        <div style={{ fontSize: 12 }}>
          <span style={{ color: D.green }}>New (Portal):</span>
          <code style={{ fontFamily: MONO, fontSize: 11, color: D.green, marginLeft: 8, background: D.input, padding: '2px 6px', borderRadius: 4 }}>{PORTAL_URL}</code>
        </div>
      </div>

      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}
