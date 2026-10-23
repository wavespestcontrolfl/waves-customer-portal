// Issue the New Construction Termite Warranty (Rule 5E-14.105(3)) from a
// pre-treat certificate. The certificate fills every job value; the office
// adds the contract basis, prices, the FDACS-13692 date and the issuer.
// Creates the e-sign link only: nothing is sent to the customer here.
import { useMemo, useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter } from "../ui";
import { adminFetch } from "../../lib/adminFetch";
import {
  NEW_CONSTRUCTION_WARRANTY_TEMPLATE_KEY,
  pretreatWarrantyValues,
  warrantyContractBasis,
  basisDateProblem,
  daysSinceTreatment,
  warrantyEligible,
} from "../../lib/pretreatWarrantyValues";

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  fontSize: 14,
  border: "1px solid #D4D4D8",
  borderRadius: 6,
  background: "#FFFFFF",
  color: "#18181B",
};
const labelStyle = { display: "block", fontSize: 14, fontWeight: 500, color: "#18181B", marginBottom: 4 };
const mutedStyle = { fontSize: 14, color: "#71717A" };

function Field({ id, label, children }) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export default function IssueWarrantyDialog({ open, onClose, project, findings }) {
  const base = useMemo(() => pretreatWarrantyValues({ project, findings }), [project, findings]);
  const [basisKind, setBasisKind] = useState("master");
  const [basisDate, setBasisDate] = useState("");
  const [treatmentPrice, setTreatmentPrice] = useState("");
  const [planPrice, setPlanPrice] = useState(base.warranty.plan_price);
  const [renewalFee, setRenewalFee] = useState("");
  const [noticeDate, setNoticeDate] = useState("");
  const [issuerName, setIssuerName] = useState("");
  const [issuerTitle, setIssuerTitle] = useState("");
  const [structures, setStructures] = useState(base.warranty.structures);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signingUrl, setSigningUrl] = useState("");

  const basisProblem = basisDate.trim() ? basisDateProblem(basisDate, base.treatment.initial_date) : "";
  const noticeProblem = noticeDate.trim() ? basisDateProblem(noticeDate, base.treatment.initial_date) : "";
  const lateDays = daysSinceTreatment(base.treatment.initial_date, base.warranty.issue_date);
  const ready = [basisDate, treatmentPrice, planPrice, renewalFee, noticeDate, issuerName, issuerTitle, structures]
    .every((v) => v.trim()) && !basisProblem && !noticeProblem && base.warranty.term_end && base.treatment.initial_date;

  const issue = async () => {
    setBusy(true);
    setError("");
    try {
      const values = {
        ...base,
        warranty: {
          ...base.warranty,
          structures: structures.trim(),
          treatment_price: treatmentPrice.trim(),
          plan_price: planPrice.trim(),
          renewal_fee: renewalFee.trim(),
          consumer_notice_date: noticeDate.trim(),
          contract_basis: warrantyContractBasis({ kind: basisKind, builder: base.project.builder, date: basisDate }),
        },
        issuer: { name: issuerName.trim(), title: issuerTitle.trim() },
      };
      const response = await adminFetch(
        `/admin/document-templates/${encodeURIComponent(NEW_CONSTRUCTION_WARRANTY_TEMPLATE_KEY)}/contracts`,
        {
          method: "POST",
          body: {
            customerId: project.customer_id,
            values,
            ...(base.project.address ? { propertyAddress: base.project.address } : {}),
          },
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const missing = data.unresolvedVariables || [];
        setError(missing.length
          ? `The certificate is missing: ${missing.join(", ")}. Fill it on the certificate first.`
          : data.error || "Could not create the warranty.");
        return;
      }
      setSigningUrl(data.signingUrl || data.contract?.signingUrl || "");
    } catch (err) {
      setError(err.message || "Could not create the warranty.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Dialog open size="md" onClose={onClose} aria-label="Issue new construction warranty">
      <DialogBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#18181B" }}>Issue new construction warranty</div>
          <div style={mutedStyle}>
            {base.warranty.plan || "No plan on the certificate"} · treated {base.treatment.initial_date || "date missing"} · covered
            through {base.warranty.term_end || "—"} · {base.treatment.product || "product missing"}. Florida requires the
            warranty within 30 days of the treatment date.
          </div>
          {lateDays != null && lateDays > 30 && (
            <div role="status" style={{ fontSize: 14, color: "#18181B" }}>
              Treated {lateDays} days ago: past the 30-day limit. The warranty states its real issue date.
            </div>
          )}
          {signingUrl ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 14, color: "#18181B" }}>
                Warranty created. Send it for signature from Document Requests.
              </div>
              <input id="warranty-signing-url" readOnly value={signingUrl} style={fieldStyle} onFocus={(e) => e.target.select()} />
            </div>
          ) : (
            <>
              <Field id="warranty-basis" label="Contract signed before treatment (Rule 5E-14.105(2))">
                <select id="warranty-basis" value={basisKind} onChange={(e) => setBasisKind(e.target.value)} style={fieldStyle}>
                  <option value="master">Builder master agreement</option>
                  <option value="signed">Signed by the owner or agent before treatment</option>
                </select>
              </Field>
              <Field id="warranty-basis-date" label={basisKind === "master" ? "Master agreement date (MM/DD/YYYY)" : "Date signed (MM/DD/YYYY)"}>
                <input id="warranty-basis-date" value={basisDate} onChange={(e) => setBasisDate(e.target.value)} style={fieldStyle} />
              </Field>
              {basisProblem && <div style={{ fontSize: 14, color: "#B91C1C" }}>{basisProblem}</div>}
              <Field id="warranty-notice-date" label="FDACS-13692 consumer notice signed on (MM/DD/YYYY)">
                <input id="warranty-notice-date" value={noticeDate} onChange={(e) => setNoticeDate(e.target.value)} style={fieldStyle} />
              </Field>
              {noticeProblem && <div style={{ fontSize: 14, color: "#B91C1C" }}>{noticeProblem}</div>}
              <Field id="warranty-structures" label="Structures covered">
                <input id="warranty-structures" value={structures} onChange={(e) => setStructures(e.target.value)} style={fieldStyle} />
              </Field>
              <Field id="warranty-treatment-price" label="Treatment price">
                <input id="warranty-treatment-price" value={treatmentPrice} onChange={(e) => setTreatmentPrice(e.target.value)} placeholder="$0.00" style={fieldStyle} />
              </Field>
              <Field id="warranty-plan-price" label="Plan price">
                <input id="warranty-plan-price" value={planPrice} onChange={(e) => setPlanPrice(e.target.value)} placeholder="$0.00" style={fieldStyle} />
              </Field>
              <Field id="warranty-renewal-fee" label="Annual renewal fee (fixed through year 5)">
                <input id="warranty-renewal-fee" value={renewalFee} onChange={(e) => setRenewalFee(e.target.value)} placeholder="$0.00" style={fieldStyle} />
              </Field>
              <Field id="warranty-issuer-name" label="Signed for Waves by">
                <input id="warranty-issuer-name" value={issuerName} onChange={(e) => setIssuerName(e.target.value)} style={fieldStyle} />
              </Field>
              <Field id="warranty-issuer-title" label="Title">
                <input id="warranty-issuer-title" value={issuerTitle} onChange={(e) => setIssuerTitle(e.target.value)} style={fieldStyle} />
              </Field>
              {error && <div role="alert" style={{ fontSize: 14, color: "#B91C1C" }}>{error}</div>}
            </>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>{signingUrl ? "Done" : "Cancel"}</Button>
        {!signingUrl && (
          <Button onClick={issue} disabled={!ready || busy}>{busy ? "Creating…" : "Create warranty"}</Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

// The "Issue warranty" button on a pre-treat certificate. Rule
// 5E-14.105(3): a new-building pre-treat gets a written warranty within 30
// days; an addition to an existing building (no plan years) gets none. Only
// a single soil-barrier application matches this warranty's wording.
export function IssueWarrantyAction({ project, findings, allowed, blocked, unsaved, buttonStyle }) {
  const [open, setOpen] = useState(false);
  const eligible = allowed
    && project?.project_type === "pre_treatment_termite_certificate"
    && Boolean(project?.customer_id)
    && warrantyEligible(findings || {});
  if (!eligible) return null;
  const disabled = blocked || unsaved;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        style={{ ...buttonStyle, opacity: disabled ? 0.4 : 1 }}
        title={unsaved ? "Save changes first" : "Create the new construction warranty for signature"}
      >
        Issue warranty
      </button>
      {open && <IssueWarrantyDialog open onClose={() => setOpen(false)} project={project} findings={findings} />}
    </>
  );
}
