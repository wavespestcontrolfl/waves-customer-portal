import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { visitMoneySummary } from "../../pages/tech/visitBrief";

const ink = "#18181b";
const muted = "#71717a";
const border = "#e4e4e7";
const rowStyle = { display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", alignItems: "flex-start" };
const moneyStyle = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const buttonStyle = { background: "transparent", border: 0, color: ink, minHeight: 44, padding: "8px 0", cursor: "pointer", font: "inherit", textDecoration: "underline", textUnderlineOffset: 3 };
const fmt = (amount) => amount == null ? "—" : Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD" });
const unitLabel = { application: "per application", month: "per month", one_time: "one-time" };
const statusCopy = {
  unlinked: "No estimate linked to this job.", not_accepted: "The linked estimate has not been accepted.",
  property_mismatch: "The estimate’s property does not match this job.",
  unmatched: "No matching service line on the linked estimate.", ambiguous: "More than one estimate line matches. Review the service link.",
};

function DiscountRow({ discount, note }) {
  return <div style={rowStyle}>
    <div>{discount.name}{discount.percent != null ? ` · ${discount.percent}%` : ""}
      {note && <div style={{ color: muted, marginTop: 3 }}>{note}</div>}
    </div>
    <span style={moneyStyle}>−{fmt(discount.dollars)}</span>
  </div>;
}

function ServicePrice({ line, apply }) {
  if (line.status !== "matched") return <div style={{ padding: "14px 16px", borderTop: `1px solid ${border}` }}>
    <div style={{ fontWeight: 500 }}>{line.serviceName}</div>
    <p style={{ color: muted, margin: "8px 0" }}>{statusCopy[line.status] || "Estimate pricing is unavailable."}</p>
    <RecordedServicePrice line={line} />
  </div>;
  const quote = line.quote;
  const proposal = apply ? line.proposal : null;
  const discounts = proposal ? proposal.discounts : quote.discounts;
  const recordedPriceDiffers = line.scheduledAmount !== quote.amount
    || (line.scheduledDiscount && line.scheduledBase !== quote.base);
  return <div style={{ padding: "12px 16px", borderTop: `1px solid ${border}` }}>
    <div style={{ fontWeight: 500, marginBottom: 7 }}>{line.serviceName}</div>
    {quote.base != null && <div style={rowStyle}><span>Base price · {unitLabel[quote.unit]}</span><span style={moneyStyle}>{fmt(quote.base)}</span></div>}
    {discounts.map((discount, index) => <DiscountRow key={index} discount={discount} note={proposal ? "Applies to this application" : "Included in accepted price"} />)}
    <div style={{ ...rowStyle, borderTop: `1px solid ${border}`, marginTop: 6, fontWeight: 500 }}>
      <span>{proposal ? "Price after discounts" : `Agreed price · ${unitLabel[quote.unit] || "unit unverified"}`}</span>
      <span style={moneyStyle}>{fmt(proposal?.amount ?? quote.amount)}</span>
    </div>
    {!quote.breakdownAvailable && <p style={{ color: muted, margin: "5px 0" }}>Discount breakdown unavailable.</p>}
    {!proposal && recordedPriceDiffers && <>
      <RecordedServicePrice line={line} />
      <p style={{ color: muted, margin: "5px 0" }}>Review this job’s recorded pricing when it differs from the agreement.</p>
    </>}
  </div>;
}

function RecordedServicePrice({ line }) {
  return <div style={{ borderTop: `1px solid ${border}`, marginTop: 8 }}>
    {line.scheduledBase != null && <div style={rowStyle}><span>Job base price</span><span style={moneyStyle}>{fmt(line.scheduledBase)}</span></div>}
    {line.scheduledDiscount && <DiscountRow discount={line.scheduledDiscount} note="Included in the scheduled price below" />}
    <div style={rowStyle}><span>Scheduled service price</span><span style={moneyStyle}>{fmt(line.scheduledAmount)}</span></div>
  </div>;
}

export default function CompletionPricingCard({ service, adminFetch, onReviewChange, disabled = false, allowDiscounts = true, reloadKey = 0 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedApply, setApply] = useState(false);
  const apply = selectedApply && allowDiscounts;
  const [retry, setRetry] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceButtonRef = useRef(null);
  const closeSource = useCallback(() => setSourceOpen(false), []);

  useEffect(() => {
    let cancelled = false;
    setData(null); setApply(false); setLoading(true); setError(""); setSourceOpen(false);
    onReviewChange(null);
    adminFetch(`/admin/schedule/${service.id}/estimate-source?completion=1`)
      .then((result) => {
        if (cancelled) return;
        const next = result?.completionPricing || null;
        setData(next); setApply(next?.canApply === true);
        if (!next) onReviewChange({ serviceId: service.id, ready: true });
      })
      .catch(() => { if (!cancelled) setError("Couldn’t load this service’s estimate and discounts."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [service.id, adminFetch, onReviewChange, retry, reloadKey]);

  useEffect(() => {
    if (!data || String(data.serviceId) !== String(service.id)) return;
    onReviewChange({ serviceId: service.id, ready: true, review: { witness: data.witness, applyDiscounts: apply },
      apply, amount: apply ? data.proposedAmount : data.currentAmount });
  }, [data, apply, service.id, onReviewChange]);


  if (!loading && !error && !data) return null; // Gate off.
  return <section aria-label="Estimate and pricing for this service" style={{ fontFamily: "Roboto, Arial, sans-serif", fontSize: 14, lineHeight: 1.45, color: ink, background: "#fff", border: `1px solid ${border}`, borderRadius: 12, overflow: "hidden", marginBottom: 20 }}>
    <div style={{ ...rowStyle, padding: "14px 16px" }}><span style={{ fontWeight: 500, fontSize: 16 }}>Estimate & pricing</span></div>
    {loading && <div role="status" style={{ padding: "0 16px 14px", color: muted }}>Loading this service’s price…</div>}
    {error && <div role="status" style={{ padding: "0 16px 14px" }}>{error}<br /><button type="button" style={buttonStyle} onClick={() => setRetry((n) => n + 1)} disabled={disabled}>Retry pricing</button></div>}
    {data && <>
      {data.estimate && <div style={{ ...rowStyle, padding: "0 16px 12px" }}><div>Accepted estimate · {data.estimate.reference || "Linked estimate"}<div style={{ color: muted, marginTop: 3 }}>Service matches shown below</div></div>
        <button ref={sourceButtonRef} type="button" style={buttonStyle} onClick={() => setSourceOpen(true)}>View estimate</button>
      </div>}
      <TierStatus data={data} />
      {data.lines.map((line) => <ServicePrice key={line.jobLineId} line={line} apply={apply} />)}
      {data.appointmentDiscount && <div style={{ padding: "0 16px", borderTop: `1px solid ${border}` }}><DiscountRow discount={(apply && data.proposedAppointmentDiscount) || data.appointmentDiscount} note="Entire appointment · Already recorded" /></div>}
      {data.canApply && <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 16px", borderTop: `1px solid ${border}`, cursor: disabled ? "default" : "pointer" }}>
        <input type="checkbox" checked={apply} disabled={disabled} onChange={(event) => setApply(event.target.checked)} style={{ width: 20, height: 20, accentColor: ink, flexShrink: 0 }} />
        <span>Apply eligible discounts when completing<div style={{ color: muted, marginTop: 3 }}>This application only. Nothing is saved yet.</div></span>
      </label>}
      <JobCharge service={service} data={data} apply={apply} />
    </>}
    {sourceOpen && <EstimateSourceDialog data={data} onClose={closeSource} returnFocusRef={sourceButtonRef} />}

  </section>;
}

function EstimateSourceDialog({ data, onClose, returnFocusRef }) {
  const sourceDialogRef = useRef(null);
  useEffect(() => {
    const close = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = sourceDialogRef.current?.querySelectorAll('button, a[href]');
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", close, true);
    return () => { document.removeEventListener("keydown", close, true); returnFocusRef.current?.focus(); };
  }, [onClose, returnFocusRef]);

  return createPortal(<div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 1200, background: "#0007", display: "flex", alignItems: "center", justifyContent: "center", padding: "calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px))" }} onClick={() => onClose()}>
      <div ref={sourceDialogRef} role="dialog" aria-modal="true" aria-label="Linked estimate for this job" style={{ fontFamily: "Roboto, Arial, sans-serif", lineHeight: 1.45, background: "white", color: ink, borderRadius: 10, width: "100%", maxWidth: 580, maxHeight: "100%", overflow: "auto", fontSize: 14 }} onClick={(event) => event.stopPropagation()}>
        <div style={{ ...rowStyle, padding: 16 }}><h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Linked estimate · {data.estimate.reference || "Accepted"}</h2><button type="button" autoFocus aria-label="Close estimate" onClick={() => onClose()} style={{ ...buttonStyle, minWidth: 44, textDecoration: "none" }}>×</button></div>
        {data.lines.map((line) => <ServicePrice key={line.jobLineId} line={line} apply={false} />)}
        <div style={{ padding: 16, borderTop: `1px solid ${border}` }}>
          {data.estimate.pdfUrl && <a href={data.estimate.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ ...buttonStyle, display: "inline-block" }}>Open full accepted estimate PDF</a>}
          <p style={{ margin: "8px 0", color: muted }}>Your completion notes and products stay open behind this estimate.</p>
        </div>
      </div>
    </div>, document.body);
}

function JobCharge({ service, data, apply }) {
  const billing = visitMoneySummary(service);
  const covered = ["prepaid", "covered_membership", "covered_annual"].includes(billing.kind);
  const noCharge = billing.kind === "no_charge" && ["callback", "always_free_service_type", "annual_renewal_owned"]
    .includes(service.billingLane?.prediction?.reason);
  const amount = covered || noCharge ? 0 : apply ? data.proposedAmount : data.currentAmount;
  const label = data.alreadyInvoiced ? "Recorded service price" : data.completedPrice ? "Completed application price" : noCharge ? "No charge for this application" : covered ? "Covered application" : "Charge for this application";
  const note = data.alreadyInvoiced ? "Already invoiced · Check job billing" : covered || noCharge ? billing.headline : "Before applicable tax or payment fees";
  const paymentNotes = { payer: "Billed to the payer", auto_charge: "Invoice then Auto Pay · Nothing charged yet" };
  return <div style={{ ...rowStyle, padding: "14px 16px", background: "#f4f4f5", alignItems: "center" }}>
    <div><span style={{ fontWeight: 500 }}>{label}</span><div style={{ color: muted, marginTop: 3 }}>{note}</div>
      {paymentNotes[billing.kind] && <div style={{ color: muted, marginTop: 3 }}>{paymentNotes[billing.kind]}</div>}
    </div>
    <span style={{ ...moneyStyle, fontSize: 26, fontWeight: 500 }}>{fmt(amount)}</span>
  </div>;
}

function TierStatus({ data }) {
  let message = null;
  if (data.tierRulesAvailable === false) message = "Tier eligibility is unavailable. No new tier discount is proposed.";
  else if (!data.canApply && data.tier && data.estimate?.tier
    && data.tier.toLowerCase() !== data.estimate.tier.toLowerCase()) {
    message = "The current tier differs from this agreement. An admin must review any change through the job’s price editor.";
  }
  return message ? <p style={{ padding: "0 16px 12px", margin: 0, color: muted }}>{message}</p> : null;
}
