import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/blue/purple fold to zinc-900. Semantic green/amber/red preserved.
// CONFIDENCE_COLORS / STATUS_COLORS / TOKEN_STATUS_COLORS all fold cleanly —
// draft (was blue) → zinc-900 stays distinct from green/amber/muted.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', purple: '#18181B', blue: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', input: '#FFFFFF', heading: '#09090B', inputBorder: '#D4D4D8' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });
const sInput = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

const CATEGORIES = ['operations', 'pricing', 'agronomics', 'equipment', 'apis', 'sops', 'pest-ecology', 'customer-lifecycle', 'chemicals', 'scheduling', 'credentials', 'integrations', 'protocols', 'general'];
const CONFIDENCE_COLORS = { high: D.green, medium: D.amber, low: D.red, unverified: D.muted };
const STATUS_COLORS = { active: D.green, flagged: D.amber, archived: D.muted, draft: D.blue };

export default function KnowledgeBasePage() {
  const [tab, setTab] = useState('browse');
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState('');
  const isMobile = useIsMobile();

  const loadStats = useCallback(async () => {
    const s = await adminFetch('/admin/kb/stats').catch(() => null);
    setStats(s);
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>
            <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>Knowledge Base</span>
            <span className="hidden md:inline">Knowledge Base</span>
          </h1>
        </div>
      </div>

      {/* Stats Row */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Active', value: stats.active, color: D.green },
            { label: 'Flagged', value: stats.flagged, color: D.amber },
            { label: 'Stale (30d+)', value: stats.stale, color: D.red },
            { label: 'High Conf', value: stats.highConfidence, color: D.teal },
            { label: 'Needs Review', value: stats.lowConfidence, color: D.muted },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, flex: '1 1 100px', minWidth: isMobile ? 80 : 100, marginBottom: 0, textAlign: 'center', padding: isMobile ? 12 : 20 }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: isMobile ? 18 : 22, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 24, background: '#F4F4F5', borderRadius: 10, padding: 4, border: '1px solid #E4E4E7' }}>
        {[
          { key: 'browse', label: isMobile ? 'Browse' : 'Browse & Search' },
          { key: 'create', label: isMobile ? 'New' : 'New Entry' },
          { key: 'audit', label: 'AI Audit' },
          { key: 'tokens', label: isMobile ? 'Tokens' : 'Token Health' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: tab === t.key ? '#18181B' : 'transparent',
            color: tab === t.key ? '#FFFFFF' : '#A1A1AA',
            fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
            fontFamily: "'DM Sans', sans-serif",
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'browse' && <BrowseTab showToast={showToast} onRefresh={loadStats} isMobile={isMobile} />}
      {tab === 'create' && <CreateTab showToast={showToast} onCreated={() => { loadStats(); setTab('browse'); }} isMobile={isMobile} />}
      {tab === 'audit' && <AuditTab showToast={showToast} onRefresh={loadStats} isMobile={isMobile} />}
      {tab === 'tokens' && <TokensTab showToast={showToast} isMobile={isMobile} />}

      {/* Toast */}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>OK</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BROWSE & SEARCH TAB
// ══════════════════════════════════════════════════════════════
function BrowseTab({ showToast, onRefresh, isMobile }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '50' });
    if (filterCategory) params.set('category', filterCategory);
    if (filterStatus) params.set('status', filterStatus);

    if (searchQuery.trim()) {
      const data = await adminFetch(`/admin/kb/search?q=${encodeURIComponent(searchQuery)}&${params}`).catch(() => ({ results: [] }));
      setEntries(data.results || []);
      setTotal(data.results?.length || 0);
    } else {
      const data = await adminFetch(`/admin/kb?${params}`).catch(() => ({ entries: [], total: 0 }));
      setEntries(data.entries || []);
      setTotal(data.total || 0);
    }
  }, [searchQuery, filterCategory, filterStatus]);

  useEffect(() => { load(); }, [load]);

  const handleVerify = async (id) => {
    await adminFetch(`/admin/kb/${id}/verify`, { method: 'POST', body: JSON.stringify({}) });
    showToast('Marked as verified');
    load(); onRefresh();
  };

  const handleFlag = async (id) => {
    await adminFetch(`/admin/kb/${id}/flag`, { method: 'POST', body: JSON.stringify({ reason: 'Flagged from admin UI' }) });
    showToast('Entry flagged for review');
    load(); onRefresh();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this knowledge base entry?')) return;
    await adminFetch(`/admin/kb/${id}`, { method: 'DELETE' });
    showToast('Entry deleted');
    setSelected(null);
    load(); onRefresh();
  };

  const handleSaveEdit = async () => {
    await adminFetch(`/admin/kb/${selected.id}`, { method: 'PUT', body: JSON.stringify({ content: editContent }) });
    showToast('Entry updated');
    setEditing(false);
    setSelected({ ...selected, content: editContent });
    load(); onRefresh();
  };

  // On mobile, show detail as full-screen overlay
  if (isMobile && selected) {
    return (
      <div>
        <button onClick={() => setSelected(null)} style={{ ...sBtn(D.border, D.muted), marginBottom: 12 }}>{'<-'} Back to list</button>
        <DetailPanel
          selected={selected} editing={editing} editContent={editContent}
          setEditing={setEditing} setEditContent={setEditContent} setSelected={setSelected}
          handleVerify={handleVerify} handleFlag={handleFlag} handleDelete={handleDelete} handleSaveEdit={handleSaveEdit}
          isMobile={isMobile}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selected && !isMobile ? '1fr 1fr' : '1fr', gap: 16 }}>
      {/* Left — List */}
      <div>
        {/* Search & Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
          <input
            value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search knowledge base..." style={{ ...sInput, flex: 1, minWidth: isMobile ? '100%' : 200 }}
          />
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
            style={{ ...sInput, width: isMobile ? '48%' : 150 }}>
            <option value="">All Categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            style={{ ...sInput, width: isMobile ? '48%' : 120 }}>
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="flagged">Flagged</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        <div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>{total} entries</div>

        <div style={{ display: 'grid', gap: 6 }}>
          {entries.map(entry => (
            <div key={entry.id} onClick={() => { setSelected(entry); setEditing(false); }}
              style={{
                ...sCard, marginBottom: 0, cursor: 'pointer', padding: isMobile ? 12 : 14,
                borderLeft: `3px solid ${STATUS_COLORS[entry.status] || D.muted}`,
                background: selected?.id === entry.id ? `${D.teal}15` : D.card,
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 4 }}>{entry.title}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={sBadge(`${CONFIDENCE_COLORS[entry.confidence]}22`, CONFIDENCE_COLORS[entry.confidence])}>{entry.confidence}</span>
                    <span style={sBadge(`${D.blue}22`, D.blue)}>{entry.category}</span>
                    {entry.status === 'flagged' && <span style={sBadge(`${D.amber}22`, D.amber)}>flagged</span>}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: D.muted, whiteSpace: 'nowrap', marginLeft: 8 }}>
                  {entry.last_verified_at ? new Date(entry.last_verified_at).toLocaleDateString() : 'never'}
                </div>
              </div>
            </div>
          ))}
          {entries.length === 0 && (
            <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>
              {searchQuery ? 'No results found' : 'No entries yet'}
            </div>
          )}
        </div>
      </div>

      {/* Right — Detail (desktop only) */}
      {selected && !isMobile && (
        <div style={{ position: 'sticky', top: 20, alignSelf: 'start' }}>
          <DetailPanel
            selected={selected} editing={editing} editContent={editContent}
            setEditing={setEditing} setEditContent={setEditContent} setSelected={setSelected}
            handleVerify={handleVerify} handleFlag={handleFlag} handleDelete={handleDelete} handleSaveEdit={handleSaveEdit}
            isMobile={isMobile}
          />
        </div>
      )}
    </div>
  );
}

