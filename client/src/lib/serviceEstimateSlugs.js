// Public marketing service-quote slugs. `/estimate/<slug>` for one of these is a
// PUBLIC QuotePage (indexable marketing), NOT a tokenized customer estimate.
// Mirrors server/config/service-estimate-slugs.js — keep the two in sync.
// Consumed by App.jsx (EstimatePublicGateway) and the funnel-analytics gate
// (lib/analytics/posthog.js isPublicFunnelPath).
export const SERVICE_ESTIMATE_SLUGS = new Set([
  'mosquito',
  'termite',
  'lawn',
  'flea',
  'cockroach',
  'bed-bug',
  'dethatching',
  'dehatching',
  'top-dressing',
  'overseeding',
]);
