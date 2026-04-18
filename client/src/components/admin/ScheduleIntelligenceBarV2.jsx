/**
 * Schedule Intelligence Bar — V2 (monochrome)
 * client/src/components/admin/ScheduleIntelligenceBarV2.jsx
 *
 * Monochrome reskin of ScheduleIntelligenceBar. Strict 1:1 on data/behavior:
 *   - same POST /admin/intelligence-bar/query (context: 'schedule')
 *   - same GET  /admin/intelligence-bar/quick-actions?context=schedule
 *   - same buildPageData() payload (date, services, unassigned, techSummary, weather)
 *   - same write-tool refresh trigger
 *   - same conversation-history threading
 * Visual changes: flat hairline container (no gradient), zinc-900 Ask button,
 * plain dot bullets, alert-fg for error messages and unassigned count.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '../ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function renderInline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-ink-primary font-medium">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let key = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('### ')) {
      elements.push(<div key={key++} className="text-14 font-medium text-ink-primary mt-3 mb-1">{line.slice(4)}</div>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<div key={key++} className="text-16 font-medium text-ink-primary mt-4 mb-2">{line.slice(3)}</div>);
      continue;
    }
    if (line.match(/^[-•*]\s/)) {
      elements.push(
        <div key={key++} className="flex gap-2 pl-1 mb-1">
          <span className="u-dot u-dot--filled mt-1.5 flex-shrink-0" />
          <span>{renderInline(line.replace(/^[-•*]\s/, ''))}</span>
        </div>
      );
      continue;
    }
    if (line.match(/^\d+\.\s/)) {
      const num = line.match(/^(\d+)\./)[1];
      elements.push(
        <div key={key++} className="flex gap-2 pl-1 mb-1">
          <span className="u-nums text-12 font-medium text-ink-primary min-w-[1.25rem]">{num}.</span>
          <span>{renderInline(line.replace(/^\d+\.\s/, ''))}</span>
        </div>
      );
      continue;
    }
    if (!line.trim()) {
      elements.push(<div key={key++} className="h-2" />);
      continue;
    }
    elements.push(<div key={key++} className="mb-1">{renderInline(line)}</div>);
  }
  return elements;
}

function QuickChip({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center h-6 px-3 text-11 font-medium border-hairline border-zinc-200 bg-white text-ink-secondary rounded-sm hover:bg-zinc-50 hover:text-ink-primary u-focus-ring transition-colors whitespace-nowrap"
    >
      {label}
    </button>
  );
}

export default function ScheduleIntelligenceBarV2({ date, scheduleData, onRefresh }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [, setStructuredData] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    adminFetch('/admin/intelligence-bar/quick-actions?context=schedule')
      .then((d) => setQuickActions(d.actions || []))
      .catch(() => {
        setQuickActions([
          { id: 'day_briefing', label: 'Day Briefing', prompt: 'Give me a full briefing for today' },
          { id: 'optimize', label: 'Optimize Routes', prompt: 'Optimize all routes for today' },
          { id: 'unassigned', label: 'Unassigned', prompt: 'Show me unassigned stops and suggest tech assignments' },
          { id: 'zone_density', label: 'Zone Density', prompt: 'Analyze zone density — any consolidation opportunities?' },
          { id: 'gaps', label: 'Gaps This Week', prompt: 'Where do we have open capacity this week?' },
          { id: 'far_out', label: 'Far-Out Appts', prompt: 'Find appointments more than 30 days out that we could move sooner' },
        ]);
      });
  }, []);

  const buildPageData = useCallback(() => {
    const pd = {
      current_date: date,
      current_date_formatted: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    };

    if (scheduleData) {
      pd.total_services = scheduleData.services?.length || 0;
      pd.completed = scheduleData.services?.filter((s) => s.status === 'completed').length || 0;
      pd.remaining = pd.total_services - pd.completed;
      pd.unassigned_count = scheduleData.unassigned?.length || 0;

      if (scheduleData.techSummary) {
        pd.technicians = scheduleData.techSummary.map((t) => ({
          name: t.techName || t.name,
          stops: t.totalServices || t.services?.length || 0,
          completed: t.completedServices || 0,
          zones: t.zones || {},
        }));
      }

      if (scheduleData.unassigned?.length > 0) {
        pd.unassigned_stops = scheduleData.unassigned.slice(0, 10).map((s) => ({
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

      const writeTools = ['optimize_all_routes', 'optimize_tech_route', 'assign_technician', 'move_stops_to_day', 'swap_tech_assignments', 'create_appointment', 'reschedule_appointment', 'cancel_appointment'];
      const didWrite = (data.toolCalls || []).some((tc) => writeTools.includes(tc.name));
      if (didWrite && onRefresh) {
        setTimeout(() => onRefresh(), 500);
      }
    } catch (err) {
      setResponse(`Error: ${err.message}`);
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

  const totalServices = scheduleData?.services?.length || 0;
  const completedCount = scheduleData?.services?.filter((s) => s.status === 'completed').length || 0;
  const unassignedCount = scheduleData?.unassigned?.length || 0;

  const isError = response && response.startsWith('Error:');

  return (
    <div className="bg-white border-hairline border-zinc-200 rounded-sm mb-4 overflow-hidden">
      {/* Command Bar */}
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px] relative">
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setExpanded(true)}
            placeholder="Optimize routes, assign techs, find gaps, move stops…"
            className="w-full h-9 pl-3 pr-20 bg-white border-hairline border-zinc-200 rounded-sm text-13 text-ink-primary placeholder-ink-tertiary focus:outline-none focus:border-zinc-900 u-focus-ring"
          />
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
            {loading ? (
              <span className="u-label text-ink-secondary px-2 animate-pulse">thinking…</span>
            ) : (
              <button
                onClick={() => submit()}
                disabled={!prompt.trim()}
                className={cn(
                  'h-6 px-3 text-11 uppercase tracking-label font-medium rounded-xs u-focus-ring transition-colors',
                  prompt.trim()
                    ? 'bg-zinc-900 text-white hover:bg-zinc-800'
                    : 'bg-transparent text-ink-tertiary opacity-40'
                )}
              >
                Ask ↵
              </button>
            )}
          </div>
        </div>

        {/* Inline stats */}
        {totalServices > 0 && !expanded && (
          <div className="flex gap-3 u-nums text-11 text-ink-secondary flex-shrink-0">
            <span><strong className="text-ink-primary font-medium">{totalServices}</strong> stops</span>
            <span><strong className="text-ink-primary font-medium">{completedCount}</strong> done</span>
            {unassignedCount > 0 && (
              <span><strong className="text-alert-fg font-medium">{unassignedCount}</strong> unassigned</span>
            )}
          </div>
        )}

        {(response || conversationHistory.length > 0) && (
          <button
            onClick={clearConversation}
            className="h-6 px-2 u-label text-ink-secondary border-hairline border-zinc-200 rounded-xs hover:bg-zinc-50 u-focus-ring"
          >
            Clear
          </button>
        )}
      </div>

      {/* Quick Actions */}
      {expanded && !response && !loading && quickActions.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-2">
          {quickActions.map((a) => (
            <QuickChip
              key={a.id}
              label={a.label}
              onClick={() => { setPrompt(a.prompt); submit(a.prompt); }}
            />
          ))}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            {[90, 70, 85].map((w, i) => (
              <div
                key={i}
                className="h-3 bg-zinc-100 rounded-xs animate-pulse"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Response */}
      {response && !loading && (
        <div className="px-4 pb-4 pt-1 border-t border-hairline border-zinc-200 max-h-[420px] overflow-y-auto">
          <div className={cn(
            'text-13 leading-relaxed mt-3',
            isError ? 'text-alert-fg' : 'text-ink-primary'
          )}>
            {renderMarkdown(response)}
          </div>

          {/* Follow-up input */}
          <div className="mt-3 flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Follow up — 'do it', 'assign to Adam', 'move to Thursday'…"
              className="flex-1 h-8 px-3 bg-white border-hairline border-zinc-200 rounded-sm text-12 text-ink-primary placeholder-ink-tertiary focus:outline-none focus:border-zinc-900 u-focus-ring"
            />
            <button
              onClick={() => submit()}
              disabled={!prompt.trim() || loading}
              className={cn(
                'h-8 px-3 text-11 uppercase tracking-label font-medium rounded-sm u-focus-ring transition-colors',
                prompt.trim()
                  ? 'bg-zinc-900 text-white hover:bg-zinc-800'
                  : 'bg-zinc-100 text-ink-tertiary opacity-40'
              )}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
