import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
const ContentCalendar = lazy(() => import('./ContentCalendar'));

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', blue: '#2563eb', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });
const sInput = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

const PLATFORM_ICONS = { facebook: '📘', instagram: '📷', linkedin: '💼', gbp: '📍' };
const PLATFORM_COLORS = { facebook: D.blue, instagram: D.purple, linkedin: D.blue, gbp: D.green };

export default function SocialMediaPage() {
  const [tab, setTab] = useState('compose');
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [rssItems, setRssItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [toast, setToast] = useState('');

  const loadData = useCallback(async () => {
    const [s, st, h] = await Promise.all([
      adminFetch('/admin/social-media/status').catch(() => null),
      adminFetch('/admin/social-media/stats').catch(() => null),
      adminFetch('/admin/social-media/history?limit=20').catch(() => ({ posts: [] })),
    ]);
    setStatus(s);
    setStats(st);
    setHistory(h.posts || []);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: D.white }}>Social Media Engine</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>Auto-post blog content to Facebook, Instagram, LinkedIn & GBP</div>
        </div>
      </div>

      {/* Platform Status */}
      {status && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {Object.entries(status.platforms).map(([key, p]) => (
            <div key={key} style={{ ...sCard, flex: '1 1 140px', minWidth: 140, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>{PLATFORM_ICONS[key] || '⚙️'}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: D.white, textTransform: 'capitalize' }}>{key}</div>
              <div style={{ marginTop: 4 }}>
                {p.configured
                  ? <span style={sBadge(`${D.green}22`, D.green)}>Connected</span>
                  : <span style={sBadge(`${D.muted}22`, D.muted)}>Not configured</span>
                }
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Total Posts', value: stats.total, color: D.white },
            { label: 'Published', value: stats.published, color: D.green },
            { label: 'Failed', value: stats.failed, color: D.red },
            { label: 'Last 7d', value: stats.last7d, color: D.teal },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, flex: '1 1 120px', minWidth: 120, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, flexWrap: 'wrap' }}>
        {[
          { key: 'compose', label: 'Compose & Publish' },
          { key: 'rss', label: 'RSS Feed' },
          { key: 'calendar', label: 'Calendar' },
          { key: 'analytics', label: 'Analytics' },
          { key: 'templates', label: 'Templates' },
          { key: 'history', label: 'Post History' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'compose' && <ComposeTab showToast={showToast} onPublished={loadData} />}
      {tab === 'rss' && <RSSTab showToast={showToast} onPublished={loadData} />}
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'analytics' && <AnalyticsTab />}
      {tab === 'templates' && <TemplatesTab showToast={showToast} />}
      {tab === 'history' && <HistoryTab history={history} onRefresh={loadData} />}

      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ── Compose Tab ──
function ComposeTab({ showToast, onPublished }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [customContent, setCustomContent] = useState({});

  const handlePreview = async () => {
    if (!title.trim()) { showToast('Enter a title'); return; }
    setGenerating(true);
    try {
      const data = await adminFetch('/admin/social-media/preview', {
        method: 'POST', body: JSON.stringify({ title, description, link }),
      });
      setPreview(data);
      setCustomContent(data);
    } catch (e) { showToast(`Preview failed: ${e.message}`); }
    setGenerating(false);
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const result = await adminFetch('/admin/social-media/publish', {
        method: 'POST', body: JSON.stringify({ title, description, link, customContent }),
      });
      const successes = result.platforms?.filter(p => p.success).length || 0;
      const skipped = result.platforms?.filter(p => p.skipped).length || 0;
      const failed = result.platforms?.filter(p => p.error).length || 0;
      showToast(`Published: ${successes} success, ${skipped} skipped, ${failed} failed`);
      onPublished();
    } catch (e) { showToast(`Publish failed: ${e.message}`); }
    setPublishing(false);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Left — Input */}
      <div>
        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Content Source</div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Blog post title or topic..." style={sInput} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Brief description or excerpt..." style={{ ...sInput, resize: 'vertical' }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Link URL</label>
            <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://www.wavespestcontrol.com/blog/..." style={sInput} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handlePreview} disabled={generating} style={{ ...sBtn(D.teal, D.white), flex: 1, opacity: generating ? 0.5 : 1 }}>
              {generating ? 'Generating AI Content...' : 'Generate AI Preview'}
            </button>
            <button onClick={handlePublish} disabled={publishing || !preview} style={{ ...sBtn(D.green, D.white), flex: 1, opacity: publishing || !preview ? 0.5 : 1 }}>
              {publishing ? 'Publishing...' : 'Publish All'}
            </button>
          </div>
        </div>
      </div>

      {/* Right — Preview */}
      <div>
        {!preview ? (
          <div style={{ ...sCard, textAlign: 'center', padding: 60, color: D.muted }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✨</div>
            <div style={{ fontSize: 15 }}>Enter content and click Generate AI Preview</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>AI will create platform-optimized versions for each channel</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {['facebook', 'instagram', 'linkedin', 'gbp'].map(platform => (
              <div key={platform} style={{ ...sCard, marginBottom: 0, borderLeft: `3px solid ${PLATFORM_COLORS[platform]}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 18 }}>{PLATFORM_ICONS[platform]}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: D.white, textTransform: 'capitalize' }}>{platform === 'gbp' ? 'Google Business (all 4 locations)' : platform}</span>
                </div>
                <textarea
                  value={customContent[platform] || ''}
                  onChange={e => setCustomContent(prev => ({ ...prev, [platform]: e.target.value }))}
                  rows={3}
                  style={{ ...sInput, resize: 'vertical', fontSize: 12 }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── RSS Feed Tab ──
function RSSTab({ showToast, onPublished }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    adminFetch('/admin/social-media/rss')
      .then(d => { setItems(d.items || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleAutoPublish = async () => {
    setChecking(true);
    try {
      const result = await adminFetch('/admin/social-media/check-rss', { method: 'POST' });
      showToast(`RSS check done: ${result.processed} new post(s) published`);
      onPublished();
      // Refresh
      const d = await adminFetch('/admin/social-media/rss');
      setItems(d.items || []);
    } catch (e) { showToast(`RSS check failed: ${e.message}`); }
    setChecking(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading RSS feed...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>Blog RSS Feed</div>
          <div style={{ fontSize: 12, color: D.muted }}>wavespestcontrol.com/feed/ — checked every 4 hours automatically</div>
        </div>
        <button onClick={handleAutoPublish} disabled={checking} style={{ ...sBtn(D.teal, D.white), opacity: checking ? 0.5 : 1 }}>
          {checking ? 'Checking...' : 'Check & Auto-Publish New'}
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((item, i) => (
          <div key={i} style={{ ...sCard, marginBottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>{item.title}</div>
              <div style={{ fontSize: 12, color: D.muted, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.description?.substring(0, 150)}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <a href={item.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, textDecoration: 'none' }}>View post ↗</a>
                {item.pubDate && <span style={{ fontSize: 11, color: D.muted }}>{new Date(item.pubDate).toLocaleDateString()}</span>}
              </div>
            </div>
            {item.posted
              ? <span style={sBadge(`${D.green}22`, D.green)}>Published</span>
              : <span style={sBadge(`${D.amber}22`, D.amber)}>Not posted</span>
            }
          </div>
        ))}
        {items.length === 0 && <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No RSS items found</div>}
      </div>
    </div>
  );
}

// ── History Tab ──
function HistoryTab({ history, onRefresh }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>Post History</div>
        <button onClick={onRefresh} style={sBtn(D.teal, D.white)}>Refresh</button>
      </div>
      {history.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No posts yet</div>
      ) : history.map(post => {
        const platforms = typeof post.platforms_posted === 'string' ? JSON.parse(post.platforms_posted) : (post.platforms_posted || []);
        return (
          <div key={post.id} style={{ ...sCard, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{post.title}</div>
                {post.source_url && <a href={post.source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, textDecoration: 'none' }}>{post.source_url}</a>}
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={sBadge(post.status === 'published' ? `${D.green}22` : `${D.red}22`, post.status === 'published' ? D.green : D.red)}>{post.status}</span>
                <span style={{ fontSize: 11, color: D.muted }}>{new Date(post.created_at).toLocaleString()}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {platforms.map((p, i) => (
                <span key={i} style={sBadge(
                  p.success ? `${PLATFORM_COLORS[p.platform] || D.green}22` : p.skipped ? `${D.muted}22` : `${D.red}22`,
                  p.success ? PLATFORM_COLORS[p.platform] || D.green : p.skipped ? D.muted : D.red
                )}>
                  {PLATFORM_ICONS[p.platform] || '📌'} {p.platform}{p.location ? ` (${p.location})` : ''}: {p.success ? '✓' : p.skipped || p.error || '✗'}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Calendar Tab ──
function CalendarTab() {
  return <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading calendar...</div>}><ContentCalendar /></Suspense>;
}

// ── Analytics Tab ──
function AnalyticsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/social-media/analytics').then(setData).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading analytics...</div>;
  if (!data) return <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No analytics data yet</div>;

  const { byPlatform = {}, weeklyTrend = [], summary = {} } = data;

  return (
    <div>
      {/* Summary */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Posts', value: summary.totalPosts || 0, color: D.white },
          { label: 'Published', value: summary.published || 0, color: D.green },
          { label: 'Success Rate', value: `${summary.successRate || 0}%`, color: summary.successRate >= 80 ? D.green : D.amber },
          { label: 'Posts/Week', value: summary.postsPerWeek || 0, color: D.teal },
          { label: 'Most Active', value: summary.mostActivePlatform || '—', color: D.purple },
        ].map(s => (
          <div key={s.label} style={{ ...sCard, flex: '1 1 120px', minWidth: 120, marginBottom: 0, textAlign: 'center' }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* By Platform */}
      <div style={{ ...sCard, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Performance by Platform</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {Object.entries(byPlatform).map(([platform, stats]) => (
            <div key={platform} style={{ padding: 14, background: D.input, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>{PLATFORM_ICONS[platform] || '📌'}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: D.white, textTransform: 'capitalize' }}>{platform}</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8, fontSize: 11 }}>
                <span style={{ color: D.green }}>{stats.success} ✓</span>
                <span style={{ color: D.red }}>{stats.failed} ✗</span>
                <span style={{ color: D.muted }}>{stats.total} total</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Weekly Trend */}
      {weeklyTrend.length > 0 && (
        <div style={{ ...sCard }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Weekly Posting Trend</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 100 }}>
            {weeklyTrend.map((w, i) => {
              const max = Math.max(...weeklyTrend.map(x => x.total), 1);
              const h = Math.max(4, (w.total / max) * 80);
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ fontSize: 9, color: D.muted }}>{w.total}</div>
                  <div style={{ width: '100%', height: h, background: w.published > 0 ? D.green : D.border, borderRadius: 3 }} />
                  <div style={{ fontSize: 8, color: D.muted, transform: 'rotate(-45deg)', transformOrigin: 'center', whiteSpace: 'nowrap' }}>{w.week?.substring(5)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Templates Tab ──
function TemplatesTab({ showToast }) {
  const TEMPLATES = [
    { id: 'seasonal_tip', name: 'Seasonal Pest Tip', icon: '🐛', platforms: ['facebook', 'instagram', 'gbp'],
      template: 'SW Florida pest alert: {topic}. Here\'s what homeowners need to know to protect their property this season. 🌊\n\n#wavespestcontrol #pestcontrol #swfl' },
    { id: 'review_highlight', name: 'Review Highlight', icon: '⭐', platforms: ['facebook', 'instagram'],
      template: '⭐⭐⭐⭐⭐ "{review_text}"\n\nThank you {customer_name} for trusting Waves! We love protecting SWFL homes. 🌊\n\n#5starreview #wavespestcontrol' },
    { id: 'before_after', name: 'Before & After', icon: '📸', platforms: ['facebook', 'instagram'],
      template: 'Transformation Tuesday! Check out these results from our {service} treatment in {city}. 🌊\n\nSwipe to see the before → after!\n\n#wavespestcontrol #transformation #{city_tag}' },
    { id: 'team_spotlight', name: 'Team Spotlight', icon: '👨‍🔧', platforms: ['facebook', 'linkedin'],
      template: 'Meet {tech_name}, one of our certified technicians! {tech_name} has been keeping SWFL homes pest-free for {years} years. 🌊\n\n#meettheteam #wavespestcontrol' },
    { id: 'local_tip', name: 'Local Area Tip', icon: '🏠', platforms: ['facebook', 'gbp'],
      template: '{city} homeowners: {tip}. Our techs serve {city} daily — call (941) 318-7612 for a free estimate! 🌊' },
    { id: 'blog_promo', name: 'Blog Promotion', icon: '📝', platforms: ['facebook', 'instagram', 'linkedin', 'gbp'],
      template: 'New on the blog: {blog_title} 🌊\n\nRead the full article: {link}\n\n#wavespestcontrol #pestcontrol #swfl' },
  ];

  const [selectedTemplate, setSelectedTemplate] = useState(null);

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Post Templates</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {TEMPLATES.map(t => (
          <div key={t.id} onClick={() => setSelectedTemplate(selectedTemplate === t.id ? null : t.id)} style={{
            ...sCard, marginBottom: 0, cursor: 'pointer',
            borderColor: selectedTemplate === t.id ? D.teal : D.border,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 20 }}>{t.icon}</span>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{t.name}</div>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              {t.platforms.map(p => <span key={p} style={sBadge(`${PLATFORM_COLORS[p] || D.muted}22`, PLATFORM_COLORS[p] || D.muted)}>{p}</span>)}
            </div>
            {selectedTemplate === t.id && (
              <div style={{ padding: 10, background: D.input, borderRadius: 8, fontSize: 12, color: D.muted, lineHeight: 1.6, whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {t.template}
                <div style={{ marginTop: 8 }}>
                  <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(t.template); showToast('Template copied!'); }} style={sBtn(D.teal, D.white)}>Copy Template</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
