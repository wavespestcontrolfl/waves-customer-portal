/**
 * Global Command Palette (⌘K / mobile bottom sheet)
 * client/src/components/admin/GlobalCommandPalette.jsx
 *
 * Desktop: centered modal triggered by ⌘K / Ctrl+K from any admin page.
 * Mobile:  full-height bottom sheet triggered by the Sparkles button in
 *          the admin shell's top bar. Also opens via ⌘K if a keyboard
 *          is attached.
 *
 * Auto-detects which page you're on and loads the right context/tools.
 * Recent prompts (last 5) surfaced at the top on mobile for fast re-run.
 */

import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { useLocation } from 'react-router-dom';
import useIsMobile from '../../hooks/useIsMobile';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const RECENTS_KEY = 'admin_ib_recents';
const RECENTS_MAX = 5;
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#fff' };

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
  '/admin/estimates': 'estimates',
  '/admin/seo': 'seo',
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
  '/admin/banking': 'banking',
  '/admin/pricing-logic': 'revenue',
};

const CONTEXT_LABELS = {
  schedule: 'Schedule & Dispatch',
  dispatch: 'Dispatch',
  dashboard: 'Dashboard',
  customers: 'Customers',
  seo: 'SEO & Content',
  blog: 'Blog',
  procurement: 'Procurement',
  revenue: 'Revenue',
  reviews: 'Reviews & Reputation',
  comms: 'Communications',
  tax: 'Taxes',
  leads: 'Pipeline',
  email: 'Email',
  banking: 'Banking & Cash Flow',
  estimates: 'Estimates & Quoting Agent',
};

const CONTEXT_COLORS = {
  schedule: D.teal,
  dispatch: D.teal,
  dashboard: D.teal,
  customers: D.teal,
  seo: D.teal,
  blog: D.teal,
  procurement: D.purple,
  revenue: D.green,
  reviews: D.amber,
  comms: '#3b82f6',
  tax: D.purple,
  leads: D.amber,
  email: D.green,
  banking: D.green,
  estimates: D.teal,
};

function detectContext(pathname) {
  if (ROUTE_CONTEXT_MAP[pathname]) return ROUTE_CONTEXT_MAP[pathname];
  for (const [route, ctx] of Object.entries(ROUTE_CONTEXT_MAP)) {
    if (pathname.startsWith(route)) return ctx;
  }
  return 'dashboard';
}

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveRecent(prompt) {
  if (!prompt || !prompt.trim()) return;
  const t = prompt.trim();
  const list = loadRecents().filter(p => p !== t);
  list.unshift(t);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX))); } catch {}
}

// ─── Markdown renderer ──────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let key = 0;
  for (const line of lines) {
    if (line.startsWith('### ')) { elements.push(<div key={key++} style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginTop: 12, marginBottom: 4 }}>{line.slice(4)}</div>); continue; }
    if (line.startsWith('## ')) { elements.push(<div key={key++} style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginTop: 14, marginBottom: 6 }}>{line.slice(3)}</div>); continue; }
    if (line.match(/^[-•*]\s/)) { elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.teal, fontSize: 10, marginTop: 5 }}>●</span><span>{renderInline(line.replace(/^[-•*]\s/, ''))}</span></div>); continue; }
    if (line.match(/^\d+\.\s/)) { const num = line.match(/^(\d+)\./)[1]; elements.push(<div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}><span style={{ color: D.teal, fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', minWidth: 18 }}>{num}.</span><span>{renderInline(line.replace(/^\d+\.\s/, ''))}</span></div>); continue; }
    if (!line.trim()) { elements.push(<div key={key++} style={{ height: 8 }} />); continue; }
    elements.push(<div key={key++} style={{ marginBottom: 4 }}>{renderInline(line)}</div>);
  }
  return elements;
}

function renderInline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} style={{ color: '#0F172A', fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
    return part;
  });
}


