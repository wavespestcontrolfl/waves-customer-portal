/**
 * Dashboard Intelligence Bar — V2 (thin wrapper)
 * client/src/components/admin/DashboardIntelligenceBarV2.jsx
 *
 * Forwards kpiData → pageData (revenue/customers/MRR/rating) on each query.
 * All UI + API lives in IntelligenceBarShell.
 */

import { useCallback } from 'react';
import IntelligenceBarShell from './IntelligenceBarShell';

const FALLBACK_ACTIONS = [
  { id: 'briefing', group: 'Summary', label: 'Morning Briefing', prompt: 'Give me a morning briefing' },
  { id: 'week_compare', group: 'Summary', label: 'This vs Last Week', prompt: 'How did we do this week vs last week?' },
  { id: 'mrr', group: 'Metrics', label: 'MRR Trend', prompt: "What's our MRR trend?" },
  { id: 'close_rate', group: 'Metrics', label: 'Close Rate', prompt: "What's our estimate close rate?" },
  { id: 'revenue', group: 'Metrics', label: 'Revenue Breakdown', prompt: 'Break down revenue by service type' },
  { id: 'churn', group: 'Metrics', label: 'Churn Check', prompt: 'Any churn this month?' },
  { id: 'leads', group: 'Ops', label: 'Lead Sources', prompt: 'Where are new customers coming from?' },
  { id: 'balances', group: 'Ops', label: 'Balances', prompt: "What's outstanding?" },
];

export default function DashboardIntelligenceBarV2({ kpiData }) {
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

  return (
    <IntelligenceBarShell
      context="dashboard"
      buildPageData={buildPageData}
      fallbackActions={FALLBACK_ACTIONS}
      placeholder="How did we do this week? What's my MRR trend? Morning briefing…"
      followupPlaceholder="Drill deeper — 'break that down by tier', 'compare to Q1'…"
    />
  );
}
