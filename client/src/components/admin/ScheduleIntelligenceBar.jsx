/**
 * Schedule Intelligence Bar
 * client/src/components/admin/ScheduleIntelligenceBar.jsx
 *
 * Wraps IntelligenceBar with schedule-specific context:
 * - Current date being viewed
 * - Tech summary (names, stop counts, zones)
 * - Unassigned count
 * - Completion progress
 * - Schedule-specific quick actions
 *
 * Replaces: Optimize Routes button + AI Routes tab
 */

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

// Markdown renderer (same as IntelligenceBar)
function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let key = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith('### ')) { elements.push(<div key={key++} style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginTop: 12, marginBottom: 4 }}>{line.slice(4)}</div>); continue; }
    if (line.startsWith('## ')) { elements.push(<div key={key++} style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginTop: 14, marginBottom: 6 }}>{line.slice(3)}</div>); continue; }
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
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} style={{ color: D.heading, fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function QuickChip({ icon, label, onClick, active }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '5px 12px', borderRadius: 9999,
      background: active ? `${D.teal}22` : hover ? `${D.teal}11` : D.card,
      border: `1px solid ${active ? D.teal : hover ? D.teal + '55' : D.border}`,
      color: active ? D.teal : hover ? D.teal : D.muted, fontSize: 12, fontWeight: 600,
      fontFamily: 'DM Sans, sans-serif', cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 13 }}>{icon}</span>{label}
    </button>
  );
}


