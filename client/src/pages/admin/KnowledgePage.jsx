import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/purple/orange fold to zinc-900. Semantic green/amber/red preserved.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', orange: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', purple: '#18181B', heading: '#09090B', inputBorder: '#D4D4D8' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' } }).then(r => r.json());
}
function adminPost(path, body) {
  return fetch(`${API_BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}

function Card({ children, style }) {
  return <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, ...style }}>{children}</div>;
}

const CATEGORY_ICONS = {
  services: '🏢', products: '📦', protocols: '🧪', compliance: '⚖️', equipment: '🔧',
  pricing: '💰', customers: '👥', pests: '🐛', turf: '🌿', operations: '📋', competitive: '🏆', index: '📇',
};

// =========================================================================
// Q&A MODAL
// =========================================================================
function QAModal({ onClose }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleAsk = async () => {
    if (!question.trim()) return;
    setLoading(true);
    setResult(null);
    const r = await adminPost('/admin/knowledge/query', { question });
    setResult(r);
    setLoading(false);
  };

  const handleFileBack = async (queryId) => {
    await adminPost('/admin/knowledge/file-back', { queryId });
    setResult(prev => ({ ...prev, filedBack: true }));
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: D.card, borderRadius: 16, padding: 28, maxWidth: 600, width: '100%', maxHeight: '80vh', overflow: 'auto', border: `1px solid ${D.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>{'🔍'} Ask the Knowledge Base</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 20, cursor: 'pointer' }}>{'✕'}</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAsk()}
            placeholder="What's the max annual rate for Celsius WG?"
            style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: `1px solid ${D.border}`, background: D.bg, color: D.heading, fontSize: 14 }} />
          <button onClick={handleAsk} disabled={loading} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', background: D.teal, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.5 : 1,
          }}>{loading ? '...' : 'Ask'}</button>
        </div>

        {result && (
          <div>
            <div style={{ padding: 16, background: D.bg, borderRadius: 10, marginBottom: 12, fontSize: 14, color: D.text, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {result.answer}
            </div>

            {(result.articleTitles || result.articlesUsed || []).length > 0 && (
              <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
                Sources: {(result.articleTitles || []).map(a => a.title || a).join(', ') || (result.articlesUsed || []).join(', ')}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${D.green}`, background: 'transparent', color: D.green, fontSize: 12, cursor: 'pointer' }}>{'👍'} Good</button>
              <button style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${D.amber}`, background: 'transparent', color: D.amber, fontSize: 12, cursor: 'pointer' }}>{'👎'} Incomplete</button>
              {!result.filedBack && (
                <button onClick={() => handleFileBack(result.queryId)} style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${D.purple}`, background: 'transparent', color: D.purple, fontSize: 12, cursor: 'pointer' }}>{'📥'} File into wiki</button>
              )}
              {result.filedBack && <span style={{ fontSize: 12, color: D.green }}>{'✅'} Filed</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// ARTICLE VIEWER
// =========================================================================
function ArticleViewer({ articleId, onBack }) {
  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch(`/admin/knowledge/article/${articleId}`).then(d => { setArticle(d.article); setLoading(false); }).catch(() => setLoading(false));
  }, [articleId]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading article...</div>;
  if (!article) return <div style={{ color: D.red, padding: 40 }}>Article not found</div>;

  const tags = Array.isArray(article.tags) ? article.tags : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button onClick={onBack} style={{ alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 12, cursor: 'pointer' }}>{'←'} Back</button>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 24 }}>{CATEGORY_ICONS[article.category] || '📄'}</span>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: D.heading }}>{article.title}</div>
            <div style={{ fontSize: 12, color: D.muted }}>{article.path} • v{article.version} • {article.word_count} words</div>
          </div>
        </div>

        {article.summary && <div style={{ fontSize: 14, color: D.text, padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 12, lineHeight: 1.6, borderLeft: `3px solid ${D.teal}` }}>{article.summary}</div>}

        {tags.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {tags.map((t, i) => (
              <span key={i} style={{ padding: '2px 8px', borderRadius: 4, background: D.teal + '22', color: D.teal, fontSize: 11 }}>{t}</span>
            ))}
          </div>
        )}

        <div style={{ fontSize: 11, color: D.muted, display: 'flex', gap: 16, marginBottom: 16 }}>
          {article.last_compiled && <span>Compiled: {new Date(article.last_compiled).toLocaleDateString()}</span>}
          {article.last_verified && <span style={{ color: D.green }}>{'✅'} Verified: {new Date(article.last_verified).toLocaleDateString()}</span>}
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 14, color: D.text, lineHeight: 1.8, whiteSpace: 'pre-wrap', fontFamily: "'DM Sans', sans-serif" }}>
          {article.content}
        </div>
      </Card>
    </div>
  );
}

// =========================================================================
// HEALTH CHECK VIEW
// =========================================================================
function HealthCheck() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/knowledge/health').then(d => { setHealth(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Running health check...</div>;
  if (!health) return null;

  const scoreColor = health.healthScore >= 80 ? D.green : health.healthScore >= 60 ? D.amber : D.red;
  const severityColor = { high: D.red, medium: D.amber, low: D.muted };

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <div style={{ width: 64, height: 64, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 800, fontFamily: MONO, background: scoreColor + '22', color: scoreColor, border: `2px solid ${scoreColor}44` }}>
          {health.healthScore}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading }}>Wiki Health Score</div>
          <div style={{ fontSize: 13, color: D.muted }}>{health.totalArticles} articles • {health.issues.length} issues</div>
        </div>
      </div>

      {health.issues.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {health.issues.slice(0, 15).map((issue, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, fontSize: 12, borderLeft: `3px solid ${severityColor[issue.severity] || D.muted}` }}>
              <span style={{ color: D.heading, fontWeight: 600 }}>{issue.title || issue.article}</span>
              <span style={{ color: D.muted, marginLeft: 8 }}>— {issue.detail}</span>
            </div>
          ))}
          {health.issues.length > 15 && <div style={{ fontSize: 12, color: D.muted, padding: '4px 12px' }}>... and {health.issues.length - 15} more</div>}
        </div>
      )}

      {health.issues.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', color: D.green, fontSize: 14 }}>{'✅'} No issues found</div>
      )}
    </Card>
  );
}

// =========================================================================
// SOURCES VIEW
// =========================================================================
function SourcesView() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState(null);
  const [addForm, setAddForm] = useState({ filename: '', file_path: '', file_type: 'csv', description: '' });
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    adminFetch('/admin/knowledge/sources').then(d => { setSources(d.sources || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleCompile = async (sourceId) => {
    setCompiling(sourceId);
    await adminPost('/admin/knowledge/compile', { sourceId });
    setCompiling(null);
    // Reload
    const d = await adminFetch('/admin/knowledge/sources');
    setSources(d.sources || []);
  };

  const handleAdd = async () => {
    await adminPost('/admin/knowledge/sources', addForm);
    setShowAdd(false);
    setAddForm({ filename: '', file_path: '', file_type: 'csv', description: '' });
    const d = await adminFetch('/admin/knowledge/sources');
    setSources(d.sources || []);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading sources...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, color: D.muted }}>{sources.length} source documents</div>
        <button onClick={() => setShowAdd(true)} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.teal}`, background: 'transparent', color: D.teal, fontSize: 12, cursor: 'pointer' }}>+ Add Source</button>
      </div>

      {showAdd && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Add Source Document</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <input value={addForm.filename} onChange={e => setAddForm(p => ({ ...p, filename: e.target.value }))} placeholder="Filename" style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${D.border}`, background: D.bg, color: D.text, fontSize: 12 }} />
            <input value={addForm.file_path} onChange={e => setAddForm(p => ({ ...p, file_path: e.target.value }))} placeholder="Full file path" style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${D.border}`, background: D.bg, color: D.text, fontSize: 12 }} />
            <select value={addForm.file_type} onChange={e => setAddForm(p => ({ ...p, file_type: e.target.value }))} style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${D.border}`, background: D.bg, color: D.text, fontSize: 12 }}>
              <option value="csv">CSV</option><option value="xlsx">Excel</option><option value="md">Markdown</option><option value="txt">Text</option><option value="json">JSON</option><option value="js">JavaScript</option><option value="pdf">PDF</option>
            </select>
            <input value={addForm.description} onChange={e => setAddForm(p => ({ ...p, description: e.target.value }))} placeholder="Description" style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${D.border}`, background: D.bg, color: D.text, fontSize: 12 }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAdd} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: D.teal, color: '#fff', fontSize: 12, cursor: 'pointer' }}>Add</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
          </div>
        </Card>
      )}

      {sources.map(s => (
        <div key={s.id} style={{ padding: '12px 16px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{s.filename}</div>
            <div style={{ fontSize: 11, color: D.muted }}>{s.description || 'No description'} • {s.file_type}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {s.processed ? (
              <span style={{ fontSize: 11, color: D.green }}>{'✅'} Compiled</span>
            ) : (
              <button onClick={() => handleCompile(s.id)} disabled={compiling === s.id} style={{
                padding: '4px 10px', borderRadius: 4, border: 'none', background: D.teal, color: '#fff', fontSize: 11, cursor: 'pointer', opacity: compiling === s.id ? 0.5 : 1,
              }}>{compiling === s.id ? 'Compiling...' : 'Compile'}</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// MAIN PAGE
// =========================================================================
const TABS = [
  { key: 'articles', label: 'Articles', icon: '📚' },
  { key: 'sources', label: 'Sources', icon: '📂' },
  { key: 'health', label: 'Health', icon: '🩺' },
  { key: 'queries', label: 'Recent Queries', icon: '💬' },
];

export default function KnowledgePage() {
  const [tab, setTab] = useState('articles');
  const [articles, setArticles] = useState([]);
  const [categoryCounts, setCategoryCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [showQA, setShowQA] = useState(false);
  const [recentQueries, setRecentQueries] = useState([]);

  useEffect(() => {
    if (tab === 'articles') {
      setLoading(true);
      let url = '/admin/knowledge?';
      if (search) url += `search=${encodeURIComponent(search)}&`;
      if (filterCat) url += `category=${filterCat}&`;
      adminFetch(url).then(d => { setArticles(d.articles || []); setCategoryCounts(d.categoryCounts || {}); setLoading(false); }).catch(() => setLoading(false));
    }
    if (tab === 'queries') {
      adminFetch('/admin/knowledge/queries').then(d => setRecentQueries(d.queries || []));
    }
  }, [tab, search, filterCat]);

  if (selectedArticle) {
    return (
      <div>
        <div style={{ fontSize: 28, fontWeight: 700, color: D.heading, marginBottom: 24 }}>Knowledge Base</div>
        <ArticleViewer articleId={selectedArticle} onBack={() => setSelectedArticle(null)} />
      </div>
    );
  }

  const totalArticles = Object.values(categoryCounts).reduce((s, c) => s + c, 0);

  return (
    <div>
      {showQA && <QAModal onClose={() => setShowQA(false)} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: D.heading }}>Knowledge Base</div>
        </div>
        <button onClick={() => setShowQA(true)} style={{
          padding: '10px 20px', borderRadius: 8, border: 'none', background: D.teal, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
        }}>{'🔍'} Ask a Question</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
            transition: 'all 0.15s', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6,
          }}><span>{t.icon}</span> {t.label}</button>
        ))}
      </div>

      {/* ARTICLES TAB */}
      {tab === 'articles' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Category Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
              <div key={cat} onClick={() => setFilterCat(filterCat === cat ? '' : cat)} style={{
                padding: '12px 14px', background: filterCat === cat ? D.teal + '22' : D.card, border: `1px solid ${filterCat === cat ? D.teal : D.border}`,
                borderRadius: 10, cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s',
              }}>
                <div style={{ fontSize: 22, marginBottom: 4 }}>{CATEGORY_ICONS[cat] || '📄'}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, textTransform: 'capitalize' }}>{cat}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: D.teal, fontFamily: MONO }}>{count}</div>
              </div>
            ))}
          </div>

          {/* Search */}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search articles..." style={{
            padding: '10px 14px', borderRadius: 8, border: `1px solid ${D.border}`, background: D.bg, color: D.heading, fontSize: 14, width: '100%',
          }} />

          {/* Article List */}
          {loading ? (
            <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading articles...</div>
          ) : articles.length === 0 ? (
            <Card style={{ textAlign: 'center', padding: 60 }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>{'📚'}</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: D.heading, marginBottom: 8 }}>No Articles Yet</div>
              <div style={{ fontSize: 14, color: D.muted }}>Add source documents and compile them to build your knowledge base.</div>
            </Card>
          ) : (
            articles.map(a => {
              const tags = typeof a.tags === 'string' ? JSON.parse(a.tags) : (a.tags || []);
              return (
                <div key={a.id} onClick={() => setSelectedArticle(a.id)} style={{
                  padding: '12px 16px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, cursor: 'pointer', transition: 'border-color 0.15s',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>{CATEGORY_ICONS[a.category] || '📄'}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{a.title}</div>
                      <div style={{ fontSize: 12, color: D.muted }}>{a.summary || a.path}</div>
                    </div>
                    <div style={{ fontSize: 11, color: D.muted, fontFamily: MONO }}>{a.word_count}w</div>
                  </div>
                  {tags.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 6, marginLeft: 30 }}>
                      {tags.slice(0, 5).map((t, i) => (
                        <span key={i} style={{ padding: '1px 6px', borderRadius: 3, background: D.bg, color: D.muted, fontSize: 10 }}>{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* SOURCES TAB */}
      {tab === 'sources' && <SourcesView />}

      {/* HEALTH TAB */}
      {tab === 'health' && <HealthCheck />}

      {/* QUERIES TAB */}
      {tab === 'queries' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {recentQueries.length === 0 ? (
            <Card style={{ textAlign: 'center', padding: 40 }}><div style={{ color: D.muted }}>No queries yet. Click "Ask a Question" to start.</div></Card>
          ) : recentQueries.map(q => (
            <Card key={q.id} style={{ padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.teal, marginBottom: 6 }}>Q: {q.query}</div>
              <div style={{ fontSize: 13, color: D.text, lineHeight: 1.6, maxHeight: 120, overflow: 'hidden' }}>{q.answer}</div>
              <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11, color: D.muted }}>
                <span>{q.asked_by}</span>
                <span>{new Date(q.created_at).toLocaleString()}</span>
                {q.response_quality && <span>{'⭐'.repeat(q.response_quality)}</span>}
                {q.filed_back && <span style={{ color: D.green }}>{'📥'} Filed back</span>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
