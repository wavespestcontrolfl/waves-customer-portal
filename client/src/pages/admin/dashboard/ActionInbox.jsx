import { Badge, Card, CardBody, CardHeader, CardTitle, UiSurface, cn } from "../../../components/ui";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { RowLink } from "./RowLink";
import { fmtMoneyCompact } from "../../../components/dashboard/charts";

// Rank: what to do first. Critical before warn; within a severity, do-this-now
// actions before watch-state alarms (kind comes from the server generators).
const SEVERITY_RANK = { critical: 0, warn: 1 };
const KIND_RANK = { action: 0, alert: 1 };
function rank(a) {
  return (
    (SEVERITY_RANK[a.severity] ?? 2) * 10 + (KIND_RANK[a.kind] ?? 1)
  );
}

// Names for the server's checks (server/services/dashboard-alerts.js). A check
// that threw comes back in the response's `failures` by id, and its items are
// missing from `alerts`, so the inbox names the checks it could not run.
const CHECK_NAMES = new Map([
  ["ar_overdue_60", "invoices 60+ days overdue"],
  ["payments_failed_today", "failed payments today"],
  ["calls_unmapped_today", "unmapped phone numbers today"],
  ["cards_expiring_7d", "cards expiring in 7 days"],
  ["inventory_unit_review", "inventory unit review"],
  ["churn_at_risk", "customers at churn risk"],
  ["stale_draft_invoices", "draft invoices unsent 3+ days"],
  ["closeout_gaps_today", "visits not closed out today"],
  ["persisted_admin_alerts", "saved system alerts"],
  ["leads_awaiting_contact", "people waiting for first contact"],
  ["estimates_expiring", "estimates expiring within 3 days"],
  ["estimate_drafts_unsent", "estimate drafts waiting to be sent"],
  ["at_risk_mrr", "recurring accounts with MRR at risk"],
  ["autopay_coverage_low", "autopay coverage"],
  ["leads_unattributed_7d", "leads missing a source"],
  ["builder_warranty_expiring", "builder termite warranties expiring"],
  ["customer_duplicates_review", "possible duplicate customers"],
]);

// "2 checks couldn't run: failed payments today and 1 more." — null when every
// check ran. Ids this map does not know yet still count.
function failedChecksNote(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null;
  const names = failures.map((f) => CHECK_NAMES.get(f?.id)).filter(Boolean);
  const unnamed = failures.length - names.length;
  const count = failures.length === 1 ? "1 check" : `${failures.length} checks`;
  if (names.length === 0) return `${count} couldn't run.`;
  return `${count} couldn't run: ${names.join(", ")}${unnamed > 0 ? ` and ${unnamed} more` : ""}.`;
}

// The TODAY section's ranked "do this now" list — server-computed operational
// alerts + action items (/admin/dashboard/alerts), deep-linked to the surface
// where each one gets fixed. Replaces the old top-4 alerts banner: every item
// shows, ordered by urgency, and a clean day says so instead of hiding.
// alerts === null means the fetch never succeeded — render an explicit
// unavailable state; claiming "all clear" on a failed load would hide any
// critical alarms behind a green checkmark. `stale` means the LATEST fetch
// failed and `alerts` is a kept-previous value: a non-empty list still shows
// (labeled stale — old items beat no items), but an empty one must not read
// as a confirmed all-clear. `failures` lists checks the server could not run
// on a load that otherwise succeeded: an empty list is then incomplete, never
// all-clear, and a non-empty one says which checks are missing.
export default function ActionInbox({ alerts, stale = false, failures = [] }) {
  const loaded = Array.isArray(alerts);
  const items = loaded ? [...alerts].sort((a, b) => rank(a) - rank(b)) : [];
  const criticalCount = items.filter((a) => a.severity === "critical").length;
  const failedNote = failedChecksNote(failures);

  if (!loaded || (items.length === 0 && (stale || failedNote))) {
    let badge = "unavailable";
    let message = "Alerts couldn't be loaded — retrying automatically.";
    if (loaded && stale) message = "Alerts couldn't be refreshed — retrying automatically.";
    else if (loaded) {
      badge = "incomplete";
      message = `Nothing found in the checks that ran. ${failedNote} Retrying automatically.`;
    }
    return (
      <UiSurface as={Card} className="mb-4">
        <CardHeader className="flex items-center gap-2.5">
          <CardTitle>Action inbox</CardTitle>
          <Badge tone="neutral">{badge}</Badge>
        </CardHeader>
        <CardBody>
          <div className="py-2 text-ui-body text-ink-secondary">{message}</div>
        </CardBody>
      </UiSurface>
    );
  }

  // Past the guard, an empty list means the latest load worked and every check ran.
  const allClear = items.length === 0;

  return (
    <UiSurface as={Card} className="mb-4">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Action inbox</CardTitle>
          {allClear ? (
            <Badge tone="neutral">
              <CheckCircle2 size={14} aria-hidden />
              All clear
            </Badge>
          ) : (
            <span
              className={cn(
                "text-ui-caption",
                criticalCount > 0 ? "text-alert-fg" : "text-ink-secondary",
              )}
            >
              {criticalCount > 0
                ? `${criticalCount} critical`
                : `${items.length} open`}
              {stale ? " · refresh failed, showing last loaded" : ""}
            </span>
          )}
        </div>
        {!allClear && (
          <Badge tone={criticalCount > 0 ? "alert" : "neutral"}>
            {items.length}
          </Badge>
        )}
      </CardHeader>
      <CardBody>
        {failedNote && (
          <div className="mb-2 text-ui-body text-ink-secondary">
            {failedNote} This list may be missing items.
          </div>
        )}
        {allClear ? (
          <div className="py-2 text-ui-body text-ink-secondary">
            Nothing needs you right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {items.map((item) => (
              <RowLink
                key={item.id}
                href={item.href}
                className="flex min-h-11 items-center justify-between gap-3 rounded-sm border-hairline border-zinc-200 bg-surface-sunken px-3 py-2 text-ui-body text-zinc-900 hover:bg-white u-focus-ring"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full flex-shrink-0",
                      item.severity === "critical"
                        ? "bg-alert-fg"
                        : "bg-amber-500",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  {item.amount != null && (
                    <span className="u-nums text-ui-caption text-ink-secondary">
                      {fmtMoneyCompact(item.amount)}
                    </span>
                  )}
                  <ArrowRight size={16} aria-hidden className="text-ink-tertiary" />
                </span>
              </RowLink>
            ))}
          </div>
        )}
      </CardBody>
    </UiSurface>
  );
}