export default function ScheduleIntelligenceBar({ date, scheduleData, onRefresh }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [structuredData, setStructuredData] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);

  // Load schedule-specific quick actions
  useEffect(() => {
    adminFetch('/admin/intelligence-bar/quick-actions?context=schedule')
      .then(d => setQuickActions(d.actions || []))
      .catch(() => {
        setQuickActions([
          { id: 'day_briefing', label: 'Day Briefing', prompt: 'Give me a full briefing for today', icon: '📋' },
          { id: 'optimize', label: 'Optimize Routes', prompt: 'Optimize all routes for today', icon: '🗺️' },
          { id: 'unassigned', label: 'Unassigned', prompt: 'Show me unassigned stops and suggest tech assignments', icon: '❓' },
          { id: 'zone_density', label: 'Zone Density', prompt: 'Analyze zone density — any consolidation opportunities?', icon: '📍' },
          { id: 'gaps', label: 'Gaps This Week', prompt: 'Where do we have open capacity this week?', icon: '📅' },
          { id: 'far_out', label: 'Far-Out Appts', prompt: 'Find appointments more than 30 days out that we could move sooner', icon: '⏩' },
        ]);
      });
  }, []);

  // Build live page data to inject into the system prompt
  const buildPageData = useCallback(() => {
    const pd = {
      current_date: date,
      current_date_formatted: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    };

    if (scheduleData) {
      pd.total_services = scheduleData.services?.length || 0;
      pd.completed = scheduleData.services?.filter(s => s.status === 'completed').length || 0;
      pd.remaining = pd.total_services - pd.completed;
      pd.unassigned_count = scheduleData.unassigned?.length || 0;

      if (scheduleData.techSummary) {
        pd.technicians = scheduleData.techSummary.map(t => ({
          name: t.techName || t.name,
          stops: t.totalServices || t.services?.length || 0,
          completed: t.completedServices || 0,
          zones: t.zones || {},
        }));
      }

      if (scheduleData.unassigned?.length > 0) {
        pd.unassigned_stops = scheduleData.unassigned.slice(0, 10).map(s => ({
          id: s.id,
          customer: `${s.firstName || s.first_name || ''} ${s.lastName || s.last_name || ''}`.trim(),
          city: s.city,
          service_type: s.serviceType || s.service_type,
        }));
      }

      if (scheduleData.weather) {
        pd.weather = scheduleData.weather;
      }
    }

    return pd;
  }, [date, scheduleData]);

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
          context: 'schedule',
          pageData: buildPageData(),
        }),
      });

      setResponse(data.response);
      setStructuredData(data.structuredData);
      setConversationHistory(data.conversationHistory || []);

      // If a write action was performed, refresh the schedule
      const writeTools = ['optimize_all_routes', 'optimize_tech_route', 'assign_technician', 'move_stops_to_day', 'swap_tech_assignments', 'create_appointment', 'reschedule_appointment', 'cancel_appointment'];
      const didWrite = (data.toolCalls || []).some(tc => writeTools.includes(tc.name));
      if (didWrite && onRefresh) {
        setTimeout(() => onRefresh(), 500);
      }
    } catch (err) {
      setResponse(`⚠️ Error: ${err.message}`);
    }

    setLoading(false);
    setPrompt('');
  }, [prompt, loading, conversationHistory, buildPageData, onRefresh]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setExpanded(false); setPrompt(''); }
  };

  const clearConversation = () => {
    setConversationHistory([]);
    setResponse(null);
    setStructuredData(null);
    setExpanded(false);
  };

  // Derive schedule stats for the bar header
  const totalServices = scheduleData?.services?.length || 0;
  const completedCount = scheduleData?.services?.filter(s => s.status === 'completed').length || 0;
  const unassignedCount = scheduleData?.unassigned?.length || 0;

  return (
    <div style={{
      background: `linear-gradient(135deg, ${D.card} 0%, ${D.bg} 100%)`,
      border: `1px solid ${D.border}`,
      borderRadius: 14, marginBottom: 16, overflow: 'hidden',
      transition: 'all 0.2s ease',
    }}>
      {/* ── Command Bar ── */}
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 9,
          background: `linear-gradient(135deg, ${D.teal}, #6366f1)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, flexShrink: 0,
        }}>⚡</div>

        <div style={{ flex: 1, position: 'relative' }}>
          <input
            ref={inputRef}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setExpanded(true)}
            placeholder="Optimize routes, assign techs, find gaps, move stops..."
            style={{
              width: '100%', padding: '9px 14px', paddingRight: 80,
              background: D.inputBg, border: `1px solid ${D.border}`,
              borderRadius: 10, color: D.text, fontSize: 13,
              fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box',
            }}
            onFocusCapture={e => e.target.style.borderColor = D.teal + '66'}
            onBlurCapture={e => e.target.style.borderColor = D.border}
          />
          <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}>
            {loading ? (
              <div style={{ padding: '4px 10px', borderRadius: 6, background: `${D.teal}22`, color: D.teal, fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', animation: 'pulse 1.5s ease infinite' }}>thinking...</div>
            ) : (
              <button onClick={() => submit()} disabled={!prompt.trim()} style={{
                padding: '4px 12px', borderRadius: 6,
                background: prompt.trim() ? D.teal : 'transparent',
                color: prompt.trim() ? D.white : D.muted,
                border: `1px solid ${prompt.trim() ? D.teal : D.border}`,
                fontSize: 11, fontWeight: 700, cursor: prompt.trim() ? 'pointer' : 'default',
                fontFamily: 'DM Sans, sans-serif', opacity: prompt.trim() ? 1 : 0.4,
              }}>Ask ↵</button>
            )}
          </div>
        </div>

        {/* Inline stats */}
        {totalServices > 0 && !expanded && (
          <div style={{ display: 'flex', gap: 8, fontSize: 11, color: D.muted, flexShrink: 0 }}>
            <span><strong style={{ color: D.heading }}>{totalServices}</strong> stops</span>
            <span><strong style={{ color: D.green }}>{completedCount}</strong> done</span>
            {unassignedCount > 0 && <span><strong style={{ color: D.red }}>{unassignedCount}</strong> unassigned</span>}
          </div>
        )}

        {(response || conversationHistory.length > 0) && (
          <button onClick={clearConversation} style={{
            padding: '5px 8px', background: 'transparent', border: `1px solid ${D.border}`,
            borderRadius: 6, color: D.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'DM Sans, sans-serif',
          }}>Clear</button>
        )}
      </div>

      {/* ── Quick Actions ── */}
      {expanded && !response && !loading && (
        <div style={{ padding: '0 16px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {quickActions.map(a => (
            <QuickChip key={a.id} icon={a.icon} label={a.label} onClick={() => { setPrompt(a.prompt); submit(a.prompt); }} />
          ))}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ padding: '8px 16px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[90, 70, 85].map((w, i) => (
              <div key={i} style={{
                height: 12, borderRadius: 6,
                background: `linear-gradient(90deg, ${D.border}44, ${D.border}88, ${D.border}44)`,
                backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease infinite', width: `${w}%`,
              }} />
            ))}
          </div>
        </div>
      )}

      {/* ── Response ── */}
      {response && !loading && (
        <div style={{
          padding: '2px 16px 16px', borderTop: `1px solid ${D.border}33`,
          maxHeight: 420, overflowY: 'auto',
        }}>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: D.text, fontFamily: 'DM Sans, sans-serif' }}>
            {renderMarkdown(response)}
          </div>

          {/* Follow-up input */}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <input
              value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Follow up — 'do it', 'assign to Adam', 'move to Thursday'..."
              style={{
                flex: 1, padding: '7px 12px', background: D.inputBg, border: `1px solid ${D.border}`,
                borderRadius: 8, color: D.text, fontSize: 12, fontFamily: 'DM Sans, sans-serif', outline: 'none',
              }}
            />
            <button onClick={() => submit()} disabled={!prompt.trim() || loading} style={{
              padding: '7px 14px', background: D.teal, color: D.white, border: 'none',
              borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
              opacity: prompt.trim() ? 1 : 0.4,
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