// ─── MAIN COMPONENT ─────────────────────────────────────────────
function GlobalCommandPalette(_props, ref) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [recents, setRecents] = useState(() => loadRecents());
  const [dragY, setDragY] = useState(0);
  const dragStartRef = useRef(null);
  const inputRef = useRef(null);
  const location = useLocation();
  const isMobile = useIsMobile(768);

  const context = detectContext(location.pathname);
  const accentColor = CONTEXT_COLORS[context] || D.teal;
  const contextLabel = CONTEXT_LABELS[context] || 'Admin';

  useImperativeHandle(ref, () => ({
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(v => !v),
  }), []);

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

  // Focus input when opening + refresh recents
  useEffect(() => {
    if (open) {
      setRecents(loadRecents());
      setDragY(0);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open]);

  // Load context-specific quick actions when context changes
  useEffect(() => {
    if (!open) return;
    adminFetch(`/admin/intelligence-bar/quick-actions?context=${context}`)
      .then(d => setQuickActions(d.actions || []))
      .catch(() => setQuickActions([]));
  }, [context, open]);

  // Clear conversation when context changes
  useEffect(() => {
    setConversationHistory([]);
    setResponse(null);
  }, [context]);

  const submit = useCallback(async (text) => {
    const q = (text || prompt).trim();
    if (!q || loading) return;
    setLoading(true); setResponse(null);
    saveRecent(q);
    setRecents(loadRecents());

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

  const close = () => setOpen(false);

  // Touch handlers for swipe-down-to-close on mobile
  const onTouchStart = (e) => {
    if (!isMobile) return;
    dragStartRef.current = e.touches[0].clientY;
  };
  const onTouchMove = (e) => {
    if (!isMobile || dragStartRef.current == null) return;
    const dy = e.touches[0].clientY - dragStartRef.current;
    if (dy > 0) setDragY(dy);
  };
  const onTouchEnd = () => {
    if (!isMobile) return;
    if (dragY > 120) {
      setOpen(false);
    } else {
      setDragY(0);
    }
    dragStartRef.current = null;
  };

  if (!open) return null;

  if (isMobile) {
    return (
      <MobileSheet
        close={close}
        dragY={dragY}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        inputRef={inputRef}
        prompt={prompt}
        setPrompt={setPrompt}
        submit={submit}
        handleKeyDown={handleKeyDown}
        loading={loading}
        response={response}
        recents={recents}
        quickActions={quickActions}
        contextLabel={contextLabel}
        clear={clear}
      />
    );
  }

  // ─── Desktop centered modal (unchanged from original) ─────────
  return (
    <>
      <div onClick={close} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)', zIndex: 9998,
      }} />

      <div style={{
        position: 'fixed', top: '10%', left: '50%', transform: 'translateX(-50%)',
        width: '90%', maxWidth: 640, maxHeight: '75vh',
        background: D.card, border: `1px solid ${D.border}`, borderRadius: 16,
        boxShadow: '0 24px 80px rgba(0,0,0,0.15)', zIndex: 9999,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'paletteIn 0.15s ease',
      }}>

        <div style={{
          padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: `1px solid ${D.border}44`,
        }}>
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
                background: '#FFFFFF', border: `1px solid ${D.border}`,
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

          <div style={{
            padding: '4px 10px', borderRadius: 8,
            background: `${accentColor}15`, border: `1px solid ${accentColor}33`,
            color: accentColor, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          }}>{contextLabel}</div>
        </div>

        {!response && !loading && quickActions.length > 0 && (
          <div style={{ padding: '12px 18px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: `1px solid ${D.border}22` }}>
            {quickActions.map(a => (
              <button key={a.id} onClick={() => { setPrompt(a.prompt); submit(a.prompt); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '5px 12px', borderRadius: 9999,
                  background: '#FFFFFF', border: `1px solid ${D.border}`,
                  color: D.muted, fontSize: 12, fontWeight: 600,
                  fontFamily: 'DM Sans, sans-serif', cursor: 'pointer',
                  transition: 'all 0.1s',
                }}
                onMouseEnter={e => { e.target.style.borderColor = accentColor + '55'; e.target.style.color = accentColor; }}
                onMouseLeave={e => { e.target.style.borderColor = D.border; e.target.style.color = D.muted; }}
              >
                {a.icon && <span style={{ fontSize: 13 }}>{a.icon}</span>}{a.label}
              </button>
            ))}
          </div>
        )}

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

        {response && !loading && (
          <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
            <div style={{ fontSize: 13, lineHeight: 1.65, color: D.text, fontFamily: 'DM Sans, sans-serif' }}>
              {renderMarkdown(response)}
            </div>
          </div>
        )}

        {response && !loading && (
          <div style={{ padding: '10px 18px', borderTop: `1px solid ${D.border}33`, display: 'flex', gap: 8 }}>
            <input
              value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Follow up..."
              style={{
                flex: 1, padding: '8px 12px', background: '#FFFFFF', border: `1px solid ${D.border}`,
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

// ─── Mobile bottom sheet ───────────────────────────────────────
function MobileSheet({
  close, dragY, onTouchStart, onTouchMove, onTouchEnd, inputRef,
  prompt, setPrompt, submit, handleKeyDown, loading, response,
  recents, quickActions, contextLabel, clear,
}) {
  return (
    <>
      {/* Backdrop */}
      <div onClick={close} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 9998, touchAction: 'none',
      }} />

      {/* Sheet */}
      <div
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, top: 64,
          background: '#FFFFFF', zIndex: 9999,
          display: 'flex', flexDirection: 'column',
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          boxShadow: '0 -12px 40px rgba(0,0,0,0.18)',
          transform: `translateY(${dragY}px)`,
          transition: dragY === 0 ? 'transform 0.2s ease' : 'none',
          paddingBottom: 'env(safe-area-inset-bottom, 0)',
        }}
      >
        {/* Drag handle + header */}
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          style={{ paddingTop: 8, paddingBottom: 4, touchAction: 'pan-y' }}
        >
          <div style={{
            width: 40, height: 4, borderRadius: 2, background: '#D4D4D8',
            margin: '0 auto',
          }} />
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 16px 12px',
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 500, color: '#18181B', letterSpacing: '-0.01em' }}>
              Intelligence Bar
            </div>
            <div style={{ fontSize: 11, color: '#71717A', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
              {contextLabel}
            </div>
          </div>
          <button
            onClick={close}
            aria-label="Close"
            style={{
              width: 36, height: 36, borderRadius: 8, border: 'none',
              background: '#F4F4F5', color: '#18181B', fontSize: 18,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        </div>

        {/* Input */}
        <div style={{ padding: '0 16px 12px' }}>
          <input
            ref={inputRef}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything…"
            style={{
              width: '100%', padding: '14px 16px', boxSizing: 'border-box',
              background: '#FAFAFA', border: '1px solid #E4E4E7',
              borderRadius: 10, color: '#18181B', fontSize: 16,
              fontFamily: 'Inter, sans-serif', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={() => submit()}
              disabled={!prompt.trim() || loading}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 10, border: 'none',
                background: prompt.trim() && !loading ? '#18181B' : '#E4E4E7',
                color: prompt.trim() && !loading ? '#FFFFFF' : '#A1A1AA',
                fontSize: 14, fontWeight: 500, cursor: prompt.trim() && !loading ? 'pointer' : 'not-allowed',
                fontFamily: 'Inter, sans-serif', letterSpacing: '0.06em', textTransform: 'uppercase',
              }}
            >{loading ? 'Thinking…' : 'Ask'}</button>
            {(response || prompt) && (
              <button
                onClick={clear}
                style={{
                  padding: '12px 16px', borderRadius: 10, border: '1px solid #E4E4E7',
                  background: '#FFFFFF', color: '#52525B', fontSize: 13,
                  fontFamily: 'Inter, sans-serif', fontWeight: 500, cursor: 'pointer',
                }}
              >Clear</button>
            )}
          </div>
        </div>

        {/* Body: scrollable region below the input */}
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 16px 20px' }}>
          {loading && (
            <div style={{ padding: '8px 0' }}>
              {[90, 70, 85, 55].map((w, i) => (
                <div key={i} style={{
                  height: 14, borderRadius: 6, marginBottom: 8,
                  background: 'linear-gradient(90deg, #E4E4E744, #E4E4E7AA, #E4E4E744)',
                  backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease infinite', width: `${w}%`,
                }} />
              ))}
            </div>
          )}

          {response && !loading && (
            <div style={{ fontSize: 14, lineHeight: 1.7, color: '#27272A', fontFamily: 'Inter, sans-serif' }}>
              {renderMarkdown(response)}
            </div>
          )}

          {!response && !loading && recents.length > 0 && (
            <Section label="Recent">
              {recents.map((r, i) => (
                <SheetRow key={`r-${i}`} onClick={() => { setPrompt(r); submit(r); }}>
                  <span style={{ fontSize: 14, color: '#18181B' }}>{r}</span>
                </SheetRow>
              ))}
            </Section>
          )}

          {!response && !loading && quickActions.length > 0 && (
            <Section label="Quick actions">
              {quickActions.map(a => (
                <SheetRow key={a.id} onClick={() => { setPrompt(a.prompt); submit(a.prompt); }}>
                  {a.icon && <span style={{ fontSize: 16 }}>{a.icon}</span>}
                  <span style={{ fontSize: 14, color: '#18181B' }}>{a.label}</span>
                </SheetRow>
              ))}
            </Section>
          )}

          {!response && !loading && recents.length === 0 && quickActions.length === 0 && (
            <div style={{
              padding: '32px 16px', textAlign: 'center',
              fontSize: 13, color: '#71717A',
            }}>
              Ask a question, or try a quick action once they load.
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      `}</style>
    </>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 10, fontWeight: 500, color: '#71717A',
        letterSpacing: '0.06em', textTransform: 'uppercase',
        padding: '6px 4px',
      }}>{label}</div>
      <div style={{
        background: '#FFFFFF', border: '1px solid #E4E4E7', borderRadius: 10,
        overflow: 'hidden',
      }}>{children}</div>
    </div>
  );
}

function SheetRow({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        width: '100%', padding: '14px 16px',
        background: '#FFFFFF', border: 'none',
        borderBottom: '0.5px solid #E4E4E7',
        cursor: 'pointer', textAlign: 'left',
        minHeight: 52,
      }}
    >{children}</button>
  );
}

export default forwardRef(GlobalCommandPalette);
