import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#fff', heading: '#0F172A', inputBg: '#FFFFFF' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// ─── Markdown-lite renderer (bold, bullets, headers) ────────────
function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let key = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Headers
    if (line.startsWith('### ')) {
      elements.push(<div key={key++} style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginTop: 12, marginBottom: 4 }}>{line.slice(4)}</div>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<div key={key++} style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginTop: 14, marginBottom: 6 }}>{line.slice(3)}</div>);
      continue;
    }

    // Bullet points
    if (line.match(/^[-•*]\s/)) {
      const content = line.replace(/^[-•*]\s/, '');
      elements.push(
        <div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}>
          <span style={{ color: D.teal, fontSize: 10, marginTop: 5 }}>●</span>
          <span>{renderInline(content)}</span>
        </div>
      );
      continue;
    }

    // Numbered lists
    if (line.match(/^\d+\.\s/)) {
      const num = line.match(/^(\d+)\./)[1];
      const content = line.replace(/^\d+\.\s/, '');
      elements.push(
        <div key={key++} style={{ display: 'flex', gap: 8, paddingLeft: 4, marginBottom: 3 }}>
          <span style={{ color: D.teal, fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', minWidth: 18 }}>{num}.</span>
          <span>{renderInline(content)}</span>
        </div>
      );
      continue;
    }

    // Empty line = spacing
    if (!line.trim()) {
      elements.push(<div key={key++} style={{ height: 8 }} />);
      continue;
    }

    // Regular paragraph
    elements.push(<div key={key++} style={{ marginBottom: 4 }}>{renderInline(line)}</div>);
  }

  return elements;
}

