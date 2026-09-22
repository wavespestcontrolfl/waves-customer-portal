import { ActionFeedback } from "../../../components/ui/ActionFeedback";

// Never render a missing feed as a business zero. Loaded data stays visible
// during refresh; the page's stale-data notice covers failed refreshes.
export default function DashboardFeed({ value, pending, label, onRetry, children }) {
  if (value != null) return children;
  return <ActionFeedback error={!pending} onRetry={pending ? undefined : onRetry}>
    {pending ? `Loading ${label}…` : `${label} is unavailable.`}
  </ActionFeedback>;
}
