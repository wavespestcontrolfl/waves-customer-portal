/**
 * Tech Intelligence Bar
 * client/src/components/tech/TechIntelligenceBar.jsx
 *
 * Mobile-first field assistant for technicians.
 * Read-only tools, short responses, one-tap quick actions.
 */

import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };

function techFetch(path, options = {}) {
  const token = localStorage.getItem('adminToken') || localStorage.getItem('waves_admin_token');
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function renderMarkdown(text) {
  if (!text) return null;
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
    if (line.startsWith('### ') || line.startsWith('## ')) return <div key={i} style={{ fontSize: 14, fontWeight: 700, color: D.white, marginTop: 10, marginBottom: 4 }}>{line.replace(/^#+\s/, '')}</div>;
    if (line.match(/^[-•*]\s/)) return <div key={i} style={{ display: 'flex', gap: 6, paddingLeft: 2, marginBottom: 2 }}><span style={{ color: D.teal, fontSize: 8, marginTop: 6 }}>●</span><span>{renderBold(line.replace(/^[-•*]\s/, ''))}</span></div>;
    return <div key={i} style={{ marginBottom: 3 }}>{renderBold(line)}</div>;
  });
}

function renderBold(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i} style={{ color: D.white, fontWeight: 600 }}>{p.slice(2, -2)}</strong> : p
  );
}


export default function TechIntelligenceBar() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);

  const techName = localStorage.getItem('techName') || localStorage.getItem('adminName') || 'Tech';

  useEffect(() => {
    techFetch('/admin/intelligence-bar/quick-actions?context=tech')
      .then(d => setQuickActions(d.actions || []))
      .catch(() => {
        setQuickActions([
          { id: 'route', label: "Today's Route", prompt: "What's my route today?", icon: '📅' },
          { id: 'next', label: "What's Next?", prompt: "What's my next stop?", icon: '➡️' },
          { id: 'weather', label: 'Spray Check', prompt: 'Can I spray right now?', icon: '🌤️' },
          { id: 'protocol', label: 'Protocol', prompt: 'Quarterly pest control protocol', icon: '📖' },
        ]);
      });
  }, []);

  const submit = useCallback(async (text) => {
    const q = (text || prompt).trim();
    if (!q || loading) return;
    setLoading(true); setExpanded(true); setResponse(null);

    try {
      const data = await techFetch('/admin/intelligence-bar/query', {
        method: 'POST',
        body: JSON.stringify({
          prompt: q, conversationHistory,
          context: 'tech',
          pageData: { tech_name: techName },
        }),
      });
      setResponse(data.response);
      setConversationHistory(data.conversationHistory || []);
    } catch (err) {
      setResponse(`Error: ${err.message}`);
    }
    setLoading(false); setPrompt('');
  }, [prompt, loading, conversationHistory, techName]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  const clear = () => { setConversationHistory([]); setResponse(null); setExpanded(false); };

  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
      marginBottom: 16, overflow: 'hidden',
    }}>
      {/* Input */}
      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8,
          background: `linear-gradient(135deg, ${D.teal}, #6366f1)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, flexShrink: 0,
        }}>⚡</div>
        <input
          value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
          onFocus={() => setExpanded(true)}
          placeholder="Ask anything..."
          style={{
            flex: 1, padding: '8px 10px', background: D.bg, border: `1px solid ${D.border}`,
            borderRadius: 8, color: D.text, fontSize: 14, fontFamily: "'Nunito Sans', sans-serif",
            outline: 'none', boxSizing: 'border-box',
          }}
        />
        {loading ? (
          <div style={{ padding: '6px 10px', borderRadius: 6, background: `${D.teal}22`, color: D.teal, fontSize: 11, fontWeight: 600, animation: 'pulse 1.5s ease infinite' }}>...</div>
        ) : prompt.trim() ? (
          <button onClick={() => submit()} style={{
            padding: '6px 12px', borderRadius: 6, background: D.teal, color: D.white,
            border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>Go</button>
        ) : null}
        {response && (
          <button onClick={clear} style={{
            padding: '6px 8px', background: 'transparent', border: `1px solid ${D.border}`,
            borderRadius: 6, color: D.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer',
          }}>✕</button>
        )}
      </div>

      {/* Quick Actions — 2-column grid for mobile */}
      {expanded && !response && !loading && (
        <div style={{ padding: '0 12px 10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {quickActions.map(a => (
            <button key={a.id} onClick={() => { setPrompt(a.prompt); submit(a.prompt); }} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px',
              background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
              color: D.muted, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              fontFamily: "'Nunito Sans', sans-serif", textAlign: 'left',
            }}>
              <span style={{ fontSize: 15 }}>{a.icon}</span>
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ padding: '6px 12px 12px' }}>
          {[85, 60].map((w, i) => (
            <div key={i} style={{ height: 10, borderRadius: 4, marginBottom: 4, background: `linear-gradient(90deg, ${D.border}44, ${D.border}88, ${D.border}44)`, backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease infinite', width: `${w}%` }} />
          ))}
        </div>
      )}

      {/* Response */}
      {response && !loading && (
        <div style={{ padding: '0 12px 12px', maxHeight: 350, overflowY: 'auto' }}>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: D.text, fontFamily: "'Nunito Sans', sans-serif" }}>
            {renderMarkdown(response)}
          </div>
          {/* Follow-up */}
          <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
            <input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Follow up..."
              style={{ flex: 1, padding: '7px 10px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 13, fontFamily: "'Nunito Sans', sans-serif", outline: 'none' }} />
            <button onClick={() => submit()} disabled={!prompt.trim()} style={{
              padding: '7px 12px', background: D.teal, color: D.white, border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: prompt.trim() ? 1 : 0.4,
            }}>Go</button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>
    </div>
  );
}
