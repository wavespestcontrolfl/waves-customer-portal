// Issue the New Construction Termite Warranty (Rule 5E-14.105(3)) from a
// pre-treat certificate. The certificate fills every job value; the office
// adds the contract basis, prices, the FDACS-13692 date and the issuer. With
// GATE_WARRANTY_13692_CHECK on, a signed FDACS-13692 on file (e-signed, or an
// uploaded paper scan) supplies that date.
// Saves a draft only: nothing is sent to the customer here.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter } from "../ui";
import { adminFetch } from "../../lib/adminFetch";
import {
  NEW_CONSTRUCTION_WARRANTY_TEMPLATE_KEY,
  pretreatWarrantyValues,
  sentCertificate,
  consumerNoticeOnFile,
  daysSinceTreatment,
  warrantyEligible,
  warrantyIssueReadiness,
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

// YYYY-MM-DD → MM/DD/YYYY for the grace end the server names.
const usDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
};

// The server's error, naming any certificate field it found empty.
function issueError(data, fallback) {
  const missing = data.unresolvedVariables || [];
  return missing.length
    ? `The certificate is missing: ${missing.join(", ")}. Fill it on the certificate first.`
    : data.error || fallback;
}

// The full warranty text, read before it is created. Create stays off until
// the box is ticked; the server refuses text that differs from this preview.
function WarrantyPreview({ text, warnings = [], reviewed, onReviewed }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {warnings.map((warning) => <div key={warning} role="status" style={{ fontSize: 14, color: "#18181B" }}>{warning}</div>)}
      <div style={{ fontSize: 14, color: "#18181B" }}>Read the full warranty. This is the exact text the customer signs.</div>
      <pre aria-label="Warranty text" style={{ ...fieldStyle, maxHeight: 360, overflowY: "auto", whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 }}>{text}</pre>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, color: "#18181B" }}>
        <input type="checkbox" checked={reviewed} onChange={(e) => onReviewed(e.target.checked)} />
        I read the full warranty text and it is correct.
      </label>
    </div>
  );
}

// Edit → Preview warranty → (read, tick) → Create warranty → done.
function IssueFooter({ stage, canPreview, canCreate, busy, onClose, onBack, onPreview, onCreate }) {
  if (stage === "done") return <DialogFooter><Button variant="secondary" onClick={onClose}>Done</Button></DialogFooter>;
  if (stage === "edit") {
    return (
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={onPreview} disabled={!canPreview}>{busy ? "Building…" : "Preview warranty"}</Button>
      </DialogFooter>
    );
  }
  return (
    <DialogFooter>
      <Button variant="secondary" onClick={onBack}>Back to edit</Button>
      <Button onClick={onCreate} disabled={!canCreate}>{busy ? "Creating…" : "Create warranty"}</Button>
    </DialogFooter>
  );
}