function renderInline(text) {
  // Bold
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: D.heading, fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
    }
    // Inline code
    if (part.includes('`')) {
      const codeParts = part.split(/(`[^`]+`)/g);
      return codeParts.map((cp, j) => {
        if (cp.startsWith('`') && cp.endsWith('`')) {
          return <code key={`${i}-${j}`} style={{ background: `${D.teal}15`, color: D.teal, padding: '1px 5px', borderRadius: 4, fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>{cp.slice(1, -1)}</code>;
        }
        return cp;
      });
    }
    return part;
  });
}


// ─── Quick Action Chip ──────────────────────────────────────────
function QuickChip({ icon, label, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '5px 12px', borderRadius: 9999,
        background: hover ? `${D.teal}22` : `${D.card}`,
        border: `1px solid ${hover ? D.teal + '55' : D.border}`,
        color: hover ? D.teal : '#000', fontSize: 12, fontWeight: 600,
        fontFamily: "'Roboto', system-ui, sans-serif", cursor: 'pointer',
        transition: 'all 0.15s ease', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 13 }}>{icon}</span>
      {label}
    </button>
  );
}


// ─── Customer Row (for results) ─────────────────────────────────
function CustomerRow({ customer, onSelect }) {
  const [hover, setHover] = useState(false);
  const c = customer;
  const tierColor = { Gold: D.amber, Silver: '#94a3b8', Bronze: '#cd7f32', Platinum: '#a855f7' }[c.tier] || D.muted;

  return (
    <div
      onClick={() => onSelect?.(c.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
        background: hover ? `${D.teal}08` : 'transparent',
        borderBottom: `1px solid ${D.border}33`, cursor: 'pointer',
        transition: 'background 0.1s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unnamed'}
        </div>
        <div style={{ fontSize: 11, color: '#000' }}>
          {c.city || '—'}{c.phone ? ` · ${c.phone}` : ''}
        </div>
      </div>
      {c.tier && (
        <span style={{
          padding: '2px 8px', borderRadius: 9999, fontSize: 9, fontWeight: 700,
          border: `1px solid ${tierColor}`, color: tierColor, letterSpacing: 0.5, textTransform: 'uppercase',
        }}>{c.tier}</span>
      )}
      {c.health_score != null && (
        <span style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 600,
          color: c.health_score > 70 ? D.green : c.health_score >= 40 ? D.amber : D.red,
        }}>{c.health_score}</span>
      )}
      {c.days_overdue != null && (
        <span style={{
          padding: '2px 8px', borderRadius: 9999, fontSize: 10, fontWeight: 700,
          background: c.days_overdue > 30 ? `${D.red}22` : `${D.amber}22`,
          color: c.days_overdue > 30 ? D.red : D.amber,
        }}>{c.days_overdue}d overdue</span>
      )}
      {c.monthly_rate > 0 && (
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: D.green }}>
          ${c.monthly_rate.toFixed(0)}/mo
        </span>
      )}
    </div>
  );
}


// ─── MAIN COMPONENT ─────────────────────────────────────────────
export default function IntelligenceBar({ onSelectCustomer }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [structuredData, setStructuredData] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [recentPrompts, setRecentPrompts] = useState([]);
  const inputRef = useRef(null);

  // Load quick actions
  useEffect(() => {
    adminFetch('/admin/intelligence-bar/quick-actions')
      .then(d => setQuickActions(d.actions || []))
      .catch(() => {
        // Fallback quick actions if endpoint not deployed yet
        setQuickActions([
          { id: 'missing_city', label: 'Missing Cities', prompt: 'Show me customers with no city on their profile', icon: '📍' },
          { id: 'pest_overdue', label: 'Pest Overdue', prompt: 'Which quarterly pest control customers are overdue for service?', icon: '🐛' },
          { id: 'lawn_overdue', label: 'Lawn Overdue', prompt: 'Which monthly lawn care customers are overdue?', icon: '🌿' },
          { id: 'at_risk', label: 'At Risk', prompt: 'Show me customers with health scores below 40', icon: '⚠️' },
          { id: 'high_balance', label: 'Balances', prompt: 'Who has an outstanding balance over $100?', icon: '💰' },
          { id: 'duplicates', label: 'Duplicates', prompt: 'Find duplicate customers by phone number', icon: '👥' },
          { id: 'tech_perf', label: 'Tech Stats', prompt: 'Compare technician performance this month', icon: '📊' },
          { id: 'win_back', label: 'Win Back', prompt: 'Show churned Gold/Platinum customers from the last 6 months', icon: '🔄' },
        ]);
      });
  }, []);

  const submit = useCallback(async (text) => {
    const q = (text || prompt).trim();
    if (!q || loading) return;

    setLoading(true);
    setExpanded(true);
    setResponse(null);
    setStructuredData(null);

    // Save to recent prompts
    setRecentPrompts(prev => {
      const filtered = prev.filter(p => p !== q);
      return [q, ...filtered].slice(0, 5);
    });

    try {
      const data = await adminFetch('/admin/intelligence-bar/query', {
        method: 'POST',
        body: JSON.stringify({ prompt: q, conversationHistory }),
      });

      setResponse(data.response);
      setStructuredData(data.structuredData);
      setConversationHistory(data.conversationHistory || []);
    } catch (err) {
      setResponse(`⚠️ Error: ${err.message}. Make sure the intelligence-bar route is registered and ANTHROPIC_API_KEY is set.`);
    }

    setLoading(false);
    setPrompt('');
  }, [prompt, loading, conversationHistory]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      setExpanded(false);
      setPrompt('');
    }
  };

  const handleQuickAction = (action) => {
    setPrompt(action.prompt);
    submit(action.prompt);
  };

  const clearConversation = () => {
    setConversationHistory([]);
    setResponse(null);
    setStructuredData(null);
    setExpanded(false);
  };

  // Extract customer lists from structured data for rendering
  const customerList = structuredData?.customers || structuredData?.overdue_customers || null;

  return (
    <div style={{
      background: `linear-gradient(135deg, ${D.card} 0%, ${D.bg} 100%)`,
      border: `1px solid ${D.border}`,
      borderRadius: 14,
      marginBottom: 16,
      overflow: 'hidden',
      transition: 'all 0.2s ease',
    }}>
      {/* ── Command Bar ────────────────────────────────── */}
      <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 10,
          background: `linear-gradient(135deg, ${D.teal}, #6366f1)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, flexShrink: 0,
        }}>⚡</div>

        <div style={{ flex: 1, position: 'relative' }}>
          <input
            ref={inputRef}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setExpanded(true)}
            placeholder="Questions? Ask Waves AI…"
            style={{
              width: '100%', padding: '10px 14px', paddingRight: 80,
              background: D.inputBg, border: `1px solid ${D.border}`,
              borderRadius: 10, color: '#000', fontSize: 14,
              fontFamily: "'Roboto', system-ui, sans-serif", outline: 'none',
              boxSizing: 'border-box',
              transition: 'border-color 0.15s',
            }}
            onFocusCapture={e => e.target.style.borderColor = D.teal + '66'}
            onBlurCapture={e => e.target.style.borderColor = D.border}
          />
          <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 4 }}>
            {loading ? (
              <div style={{
                padding: '5px 12px', borderRadius: 8,
                background: `${D.teal}22`, color: D.teal,
                fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace',
                animation: 'pulse 1.5s ease infinite',
              }}>thinking...</div>
            ) : (
              <button
                onClick={() => submit()}
                disabled={!prompt.trim()}
                style={{
                  padding: '5px 14px', borderRadius: 8,
                  background: prompt.trim() ? D.teal : 'transparent',
                  color: prompt.trim() ? D.white : D.muted,
                  border: `1px solid ${prompt.trim() ? D.teal : D.border}`,
                  fontSize: 12, fontWeight: 700, cursor: prompt.trim() ? 'pointer' : 'default',
                  fontFamily: "'Roboto', system-ui, sans-serif",
                  opacity: prompt.trim() ? 1 : 0.4,
                  transition: 'all 0.15s',
                }}
              >Ask ↵</button>
            )}
          </div>
        </div>

        {(response || conversationHistory.length > 0) && (
          <button onClick={clearConversation} style={{
            padding: '6px 10px', background: 'transparent',
            border: `1px solid ${D.border}`, borderRadius: 8,
            color: '#000', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            fontFamily: "'Roboto', system-ui, sans-serif", whiteSpace: 'nowrap',
          }}>Clear</button>
        )}
      </div>

      {/* ── Quick Action Chips ────────────────────────── */}
      {expanded && !response && !loading && (
        <div style={{
          padding: '0 18px 14px',
          display: 'flex', flexWrap: 'wrap', gap: 6,
        }}>
          {quickActions.map(a => (
            <QuickChip key={a.id} icon={a.icon} label={a.label} onClick={() => handleQuickAction(a)} />
          ))}
        </div>
      )}

      {/* ── Recent Prompts ────────────────────────────── */}
      {expanded && !response && !loading && recentPrompts.length > 0 && (
        <div style={{ padding: '0 18px 14px' }}>
          <div style={{ fontSize: 10, color: '#000', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Recent</div>
          {recentPrompts.map((p, i) => (
            <div
              key={i}
              onClick={() => { setPrompt(p); submit(p); }}
              style={{
                padding: '6px 12px', fontSize: 12, color: '#000', cursor: 'pointer',
                borderRadius: 6, marginBottom: 2,
                transition: 'all 0.1s',
              }}
              onMouseEnter={e => { e.target.style.background = `${D.teal}11`; e.target.style.color = D.text; }}
              onMouseLeave={e => { e.target.style.background = 'transparent'; e.target.style.color = D.muted; }}
            >
              ↩ {p}
            </div>
          ))}
        </div>
      )}

      {/* ── Loading Skeleton ──────────────────────────── */}
      {loading && (
        <div style={{ padding: '12px 18px 18px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[90, 70, 85, 60].map((w, i) => (
              <div key={i} style={{
                height: 14, borderRadius: 6,
                background: `linear-gradient(90deg, ${D.border}44, ${D.border}88, ${D.border}44)`,
                backgroundSize: '200% 100%',
                animation: 'shimmer 1.5s ease infinite',
                width: `${w}%`,
              }} />
            ))}
          </div>
          <style>{`
            @keyframes shimmer {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
            }
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.5; }
            }
          `}</style>
        </div>
      )}

      {/* ── Response Panel ────────────────────────────── */}
      {response && !loading && (
        <div style={{
          padding: '2px 18px 18px',
          borderTop: `1px solid ${D.border}33`,
          maxHeight: 520, overflowY: 'auto',
        }}>
          {/* Claude's text response */}
          <div style={{
            fontSize: 13, lineHeight: 1.65, color: '#000',
            fontFamily: "'Roboto', system-ui, sans-serif",
          }}>
            {renderMarkdown(response)}
          </div>

          {/* Structured customer list if available */}
          {customerList && customerList.length > 0 && (
            <div style={{
              marginTop: 14, background: D.inputBg,
              border: `1px solid ${D.border}`, borderRadius: 10,
              overflow: 'hidden', maxHeight: 300, overflowY: 'auto',
            }}>
              <div style={{
                padding: '8px 12px', background: `${D.teal}0a`,
                borderBottom: `1px solid ${D.border}33`,
                fontSize: 11, fontWeight: 700, color: '#000',
                textTransform: 'uppercase', letterSpacing: 0.8,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>Results ({customerList.length})</span>
                {structuredData?.total_matching != null && structuredData.total_matching > customerList.length && (
                  <span style={{ color: D.teal, textTransform: 'none', letterSpacing: 0 }}>
                    showing {customerList.length} of {structuredData.total_matching}
                  </span>
                )}
              </div>
              {customerList.map((c, i) => (
                <CustomerRow key={c.id || i} customer={c} onSelect={onSelectCustomer} />
              ))}
            </div>
          )}

          {/* Follow-up input */}
          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <input
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Follow up..."
              style={{
                flex: 1, padding: '8px 12px',
                background: D.inputBg, border: `1px solid ${D.border}`,
                borderRadius: 8, color: '#000', fontSize: 13,
                fontFamily: "'Roboto', system-ui, sans-serif", outline: 'none',
              }}
            />
            <button
              onClick={() => submit()}
              disabled={!prompt.trim() || loading}
              style={{
                padding: '8px 16px', background: D.teal, color: D.white,
                border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: "'Roboto', system-ui, sans-serif",
                opacity: prompt.trim() ? 1 : 0.4,
              }}
            >Send</button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
