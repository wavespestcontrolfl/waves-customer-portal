/**
 * Dashboard Intelligence Bar
 * client/src/components/admin/DashboardIntelligenceBar.jsx
 *
 * Context-aware Intelligence Bar for the Dashboard page.
 * Injects live KPI data so Claude knows the current business state.
 *
 * Replaces: Static KPI cards, clickable detail panels
 * Adds: Period comparison, MRR trends, funnel analysis, churn reports,
 *        morning briefings — all via natural language
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let key = 0;
  for (const line of lines) {
    if (line.startsWith('### ')) { elements.push(<div key={key++} style={{ fontSize: 14, fontWeight: 700, color: D.white, marginTop: 12, marginBottom: 4 }}>{line.slice(4)}</div>); continue; }
    if (line.startsWith('## ')) { elements.push(<div key={key++} style={{ fontSize: 15, fontWeight: 700, color: D.white, marginTop: 14, marginBottom: 6 }}>{line.slice(3)}</div>); continue; }
    if (line.match(/^[-•*]\s/)) {
      elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.teal, fontSize: 10, marginTop: 5 }}>●</span><span>{renderInline(line.replace(/^[-•*]\s/, ''))}</span></div>);
      continue;
    }
    if (line.match(/^\d+\.\s/)) {
      const num = line.match(/^(\d+)\./)[1];
      elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.teal, fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', minWidth: 18 }}>{num}.</span><span>{renderInline(line.replace(/^\d+\.\s/, ''))}</span></div>);
      continue;
    }
    if (!line.trim()) { elements.push(<div key={key++} style={{ height: 8 }} />); continue; }
    elements.push(<div key={key++} style={{ marginBottom: 4 }}>{renderInline(line)}</div>);
  }
  return elements;
}

function renderInline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} style={{ color: D.white, fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function QuickChip({ icon, label, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '5px 12px', borderRadius: 9999,
      background: hover ? `${D.teal}22` : D.card,
      border: `1px solid ${hover ? D.teal + '55' : D.border}`,
      color: hover ? D.teal : D.muted, fontSize: 12, fontWeight: 600,
      fontFamily: 'DM Sans, sans-serif', cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 13 }}>{icon}</span>{label}
    </button>
  );
}


export default function DashboardIntelligenceBar({ kpiData }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [structuredData, setStructuredData] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    adminFetch('/admin/intelligence-bar/quick-actions?context=dashboard')
      .then(d => setQuickActions(d.actions || []))
      .catch(() => {
        setQuickActions([
          { id: 'briefing', label: 'Morning Briefing', prompt: 'Give me a morning briefing', icon: '☀️' },
          { id: 'week_compare', label: 'This vs Last Week', prompt: 'How did we do this week vs last week?', icon: '📊' },
          { id: 'mrr', label: 'MRR Trend', prompt: "What's our MRR trend?", icon: '📈' },
          { id: 'close_rate', label: 'Close Rate', prompt: "What's our estimate close rate?", icon: '🎯' },
          { id: 'revenue', label: 'Revenue Breakdown', prompt: 'Break down revenue by service type', icon: '💰' },
          { id: 'churn', label: 'Churn Check', prompt: 'Any churn this month?', icon: '🔻' },
          { id: 'leads', label: 'Lead Sources', prompt: 'Where are new customers coming from?', icon: '🧲' },
          { id: 'balances', label: 'Balances', prompt: "What's outstanding?", icon: '🧾' },
        ]);
      });
  }, []);

  const buildPageData = useCallback(() => {
    if (!kpiData?.kpis) return {};
    const k = kpiData.kpis;
    return {
      revenue_mtd: k.revenueMTD,
      revenue_change_pct: k.revenueChangePercent,
      active_customers: k.activeCustomers,
      new_customers_this_month: k.newCustomersThisMonth,
      estimates_pending: k.estimatesPending,
      services_this_week: k.servicesThisWeek,
      google_rating: k.googleReviewRating,
      google_reviews: k.googleReviewCount,
      mrr: kpiData.mrr,
    };
  }, [kpiData]);

  const submit = useCallback(async (text) => {
    const q = (text || prompt).trim();
    if (!q || loading) return;

    setLoading(true);
    setExpanded(true);
    setResponse(null);
    setStructuredData(null);

    try {
      const data = await adminFetch('/admin/intelligence-bar/query', {
        method: 'POST',
        body: JSON.stringify({
          prompt: q,
          conversationHistory,
          context: 'dashboard',
          pageData: buildPageData(),
        }),
      });

      setResponse(data.response);
      setStructuredData(data.structuredData);
      setConversationHistory(data.conversationHistory || []);
    } catch (err) {
      setResponse(`⚠️ Error: ${err.message}`);
    }

    setLoading(false);
    setPrompt('');
  }, [prompt, loading, conversationHistory, buildPageData]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setExpanded(false); setPrompt(''); }
  };

  const clear = () => {
    setConversationHistory([]);
    setResponse(null);
    setStructuredData(null);
    setExpanded(false);
  };

  return (
    <div style={{
      background: `linear-gradient(135deg, ${D.card} 0%, ${D.bg} 100%)`,
      border: `1px solid ${D.border}`, borderRadius: 14,
      marginBottom: 20, overflow: 'hidden',
    }}>
      {/* Command Bar */}
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 10,
          background: `linear-gradient(135deg, ${D.teal}, #6366f1)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, flexShrink: 0,
        }}>⚡</div>

        <div style={{ flex: 1, position: 'relative' }}>
          <input
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setExpanded(true)}
            placeholder="How did we do this week? What's my MRR trend? Morning briefing..."
            style={{
              width: '100%', padding: '10px 14px', paddingRight: 80,
              background: D.bg, border: `1px solid ${D.border}`,
              borderRadius: 10, color: D.text, fontSize: 14,
              fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box',
            }}
            onFocusCapture={e => e.target.style.borderColor = D.teal + '66'}
            onBlurCapture={e => e.target.style.borderColor = D.border}
          />
          <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}>
            {loading ? (
              <div style={{ padding: '5px 12px', borderRadius: 8, background: `${D.teal}22`, color: D.teal, fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', animation: 'pulse 1.5s ease infinite' }}>analyzing...</div>
            ) : (
              <button onClick={() => submit()} disabled={!prompt.trim()} style={{
                padding: '5px 14px', borderRadius: 8,
                background: prompt.trim() ? D.teal : 'transparent',
                color: prompt.trim() ? D.white : D.muted,
                border: `1px solid ${prompt.trim() ? D.teal : D.border}`,
                fontSize: 12, fontWeight: 700, cursor: prompt.trim() ? 'pointer' : 'default',
                fontFamily: 'DM Sans, sans-serif', opacity: prompt.trim() ? 1 : 0.4,
              }}>Ask ↵</button>
            )}
          </div>
        </div>

        {response && (
          <button onClick={clear} style={{
            padding: '6px 10px', background: 'transparent', border: `1px solid ${D.border}`,
            borderRadius: 8, color: D.muted, fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}>Clear</button>
        )}
      </div>

      {/* Quick Actions */}
      {expanded && !response && !loading && (
        <div style={{ padding: '0 18px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {quickActions.map(a => (
            <QuickChip key={a.id} icon={a.icon} label={a.label} onClick={() => { setPrompt(a.prompt); submit(a.prompt); }} />
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ padding: '8px 18px 18px' }}>
          {[92, 75, 88, 60].map((w, i) => (
            <div key={i} style={{
              height: 13, borderRadius: 6, marginBottom: 6,
              background: `linear-gradient(90deg, ${D.border}44, ${D.border}88, ${D.border}44)`,
              backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease infinite', width: `${w}%`,
            }} />
          ))}
        </div>
      )}

      {/* Response */}
      {response && !loading && (
        <div style={{
          padding: '2px 18px 18px', borderTop: `1px solid ${D.border}33`,
          maxHeight: 520, overflowY: 'auto',
        }}>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: D.text, fontFamily: 'DM Sans, sans-serif' }}>
            {renderMarkdown(response)}
          </div>

          {/* Follow-up */}
          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <input
              value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Drill deeper — 'break that down by tier', 'compare to Q1'..."
              style={{
                flex: 1, padding: '8px 12px', background: D.bg, border: `1px solid ${D.border}`,
                borderRadius: 8, color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none',
              }}
            />
            <button onClick={() => submit()} disabled={!prompt.trim() || loading} style={{
              padding: '8px 16px', background: D.teal, color: D.white, border: 'none',
              borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: prompt.trim() ? 1 : 0.4,
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