// ── Shared Detail Panel (used in both mobile & desktop) ──
function DetailPanel({ selected, editing, editContent, setEditing, setEditContent, setSelected, handleVerify, handleFlag, handleDelete, handleSaveEdit, isMobile }) {
  return (
    <div style={sCard}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 700, color: D.heading }}>{selected.title}</div>
        {!isMobile && <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 18 }}>x</button>}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={sBadge(`${D.blue}22`, D.blue)}>{selected.category}</span>
        <span style={sBadge(`${CONFIDENCE_COLORS[selected.confidence]}22`, CONFIDENCE_COLORS[selected.confidence])}>{selected.confidence}</span>
        <span style={sBadge(`${STATUS_COLORS[selected.status]}22`, STATUS_COLORS[selected.status])}>{selected.status}</span>
        <span style={{ fontSize: 10, color: D.muted }}>src: {selected.source}</span>
      </div>

      {/* Tags */}
      {selected.tags && (() => {
        const tags = typeof selected.tags === 'string' ? JSON.parse(selected.tags) : selected.tags;
        return tags.length > 0 ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
            {tags.map(t => <span key={t} style={{ fontSize: 10, color: D.teal, background: `${D.teal}15`, padding: '2px 6px', borderRadius: 3 }}>#{t}</span>)}
          </div>
        ) : null;
      })()}

      {/* Content */}
      {editing ? (
        <div>
          <textarea
            value={editContent} onChange={e => setEditContent(e.target.value)}
            rows={isMobile ? 14 : 20} style={{ ...sInput, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={handleSaveEdit} style={sBtn(D.green, D.white)}>Save</button>
            <button onClick={() => setEditing(false)} style={sBtn(D.border, D.muted)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{
          background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, padding: isMobile ? 12 : 16,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: D.text, lineHeight: 1.6,
          maxHeight: isMobile ? 300 : 400, overflow: 'auto', whiteSpace: 'pre-wrap',
        }}>
          {selected.content}
        </div>
      )}

      {/* Meta */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 10, color: D.muted, flexWrap: 'wrap' }}>
        <span>Verified: {selected.last_verified_at ? `${new Date(selected.last_verified_at).toLocaleDateString()} by ${selected.verified_by}` : 'never'}</span>
        <span>Updated: {new Date(selected.updated_at).toLocaleDateString()}</span>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button onClick={() => { setEditing(true); setEditContent(selected.content); }} style={sBtn(D.teal, D.white)}>Edit</button>
        <button onClick={() => handleVerify(selected.id)} style={sBtn(D.green, D.white)}>Verify</button>
        <button onClick={() => handleFlag(selected.id)} style={sBtn(D.amber, D.white)}>Flag</button>
        <button onClick={() => handleDelete(selected.id)} style={sBtn(D.red, D.white)}>Delete</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CREATE TAB
// ══════════════════════════════════════════════════════════════
function CreateTab({ showToast, onCreated, isMobile }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('general');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [confidence, setConfidence] = useState('medium');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) { showToast('Title required'); return; }
    setSaving(true);
    try {
      await adminFetch('/admin/kb', {
        method: 'POST',
        body: JSON.stringify({
          title, category, content,
          tags: tags.split(',').map(t => t.trim()).filter(Boolean),
          confidence, source: 'manual',
        }),
      });
      showToast('Entry created');
      onCreated();
    } catch (e) { showToast(`Error: ${e.message}`); }
    setSaving(false);
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>New Knowledge Base Entry</div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Title</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Rodent Exclusion Warranty Protocol" style={sInput} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)} style={sInput}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Confidence</label>
            <select value={confidence} onChange={e => setConfidence(e.target.value)} style={sInput}>
              <option value="high">High -- verified, authoritative</option>
              <option value="medium">Medium -- believed accurate</option>
              <option value="low">Low -- needs verification</option>
              <option value="unverified">Unverified -- just captured</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Tags (comma-separated)</label>
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="e.g. rodent, exclusion, warranty, renewal" style={sInput} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, display: 'block', marginBottom: 4 }}>Content (Markdown)</label>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={isMobile ? 12 : 16}
            placeholder={"# Entry Title\n\nWrite your knowledge base entry in markdown..."}
            style={{ ...sInput, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, resize: 'vertical' }} />
        </div>

        <button onClick={handleSave} disabled={saving} style={{ ...sBtn(D.green, D.white), opacity: saving ? 0.5 : 1, width: '100%', padding: 12 }}>
          {saving ? 'Saving...' : 'Create Entry'}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// AI AUDIT TAB
