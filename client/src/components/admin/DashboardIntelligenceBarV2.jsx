/**
 * Dashboard Intelligence Bar — V2 (monochrome)
 * client/src/components/admin/DashboardIntelligenceBarV2.jsx
 *
 * Monochrome reskin of DashboardIntelligenceBar. Strict 1:1 on data/behavior:
 *   - same POST /admin/intelligence-bar/query (context: 'dashboard')
 *   - same GET  /admin/intelligence-bar/quick-actions?context=dashboard
 *   - same buildPageData() payload (revenue/customers/MRR/rating)
 *   - same conversation-history threading + clear behavior
 * Visual changes: hairline white container (no gradient), zinc-900 Ask button,
 * dropped icon chip + quick-action emojis, alert-fg only on errors.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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
  for (const line of lines) {
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

export default function DashboardIntelligenceBarV2({ kpiData }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [, setStructuredData] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    adminFetch('/admin/intelligence-bar/quick-actions?context=dashboard')
      .then((d) => setQuickActions(d.actions || []))
      .catch(() => {
        setQuickActions([
          { id: 'briefing', label: 'Morning Briefing', prompt: 'Give me a morning briefing' },
          { id: 'week_compare', label: 'This vs Last Week', prompt: 'How did we do this week vs last week?' },
          { id: 'mrr', label: 'MRR Trend', prompt: "What's our MRR trend?" },
          { id: 'close_rate', label: 'Close Rate', prompt: "What's our estimate close rate?" },
          { id: 'revenue', label: 'Revenue Breakdown', prompt: 'Break down revenue by service type' },
          { id: 'churn', label: 'Churn Check', prompt: 'Any churn this month?' },
          { id: 'leads', label: 'Lead Sources', prompt: 'Where are new customers coming from?' },
          { id: 'balances', label: 'Balances', prompt: "What's outstanding?" },
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
      setResponse(`Error: ${err.message}`);
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
            placeholder="How did we do this week? What's my MRR trend? Morning briefing…"
            className="w-full h-9 pl-3 pr-20 bg-white border-hairline border-zinc-200 rounded-sm text-13 text-ink-primary placeholder-ink-tertiary focus:outline-none focus:border-zinc-900 u-focus-ring"
          />
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
            {loading ? (
              <span className="u-label text-ink-secondary px-2 animate-pulse">analyzing…</span>
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

        {(response || conversationHistory.length > 0) && (
          <button
            onClick={clear}
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
            {[92, 75, 88, 60].map((w, i) => (
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
        <div className="px-4 pb-4 pt-1 border-t border-hairline border-zinc-200 max-h-[520px] overflow-y-auto">
          <div className={cn(
            'text-13 leading-relaxed mt-3',
            isError ? 'text-alert-fg' : 'text-ink-primary'
          )}>
            {renderMarkdown(response)}
          </div>

          {/* Follow-up */}
          <div className="mt-3 flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Drill deeper — 'break that down by tier', 'compare to Q1'…"
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
