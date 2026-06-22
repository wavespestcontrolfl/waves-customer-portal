/**
 * Public statement pay page — `/pay/statement/:token` (third-party payer P5b).
 *
 * The AP-facing counterpart to the invoice pay page (PayPageV2). An accounts-
 * payable contact opens the consolidated NET statement's pay link and settles it
 * online; the charge lands on the PAYER's Stripe customer, never a homeowner. The
 * statement settles to `paid` (cascading to its accrued invoices) via the Stripe
 * webhook — this page only confirms the PaymentIntent.
 *
 * Mirrors PayPageV2's proven two-step surcharge flow (card: createPaymentMethod →
 * /quote → confirm → /finalize → handleNextAction; ACH: confirmPayment direct, no
 * surcharge), trimmed of invoice-only machinery (no live /update-amount sync, no
 * express checkout, no save-card/consent — none of which the statement backend
 * exposes). Backend: server/routes/pay-statement.js (gated GATE_PAYER_STATEMENTS;
 * a disabled gate 404s, which renders the "couldn't find that statement" state).
 *
 * Customer-facing warm brand (NOT admin monochrome).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import { COLORS, FONTS } from "../theme-brand";
import { WavesShell, BrandCard, BrandButton, SerifHeading, HelpPhoneLink } from "../components/brand";
import { getStripe } from "../lib/stripeLoader";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const fmtCurrency = (n) =>
  `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// DATE-only strings ('YYYY-MM-DD') render in UTC so they never shift a day.
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : null;

function SummaryRow({ label, value, strong }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: strong ? 17 : 15, color: strong ? COLORS.navy : COLORS.textBody, fontWeight: strong ? 700 : 400 }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// ── Stripe Elements + surcharge flow ──────────────────────────────
function StatementPaymentForm({ token, publishableKey, clientSecret, paymentIntentId, baseAmount, surchargeRateBps, billingName, billingEmail, onSuccess, onFinalizeFailed }) {
  const mountRef = useRef(null);
  const elementsRef = useRef(null);
  const stripeRef = useRef(null);
  const selectedMethodRef = useRef("card");
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elementError, setElementError] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState("card");
  const [quote, setQuote] = useState(null); // { quoteToken, base, surcharge, total, rateBps }
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  const pct = (() => {
    const bps = Number(quote?.rateBps ?? surchargeRateBps);
    return Number.isFinite(bps) && bps > 0 ? Number((bps / 100).toFixed(2)).toString() : null;
  })();

  useEffect(() => {
    if (!publishableKey || !clientSecret) return undefined;
    let cancelled = false;
    setLoadFailed(false);
    (async () => {
      try {
        const stripe = await getStripe(publishableKey);
        if (cancelled) return;
        stripeRef.current = stripe;
        const elements = stripe.elements({
          clientSecret,
          paymentMethodCreation: "manual",
          appearance: {
            theme: "stripe",
            variables: {
              colorPrimary: COLORS.blueDeeper,
              colorBackground: COLORS.white,
              colorText: COLORS.navy,
              colorDanger: COLORS.red,
              fontFamily: FONTS.body,
              borderRadius: "8px",
              spacingUnit: "4px",
            },
          },
        });
        if (cancelled) return;
        elementsRef.current = elements;
        // Seed billing details — us_bank_account (ACH) confirmation REQUIRES a
        // name + email; the statement only knows the AP contact (company + AP
        // email), so prefill those so a bank-transfer confirm doesn't fail for
        // missing billing details.
        const billingDetails = {};
        if (billingName) billingDetails.name = billingName;
        if (billingEmail) billingDetails.email = billingEmail;
        const paymentElement = elements.create("payment", {
          layout: { type: "accordion", defaultCollapsed: false, radios: true, spacedAccordionItems: true },
          paymentMethodOrder: ["card", "us_bank_account"],
          wallets: { applePay: "never", googlePay: "never" },
          ...(Object.keys(billingDetails).length ? { defaultValues: { billingDetails } } : {}),
        });
        paymentElement.on("ready", () => { if (!cancelled) setReady(true); });
        paymentElement.on("change", (event) => {
          if (cancelled) return;
          // Any edit invalidates a pending quote (the PM may have changed).
          setAwaitingConfirm(false);
          setQuote(null);
          setElementError(event.error?.message || null);
          const next = event.value?.type || null;
          if (next && next !== selectedMethodRef.current) {
            selectedMethodRef.current = next;
            setSelectedMethod(next);
          }
        });
        paymentElement.mount(mountRef.current);
      } catch (err) {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [publishableKey, clientSecret]);

  // Card: submit → createPaymentMethod → /quote → show surcharge. ACH: confirm now.
  const handleSubmit = useCallback(async () => {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setElementError(null);

    // ACH — no surcharge; confirm the base-amount PI directly.
    if (selectedMethodRef.current === "us_bank_account") {
      try {
        const { error, paymentIntent: pi } = await stripeRef.current.confirmPayment({
          elements: elementsRef.current,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        if (error) { setElementError(error.message); setProcessing(false); return; }
        if (pi && (pi.status === "succeeded" || pi.status === "processing")) onSuccess?.(pi);
        else if (pi?.status === "requires_action") { setElementError("Additional verification required."); setProcessing(false); }
        else onSuccess?.(pi);
      } catch (err) {
        setElementError(err.message || "Payment failed.");
        setProcessing(false);
      }
      return;
    }

    // Card — Step 1: create the PaymentMethod, then quote the surcharge.
    try {
      const { error: submitError } = await elementsRef.current.submit();
      if (submitError) { setElementError(submitError.message); setProcessing(false); return; }

      const { error: pmError, paymentMethod } = await stripeRef.current.createPaymentMethod({ elements: elementsRef.current });
      if (pmError) { setElementError(pmError.message); setProcessing(false); return; }

      const res = await fetch(`${API_BASE}/pay/statement/${token}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethodId: paymentMethod.id }),
      });
      const q = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(q.error || "Could not get a surcharge quote.");
      setQuote(q);
      setAwaitingConfirm(true);
      setProcessing(false);
    } catch (err) {
      setElementError(err.message || "Payment failed.");
      setProcessing(false);
    }
  }, [processing, token, onSuccess]);

  // Card: Step 2 — apply surcharge + confirm. Settles via webhook, not here.
  //
  // /finalize updates the shared PI to base+surcharge before confirming. So on
  // ANY failure here the PI is left at the card-surcharged amount — a subsequent
  // attempt (retry card, or switch to ACH which carries no surcharge) on that same
  // PI would charge the wrong amount and fail webhook amount-agreement. Every
  // failure path therefore calls `onFinalizeFailed`, which resets the statement
  // back to a fresh BASE-amount PaymentIntent (re-running /setup) before another
  // attempt. We do NOT reset on quote/ACH failures — those never mutate the PI.
  const handleFinalize = useCallback(async () => {
    if (!quote || processing) return;
    setProcessing(true);
    setElementError(null);
    const fail = (message) => onFinalizeFailed?.(message || "Payment was not completed. Please try again.");
    try {
      const res = await fetch(`${API_BASE}/pay/statement/${token}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteToken: quote.quoteToken }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { fail(result.error || "Payment failed."); return; }

      if (result.requiresAction && result.clientSecret) {
        const { error: actionError, paymentIntent: actionPI } = await stripeRef.current.handleNextAction({ clientSecret: result.clientSecret });
        if (actionError) { fail(actionError.message); return; }
        if (actionPI && (actionPI.status === "succeeded" || actionPI.status === "processing")) {
          onSuccess?.({ id: actionPI.id, status: actionPI.status });
          return;
        }
        fail("Payment could not be completed. Please try again.");
        return;
      }

      if (result.status === "succeeded" || result.status === "processing") {
        onSuccess?.({ id: result.paymentIntentId, status: result.status });
      } else {
        fail("Payment was not completed. Please try again or use another method.");
      }
    } catch (err) {
      fail(err.message || "Payment failed.");
    }
  }, [quote, processing, token, onSuccess, onFinalizeFailed]);

  if (loadFailed) {
    return (
      <p style={{ fontSize: 15, color: COLORS.textBody, lineHeight: 1.55 }}>
        We couldn&rsquo;t load the secure payment form. Please refresh, or call us — <HelpPhoneLink tone="dark" inline /> — to pay by phone.
      </p>
    );
  }

  return (
    <div>
      <div ref={mountRef} />
      {selectedMethod !== "us_bank_account" && pct && !awaitingConfirm && (
        <p style={{ fontSize: 13, color: COLORS.textCaption, marginTop: 10 }}>
          Credit cards add up to {pct}% to cover processing. Debit cards and bank transfers have no added fee.
        </p>
      )}

      {awaitingConfirm && quote && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 8, background: COLORS.blueSurface || "rgba(27,44,91,0.05)" }}>
          <SummaryRow label="Statement total" value={fmtCurrency(quote.base)} />
          {quote.surcharge > 0 && <SummaryRow label={`Card surcharge (${pct}%)`} value={fmtCurrency(quote.surcharge)} />}
          <div style={{ borderTop: `1px solid ${COLORS.grayLight || "#E2E8F0"}`, marginTop: 6, paddingTop: 6 }}>
            <SummaryRow label="Amount to charge" value={fmtCurrency(quote.total)} strong />
          </div>
        </div>
      )}

      {elementError && (
        <p style={{ fontSize: 14, color: COLORS.red, marginTop: 12 }}>{elementError}</p>
      )}

      <div style={{ marginTop: 16 }}>
        <BrandButton
          variant="primary"
          fullWidth
          onClick={awaitingConfirm ? handleFinalize : handleSubmit}
          disabled={!ready || processing}
        >
          {processing
            ? "Processing…"
            : awaitingConfirm && quote
            ? `Pay ${fmtCurrency(quote.total)}`
            : "Continue to payment"}
        </BrandButton>
      </div>
    </div>
  );
}

export default function StatementPayPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [setup, setSetup] = useState(null);
  const [setupError, setSetupError] = useState(null);
  const [paid, setPaid] = useState(false);
  const [payNotice, setPayNotice] = useState(null); // recovery message across a PI reset

  // A card /finalize attempt left the PI at the surcharged amount; drop it and
  // re-run /setup to mint a fresh BASE-amount PI before another attempt (so a
  // retry or a switch to ACH can't charge the stale surcharged total).
  const resetPaymentIntent = (message) => {
    setPayNotice(message || null);
    setSetupError(null);
    setSetup(null); // re-triggers the setup effect → fresh base PI + remounted form
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`${API_BASE}/pay/statement/${token}`)
      .then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) { setError(true); setLoading(false); } });
    return () => { alive = false; };
  }, [token]);

  // Create the PaymentIntent once we know the statement is payable.
  useEffect(() => {
    if (!data || paid || setup || setupError) return;
    if (!data.statement?.payable) return;
    let alive = true;
    fetch(`${API_BASE}/pay/statement/${token}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok) { setSetupError(d?.error || "Could not start the payment."); return; }
        setSetup(d);
      })
      .catch(() => { if (alive) setSetupError("Could not start the payment."); });
    return () => { alive = false; };
  }, [data, token, paid, setup, setupError]);

  const shell = (children) => (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ maxWidth: 560, margin: "48px auto", padding: "0 16px" }}>{children}</div>
    </WavesShell>
  );

  if (loading) return shell(<BrandCard><p style={{ margin: 0, color: COLORS.textBody }}>Loading…</p></BrandCard>);

  if (error || !data) {
    return shell(
      <BrandCard>
        <SerifHeading style={{ marginBottom: 12 }}>We couldn&rsquo;t find that statement</SerifHeading>
        <p style={{ margin: 0, fontSize: 16, color: COLORS.textBody, lineHeight: 1.55 }}>
          The link may have expired or been mistyped. Give us a call and we&rsquo;ll sort it out — <HelpPhoneLink tone="dark" inline />.
        </p>
      </BrandCard>,
    );
  }

  const { statement, billTo, lines } = data;

  if (paid || statement.status === "paid") {
    return shell(
      <BrandCard>
        <SerifHeading style={{ marginBottom: 12 }}>Payment received — thank you</SerifHeading>
        <p style={{ margin: 0, fontSize: 16, color: COLORS.textBody, lineHeight: 1.55 }}>
          Statement {statement.number} is settled. A receipt will follow by email. Questions? <HelpPhoneLink tone="dark" inline />.
        </p>
      </BrandCard>,
    );
  }

  if (!statement.payable) {
    return shell(
      <BrandCard>
        <SerifHeading style={{ marginBottom: 12 }}>Nothing to pay right now</SerifHeading>
        <p style={{ margin: 0, fontSize: 16, color: COLORS.textBody, lineHeight: 1.55 }}>
          Statement {statement.number} isn&rsquo;t open for payment{statement.status === "processing" ? " — a payment is already processing" : ""}. Questions? <HelpPhoneLink tone="dark" inline />.
        </p>
      </BrandCard>,
    );
  }

  const dueLabel = statement.due_date ? fmtDate(statement.due_date) : null;

  return shell(
    <BrandCard padding={28}>
      <SerifHeading style={{ marginBottom: 6 }}>Pay statement {statement.number}</SerifHeading>
      <p style={{ margin: "0 0 18px", fontSize: 14, color: COLORS.textCaption }}>
        {billTo?.company ? `Billed to ${billTo.company}. ` : ""}
        {statement.terms ? `${termLabel(statement.terms)}. ` : ""}
        {dueLabel ? `Due ${dueLabel}.` : ""}
      </p>

      <div style={{ marginBottom: 18 }}>
        {(lines || []).map((l, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: `1px solid ${COLORS.grayLight || "#EEF2F6"}`, fontSize: 14, color: COLORS.textBody }}>
            <span style={{ minWidth: 0 }}>
              {fmtDate(l.service_date)} · {l.service_type || "Service"}
              {l.service_address ? ` · ${l.service_address}` : ""}
            </span>
            <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(l.total)}</span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 18 }}>
        <SummaryRow label="Subtotal" value={fmtCurrency(statement.subtotal)} />
        {Number(statement.tax_amount) > 0 && <SummaryRow label="Tax" value={fmtCurrency(statement.tax_amount)} />}
        <div style={{ borderTop: `1px solid ${COLORS.grayLight || "#E2E8F0"}`, marginTop: 6, paddingTop: 6 }}>
          <SummaryRow label="Amount due" value={fmtCurrency(statement.total)} strong />
        </div>
      </div>

      {payNotice && (
        <p style={{ fontSize: 14, color: COLORS.red, marginBottom: 12, lineHeight: 1.5 }}>{payNotice}</p>
      )}
      {setupError ? (
        <p style={{ fontSize: 15, color: COLORS.red, lineHeight: 1.55 }}>
          {setupError} Please refresh, or call us — <HelpPhoneLink tone="dark" inline />.
        </p>
      ) : !setup ? (
        <p style={{ fontSize: 14, color: COLORS.textCaption }}>Preparing secure payment…</p>
      ) : (
        <StatementPaymentForm
          token={token}
          publishableKey={setup.publishableKey || data.publishableKey}
          clientSecret={setup.clientSecret}
          paymentIntentId={setup.paymentIntentId}
          baseAmount={setup.baseAmount ?? statement.total}
          surchargeRateBps={data.surchargeRateBps}
          billingName={billTo?.company || null}
          billingEmail={billTo?.ap_email || null}
          onSuccess={() => setPaid(true)}
          onFinalizeFailed={resetPaymentIntent}
        />
      )}

      <p style={{ marginTop: 20, fontSize: 13, color: COLORS.textCaption, lineHeight: 1.5 }}>
        Questions about this statement? <HelpPhoneLink tone="dark" inline /> or reply to the email it came from.
      </p>
    </BrandCard>,
  );
}

function termLabel(v) {
  return { net15: "Net 15", net30: "Net 30", due_on_receipt: "Due on receipt" }[v] || v;
}
