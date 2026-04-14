/**
 * Global Command Palette (⌘K)
 * client/src/components/admin/GlobalCommandPalette.jsx
 *
 * Fixed overlay triggered by ⌘K / Ctrl+K from any admin page.
 * Auto-detects which page you're on and loads the right context/tools.
 * One component, one backend route, works everywhere.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#a855f7', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

// ─── Route → Context mapping ────────────────────────────────────
const ROUTE_CONTEXT_MAP = {
  '/admin/schedule': 'schedule',
  '/admin/dispatch': 'dispatch',
  '/admin/dashboard': 'dashboard',
  '/admin': 'dashboard',
  '/admin/customers': 'customers',
  '/admin/health': 'customers',
  '/admin/leads': 'leads',
  '/admin/seo': 'seo',
  '/admin/wordpress': 'wordpress',
  '/admin/ppc': 'seo',
  '/admin/social-media': 'seo',
  '/admin/inventory': 'procurement',
  '/admin/revenue': 'revenue',
  '/admin/invoices': 'revenue',
  '/admin/tax': 'tax',
  '/admin/reviews': 'reviews',
  '/admin/referrals': 'reviews',
  '/admin/communications': 'comms',
  '/admin/email': 'email',
};

const CONTEXT_LABELS = {
  schedule: 'Schedule & Dispatch',
  dispatch: 'Dispatch',
  dashboard: 'Dashboard',
  customers: 'Customers',
  seo: 'SEO & Content',
  wordpress: 'WordPress Fleet',
  blog: 'Blog',
  procurement: 'Procurement',
  revenue: 'Revenue',
  reviews: 'Reviews & Reputation',
  comms: 'Communications',
  tax: 'Tax Center',
  leads: 'Leads Pipeline',
  email: 'Email',
};

const CONTEXT_COLORS = {
  schedule: D.teal,
  dispatch: D.teal,
  dashboard: D.teal,
  customers: D.teal,
  seo: D.teal,
  wordpress: D.teal,
  blog: D.teal,
  procurement: D.purple,
  revenue: D.green,
  reviews: D.amber,
  comms: '#3b82f6',
  tax: D.purple,
  leads: D.amber,
  email: D.green,
};

function detectContext(pathname) {
  // Exact match first
  if (ROUTE_CONTEXT_MAP[pathname]) return ROUTE_CONTEXT_MAP[pathname];
  // Prefix match
  for (const [route, ctx] of Object.entries(ROUTE_CONTEXT_MAP)) {
    if (pathname.startsWith(route)) return ctx;
  }
  return 'dashboard'; // fallback
}


// ─── Markdown renderer ──────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let key = 0;
  for (const line of lines) {
    if (line.startsWith('### ')) { elements.push(<div key={key++} style={{ fontSize: 14, fontWeight: 700, color: D.white, marginTop: 12, marginBottom: 4 }}>{line.slice(4)}</div>); continue; }
    if (line.startsWith('## ')) { elements.push(<div key={key++} style={{ fontSize: 15, fontWeight: 700, color: D.white, marginTop: 14, marginBottom: 6 }}>{line.slice(3)}</div>); continue; }
    if (line.match(/^[-•*]\s/)) { elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.teal, fontSize: 10, marginTop: 5 }}>●</span><span>{renderInline(line.replace(/^[-•*]\s/, ''))}</span></div>); continue; }
    if (line.match(/^\d+\.\s/)) { const num = line.match(/^(\d+)\./)[1]; elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.teal, fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', minWidth: 18 }}>{num}.</span><span>{renderInline(line.replace(/^\d+\.\s/, ''))}</span></div>); continue; }
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


// ─── MAIN COMPONENT ─────────────────────────────────────────────
export default function GlobalCommandPalette() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const inputRef = useRef(null);
  const location = useLocation();

  const context = detectContext(location.pathname);
  const accentColor = CONTEXT_COLORS[context] || D.teal;
  const contextLabel = CONTEXT_LABELS[context] || 'Admin';

  // ⌘K / Ctrl+K listener
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Focus input when opening
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Load context-specific quick actions when context changes
  useEffect(() => {
    if (!open) return;
    adminFetch(`/admin/intelligence-bar/quick-actions?context=${context}`)
      .then(d => setQuickActions(d.actions || []))
      .catch(() => setQuickActions([]));
  }, [context, open]);

  // Clear conversation when context changes (navigated to different page)
  useEffect(() => {
    setConversationHistory([]);
    setResponse(null);
  }, [context]);

  const submit = useCallback(async (text) => {
    const q = (text || prompt).trim();
    if (!q || loading) return;
    setLoading(true); setResponse(null);

    try {
      const data = await adminFetch('/admin/intelligence-bar/query', {
        method: 'POST',
        body: JSON.stringify({
          prompt: q,
          conversationHistory,
          context,
          pageData: { route: location.pathname },
        }),
      });
      setResponse(data.response);
      setConversationHistory(data.conversationHistory || []);
    } catch (err) {
      setResponse(`Error: ${err.message}`);
    }
    setLoading(false); setPrompt('');
  }, [prompt, loading, conversationHistory, context, location.pathname]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setOpen(false); }
  };

  const clear = () => {
    setConversationHistory([]);
    setResponse(null);
    setPrompt('');
  };

  const close = () => {
    setOpen(false);
    // Don't clear conversation — user might reopen
  };

  if (!open) {
    // Render just the ⌘K hint in the sidebar or a floating button
    return null;
  }

  return (
    <>
      {/* Backdrop */}
      <div onClick={close} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)', zIndex: 9998,
      }} />

      {/* Palette */}
      <div style={{
        position: 'fixed', top: '10%', left: '50%', transform: 'translateX(-50%)',
        width: '90%', maxWidth: 640, maxHeight: '75vh',
        background: D.card, border: `1px solid ${D.border}`, borderRadius: 16,
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)', zIndex: 9999,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'paletteIn 0.15s ease',
      }}>

        {/* Header with context badge */}
        <div style={{
          padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: `1px solid ${D.border}44`,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            background: `linear-gradient(135deg, ${accentColor}, #6366f1)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, flexShrink: 0,
          }}>⚡</div>

          <div style={{ flex: 1, position: 'relative' }}>
            <input
              ref={inputRef}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              autoFocus
              style={{
                width: '100%', padding: '10px 14px', paddingRight: 90,
                background: D.bg, border: `1px solid ${D.border}`,
                borderRadius: 10, color: D.text, fontSize: 15,
                fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box',
              }}
              onFocusCapture={e => e.target.style.borderColor = accentColor + '66'}
              onBlurCapture={e => e.target.style.borderColor = D.border}
            />
            <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 4, alignItems: 'center' }}>
              {loading ? (
                <div style={{ padding: '5px 10px', borderRadius: 6, background: `${accentColor}22`, color: accentColor, fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', animation: 'pulse 1.5s ease infinite' }}>thinking...</div>
              ) : prompt.trim() ? (
                <button onClick={() => submit()} style={{
                  padding: '5px 12px', borderRadius: 6, background: accentColor, color: D.white,
                  border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}>Go</button>
              ) : (
                <span style={{ padding: '4px 8px', borderRadius: 4, background: D.bg, border: `1px solid ${D.border}`, fontSize: 10, color: D.muted, fontFamily: 'JetBrains Mono, monospace' }}>ESC</span>
              )}
            </div>
          </div>

          {/* Context badge */}
          <div style={{
            padding: '4px 10px', borderRadius: 8,
            background: `${accentColor}15`, border: `1px solid ${accentColor}33`,
            color: accentColor, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          }}>{contextLabel}</div>
        </div>

        {/* Quick Actions */}
        {!response && !loading && quickActions.length > 0 && (
          <div style={{ padding: '12px 18px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: `1px solid ${D.border}22` }}>
            {quickActions.map(a => (
              <button key={a.id} onClick={() => { setPrompt(a.prompt); submit(a.prompt); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '5px 12px', borderRadius: 9999,
                  background: D.bg, border: `1px solid ${D.border}`,
                  color: D.muted, fontSize: 12, fontWeight: 600,
                  fontFamily: 'DM Sans, sans-serif', cursor: 'pointer',
                  transition: 'all 0.1s',
                }}
                onMouseEnter={e => { e.target.style.borderColor = accentColor + '55'; e.target.style.color = accentColor; }}
                onMouseLeave={e => { e.target.style.borderColor = D.border; e.target.style.color = D.muted; }}
              >
                <span style={{ fontSize: 13 }}>{a.icon}</span>{a.label}
              </button>
            ))}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ padding: '14px 18px' }}>
            {[90, 70, 85, 55].map((w, i) => (
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
          <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
            <div style={{ fontSize: 13, lineHeight: 1.65, color: D.text, fontFamily: 'DM Sans, sans-serif' }}>
              {renderMarkdown(response)}
            </div>
          </div>
        )}

        {/* Footer with follow-up */}
        {response && !loading && (
          <div style={{ padding: '10px 18px', borderTop: `1px solid ${D.border}33`, display: 'flex', gap: 8 }}>
            <input
              value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Follow up..."
              style={{
                flex: 1, padding: '8px 12px', background: D.bg, border: `1px solid ${D.border}`,
                borderRadius: 8, color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none',
              }}
            />
            <button onClick={() => submit()} disabled={!prompt.trim()} style={{
              padding: '8px 14px', background: accentColor, color: D.white, border: 'none',
              borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              opacity: prompt.trim() ? 1 : 0.4,
            }}>Send</button>
            <button onClick={clear} style={{
              padding: '8px 10px', background: 'transparent', border: `1px solid ${D.border}`,
              borderRadius: 8, color: D.muted, fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}>Clear</button>
          </div>
        )}

        {/* Keyboard hint */}
        <div style={{
          padding: '6px 18px', borderTop: `1px solid ${D.border}22`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 10, color: D.border }}>
            Intelligence Bar — context: {contextLabel}
          </span>
          <span style={{ fontSize: 10, color: D.border, fontFamily: 'JetBrains Mono, monospace' }}>
            {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+K to toggle
          </span>
        </div>
      </div>

      <style>{`
        @keyframes paletteIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-10px) scale(0.98); }
          to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>
    </>
  );
}