// ══════════════════════════════════════════════════════════════
function AuditTab({ showToast, onRefresh, isMobile }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [maxEntries, setMaxEntries] = useState(10);

  const runAudit = async (forceAll = false) => {
    setRunning(true);
    try {
      const data = await adminFetch('/admin/kb/audit/run', {
        method: 'POST', body: JSON.stringify({ maxEntries, forceAll }),
      });
      setResults(data);
      showToast(`Audit complete: ${data.audited} reviewed, ${data.flagged} flagged`);
      onRefresh();
    } catch (e) { showToast(`Audit failed: ${e.message}`); }
    setRunning(false);
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 8 }}>AI Knowledge Audit</div>
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>
          "Question Your Assumptions" -- AI reviews entries for accuracy, staleness, and correctness.
          Runs automatically weekly via cron, or trigger manually below.
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: isMobile ? 'stretch' : 'center', marginBottom: 16, flexDirection: isMobile ? 'column' : 'row' }}>
          <div>
            <label style={{ fontSize: 11, color: D.muted, display: 'block', marginBottom: 4 }}>Max entries to review</label>
            <input type="number" value={maxEntries} onChange={e => setMaxEntries(parseInt(e.target.value) || 10)}
              min={1} max={50} style={{ ...sInput, width: 80 }} />
          </div>
          <button onClick={() => runAudit(false)} disabled={running}
            style={{ ...sBtn(D.teal, D.white), opacity: running ? 0.5 : 1, marginTop: isMobile ? 0 : 16 }}>
            {running ? 'Auditing...' : 'Audit Stale & Low-Confidence'}
          </button>
          <button onClick={() => runAudit(true)} disabled={running}
            style={{ ...sBtn(D.amber, D.white), opacity: running ? 0.5 : 1, marginTop: isMobile ? 0 : 16 }}>
            {running ? 'Auditing...' : 'Audit All (Force)'}
          </button>
        </div>
      </div>

      {results && (
        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
            Results: {results.audited} reviewed, <span style={{ color: results.flagged > 0 ? D.amber : D.green }}>{results.flagged} flagged</span>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {(results.results || []).map((r, i) => (
              <div key={i} style={{
                ...sCard, marginBottom: 0, padding: 14,
                borderLeft: `3px solid ${r.status === 'pass' ? D.green : r.status === 'flag' ? D.amber : D.red}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{r.title}</div>
                  <span style={sBadge(
                    r.status === 'pass' ? `${D.green}22` : `${D.amber}22`,
                    r.status === 'pass' ? D.green : D.amber,
                  )}>{r.status}</span>
                </div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{r.summary}</div>
                {r.issues?.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {r.issues.map((issue, j) => (
                      <div key={j} style={{ fontSize: 11, color: D.amber, marginTop: 2 }}>- {issue}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TOKEN HEALTH TAB
// ══════════════════════════════════════════════════════════════
function TokensTab({ showToast, isMobile }) {
  const [tokens, setTokens] = useState([]);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const data = await adminFetch('/admin/kb/tokens/status').catch(() => ({ tokens: [] }));
    setTokens(data.tokens || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const runCheck = async () => {
    setChecking(true);
    try {
      const result = await adminFetch('/admin/kb/tokens/check', { method: 'POST' });
      showToast(`Checked ${result.checked} tokens: ${result.healthy} healthy, ${result.failures} failed`);
      load();
    } catch (e) { showToast(`Check failed: ${e.message}`); }
    setChecking(false);
  };

  const TOKEN_STATUS_COLORS = { healthy: D.green, expired: D.red, 'expiring-soon': D.amber, error: D.red, unknown: D.muted };
  const TOKEN_STATUS_ICONS = { healthy: 'OK', expired: 'X', 'expiring-soon': '!', error: 'X', unknown: '?' };

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading }}>API Token Health</div>
          <div style={{ fontSize: 12, color: D.muted }}>Monitor OAuth tokens and API credentials across all platforms</div>
        </div>
        <button onClick={runCheck} disabled={checking} style={{ ...sBtn(D.teal, D.white), opacity: checking ? 0.5 : 1 }}>
          {checking ? 'Checking...' : 'Run Health Check'}
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {tokens.map(token => {
          const meta = typeof token.metadata === 'string' ? JSON.parse(token.metadata) : (token.metadata || {});
          return (
            <div key={token.id} style={{
              ...sCard, marginBottom: 0, padding: isMobile ? 12 : 16,
              borderLeft: `3px solid ${TOKEN_STATUS_COLORS[token.status] || D.muted}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{token.platform}</div>
                  <div style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>{token.env_var_name}</div>
                </div>
                <span style={sBadge(
                  `${TOKEN_STATUS_COLORS[token.status]}22`,
                  TOKEN_STATUS_COLORS[token.status],
                )}>
                  {TOKEN_STATUS_ICONS[token.status]} {token.status}
                </span>
              </div>

              {token.last_error && (
                <div style={{ fontSize: 11, color: D.red, marginTop: 6, background: `${D.red}10`, padding: '6px 10px', borderRadius: 6 }}>
                  {token.last_error.substring(0, 200)}
                </div>
              )}

              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 10, color: D.muted, flexWrap: 'wrap' }}>
                {token.expires_at && <span>Expires: {new Date(token.expires_at).toLocaleDateString()}</span>}
                {token.last_verified_at && <span>Last checked: {new Date(token.last_verified_at).toLocaleString()}</span>}
                {meta.ttl && <span>TTL: {meta.ttl}</span>}
                {meta.authUrl && <a href={meta.authUrl} target="_blank" rel="noopener noreferrer" style={{ color: D.teal, textDecoration: 'none' }}>Re-authorize</a>}
                {meta.refreshUrl && <a href={meta.refreshUrl} target="_blank" rel="noopener noreferrer" style={{ color: D.teal, textDecoration: 'none' }}>Refresh token</a>}
              </div>
            </div>
          );
        })}
        {tokens.length === 0 && (
          <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>
            No token data yet -- run a health check to initialize
          </div>
        )}
      </div>
    </div>
  );
}