// The FDACS-13692 consumer notice (Rule 5E-14.105(1)): the one on file, or
// the grace-period warning with a paper-scan upload.
function ConsumerNoticePanel({ customerId, onFile, graceEnd, onUploaded }) {
  const [file, setFile] = useState(null);
  const [signedOn, setSignedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const base = `/admin/customers/${encodeURIComponent(customerId)}/consumer-notices`;

  const view = async () => {
    setProblem("");
    try {
      const response = await adminFetch(`${base}/paper/${encodeURIComponent(onFile.id)}/file`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) return setProblem(data.error || "Could not open the scan.");
      window.open(data.url, "_blank", "noopener");
    } catch (err) {
      setProblem(err.message || "Could not open the scan.");
    }
  };

  const upload = async () => {
    setBusy(true);
    setProblem("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("signedOn", signedOn.trim());
      const response = await adminFetch(`${base}/paper`, { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return setProblem(data.error || "Could not save the scan.");
      setFile(null);
      setSignedOn("");
      await onUploaded();
    } catch (err) {
      setProblem(err.message || "Could not save the scan.");
    } finally {
      setBusy(false);
    }
  };

  if (onFile) {
    return (
      <div role="status" style={{ fontSize: 14, color: "#18181B" }}>
        FDACS-13692 on file: {onFile.source === "paper" ? `paper, signed ${onFile.signedOn}` : `e-signed ${onFile.signedOn}`}.
        {onFile.source === "paper" && (
          <> <button type="button" onClick={view} style={{ background: "none", border: 0, padding: 0, color: "#18181B", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>View</button></>
        )}
        {problem && <div role="alert" style={{ color: "#B91C1C" }}>{problem}</div>}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div role="status" style={{ fontSize: 14, color: "#18181B" }}>
        No signed FDACS-13692 is on file for this customer. Until {graceEnd || "the grace end"} you can type the date it was signed.
        After that, the warranty cannot be issued without one: send it from Document Requests, or upload the paper form.
      </div>
      <Field id="warranty-notice-file" label="Upload paper FDACS-13692 (JPG, PNG or PDF, up to 10 MB)">
        <input id="warranty-notice-file" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} style={fieldStyle} />
      </Field>
      <Field id="warranty-notice-file-date" label="Paper form signed on (MM/DD/YYYY)">
        <input id="warranty-notice-file-date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} style={fieldStyle} />
      </Field>
      <div>
        <Button variant="secondary" onClick={upload} disabled={busy || !file || !signedOn.trim()}>{busy ? "Saving…" : "Upload paper FDACS-13692"}</Button>
      </div>
      {problem && <div role="alert" style={{ fontSize: 14, color: "#B91C1C" }}>{problem}</div>}
    </div>
  );
}

// The FDACS-13692 section of the form: the notice panel when the check is on,
// and the typed date unless a notice on file supplies it.
function ConsumerNoticeFields({ customerId, noticeList, onFile, noticeDate, onNoticeDate, noticeProblem, onUploaded }) {
  return (
    <>
      {noticeList && <ConsumerNoticePanel customerId={customerId} onFile={onFile} graceEnd={usDay(noticeList.graceEnd)} onUploaded={onUploaded} />}
      {!onFile && (
        <>
          <Field id="warranty-notice-date" label="FDACS-13692 consumer notice signed on (MM/DD/YYYY)">
            <input id="warranty-notice-date" value={noticeDate} onChange={(e) => onNoticeDate(e.target.value)} style={fieldStyle} />
          </Field>
          {noticeProblem && <div style={{ fontSize: 14, color: "#B91C1C" }}>{noticeProblem}</div>}
        </>
      )}
    </>
  );
}

// The customer's consumer-notices list. null = the check is off (the route
// answers 404) or not loaded: the typed date, as before.
function useConsumerNotices(customerId, open) {
  const [noticeList, setNoticeList] = useState(null);
  const loadNotices = useCallback(async () => {
    try {
      const response = await adminFetch(`/admin/customers/${encodeURIComponent(customerId)}/consumer-notices`);
      const data = response.ok ? await response.json().catch(() => null) : null;
      setNoticeList(data?.enabled ? data : null);
    } catch {
      setNoticeList(null);
    }
  }, [customerId]);
  useEffect(() => { if (open) loadNotices(); }, [open, loadNotices]);
  return { noticeList, loadNotices };
}

function Field({ id, label, children }) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export default function IssueWarrantyDialog({ open, onClose, project, findings }) {
  const [basisKind, setBasisKind] = useState("master");
  const base = useMemo(() => pretreatWarrantyValues({ project, findings, basisKind }), [project, findings, basisKind]);
  const [basisDate, setBasisDate] = useState("");
  const [treatmentPrice, setTreatmentPrice] = useState("");
  const [planPrice, setPlanPrice] = useState(base.warranty.plan_price);
  const [renewalFee, setRenewalFee] = useState("");
  const [noticeDate, setNoticeDate] = useState("");
  const [issuerName, setIssuerName] = useState("");
  const [issuerTitle, setIssuerTitle] = useState("");
  const [structures, setStructures] = useState(base.warranty.structures);
  const [noticeLocation, setNoticeLocation] = useState("");
  const [payer, setPayer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const [preview, setPreview] = useState(null);
  const [reviewed, setReviewed] = useState(false);
  const { noticeList, loadNotices } = useConsumerNotices(project.customer_id, open);

  const noticeOnFile = noticeList ? consumerNoticeOnFile(noticeList.notices, base.treatment.initial_date, basisDate) : null;
  const { basisProblem, noticeProblem, ready } = warrantyIssueReadiness(base, {
    basisDate, noticeDate, treatmentPrice, planPrice, renewalFee, issuerName, issuerTitle, structures, noticeLocation, payer,
  }, { noticeOnFile: Boolean(noticeOnFile) });
  const lateDays = daysSinceTreatment(base.warranty.start_date, base.warranty.issue_date);

  // The server builds every job field from the saved certificate and
  // stamps the issue date; only the office's own fields go up.
  const requestBody = (extra) => {
    const values = {
        warranty: {
          structures: structures.trim(),
          notice_location: noticeLocation.trim(),
          payer: payer.trim(),
          treatment_price: treatmentPrice.trim(),
          plan_price: planPrice.trim(),
          renewal_fee: renewalFee.trim(),
          // A notice on file prints its own date; the server ignores this one.
          ...(noticeOnFile ? {} : { consumer_notice_date: noticeDate.trim() }),
        },
        basis: { kind: basisKind, date: basisDate.trim() },
        issuer: { name: issuerName.trim(), title: issuerTitle.trim() },
    };
    // No propertyAddress or recipientName override: the server refuses them.
    return { customerId: project.customer_id, projectId: project.id, values, ...extra };
  };

  const run = async (step) => {
    setBusy(true);
    setError("");
    try {
      await step();
    } catch (err) {
      setError(err.message || "Could not create the warranty.");
    } finally {
      setBusy(false);
    }
  };

  const showPreview = () => run(async () => {
    const response = await adminFetch(
      `/admin/document-templates/${encodeURIComponent(NEW_CONSTRUCTION_WARRANTY_TEMPLATE_KEY)}/issue-preview`,
      { method: "POST", body: requestBody() },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setError(issueError(data, "Could not build the warranty text."));
    setReviewed(false);
    setPreview({ text: data.body, hash: data.renderHash, warnings: data.warnings });
  });

  const issue = () => run(async () => {
    const response = await adminFetch(
      `/admin/document-templates/${encodeURIComponent(NEW_CONSTRUCTION_WARRANTY_TEMPLATE_KEY)}/contracts`,
      { method: "POST", body: requestBody({ confirmedRenderHash: preview.hash }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return setError(issueError(data, "Could not create the warranty."));
    setCreated(true);
  });

  if (!open) return null;
  return (
    <Dialog open size="md" onClose={onClose} aria-label="Issue new construction warranty">
      <DialogBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#18181B" }}>Issue new construction warranty</div>
          <div style={mutedStyle}>
            {base.warranty.plan || "No plan on the certificate"} · treated {base.treatment.initial_date || "date missing"} · runs
            from the {base.warranty.start_basis} treatment date {base.warranty.start_date || "—"} · covered
            through {base.warranty.term_end || "—"} · {base.treatment.product || "product missing"}. Florida requires the
            warranty within 30 days of that date.
          </div>
          {basisKind === "master" && !base.warranty.start_date && (
            <div role="status" style={{ fontSize: 14, color: "#B91C1C" }}>
              A builder lot warranty runs from the final exterior treatment. Record its date on the certificate and send the
              certificate again first.
            </div>
          )}
          {lateDays != null && lateDays > 30 && (
            <div role="status" style={{ fontSize: 14, color: "#18181B" }}>
              Treated {lateDays} days ago: past the 30-day limit in Rule 5E-14.105(3)(a). Send it today.
            </div>
          )}
          {created ? (
            // The server saves it as a draft with no link: it counts as sent
            // only when Document Requests sends it (email, text or copy link).
            <div role="status" style={{ fontSize: 14, color: "#18181B" }}>
              Warranty saved as a draft. Nothing has gone to the owner yet. Send it from Contracts → Document Requests.
            </div>
          ) : preview ? (
            <>
              <WarrantyPreview text={preview.text} warnings={preview.warnings} reviewed={reviewed} onReviewed={setReviewed} />
              {error && <div role="alert" style={{ fontSize: 14, color: "#B91C1C" }}>{error}</div>}
            </>
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
              <ConsumerNoticeFields
                customerId={project.customer_id}
                noticeList={noticeList}
                onFile={noticeOnFile}
                noticeDate={noticeDate}
                onNoticeDate={setNoticeDate}
                noticeProblem={noticeProblem}
                onUploaded={loadNotices}
              />
              <Field id="warranty-notice-location" label="Treatment notice posted at (F.S. 482.226(5))">
                <input id="warranty-notice-location" value={noticeLocation} onChange={(e) => setNoticeLocation(e.target.value)} placeholder="e.g. on the wall beside the electric panel in the garage" style={fieldStyle} />
              </Field>
              <Field id="warranty-structures" label="Structures covered">
                <input id="warranty-structures" value={structures} onChange={(e) => setStructures(e.target.value)} style={fieldStyle} />
              </Field>
              <Field id="warranty-payer" label="Treatment paid by (builder or owner)">
                <input id="warranty-payer" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="Name of who paid for this treatment" style={fieldStyle} />
              </Field>
              <Field id="warranty-treatment-price" label="Treatment price">
                <input id="warranty-treatment-price" value={treatmentPrice} onChange={(e) => setTreatmentPrice(e.target.value)} placeholder="$0.00" style={fieldStyle} />
              </Field>
              <Field id="warranty-plan-price" label="Plan price">
                <input id="warranty-plan-price" value={planPrice} onChange={(e) => setPlanPrice(e.target.value)} placeholder="$0.00" style={fieldStyle} />
              </Field>
              <Field id="warranty-renewal-fee" label={basisKind === "master" ? "Annual renewal fee (fixed through year 5, not more than $149.00)" : "Annual renewal fee (fixed through year 5)"}>
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
      <IssueFooter
        stage={created ? "done" : preview ? "review" : "edit"}
        canPreview={ready && !busy}
        canCreate={reviewed && !busy}
        busy={busy}
        onClose={onClose}
        onBack={() => setPreview(null)}
        onPreview={showPreview}
        onCreate={issue}
      />
    </Dialog>
  );
}

// The "Issue warranty" button on a pre-treat certificate. Rule
// 5E-14.105(3): a new-building pre-treat gets a written warranty within 30
// days; an addition to an existing building (no plan years) gets none. Only
// a single soil-barrier application matches this warranty's wording.
// It reads the certificate as sent (the copy the server issues from); before
// any send it reads the live findings only to show the button, disabled.
export function IssueWarrantyAction({ project, findings, allowed, blocked, buttonStyle }) {
  const [open, setOpen] = useState(false);
  const sent = sentCertificate(project);
  const eligible = allowed
    && project?.project_type === "pre_treatment_termite_certificate"
    && Boolean(project?.customer_id)
    && warrantyEligible(sent ? sent.findings : findings || {});
  if (!eligible) return null;
  const unsent = !sent;
  const disabled = blocked || unsent;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        style={{ ...buttonStyle, opacity: disabled ? 0.4 : 1 }}
        title={unsent ? "Send the certificate first" : "Create the new construction warranty from the certificate as sent"}
      >
        Issue warranty
      </button>
      {open && <IssueWarrantyDialog open onClose={() => setOpen(false)} project={sent.project} findings={sent.findings} />}
    </>
  );
}
