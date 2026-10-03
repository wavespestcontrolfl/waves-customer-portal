import useVisiblePageRefresh from "../../hooks/useVisiblePageRefresh";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Copy } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Badge, Button, Card, CardBody, UiSurface, ActionFeedback, cn } from "../../components/ui";
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
  same_address_different_phone: "Same address, different phone",
  same_address_phone_missing: "Same address — a phone number is missing",
  same_address_phone_shared: "Same address and the same phone — not in the shared-phone list because a record is not marked active",
  name_conflict: "Names differ",
  address_conflict: "Different addresses",
  address_unit_conflict: "Different units at the same address",
  address_zip_conflict: "Same street, different ZIP",
  address_city_conflict: "Same street, different city",
  address_unparsable: "Address can't be compared automatically",
  group_has_identity_conflict: "Phone shared by conflicting identities",
  loser_has_stripe_customer_id: "Duplicate has a Stripe profile",
  loser_has_portal_login: "Duplicate has a portal login",
  loser_has_live_stage: "Duplicate is a live customer (stage)",
  loser_has_third_party_payer: "Duplicate bills to a third-party payer",
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

function fmtPhone(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return value ? String(value) : "";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function visitsText(count) {
  if (count == null) return null;
  return count === 0 ? "no upcoming visits" : `${count} upcoming visit${count === 1 ? "" : "s"}`;
}

// What a same-address merge does (or did) with the merged-away person's phone,
// one plain sentence per carry status. The status is the server's prediction
// before the click (evidence.phone_carry) and its result after (phoneCarry),
// so the copy never promises to save a number there is none to save.
function carrySentence(status, customer, { past, shared = false }) {
  const name = displayName(customer);
  const phone = fmtPhone(customer?.phone);
  if (status === "carried") {
    return past
      ? `${name}’s number${phone ? ` ${phone}` : ""} is saved as a contact on the kept customer, so their next call finds this account. It is held from automated texts — it has not agreed to receive them.`
      : `${name}’s phone number is saved as a contact on them.`;
  }
  if (status === "no_free_slot") {
    return past
      ? `The kept customer has no free contact slot — add ${phone || "that phone number"} to them manually so ${name}’s next call finds this account.`
      : `The kept customer has no free contact slot, so ${name}’s phone number will NOT be saved — add it by hand afterwards.`;
  }
  if (status === "not_applicable" && shared) {
    return "They already share a phone number, so there is no number to save.";
  }
  if (status === "not_applicable") {
    return past ? `${name} had no usable phone number on file, so no number was saved.` : `${name} has no usable phone number on file, so no number is saved.`;
  }
  if (status === "already_on_winner") {
    return past ? `${name}’s number was already saved on the kept customer.` : `${name}’s number is already saved on the kept customer.`;
  }
  return "";
}

function phoneCarryResult(carry, customer, { shared = false } = {}) {
  const sentence = carrySentence(carry?.status, customer, { past: true, shared });
  if (carry?.status === "no_free_slot") return { error: `Merged, but ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`, sentence };
  return { toast: sentence ? `Merged — ${sentence}` : "Merged", sentence };
}

// Confirmation text for a same-address merge, driven by the pair's phone state
// and the predicted carry — never implies two different numbers when a record
// has none.
function sameAddressConfirm(customer, winner, evidence) {
  const state = evidence?.phone_state;
  let base = "They are two customers at the same address";
  if (state === "shared_phone") base += " with the same phone number (one record is not marked active, so they are not in the shared-phone list).";
  else if (state === "both_usable" || (!state && evidence?.phones_differ !== false)) base += " with different phones.";
  else if (state === "both_missing") base += "; neither has a phone number on file.";
  else base += `; ${displayName(evidence?.phones?.winner === "none" ? winner : customer)} has no phone number on file.`;
  return `Merge ${displayName(customer)} into ${displayName(winner)}? ${base} All history moves to the kept customer. ${carrySentence(evidence?.phone_carry?.status, customer, { past: false, shared: state === "shared_phone" })}`.trim();
}

function fmtAddress(addr) {
  return [addr?.address_line1, addr?.address_line2, addr?.city, addr?.zip].filter(Boolean).join(", ");
}

// matched (same-address cards only): the address this customer matched on —
// their own row or a saved property. A saved-property match leads with that
// address and labels the primary address as such.
function CustomerLine({ customer, isWinner, showPhone = false, matched = null, phoneState = null }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/admin/customers?customerId=${encodeURIComponent(customer.id)}`}
          className="break-words text-ui-body font-medium text-zinc-900 underline-offset-2 hover:underline u-focus-ring"
        >
          {displayName(customer)}
        </Link>
        {isWinner && <Badge tone="strong">Keep</Badge>}
        {customer.has_stripe && <Badge tone="neutral">Stripe</Badge>}
        {customer.has_portal_login && <Badge tone="neutral">Portal login</Badge>}
      </div>
      {showPhone && (
        <div className="u-nums break-words text-ui-body text-ink-secondary">
          {[phoneState === "none" ? "No phone on file" : (fmtPhone(customer.phone) || "No phone on file"), visitsText(customer.upcoming_visits)].filter(Boolean).join(" · ")}
        </div>
      )}
      {matched && matched.via === "property" && (
        <div className="break-words text-ui-body text-zinc-900">
          Matched at {fmtAddress(matched)} (saved property)
        </div>
      )}
      <div className="break-words text-ui-body text-ink-secondary">
        {matched && matched.via === "property" ? "Primary address: " : ""}
        {[customer.address_line1, customer.city, customer.zip].filter(Boolean).join(", ") || "No address on file"}
      </div>
      <div className="break-words text-ui-body text-ink-secondary">
        {[customer.email, customer.pipeline_stage, `added ${fmtDate(customer.created_at)}`].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

export default function DuplicateCustomersPage() {
  const [groups, setGroups] = useState([]);
  // Present only when GATE_DUPLICATES_SAME_ADDRESS is on (the API omits the key otherwise).
  const [sameAddressGroups, setSameAddressGroups] = useState([]);
  const [sameAddressError, setSameAddressError] = useState("");
  const [merges, setMerges] = useState([]);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [toast, setToast] = useState("");
  const [actionKey, setActionKey] = useState("");

  const loadSeq = useRef(0);
  const foregroundRead = useRef(0);
  const load = useCallback(async ({ background = false } = {}) => {
    const seq = ++loadSeq.current;
    if (!background) foregroundRead.current = seq;
    if (!background) { setLoading(true); setReadError(""); }
    try {
      const data = await api("/admin/customer-duplicates");

      // A secondary read failure must not erase the loaded Undo history
      // during a background refresh. The primary queue can still update.
      const journal = await api("/admin/customer-duplicates/merges").catch(() => null);
      if (seq !== loadSeq.current) return;
      setGroups(data.groups || []);
      setSameAddressGroups(data.sameAddressGroups || []);
      setSameAddressError(data.sameAddressError || "");
      if (journal) setMerges(journal.merges || []);
      else if (!background) setMerges([]);
      setReadError("");
    } catch (err) {
      if (seq === loadSeq.current) setReadError(err.message || "Could not load duplicate customers");
    } finally {
      if (!background && seq === foregroundRead.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => { loadSeq.current += 1; };
  }, [load]);
  useVisiblePageRefresh(() => load({ background: true }), { intervalMs: 60000, enabled: !loading && !actionKey });

  const runAction = async ({ key, endpoint, body, confirmText, successText, onResult }) => {
    if (confirmText && !window.confirm(confirmText)) return;
    loadSeq.current += 1;
    setActionKey(key);
    setActionError("");
    setToast("");
    try {
      const result = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      // Reload first so onResult can report a partial mutation failure after
      // the updated records have been applied.
      await load();
      if (onResult) onResult(result);
      else setToast(successText);
    } catch (err) {
      setActionError(err.message || "Action failed");
    } finally {
      setActionKey("");
    }
  };

  const pendingCount = [...groups, ...sameAddressGroups].reduce((n, g) => n + g.candidates.length, 0);

    const renderGroupCard = (group, sameAddress = false) => {
      // Same-address cards: the premise the pair matched on, per member.
      const keptMatched = sameAddress ? (group.candidates[0]?.evidence?.matched_address?.winner || null) : null;
      return (
      <Card key={sameAddress ? `same-address:${group.winner.id}` : group.winner.id}>
        <CardBody>
          {sameAddress ? (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-ui-caption font-medium text-ink-secondary">Same address</span>
              <span className="break-words text-ui-body font-medium text-zinc-900">
                {(keptMatched ? fmtAddress(keptMatched) : [group.winner.address_line1, group.winner.address_line2, group.winner.city, group.winner.zip].filter(Boolean).join(", ")) || "Address on a saved property"}
              </span>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-ui-caption font-medium text-ink-secondary">Shared phone</span>
              <span className="u-nums text-ui-body font-medium text-zinc-900">
                ({group.phone10.slice(0, 3)}) {group.phone10.slice(3, 6)}-{group.phone10.slice(6)}
              </span>
            </div>
          )}

          <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
            <CustomerLine customer={group.winner} isWinner showPhone={sameAddress} matched={keptMatched} phoneState={sameAddress ? group.candidates[0]?.evidence?.phones?.winner : null} />
          </div>

          <div className="grid gap-2">
            {group.candidates.map(({ customer, tier, reasons, evidence }) => {
              const matchedAddress = sameAddress ? (evidence?.matched_address?.loser || null) : null;
              const keptHere = sameAddress ? (evidence?.matched_address?.winner || null) : null;
              const acting = actionKey.startsWith(`${customer.id}:`);
              // Every positive address disagreement (street, unit, ZIP,
              // city) is a potential second property worth preserving.
              const addressConflict = reasons.some((r) => r.startsWith("address_"));
              return (
                <div
                  key={customer.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-sm border-hairline border-zinc-200 px-3 py-2"
                >
                  {/* basis-full takes the whole row below md, so the action
                      buttons WRAP underneath on phones instead of crushing
                      this column to slivers; md:basis-auto restores the
                      side-by-side row once there is width for both */}
                  <div className="min-w-0 basis-full flex-1 md:basis-auto">
                    <CustomerLine customer={customer} showPhone={sameAddress} matched={matchedAddress} phoneState={sameAddress ? evidence?.phones?.loser : null} />
                    {keptHere && keptMatched && fmtAddress(keptHere) !== fmtAddress(keptMatched) && (
                      <div className="break-words text-ui-body text-ink-secondary">
                        Kept customer matched this one at {fmtAddress(keptHere)}
                        {keptHere.via === "property" ? " (saved property)" : ""}
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={TIER_TONE[tier] || "neutral"}>{TIER_LABEL[tier] || tier}</Badge>
                      {reasons.map((reason) => (
                        <span key={reason} className="text-ui-body text-ink-secondary">
                          {reasonLabel(reason)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className={cn("flex shrink-0 flex-wrap items-center gap-2")}>
                    {/* Address-conflict candidates must go through
                        "Merge + keep address" — the server 409s a plain
                        merge so the second service address isn't lost. */}
                    {tier !== "red" && !addressConflict && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={acting}
                        onClick={() => runAction({
                          key: `${customer.id}:merge`,
                          endpoint: "/admin/customer-duplicates/merge",
                          body: { winnerId: group.winner.id, loserId: customer.id, ...(sameAddress ? { kind: "same_address" } : {}) },
                          confirmText: sameAddress
                            ? sameAddressConfirm(customer, group.winner, evidence)
                            : `Merge ${displayName(customer)} into ${displayName(group.winner)}? All history moves to the kept customer.`,
                          ...(sameAddress
                            ? {
                              onResult: (res) => {
                                const carry = phoneCarryResult(res?.phoneCarry, customer, { shared: evidence?.phone_state === "shared_phone" });
                                if (carry.error) setActionError(carry.error);
                                else setToast(carry.toast);
                              },
                            }
                            : { successText: "Merged" }),
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
                          body: { winnerId: group.winner.id, loserId: customer.id, ...(sameAddress ? { kind: "same_address" } : {}) },
                          confirmText: `Merge ${displayName(customer)} into ${displayName(group.winner)} and keep ${customer.address_line1} as an additional property?`,
                          // The merge can commit while the property write
                          // fails — never claim the address was saved
                          // unless the server says it was.
                          onResult: (res) => {
                            const carry = sameAddress ? phoneCarryResult(res?.phoneCarry, customer, { shared: evidence?.phone_state === "shared_phone" }) : null;
                            if (!res?.propertyLinked) setActionError(`Merged, but the address could NOT be saved as a property — add it to the kept customer manually.${carry?.error ? ` ${carry.error}` : ""}`);
                            else if (carry?.error) setActionError(carry.error);
                            else setToast(carry?.sentence ? `Merged — address saved as a property. ${carry.sentence}` : "Merged — address saved as a property");
                          },
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
      );
    };

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader
        variant="workspace"
        title="Duplicate customers"
        icon={Copy}
      />

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        Groups share a phone number. Merging keeps the highlighted row, repoints all history
        (calls, leads, estimates, invoices) onto it, and retires the duplicate — every merge is
        journaled, and eligible ones can be undone from Recent merges below. Undo only reverts
        untouched merges: account activity since the merge, or merges that fold colliding
        records, make them Not undoable. “Link as property” also saves the duplicate’s address
        as an additional property on the kept customer.
      </div>

      {readError && <ActionFeedback error onRetry={actionKey ? undefined : load} className="mb-3">{readError}</ActionFeedback>}
      {actionError && <ActionFeedback error className="mb-3">{actionError}</ActionFeedback>}
      {toast && <ActionFeedback className="mb-3">{toast}</ActionFeedback>}

      {loading && !groups.length && (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading duplicate groups…</div>
      )}
      {!loading && !pendingCount && (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">
          No duplicate customers pending review.
        </div>
      )}

      <div className="grid gap-3">
        {groups.map((group) => renderGroupCard(group))}
      </div>

      {(sameAddressGroups.length > 0 || sameAddressError) && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-ui-caption font-medium text-ink-secondary">Same address, different phone</span>
            <span className="text-ui-body text-ink-secondary">review only · never merged automatically</span>
          </div>
          <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
            These customers live at the same address but have different phone numbers — often a
            family member who called from their own phone. Merging keeps the highlighted row and
            saves the other person’s phone as a contact on it, so their next call finds the account.
            If they are separate households, choose Not a duplicate.
          </div>
          {sameAddressError && <ActionFeedback error className="mb-3">{sameAddressError}</ActionFeedback>}
          <div className="grid gap-3">
            {sameAddressGroups.map((group) => renderGroupCard(group, true))}
          </div>
        </div>
      )}

      {merges.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-ui-caption font-medium text-ink-secondary">Recent merges</span>
            <span className="text-ui-body text-ink-secondary">last {merges.length} · journaled · eligible merges can be undone</span>
          </div>
          <Card>
            <CardBody>
              <div className="grid gap-2">
                {merges.map((merge) => (
                  <div
                    key={merge.journalId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-sm border-hairline border-zinc-200 px-3 py-2"
                  >
                    <div className="min-w-0 basis-full flex-1 md:basis-auto">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ui-body font-medium text-zinc-900">{merge.loserName}</span>
                        <span className="text-ui-body text-ink-secondary">merged into</span>
                        <Link
                          to={`/admin/customers?customerId=${encodeURIComponent(merge.winnerId)}`}
                          className="text-ui-body font-medium text-zinc-900 underline-offset-2 hover:underline u-focus-ring"
                        >
                          {merge.winnerName}
                        </Link>
                        <Badge tone={merge.tier === "green" ? "strong" : "neutral"}>
                          {merge.tier === "green" ? "Auto" : "Manual"}
                        </Badge>
                      </div>
                      <div className="break-words text-ui-body text-ink-secondary">
                        {[
                          merge.performedBy,
                          fmtDate(merge.createdAt),
                          merge.undoneAt ? `undone ${fmtDate(merge.undoneAt)}${merge.undoneBy ? ` by ${merge.undoneBy}` : ""}` : null,
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {merge.undoneAt ? (
                        <span className="text-ui-body text-ink-secondary">Undone</span>
                      ) : merge.revertible ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actionKey === `${merge.journalId}:revert`}
                          onClick={() => runAction({
                            key: `${merge.journalId}:revert`,
                            endpoint: `/admin/customer-duplicates/merges/${merge.journalId}/revert`,
                            body: {},
                            confirmText: `Undo this merge? ${merge.loserName} will be restored as a separate customer and their history moved back.`,
                            // The revert can commit while some rows stayed on
                            // the kept customer — report the partial outcome.
                            onResult: (res) => {
                              if (res?.skipped?.length) {
                                setActionError(`Merge undone, but ${res.skipped.length} item(s) could not be restored automatically — details in the admin notification.`);
                              } else {
                                setToast("Merge undone");
                              }
                            },
                          })}
                        >
                          Undo merge
                        </Button>
                      ) : (
                        // Pre-upgrade merges have no row-level repoint record.
                        <span className="text-ui-body text-ink-secondary">Not undoable</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </UiSurface>
  );
}
