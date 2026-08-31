// Customer 360 — "Cancel plan…" (cancel-flow lane C3).
//
// Admin-side cancellation on the SAME engine the customer portal uses. The
// server computes every fact shown here (POST /admin/customers/:id/
// cancel-plan/preview → services/admin-cancellation.js); this dialog only
// collects the choices and shows the before/after, then commits once
// (POST /admin/customers/:id/cancel-plan). Nothing is client-computed —
// no dollars, no visit counts.
//
// Tier 1 V2 surface: components/ui primitives + zinc ramp. Admin stays
// monochrome; alert-fg only for genuine alerts (scope errors, partial runs).
import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Radio,
  Select,
  Textarea,
} from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

const REASON_LABELS = {
  price: "Price",
  results_pest: "Results — pest",
  results_lawn: "Results — lawn",
  service_experience: "Service experience",
  away: "Away / seasonal",
  scheduling_access_communication: "Scheduling, access, or communication",
  moving_or_property_change: "Moving or property change",
  no_longer_needed: "No longer needed",
  service_mix: "Service mix",
  diy: "Doing it themselves",
  competitor: "Competitor",
  hoa_or_landlord: "HOA or landlord",
  financial_hardship: "Financial hardship",
  health_or_chemicals: "Health or chemicals",
  billing_issue: "Billing issue",
  unexpected_recurring: "Did not expect a recurring plan",
  damage_or_adverse_effect: "Damage or adverse effect",
  personal_circumstances: "Personal circumstances",
  other: "Other",
};

function money(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return `$${Number(v).toFixed(2)}`;
}

