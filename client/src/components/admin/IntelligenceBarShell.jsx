/**
 * Intelligence Bar Shell — shared V2 UI consumed by every per-page IB wrapper.
 * client/src/components/admin/IntelligenceBarShell.jsx
 *
 * Single source of truth for: command input, Ask button, quick-action chips,
 * loading skeleton, markdown response render, follow-up input, Clear, recents.
 * State/API/keyboard lives in `useIntelligenceBar` hook — this file is chrome.
 *
 * Props:
 *   context              — IB context string, forwarded to the hook
 *   buildPageData        — fn → pageData (called per-submit)
 *   fallbackActions      — quick-actions fallback if API fails
 *   onAfterSubmit        — (responseData) => void, runs on every success
 *   placeholder          — main input placeholder
 *   followupPlaceholder  — follow-up input placeholder
 *   askLabel             — main button label (default 'Ask ↵')
 *   loadingLabel         — loading indicator text (default 'analyzing…')
 *   headerSlot           — ReactNode | (state) => ReactNode — right of input
 *   responseSlot         — (structuredData) => ReactNode, rendered under response
 *   responseMaxHeight    — CSS max-height for response pane (default '520px')
 *   promotions           — {actionId: {reason}} — surfaces chips as suggested
 *   skeletonBars         — widths array for loading skeleton bars
 *   bodyClassName        — extra classes on outer container
 *
 * Recents + favorites are persisted in localStorage per-context by the hook.
 */

import { useRef } from 'react';
import { cn } from '../ui';
import { useIntelligenceBar } from '../../hooks/useIntelligenceBar';

export function renderInline(text) {
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

export function renderMarkdown(text) {
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

export function QuickChip({ label, onClick, title, promoted = false }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title ? `${label} — ${title}` : label}
      className={cn(
        'inline-flex items-center h-6 px-3 text-11 font-medium border-hairline rounded-sm u-focus-ring transition-colors whitespace-nowrap',
        promoted
          ? 'bg-zinc-900 text-white border-zinc-900 hover:bg-zinc-800'
          : 'bg-white text-ink-secondary border-zinc-200 hover:bg-zinc-50 hover:text-ink-primary'
      )}
    >
      {promoted && <span className="u-dot u-dot--filled mr-1.5" />}
      {label}
    </button>
  );
}

function groupActions(actions) {
  const groups = [];
  const seen = new Map();
  for (const a of actions) {
    const key = a.group || null;
    if (!seen.has(key)) {
      seen.set(key, groups.length);
      groups.push({ group: key, items: [] });
    }
    groups[seen.get(key)].items.push(a);
  }
  return groups;
}

