import { useState, useEffect, useCallback } from 'react';
import SEOIntelligenceBar from '../../components/admin/SEOIntelligenceBar';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#FFFFFF', input: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'opacity .15s' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });
const sInput = { width: '100%', padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

const TYPE_COLORS = { pest_control: D.teal, exterminator: D.red, lawn_care: D.green };
const TYPE_ICONS = { pest_control: '🐛', exterminator: '🔫', lawn_care: '🌿' };
const CONTENT_COLORS = { built: D.green, partial: D.amber, clone_needs_rebuild: D.red, needs_content: D.amber, unknown: D.muted };
const CONTENT_LABELS = { built: 'Built', partial: 'Partial', clone_needs_rebuild: 'Needs Rebuild', needs_content: 'Needs Content', unknown: 'Unknown' };


const TABS = [
  { id: 'fleet', label: 'Fleet Overview' },
  { id: 'sites', label: 'All Sites' },
  { id: 'specs', label: 'Specs & Protocols' },
];

export default function WordPressSitesPage() {
  const [sites, setSites] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('fleet');
  const [editingId, setEditingId] = useState(null);
  const [creds, setCreds] = useState({ wp_username: '', wp_app_password: '' });
  const [testing, setTesting] = useState(null);
  const [scanning, setScanning] = useState(null);
  const [toast, setToast] = useState('');
  const [migrationPending, setMigrationPending] = useState(false);

  const loadSites = useCallback(() => {
    Promise.all([
      adminFetch('/admin/wordpress/sites'),
      adminFetch('/admin/wordpress/fleet-stats').catch(() => null),
    ]).then(([sitesData, statsData]) => {
      setSites(sitesData.sites || []);
      setMigrationPending(sitesData.migrationPending || false);
      if (statsData) setStats(statsData);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(loadSites, [loadSites]);
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
      showToast(r.connected ? `Connected as ${r.user?.name || r.user}` : `Failed: ${r.error}`);
      loadSites();
    } catch (e) { showToast(`Test failed: ${e.message}`); }
    setTesting(null);
  };

  const quickScan = async (siteId) => {
    setScanning(siteId);
    try {
      const r = await adminFetch(`/admin/wordpress/sites/${siteId}/quick-scan`, { method: 'POST' });
      showToast(`${r.totalPages} pages, ${r.totalPosts} posts, WP ${r.wpVersion || '?'}, schema: ${r.schemaFound ? 'yes' : 'no'}`);
      loadSites();
    } catch (e) { showToast(`Scan failed: ${e.message}`); }
    setScanning(null);
  };

  const quickScanAll = async () => {
    showToast('Scanning all connected sites — results in ~30s...');
    try {
      await adminFetch('/admin/wordpress/quick-scan-all', { method: 'POST' });
      setTimeout(loadSites, 25000);
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  const connected = sites.filter(s => s.wp_username || s.has_credentials).length;

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading WordPress fleet...</div>;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: D.heading }}>WordPress Fleet</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>15-domain network management</div>
        </div>
        <button onClick={quickScanAll} style={{ ...sBtn('transparent', D.teal), border: `1px solid ${D.teal}33`, padding: '10px 20px' }}>
          🔍 Scan All Sites
        </button>
      </div>

      {/* Intelligence Bar */}
      <SEOIntelligenceBar context="wordpress" />

      {migrationPending && (
        <div style={{ ...sCard, borderColor: D.amber, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20 }}>⚠️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.amber }}>Database migration pending</div>
            <div style={{ fontSize: 12, color: D.muted }}>Fleet monitoring columns need to be added. Redeploy on Railway or run migrations.</div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, borderBottom: `1px solid ${D.border}` }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: tab === t.id ? D.card : 'transparent',
            color: tab === t.id ? D.teal : D.muted,
            border: 'none', borderBottom: tab === t.id ? `2px solid ${D.teal}` : '2px solid transparent',
            borderRadius: '8px 8px 0 0', transition: 'all .15s',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* FLEET OVERVIEW TAB                                                */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'fleet' && (
        <div>
          {/* Stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Total Sites', value: sites.length, color: D.heading },
              { label: 'Connected', value: connected, color: D.green },
              { label: 'Built', value: sites.filter(s => s.content_status === 'built').length, color: D.green },
              { label: 'Need Rebuild', value: sites.filter(s => s.content_status === 'clone_needs_rebuild').length, color: D.red },
              { label: 'Schema Live', value: sites.filter(s => s.schema_deployed).length, color: D.teal },
              { label: 'llms.txt Live', value: sites.filter(s => s.llms_txt_deployed).length, color: D.purple },
              { label: 'Total Pages', value: sites.reduce((s, x) => s + (x.total_pages || 0), 0), color: D.heading },
              { label: 'Blog Posts', value: sites.reduce((s, x) => s + (x.blog_post_count || 0), 0), color: D.amber },
            ].map(s => (
              <div key={s.label} style={{ ...sCard, marginBottom: 0, textAlign: 'center', padding: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Verticals breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
            {['pest_control', 'exterminator', 'lawn_care'].map(v => {
              const vSites = sites.filter(s => s.site_type === v);
              const hub = vSites.find(s => s.hub_type === 'hub');
              const spokes = vSites.filter(s => s.hub_type !== 'hub');
              return (
                <div key={v} style={{ ...sCard, marginBottom: 0, borderLeft: `3px solid ${TYPE_COLORS[v]}` }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 10 }}>
                    {TYPE_ICONS[v]} {v === 'pest_control' ? 'Pest Control' : v === 'exterminator' ? 'Exterminators' : 'Lawn Care'}
                    <span style={{ fontSize: 11, color: D.muted, fontWeight: 400, marginLeft: 8 }}>{vSites.length} sites</span>
                  </div>
                  {hub && (
                    <div style={{ marginBottom: 10, padding: '6px 10px', background: `${D.purple}11`, borderRadius: 6, border: `1px solid ${D.purple}33` }}>
                      <span style={{ ...sBadge(`${D.purple}22`, D.purple), marginRight: 6 }}>HUB</span>
                      <span style={{ fontSize: 12, color: D.text }}>{hub.domain}</span>
                      <div style={{ fontSize: 10, color: D.muted, marginTop: 2 }}>
                        {hub.total_pages || '?'} pages · {hub.blog_post_count || '?'} posts
                        {hub.schema_deployed && ' · ✅ schema'}
                      </div>
                    </div>
                  )}
                  {spokes.map(s => (
                    <div key={s.id} style={{ fontSize: 12, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: CONTENT_COLORS[s.content_status] || D.muted, flexShrink: 0 }} />
                      <span style={{ color: D.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.domain}</span>
                      <span style={{ fontSize: 10, color: D.muted, flexShrink: 0, fontFamily: MONO }}>
                        {s.total_pages || '—'}p {s.blog_post_count || '—'}b
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* Build progress table */}
          <div style={{ ...sCard, overflow: 'auto' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 14 }}>Build Progress</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                  {['Domain', 'Type', 'City', 'Content', 'Pages', 'Blog', 'Schema', 'llms.txt', 'WP'].map(h => (
                    <th key={h} style={{ padding: '8px 6px', textAlign: h === 'Domain' ? 'left' : 'center', color: D.muted, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sites.map(s => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${D.border}22` }}>
                    <td style={{ padding: '7px 6px' }}>
                      <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" style={{ color: D.text, textDecoration: 'none', fontSize: 12 }}>{s.domain}</a>
                    </td>
                    <td style={{ padding: '7px 6px', textAlign: 'center' }}>
                      <span style={{ fontSize: 14 }}>{TYPE_ICONS[s.site_type]}</span>
                    </td>
                    <td style={{ padding: '7px 6px', textAlign: 'center', color: D.muted, fontSize: 11 }}>{s.target_city || s.area}</td>
                    <td style={{ padding: '7px 6px', textAlign: 'center' }}>
                      <span style={sBadge(`${CONTENT_COLORS[s.content_status] || D.muted}22`, CONTENT_COLORS[s.content_status] || D.muted)}>
                        {CONTENT_LABELS[s.content_status] || '?'}
                      </span>
                    </td>
                    <td style={{ padding: '7px 6px', textAlign: 'center', fontFamily: MONO, color: s.total_pages ? D.text : D.muted }}>{s.total_pages || '—'}</td>
                    <td style={{ padding: '7px 6px', textAlign: 'center', fontFamily: MONO, color: s.blog_post_count ? D.text : D.muted }}>{s.blog_post_count || '—'}</td>
                    <td style={{ padding: '7px 6px', textAlign: 'center', fontSize: 13 }}>{s.schema_deployed ? '✅' : '❌'}</td>
                    <td style={{ padding: '7px 6px', textAlign: 'center', fontSize: 13 }}>{s.llms_txt_deployed ? '✅' : '❌'}</td>
                    <td style={{ padding: '7px 6px', textAlign: 'center', fontFamily: MONO, color: D.muted, fontSize: 10 }}>{s.wordpress_version || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ALL SITES TAB                                                     */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'sites' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
          {sites.map(site => (
            <div key={site.id} style={{ ...sCard, marginBottom: 0, borderLeft: `3px solid ${TYPE_COLORS[site.site_type] || D.muted}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
                    {TYPE_ICONS[site.site_type] || '🌐'} {site.name}
                    {site.hub_type === 'hub' && <span style={{ ...sBadge(`${D.purple}22`, D.purple), marginLeft: 6, verticalAlign: 'middle' }}>HUB</span>}
                  </div>
                  <a href={`https://${site.domain}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: D.teal, textDecoration: 'none' }}>{site.domain}</a>
                </div>
                <span style={sBadge(`${CONTENT_COLORS[site.content_status] || D.muted}22`, CONTENT_COLORS[site.content_status] || D.muted)}>
                  {CONTENT_LABELS[site.content_status] || 'Unknown'}
                </span>
              </div>

              <div style={{ fontSize: 11, color: D.muted, marginBottom: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>📍 {site.target_city || site.area}</span>
                {site.total_pages > 0 && <span>📄 {site.total_pages} pages</span>}
                {site.blog_post_count > 0 && <span>📝 {site.blog_post_count} posts</span>}
                {site.wordpress_version && <span>WP {site.wordpress_version}</span>}
              </div>

              {/* Deployment checklist */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 11 }}>
                <span style={{ color: site.schema_deployed ? D.green : D.muted }}>{site.schema_deployed ? '✅' : '⬜'} Schema</span>
                <span style={{ color: site.llms_txt_deployed ? D.green : D.muted }}>{site.llms_txt_deployed ? '✅' : '⬜'} llms.txt</span>
                <span style={{ color: site.ga4_active ? D.green : D.muted }}>{site.ga4_active ? '✅' : '⬜'} GA4</span>
                <span style={{ color: site.search_console_verified ? D.green : D.muted }}>{site.search_console_verified ? '✅' : '⬜'} GSC</span>
              </div>

              {/* Connection */}
              {(site.wp_username || site.has_credentials) ? (
                <div style={{ fontSize: 11, color: D.green, marginBottom: 6 }}>● Connected as {site.wp_username}</div>
              ) : (
                <div style={{ fontSize: 11, color: D.amber, marginBottom: 6 }}>○ Not connected</div>
              )}

              {/* Credential editing */}
              {editingId === site.id && (
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
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(site.wp_username || site.has_credentials) && editingId !== site.id && (
                  <>
                    <button onClick={() => testConnection(site.id)} disabled={testing === site.id} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}`, padding: '4px 10px', fontSize: 11, opacity: testing === site.id ? 0.5 : 1 }}>
                      {testing === site.id ? '...' : 'Test'}
                    </button>
                    <button onClick={() => quickScan(site.id)} disabled={scanning === site.id} style={{ ...sBtn('transparent', D.teal), border: `1px solid ${D.teal}33`, padding: '4px 10px', fontSize: 11, opacity: scanning === site.id ? 0.5 : 1 }}>
                      {scanning === site.id ? '...' : 'Quick Scan'}
                    </button>
                  </>
                )}
                <button onClick={() => { setEditingId(editingId === site.id ? null : site.id); setCreds({ wp_username: site.wp_username || '', wp_app_password: '' }); }} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}`, padding: '4px 10px', fontSize: 11 }}>
                  {editingId === site.id ? 'Cancel' : (site.wp_username || site.has_credentials) ? 'Creds' : 'Connect'}
                </button>
              </div>

              {site.last_error && <div style={{ fontSize: 10, color: D.red, marginTop: 6, lineHeight: 1.3 }}>{String(site.last_error).substring(0, 120)}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* SPECS & PROTOCOLS TAB                                             */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'specs' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { name: '15-Site Network Spec', file: '15-site-network-spec', desc: 'Complete architecture — every site, every page, every backlink, implementation timeline', icon: '🌐' },
              { name: 'Lawn Care Spoke Rebuild', file: 'lawn-care-spoke-rebuild', desc: 'Full rebuild spec for 4 lawn care sites — page structures, content frameworks, service sub-pages', icon: '🌱' },
              { name: 'Fleet Protocol', file: 'fleet-protocol', desc: 'WordPress fleet management — site registry, GA4, monitoring, hub & spoke architecture', icon: '🚀' },
              { name: 'Claude Code Protocol', file: 'claude-code-protocol', desc: 'WordPress + Claude Code — MCP adapter, plugin audit, SEO automation, content pipeline', icon: '🤖' },
            ].map(spec => (
              <a key={spec.file} href={`${API_BASE}/admin/wordpress/specs/${spec.file}`} target="_blank" rel="noopener noreferrer" style={{
                background: D.bg, borderRadius: 10, padding: 16, border: `1px solid ${D.border}`,
                textDecoration: 'none', display: 'block', transition: 'border-color 0.2s',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 20 }}>{spec.icon}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: D.teal }}>{spec.name}</span>
                </div>
                <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.5 }}>{spec.desc}</div>
              </a>
            ))}
          </div>

          {/* Implementation checklist */}
          <div style={sCard}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 14 }}>Implementation Checklist</div>
            {[
              { phase: 'Phase 1: Quick Wins (Weeks 1–2)', color: D.teal, items: [
                'Deploy LocalBusiness schema to all 11 built sites',
                'Deploy FAQ schema to all /faqs/ pages',
                'Deploy llms.txt to all 11 built sites',
                'Verify robots.txt allows AI crawlers on all 15 domains',
                'Write & publish 45 blog posts with hub backlinks (5 per built spoke)',
              ]},
              { phase: 'Phase 2: waveslawncare.com Hub Expansion (Weeks 3–4)', color: D.green, items: [
                'Update nav to point to own service/area pages',
                'Build 7 service sub-pages (fertilization → tree & shrub)',
                'Build 7 city service area pages',
                'Build 12 lawn library pages',
                'Build FAQ, About, Contact, Inspection, Newsletter, Reviews, Careers pages',
                'Write 10 launch blog posts',
                'Deploy LandscapingBusiness schema + llms.txt',
              ]},
              { phase: 'Phase 3: Lawn Care Spoke Rebuilds (Weeks 5–8)', color: D.red, items: [
                'Rebuild bradentonfllawncare.com — full 40-page site (template)',
                'Rebuild sarasotafllawncare.com — clone templates, Sarasota content',
                'Rebuild venicelawncare.com — clone templates, Venice content',
                'Rebuild parrishfllawncare.com — clone templates, Parrish content',
                'Write 5 launch blog posts per site with hub backlinks',
              ]},
              { phase: 'Phase 4: Cross-Validation (Week 9)', color: D.purple, items: [
                'Run uniqueness check across all matching pages (<25% similarity)',
                'Add cross-links between same-city spokes (pest ↔ ext ↔ lawn)',
                'Verify all schema with Google Rich Results Test',
                'Request indexing for all new pages via Search Console',
              ]},
              { phase: 'Phase 5: Ongoing (Week 10+)', color: D.amber, items: [
                'Publish 2–3 blog posts per spoke per month (26–39 posts/month)',
                'Update AggregateRating in schema quarterly',
                'Quarterly content freshness pass on all spoke homepages',
                'Monthly AI visibility check (ChatGPT/Perplexity/Claude)',
                'Rotate application passwords every 90 days',
              ]},
            ].map(phase => (
              <div key={phase.phase} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: phase.color, marginBottom: 8 }}>{phase.phase}</div>
                {phase.items.map((item, i) => (
                  <div key={i} style={{ fontSize: 12, color: D.muted, marginBottom: 4, paddingLeft: 20, position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 0, top: 1 }}>☐</span> {item}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Network page target */}
          <div style={{ ...sCard, marginTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 8 }}>Network Target: ~595 Pages</div>
            <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.6 }}>
              Current: ~343 pages across 15 domains. After full build-out: ~595 pages including
              waveslawncare.com hub expansion (~37 new pages), 4 lawn care spoke rebuilds (~135 new pages),
              and 75 launch blog posts with hub backlinks across all built spokes.
              Ongoing: 26–39 new blog posts per month network-wide.
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`,
        borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12,
        transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0,
        transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}