function fmtDate(d) {
  if (!d) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
    return new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function Fact({ label, children }) {
  return (
    <div className="flex justify-between gap-3 py-1 border-b border-hairline border-zinc-100 last:border-b-0">
      <span className="text-ink-secondary">{label}</span>
      <span className="text-zinc-900 text-right u-nums">{children}</span>
    </div>
  );
}

export default function CancelPlanDialog({ customer, onClose, onDone }) {
  const [wholeAccount, setWholeAccount] = useState(true);
  const [families, setFamilies] = useState([]);
  const [effectiveDate, setEffectiveDate] = useState("now");
  const [waiveLateFee, setWaiveLateFee] = useState(false);
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");

  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState("");
  const [result, setResult] = useState(null);

  const scope = wholeAccount ? [] : families;
  const scopeKey = scope.join(",");

  // The preview follows every choice that changes the facts (scope,
  // effective date). Reason / note / toggles ride along so the server echoes
  // exactly what the commit will carry.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr("");
    adminFetch(`/admin/customers/${customer.id}/cancel-plan/preview`, {
      method: "POST",
      body: JSON.stringify({
        families: scope,
        effectiveDate,
        waiveLateFee,
        sendConfirmation,
        reasonCode: reasonCode || null,
        note,
      }),
    })
      .then((r) => {
        if (cancelled) return;
        setPreview(r);
        // The server decides whether "end of paid coverage" is even a
        // choice; snap back to "now" if it stopped being one.
        if (!r.prepay && effectiveDate !== "now") setEffectiveDate("now");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e.code === "no_paid_coverage") {
          setEffectiveDate("now");
          return;
        }
        setLoadErr(e.message || "Preview failed");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Deps are the fact-changing choices only; toggles/reason/note are read
    // at request time and travel unchanged into the commit body.
  }, [customer.id, scopeKey, effectiveDate]);

  const toggleFamily = (key) => {
    setFamilies((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const impact = preview?.impact || null;
  const owned = impact?.families || [];
  const prepay = preview?.prepay || null;
  const scopeBlocked = !wholeAccount && (families.length === 0 || preview?.scopedSupported === false);
  // !loadErr: a FAILED refresh leaves the prior preview rendered (so the
  // scope checkboxes survive), but it must never back the red button — the
  // facts shown and the scope committed have to come from the same
  // successful response (in-flight refreshes are already blocked by
  // !loading, and out-of-order responses by the effect's cancelled flag).
  const canCommit = !!preview && !loadErr && preview.eligible && !scopeBlocked && !loading && !running && !result;

  const commit = async () => {
    setRunning(true);
    setRunErr("");
    try {
      const r = await adminFetch(`/admin/customers/${customer.id}/cancel-plan`, {
        method: "POST",
        body: JSON.stringify({
          families: scope,
          effectiveDate,
          prepayDisposition: prepay ? prepay.disposition : null,
          waiveLateFee,
          sendConfirmation,
          reasonCode: reasonCode || null,
          note,
        }),
      });
      setResult(r);
      try {
        await onDone?.();
      } catch (refreshError) {
        setRunErr(`Cancellation recorded, but the customer profile could not refresh: ${refreshError.message || "Refresh failed"}`);
      }
    } catch (e) {
      setRunErr(e.message || "Cancellation failed");
    }
    setRunning(false);
  };

  const scopeLabel = wholeAccount
    ? "the whole plan"
    : (preview?.scopeLabels?.length ? preview.scopeLabels.join(", ") : "the selected services");

  return (
    <Dialog open onClose={() => !running && onClose()} size="md">
      <DialogHeader>
        <DialogTitle>Cancel plan</DialogTitle>
        <div className="text-13 text-ink-secondary mt-1">
          {customer.firstName} {customer.lastName} — same engine the customer portal uses. Nothing happens until you press the red button.
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4 text-13">
        {loadErr && (
          <div className="px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-13">{loadErr}</div>
        )}

        {!result && (
          <>
            {/* SCOPE */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-12 uppercase tracking-label text-ink-secondary mb-1">Scope</legend>
              <Radio
                id="cancel-plan-scope-all"
                name="cancel-plan-scope"
                label="Whole account"
                checked={wholeAccount}
                onChange={() => setWholeAccount(true)}
                disabled={running}
              />
              <Radio
                id="cancel-plan-scope-some"
                name="cancel-plan-scope"
                label="Only these services"
                checked={!wholeAccount}
                onChange={() => setWholeAccount(false)}
                disabled={running || owned.length < 2}
              />
              {!wholeAccount && (
                <div className="ml-6 flex flex-col gap-1.5">
                  {owned.map((f) => (
                    <Checkbox
                      key={f.key}
                      id={`cancel-plan-family-${f.key}`}
                      label={`${f.label}${f.upcomingVisits ? ` — ${f.upcomingVisits} upcoming` : ""}${f.monthlyRate != null ? ` — ${money(f.monthlyRate)}/mo` : ""}`}
                      checked={families.includes(f.key)}
                      onChange={() => toggleFamily(f.key)}
                      disabled={running}
                    />
                  ))}
                  {preview?.scopedSupported === false && (
                    <div className="px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-13">
                      {preview.scopeError === "scope_not_owned"
                        ? "That service is not on the plan any more."
                        : "The services that would stay cannot be priced from the plan-rate ledger — cancel the whole plan, or repair the ledger first."}
                    </div>
                  )}
                </div>
              )}
            </fieldset>

            {/* EFFECTIVE DATE — only a choice for an annual-prepay whole-account cancel */}
            {wholeAccount && prepay && (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-12 uppercase tracking-label text-ink-secondary mb-1">Effective</legend>
                <Radio
                  id="cancel-plan-effective-term"
                  name="cancel-plan-effective"
                  label={`End of paid coverage (${fmtDate(prepay.termEnd)}) — covered visits stay on the calendar, no renewal`}
                  checked={effectiveDate === "end_of_coverage"}
                  onChange={() => setEffectiveDate("end_of_coverage")}
                  disabled={running}
                />
                <Radio
                  id="cancel-plan-effective-now"
                  name="cancel-plan-effective"
                  label="Now — pull every visit and record a refund of the unused prepaid value"
                  checked={effectiveDate === "now"}
                  onChange={() => setEffectiveDate("now")}
                  disabled={running}
                />
                {effectiveDate === "now" && prepay.refund && (
                  <div className="ml-6 text-12 text-ink-secondary">
                    {prepay.refund.needsManualCalc
                      ? "Refund amount needs a manual calculation (the term has no included-visit count). An office task will say so."
                      : `${money(prepay.refund.amount)} = ${money(prepay.refund.prepaidAmount)} ÷ ${prepay.refund.includedVisits} visits × ${prepay.refund.remainingVisits} remaining. Recorded on the case and opened as an office task — not refunded automatically.`}
                  </div>
                )}
              </fieldset>
            )}

            {/* OPTIONS */}
            <div className="flex flex-col gap-2">
              <Checkbox
                id="cancel-plan-waive-fee"
                label="Waive the scheduled-visit fee on pulled visits"
                checked={waiveLateFee}
                onChange={(e) => setWaiveLateFee(e.target.checked)}
                disabled={running}
              />
              <Checkbox
                id="cancel-plan-send-confirmation"
                label="Send the customer the confirmation text and email"
                checked={sendConfirmation}
                onChange={(e) => setSendConfirmation(e.target.checked)}
                disabled={running}
              />
              {sendConfirmation && preview && !preview.confirmationChannels.sms && !preview.confirmationChannels.email && (
                <div className="ml-6 text-12 text-ink-secondary">No phone or email on file — nothing can be sent.</div>
              )}
            </div>

            {/* REASON + NOTE */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-12 uppercase tracking-label text-ink-secondary">Reason (optional)</span>
                <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} disabled={running} aria-label="Reason">
                  <option value="">—</option>
                  {(preview?.reasonCodes || Object.keys(REASON_LABELS)).map((code) => (
                    <option key={code} value={code}>{REASON_LABELS[code] || code}</option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-12 uppercase tracking-label text-ink-secondary">Note (optional)</span>
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={running} maxLength={2000} aria-label="Note" />
              </label>
            </div>

            {/* PREVIEW FACTS */}
            <div className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm">
              <div className="font-medium text-zinc-900 mb-1">Preview — what pressing the button will do</div>
              {loading && <div className="text-ink-secondary">Loading…</div>}
              {!loading && preview && !preview.eligible && (
                <div className="text-ink-secondary">There is no active plan, recurring service, or upcoming visit on this account to cancel.</div>
              )}
              {!loading && preview && preview.eligible && impact && (
                <div>
                  <Fact label="Cancels">{scopeLabel}</Fact>
                  <Fact label="Effective">{fmtDate(preview.effectiveOn)}</Fact>
                  <Fact label="Visits pulled">{impact.visitsCancelled ?? 0}{impact.nextVisitCancelled ? ` (next ${fmtDate(impact.nextVisitCancelled)})` : ""}</Fact>
                  <Fact label="WaveGuard tier">{impact.tierBefore || "none"} → {impact.tierAfter || "none"}</Fact>
                  {impact.accountMonthlyBefore != null && (
                    <Fact label="Monthly">{money(impact.accountMonthlyBefore)} → {money(impact.accountMonthlyAfter)}</Fact>
                  )}
                  {impact.remaining?.length > 0 && (
                    <Fact label="Stays">{impact.remaining.map((r) => `${r.label} ${money(r.monthlyBefore)} → ${money(r.monthlyAfter)}`).join(", ")}</Fact>
                  )}
                  {impact.openBalance != null && impact.openBalance > 0 && (
                    <Fact label="Open balance">{money(impact.openBalance)} (still payable)</Fact>
                  )}
                  {impact.autopayOn && wholeAccount && <Fact label="Autopay">on → off</Fact>}
                  {impact.termiteRental && <Fact label="Termite stations">retrieval task will be raised</Fact>}
                  {/* Only the channels that CAN send — a missing phone or
                      email must not be promised as "text + email". */}
                  <Fact label="Customer told">{sendConfirmation
                    ? ([preview.confirmationChannels?.sms && "text", preview.confirmationChannels?.email && "email"]
                        .filter(Boolean).join(" + ") || "nothing (no phone or email on file)")
                    : "nothing"}</Fact>
                </div>
              )}
            </div>
          </>
        )}

        {result && (
          <div>
            <div className="mb-2 font-medium">
              {result.processed ? "Done." : "Partially done — the office review alert has the details."}
            </div>
            <div>
              <Fact label="Cancelled">{result.scope?.length ? result.scope.join(", ") : "whole account"}</Fact>
              <Fact label="Effective">{fmtDate(result.effectiveDate)}</Fact>
              <Fact label="Visits pulled">{result.visitsPulled}</Fact>
              {result.tierAfter !== undefined && (
                <Fact label="WaveGuard tier">{result.tierBefore || "none"} → {result.tierAfter || "none"}</Fact>
              )}
              {result.lateFeeWaived && <Fact label="Scheduled-visit fee">waived</Fact>}
              {result.refund && (
                <Fact label="Refund recorded">{result.refund.needsManualCalc ? "needs manual calculation (office task)" : `${money(result.refund.amount)} (office task; not refunded automatically)`}</Fact>
              )}
              <Fact label="Customer told">
                {result.confirmationRequested
                  ? (result.confirmationChannels?.length ? result.confirmationChannels.join(" + ") : "nothing accepted (see logs)")
                  : "nothing (by choice)"}
              </Fact>
            </div>
            {result.errors?.length > 0 && (
              <div className="mt-2 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-13">
                Needs review: {result.errors.join(", ")}
              </div>
            )}
          </div>
        )}

        {runErr && (
          <div className="px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-13">{runErr}</div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={running}>
          {result ? "Close" : "Close without cancelling"}
        </Button>
        {!result && (
          <Button variant="danger" onClick={commit} disabled={!canCommit}>
            {running ? "Working…" : `Cancel ${scopeLabel}`}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