export default function IntelligenceBarShell({
  context,
  buildPageData,
  fallbackActions,
  onAfterSubmit,
  placeholder = 'Ask anything…',
  followupPlaceholder = 'Follow up…',
  askLabel = 'Ask ↵',
  loadingLabel = 'analyzing…',
  headerSlot = null,
  responseSlot = null,
  responseMaxHeight = '520px',
  skeletonBars = [92, 75, 88, 60],
  bodyClassName = '',
  promotions = null,
}) {
  const {
    prompt, setPrompt,
    loading,
    response,
    structuredData,
    conversationHistory,
    quickActions,
    expanded, setExpanded,
    recentPrompts,
    favorites,
    toggleFavorite,
    submit,
    clear,
    handleKeyDown,
  } = useIntelligenceBar({
    context,
    buildPageData,
    fallbackActions,
    onAfterSubmit,
  });

  const inputRef = useRef(null);
  const isError = response && response.startsWith('Error:');
  const resolvedHeader = typeof headerSlot === 'function'
    ? headerSlot({ expanded, loading, hasResponse: !!response })
    : headerSlot;

  return (
    <div className={cn('bg-white border-hairline border-zinc-200 rounded-sm mb-4 overflow-hidden', bodyClassName)}>
      {/* Command bar */}
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0 sm:min-w-[220px] relative">
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setExpanded(true)}
            placeholder={placeholder}
            className="w-full h-11 sm:h-9 pl-3 pr-20 bg-white border-hairline border-zinc-200 rounded-sm text-14 sm:text-13 text-ink-primary placeholder-ink-tertiary focus:outline-none focus:border-zinc-900 u-focus-ring"
          />
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
            {loading ? (
              <span className="u-label text-ink-secondary px-2 animate-pulse">{loadingLabel}</span>
            ) : (
              <button
                onClick={() => submit()}
                disabled={!prompt.trim()}
                className={cn(
                  'h-8 sm:h-6 px-3 text-11 uppercase tracking-label font-medium rounded-xs u-focus-ring transition-colors',
                  'bg-zinc-900 text-white hover:bg-zinc-800',
                  !prompt.trim() && 'cursor-not-allowed'
                )}
              >
                {askLabel}
              </button>
            )}
          </div>
        </div>

        {resolvedHeader}

        {(response || conversationHistory.length > 0) && (
          <button
            onClick={clear}
            className="h-6 px-2 u-label text-ink-secondary border-hairline border-zinc-200 rounded-xs hover:bg-zinc-50 u-focus-ring"
          >
            Clear
          </button>
        )}
      </div>

      {/* Pinned favorites */}
      {expanded && !response && !loading && favorites.length > 0 && (
        <div className="px-4 pb-3">
          <div className="u-label text-ink-tertiary mb-1.5">Pinned</div>
          <div className="flex flex-wrap gap-2">
            {favorites.map((p, i) => (
              <div key={i} className="inline-flex items-center border-hairline border-zinc-200 bg-white rounded-sm overflow-hidden">
                <button
                  onClick={() => { setPrompt(p); submit(p); }}
                  title={p}
                  aria-label={p}
                  className="h-6 px-3 text-11 font-medium text-ink-primary hover:bg-zinc-50 u-focus-ring max-w-[240px] truncate"
                >
                  {p}
                </button>
                <button
                  onClick={() => toggleFavorite(p)}
                  title="Unpin"
                  aria-label={`Unpin ${p}`}
                  className="h-6 px-1.5 text-11 text-ink-primary border-l border-hairline border-zinc-200 hover:bg-zinc-50 u-focus-ring"
                >
                  ★
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      {expanded && !response && !loading && quickActions.length > 0 && (
        <div className="px-4 pb-3">
          {groupActions(quickActions).map((g, gi) => (
            <div key={g.group ?? `g-${gi}`} className={gi === 0 ? '' : 'mt-2'}>
              {g.group && (
                <div className="u-label text-ink-tertiary mb-1.5">{g.group}</div>
              )}
              <div className="flex flex-wrap gap-2">
                {g.items.map((a) => {
                  const promo = promotions?.[a.id];
                  const title = promo?.reason
                    ? `Suggested — ${promo.reason} · ${a.prompt}`
                    : a.prompt;
                  return (
                    <QuickChip
                      key={a.id}
                      label={a.label}
                      title={title}
                      promoted={!!promo}
                      onClick={() => { setPrompt(a.prompt); submit(a.prompt); }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recents */}
      {expanded && !response && !loading && recentPrompts.length > 0 && (
        <div className="px-4 pb-3">
          <div className="u-label text-ink-tertiary mb-1.5">Recent</div>
          {recentPrompts.map((p, i) => {
            const isFav = favorites.includes(p);
            return (
              <div
                key={i}
                className="flex items-center gap-1 px-2 py-1 rounded-xs hover:bg-zinc-50 transition-colors"
              >
                <button
                  onClick={() => { setPrompt(p); submit(p); }}
                  className="flex-1 text-left text-12 text-ink-secondary hover:text-ink-primary truncate u-focus-ring"
                >
                  {p}
                </button>
                <button
                  onClick={() => toggleFavorite(p)}
                  title={isFav ? 'Unpin' : 'Pin'}
                  aria-label={isFav ? `Unpin ${p}` : `Pin ${p}`}
                  className={cn(
                    'h-5 w-5 flex items-center justify-center text-11 rounded-xs u-focus-ring transition-colors',
                    isFav ? 'text-ink-primary' : 'text-ink-tertiary hover:text-ink-primary'
                  )}
                >
                  {isFav ? '★' : '☆'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            {skeletonBars.map((w, i) => (
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
        <div
          className="px-4 pb-4 pt-1 border-t border-hairline border-zinc-200 overflow-y-auto"
          style={{ maxHeight: responseMaxHeight }}
        >
          <div className={cn(
            'text-13 leading-relaxed mt-3',
            isError ? 'text-alert-fg' : 'text-ink-primary'
          )}>
            {renderMarkdown(response)}
          </div>

          {responseSlot && responseSlot(structuredData)}

          {/* Follow-up */}
          <div className="mt-3 flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={followupPlaceholder}
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
