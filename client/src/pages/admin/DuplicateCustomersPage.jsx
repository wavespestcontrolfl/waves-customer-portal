import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, RefreshCw } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Badge, Button, Card, CardBody, cn } from "../../components/ui";
import { adminFetch as rawAdminFetch } from "../../lib/adminFetch";

function api(path, options = {}) {
  return rawAdminFetch(path, options).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || body.reason || `HTTP ${res.status}`);
    return body;
  });
}

const TIER_TONE = { green: "strong", yellow: "neutral", red: "alert" };
const TIER_LABEL = {
  green: "Auto-mergeable",
  yellow: "Needs review",
  red: "Likely two people",
};

const REASON_LABELS = {
  name_conflict: "Names differ",
  address_conflict: "Different addresses",
  address_unit_conflict: "Different units at the same address",
  address_zip_conflict: "Same street, different ZIP",
  address_city_conflict: "Same street, different city",
  group_has_identity_conflict: "Phone shared by conflicting identities",
  loser_has_stripe_customer_id: "Duplicate has a Stripe profile",
  loser_has_portal_login: "Duplicate has a portal login",
};

function reasonLabel(reason) {
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.startsWith("loser_has_")) {
    return `Duplicate has ${reason.replace("loser_has_", "").replace(/_/g, " ")}`;
  }
  return reason.replace(/_/g, " ");
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

function displayName(customer) {
  return [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim() || "Unknown";
}

function CustomerLine({ customer, isWinner }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <Link
          to={`/admin/customers?customerId=${encodeURIComponent(customer.id)}`}
          className="truncate text-13 font-medium text-zinc-900 underline-offset-2 hover:underline"
        >
          {displayName(customer)}
        </Link>
        {isWinner && <Badge tone="strong">Keep</Badge>}
        {customer.has_stripe && <Badge tone="neutral">Stripe</Badge>}
        {customer.has_portal_login && <Badge tone="neutral">Portal login</Badge>}
      </div>
      <div className="truncate text-12 text-ink-secondary">
        {[customer.address_line1, customer.city, customer.zip].filter(Boolean).join(", ") || "No address on file"}
      </div>
      <div className="truncate text-11 text-ink-secondary">
        {[customer.email, customer.pipeline_stage, `added ${fmtDate(customer.created_at)}`].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

export default function DuplicateCustomersPage() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionKey, setActionKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api("/admin/customer-duplicates");
      setGroups(data.groups || []);
    } catch (err) {
      setError(err.message || "Could not load duplicate customers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = async ({ key, endpoint, body, confirmText, successText }) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setActionKey(key);
    setError("");
    setToast("");
    try {
      await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      setToast(successText);
      await load();
    } catch (err) {
      setError(err.message || "Action failed");
    } finally {
      setActionKey("");
    }
  };

  const pendingCount = groups.reduce((n, g) => n + g.candidates.length, 0);

  return (
    <div className="mx-auto max-w-[1100px]">
      <AdminCommandHeader
        title="Duplicate Customers"
        icon={Copy}
        actions={[{ label: "Refresh", icon: RefreshCw, variant: "secondary", onClick: load, disabled: loading }]}
      />

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-12 text-ink-secondary">
        Groups share a phone number. Merging keeps the highlighted row, repoints all history
        (calls, leads, estimates, invoices) onto it, and retires the duplicate — every merge is
        journaled and reversible. “Link as property” also saves the duplicate’s address as an
        additional property on the kept customer.
      </div>

      {error && (
        <div className="mb-3 rounded-sm border-hairline border-red-200 bg-red-50 px-3 py-2 text-12 text-red-900">
          {error}
        </div>
      )}
      {toast && (
        <div className="mb-3 rounded-sm border-hairline border-emerald-200 bg-emerald-50 px-3 py-2 text-12 text-emerald-950">
          {toast}
        </div>
      )}

      {loading && !groups.length && (
        <div className="px-3 py-8 text-center text-13 text-ink-secondary">Loading duplicate groups…</div>
      )}
      {!loading && !pendingCount && (
        <div className="px-3 py-8 text-center text-13 text-ink-secondary">
          No duplicate customers pending review.
        </div>
      )}

      <div className="grid gap-3">
        {groups.map((group) => (
          <Card key={group.winner.id}>
            <CardBody>
              <div className="mb-2 flex items-center gap-2">
                <span className="u-label text-ink-secondary">Shared phone</span>
                <span className="u-nums text-13 font-medium text-zinc-900">
                  ({group.phone10.slice(0, 3)}) {group.phone10.slice(3, 6)}-{group.phone10.slice(6)}
                </span>
              </div>

              <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
                <CustomerLine customer={group.winner} isWinner />
              </div>

              <div className="grid gap-2">
                {group.candidates.map(({ customer, tier, reasons }) => {
                  const acting = actionKey.startsWith(`${customer.id}:`);
                  // Every positive address disagreement (street, unit, ZIP,
                  // city) is a potential second property worth preserving.
                  const addressConflict = reasons.some((r) => r.startsWith("address_"));
                  return (
                    <div
                      key={customer.id}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-sm border-hairline border-zinc-200 px-3 py-2"
                    >
                      {/* min-w forces the action buttons to WRAP below on
                          phones instead of crushing this column to slivers */}
                      <div className="min-w-[240px] flex-1">
                        <CustomerLine customer={customer} />
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge tone={TIER_TONE[tier] || "neutral"}>{TIER_LABEL[tier] || tier}</Badge>
                          {reasons.map((reason) => (
                            <span key={reason} className="text-11 text-ink-secondary">
                              {reasonLabel(reason)}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className={cn("flex shrink-0 flex-wrap items-center gap-2")}>
                        {tier !== "red" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={acting}
                            onClick={() => runAction({
                              key: `${customer.id}:merge`,
                              endpoint: "/admin/customer-duplicates/merge",
                              body: { winnerId: group.winner.id, loserId: customer.id },
                              confirmText: `Merge ${displayName(customer)} into ${displayName(group.winner)}? All history moves to the kept customer.`,
                              successText: "Merged",
                            })}
                          >
                            Merge into kept
                          </Button>
                        )}
                        {tier !== "red" && addressConflict && customer.address_line1 && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={acting}
                            onClick={() => runAction({
                              key: `${customer.id}:link`,
                              endpoint: "/admin/customer-duplicates/link-as-property",
                              body: { winnerId: group.winner.id, loserId: customer.id },
                              confirmText: `Merge ${displayName(customer)} into ${displayName(group.winner)} and keep ${customer.address_line1} as an additional property?`,
                              successText: "Merged — address saved as a property",
                            })}
                          >
                            Merge + keep address
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={acting}
                          onClick={() => runAction({
                            key: `${customer.id}:dismiss`,
                            endpoint: "/admin/customer-duplicates/dismiss",
                            body: { customerIdA: group.winner.id, customerIdB: customer.id },
                            confirmText: `Mark ${displayName(customer)} and ${displayName(group.winner)} as NOT duplicates? This pair won't be flagged again.`,
                            successText: "Dismissed",
                          })}
                        >
                          Not a duplicate
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
