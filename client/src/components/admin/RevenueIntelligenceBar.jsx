/**
 * Revenue Intelligence Bar
 * client/src/components/admin/RevenueIntelligenceBar.jsx
 *
 * Context-aware wrapper for the Revenue page.
 * Passes the active period and topline KPIs so Claude knows
 * what the operator is currently viewing.
 */

import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#fff', heading: '#0F172A', inputBg: '#FFFFFF' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let key = 0;
  for (const line of lines) {
    if (line.startsWith('### ')) { elements.push(<div key={key++} style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginTop: 12, marginBottom: 4 }}>{line.slice(4)}</div>); continue; }
    if (line.startsWith('## ')) { elements.push(<div key={key++} style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginTop: 14, marginBottom: 6 }}>{line.slice(3)}</div>); continue; }
    if (line.match(/^[-•*]\s/)) { elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.green, fontSize: 10, marginTop: 5 }}>●</span><span>{renderInline(line.replace(/^[-•*]\s/, ''))}</span></div>); continue; }
    if (line.match(/^\d+\.\s/)) { const num = line.match(/^(\d+)\./)[1]; elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.green, fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', minWidth: 18 }}>{num}.</span><span>{renderInline(line.replace(/^\d+\.\s/, ''))}</span></div>); continue; }
    if (!line.trim()) { elements.push(<div key={key++} style={{ height: 8 }} />); continue; }
    elements.push(<div key={key++} style={{ marginBottom: 4 }}>{renderInline(line)}</div>);
  }
  return elements;
}

function renderInline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} style={{ color: D.heading, fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function QuickChip({ icon, label, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 9999,
      background: hover ? `${D.green}22` : D.card, border: `1px solid ${hover ? D.green + '55' : D.border}`,
      color: hover ? D.green : D.muted, fontSize: 12, fontWeight: 600,
      fontFamily: 'DM Sans, sans-serif', cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 13 }}>{icon}</span>{label}
    </button>
  );
}


export default function RevenueIntelligenceBar({ period, revenueData }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    adminFetch('/admin/intelligence-bar/quick-actions?context=revenue')
      .then(d => setQuickActions(d.actions || []))
      .catch(() => {
        setQuickActions([
          { id: 'overview', label: 'Overview', prompt: "How's revenue this month?", icon: '💰' },
          { id: 'compare', label: 'vs Last Month', prompt: 'Compare this month vs last month', icon: '📊' },
          { id: 'service_lines', label: 'Service P&L', prompt: 'Service line P&L breakdown', icon: '📋' },
          { id: 'tech', label: 'Tech RPMH', prompt: 'Rank techs by RPMH', icon: '👷' },
          { id: 'top', label: 'Top Customers', prompt: 'Top 10 customers by revenue', icon: '🏆' },
          { id: 'ads', label: 'Ad ROI', prompt: 'Ad attribution and ROAS', icon: '📣' },
        ]);
      });
  }, []);

  const buildPageData = useCallback(() => {
    const pd = { active_period: period || 'month' };
    if (revenueData?.topline) {
      const t = revenueData.topline;
      pd.current_revenue = t.totalRevenue;
      pd.gross_margin_pct = t.grossMarginPct;
      pd.rpmh = t.revenuePerManHour;
      pd.mrr = t.mrr;
      pd.total_services = t.totalServices;
    }
    return pd;
  }, [period, revenueData]);

  const submit = useCallback(async (text) => {
    const q = (text || prompt).trim();
    if (!q || loading) return;
    setLoading(true); setExpanded(true); setResponse(null);

    try {
      const data = await adminFetch('/admin/intelligence-bar/query', {
        method: 'POST',
        body: JSON.stringify({ prompt: q, conversationHistory, context: 'revenue', pageData: buildPageData() }),
      });
      setResponse(data.response);
      setConversationHistory(data.conversationHistory || []);
    } catch (err) {
      setResponse(`⚠️ Error: ${err.message}`);
    }
    setLoading(false); setPrompt('');
  }, [prompt, loading, conversationHistory, buildPageData]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setExpanded(false); setPrompt(''); }
  };

  const clear = () => { setConversationHistory([]); setResponse(null); setExpanded(false); };

  return (
    <div style={{
      background: `linear-gradient(135deg, ${D.card} 0%, ${D.bg} 100%)`,
      border: `1px solid ${D.border}`, borderRadius: 14, marginBottom: 20, overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 9,
          background: `linear-gradient(135deg, ${D.green}, ${D.teal})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0,
        }}>⚡</div>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
            onFocus={() => setExpanded(true)}
            placeholder="Compare months, analyze margins, rank techs by RPMH, ad ROI..."
            style={{
              width: '100%', padding: '9px 14px', paddingRight: 80, background: D.inputBg,
              border: `1px solid ${D.border}`, borderRadius: 10, color: D.text, fontSize: 13,
              fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box',
            }}
            onFocusCapture={e => e.target.style.borderColor = D.green + '66'}
            onBlurCapture={e => e.target.style.borderColor = D.border}
          />
          <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}>
            {loading ? (
              <div style={{ padding: '4px 10px', borderRadius: 6, background: `${D.green}22`, color: D.green, fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', animation: 'pulse 1.5s ease infinite' }}>analyzing...</div>
            ) : (
              <button onClick={() => submit()} disabled={!prompt.trim()} style={{
                padding: '4px 12px', borderRadius: 6, background: prompt.trim() ? D.green : 'transparent',
                color: prompt.trim() ? D.white : D.muted, border: `1px solid ${prompt.trim() ? D.green : D.border}`,
                fontSize: 11, fontWeight: 700, cursor: prompt.trim() ? 'pointer' : 'default', opacity: prompt.trim() ? 1 : 0.4,
              }}>Ask ↵</button>
            )}
          </div>
        </div>
        {response && (
          <button onClick={clear} style={{ padding: '5px 8px', background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6, color: D.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>Clear</button>
        )}
      </div>

      {expanded && !response && !loading && (
        <div style={{ padding: '0 16px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {quickActions.map(a => (
            <QuickChip key={a.id} icon={a.icon} label={a.label} onClick={() => { setPrompt(a.prompt); submit(a.prompt); }} />
          ))}
        </div>
      )}

      {loading && (
        <div style={{ padding: '8px 16px 16px' }}>
          {[90, 70, 85].map((w, i) => (
            <div key={i} style={{ height: 12, borderRadius: 6, marginBottom: 6, background: `linear-gradient(90deg, ${D.border}44, ${D.border}88, ${D.border}44)`, backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease infinite', width: `${w}%` }} />
          ))}
        </div>
      )}

      {response && !loading && (
        <div style={{ padding: '2px 16px 16px', borderTop: `1px solid ${D.border}33`, maxHeight: 500, overflowY: 'auto' }}>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: D.text, fontFamily: 'DM Sans, sans-serif' }}>
            {renderMarkdown(response)}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Drill deeper — 'break that down by tier', 'compare to Q1'..."
              style={{ flex: 1, padding: '7px 12px', background: D.inputBg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 12, fontFamily: 'DM Sans, sans-serif', outline: 'none' }} />
            <button onClick={() => submit()} disabled={!prompt.trim() || loading} style={{
              padding: '7px 14px', background: D.green, color: D.white, border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer', opacity: prompt.trim() ? 1 : 0.4,
            }}>Send</button>
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
