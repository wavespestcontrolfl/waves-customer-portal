/**
 * SEO Intelligence Bar — V2 (thin wrapper, multi-context)
 * client/src/components/admin/SEOIntelligenceBarV2.jsx
 *
 * Serves seo / blog / reviews / comms / tax / leads / banking / email. Context
 * parameterized per-mount. Refreshes after every successful submit (caller
 * decides what onRefresh does).
 */

import { useCallback } from 'react';
import IntelligenceBarShell from './IntelligenceBarShell';

const FALLBACK_ACTIONS = {
  seo: [
    { id: 'health', label: 'Fleet Health', prompt: 'Check all 15 sites for issues' },
    { id: 'traffic', label: 'Top Sites', prompt: 'Rank sites by traffic' },
    { id: 'drops', label: 'Drops', prompt: 'Any ranking drops this week?' },
    { id: 'queries', label: 'Top Queries', prompt: 'Top 20 non-branded keywords' },
  ],
  blog: [
    { id: 'pipeline', label: 'Pipeline', prompt: "What's in the content pipeline?" },
    { id: 'perf', label: 'Top Posts', prompt: 'Which blog posts perform best?' },
  ],
  reviews: [
    { id: 'stats', label: 'Review Stats', prompt: 'How are our Google reviews?' },
    { id: 'unresponded', label: 'Needs Reply', prompt: 'Any reviews needing a reply?' },
    { id: 'trends', label: 'Trends', prompt: 'Review trend over 6 months' },
  ],
  comms: [
    { id: 'unanswered', label: 'Unanswered', prompt: 'Any unanswered messages?' },
    { id: 'today', label: "Today's Activity", prompt: 'What happened today?' },
    { id: 'calls', label: 'Calls', prompt: 'Recent calls today' },
  ],
  tax: [
    { id: 'overview', label: 'Tax Overview', prompt: 'Give me the full tax picture' },
    { id: 'quarterly', label: 'Quarterly Est.', prompt: 'Estimated quarterly tax payment' },
    { id: 'expenses', label: 'Expenses', prompt: 'Expenses by category this year' },
  ],
  leads: [
    { id: 'overview', label: 'Pipeline', prompt: 'How does the pipeline look?' },
    { id: 'stale', label: 'Stale Leads', prompt: 'Leads not contacted in 48 hours' },
    { id: 'funnel', label: 'Funnel', prompt: 'Show me the funnel' },
  ],
  banking: [
    { id: 'balance', label: 'Balance', prompt: "What's my Stripe balance?" },
    { id: 'payouts', label: 'Payouts', prompt: 'Recent payouts to the bank' },
    { id: 'cash_flow', label: 'Cash Flow', prompt: 'Cash flow this month' },
  ],
  email: [
    { id: 'summary', label: 'Inbox', prompt: 'Inbox summary' },
    { id: 'unread', label: 'Unread', prompt: 'Unread emails' },
  ],
};

export default function SEOIntelligenceBarV2({ context = 'seo', activeDomain, onRefresh }) {
  const buildPageData = useCallback(() => ({
    page: context,
    active_domain: activeDomain || null,
  }), [context, activeDomain]);

  const handleAfterSubmit = useCallback(() => {
    if (onRefresh) onRefresh();
  }, [onRefresh]);

  return (
    <IntelligenceBarShell
      context={context}
      buildPageData={buildPageData}
      fallbackActions={FALLBACK_ACTIONS[context] || FALLBACK_ACTIONS.seo}
      onAfterSubmit={handleAfterSubmit}
      followupPlaceholder="Drill deeper — 'show me that site', 'compare to last month'…"
      responseMaxHeight="500px"
      skeletonBars={[90, 70, 85]}
      headerSlot={
        activeDomain ? (
          <span className="inline-flex items-center h-6 px-2 text-11 font-medium border-hairline border-zinc-200 bg-zinc-50 text-ink-secondary rounded-xs whitespace-nowrap">
            {activeDomain}
          </span>
        ) : null
      }
    />
  );
}
