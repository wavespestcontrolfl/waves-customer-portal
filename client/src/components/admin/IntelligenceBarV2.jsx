/**
 * Intelligence Bar — V2 (monochrome)
 * client/src/components/admin/IntelligenceBarV2.jsx
 *
 * Monochrome reskin of IntelligenceBar (customer-search IB). Strict 1:1 on data/behavior:
 *   - same POST /admin/intelligence-bar/query (no context → default customers context)
 *   - same GET  /admin/intelligence-bar/quick-actions
 *   - same onSelectCustomer callback
 *   - same recentPrompts (last 5) state
 *   - same structuredData extraction (customers | overdue_customers)
 *   - same conversation-history threading + clear behavior
 * Visual changes: hairline white container (no gradient), zinc-900 Ask button,
 * dropped icon chip + quick-action emojis, monochrome CustomerRow
 * (tier pill = neutral, health/days_overdue = alert-fg only when adverse),
 * recent prompts without arrow, alert-fg on error text only.
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
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-ink-primary font-medium">{part.slice(2, -2)}</strong>;
    }
    if (part.includes('`')) {
      const codeParts = part.split(/(`[^`]+`)/g);
      return codeParts.map((cp, j) => {
        if (cp.startsWith('`') && cp.endsWith('`')) {
          return (
            <code
              key={`${i}-${j}`}
              className="u-nums text-12 bg-zinc-100 text-ink-primary px-1.5 py-px rounded-xs"
            >
              {cp.slice(1, -1)}
            </code>
          );
        }
        return cp;
      });
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

function CustomerRow({ customer, onSelect }) {
  const c = customer;
  const name = c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unnamed';
  const healthLow = c.health_score != null && c.health_score < 40;
  const overdueBad = c.days_overdue != null && c.days_overdue > 30;

  return (
    <div
      onClick={() => onSelect?.(c.id)}
      className="flex items-center gap-3 px-3 py-2 border-b border-hairline border-zinc-200 last:border-b-0 cursor-pointer hover:bg-zinc-50 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="text-13 font-medium text-ink-primary truncate">{name}</div>
        <div className="text-11 text-ink-tertiary">
          {c.city || '—'}{c.phone ? ` · ${c.phone}` : ''}
        </div>
      </div>
      {c.tier && (
        <span className="inline-flex items-center h-5 px-2 text-10 font-medium uppercase tracking-label border-hairline border-zinc-200 text-ink-secondary rounded-xs">
          {c.tier}
        </span>
      )}
      {c.health_score != null && (
        <span className={cn('u-nums text-11 font-medium', healthLow ? 'text-alert-fg' : 'text-ink-primary')}>
          {c.health_score}
        </span>
      )}
      {c.days_overdue != null && (
        <span className={cn('u-nums text-10 font-medium', overdueBad ? 'text-alert-fg' : 'text-ink-secondary')}>
          {c.days_overdue}d overdue
        </span>
      )}
      {c.monthly_rate > 0 && (
        <span className="u-nums text-11 text-ink-secondary">
          ${c.monthly_rate.toFixed(0)}/mo
        </span>
      )}
    </div>
  );
}

export default function IntelligenceBarV2({ onSelectCustomer }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [structuredData, setStructuredData] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [recentPrompts, setRecentPrompts] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    adminFetch('/admin/intelligence-bar/quick-actions')
      .then((d) => setQuickActions(d.actions || []))
      .catch(() => {
        setQuickActions([
          { id: 'missing_city', label: 'Missing Cities', prompt: 'Show me customers with no city on their profile' },
          { id: 'pest_overdue', label: 'Pest Overdue', prompt: 'Which quarterly pest control customers are overdue for service?' },
          { id: 'lawn_overdue', label: 'Lawn Overdue', prompt: 'Which monthly lawn care customers are overdue?' },
          { id: 'at_risk', label: 'At Risk', prompt: 'Show me customers with health scores below 40' },
          { id: 'high_balance', label: 'Balances', prompt: 'Who has an outstanding balance over $100?' },
          { id: 'duplicates', label: 'Duplicates', prompt: 'Find duplicate customers by phone number' },
          { id: 'tech_perf', label: 'Tech Stats', prompt: 'Compare technician performance this month' },
          { id: 'win_back', label: 'Win Back', prompt: 'Show churned Gold/Platinum customers from the last 6 months' },
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

    setRecentPrompts((prev) => {
      const filtered = prev.filter((p) => p !== q);
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
      setResponse(`Error: ${err.message}. Make sure the intelligence-bar route is registered and ANTHROPIC_API_KEY is set.`);
    }

    setLoading(false);
    setPrompt('');
  }, [prompt, loading, conversationHistory]);

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

  const customerList = structuredData?.customers || structuredData?.overdue_customers || null;
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
            placeholder="Ask anything about your customers, schedule, or revenue…"
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

      {/* Recent Prompts */}
      {expanded && !response && !loading && recentPrompts.length > 0 && (
        <div className="px-4 pb-3">
          <div className="u-label text-ink-tertiary mb-1.5">Recent</div>
          {recentPrompts.map((p, i) => (
            <div
              key={i}
              onClick={() => { setPrompt(p); submit(p); }}
              className="px-2 py-1 text-12 text-ink-secondary cursor-pointer rounded-xs hover:bg-zinc-50 hover:text-ink-primary transition-colors truncate"
            >
              {p}
            </div>
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

          {/* Structured customer list */}
          {customerList && customerList.length > 0 && (
            <div className="mt-3 border-hairline border-zinc-200 rounded-sm overflow-hidden max-h-[300px] overflow-y-auto">
              <div className="px-3 py-2 bg-zinc-50 border-b border-hairline border-zinc-200 flex items-center justify-between">
                <span className="u-label text-ink-secondary">Results ({customerList.length})</span>
                {structuredData?.total_matching != null && structuredData.total_matching > customerList.length && (
                  <span className="text-11 text-ink-tertiary">
                    showing {customerList.length} of {structuredData.total_matching}
                  </span>
                )}
              </div>
              {customerList.map((c, i) => (
                <CustomerRow key={c.id || i} customer={c} onSelect={onSelectCustomer} />
              ))}
            </div>
          )}

          {/* Follow-up */}
          <div className="mt-3 flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Follow up…"
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
