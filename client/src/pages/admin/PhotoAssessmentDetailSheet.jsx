/**
 * Photo assessment detail — customer report preview, tech treatment view,
 * photos, funnel timeline, linking, and the MANUAL send-report action.
 *
 * The "Send report" button here is the only thing that ever emails an
 * assessment report (owner-sends-all-comms rule): it requires an explicit
 * click plus a confirm dialog, and the server mints/refreshes the tokenized
 * link either way so copy-link always works when email can't.
 *
 * Tier 1 V2 — components/ui + Tailwind zinc; alert-fg only for genuine
 * safety flags (venomous / structural).
 */

import { useState, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetHeader,
  SheetBody,
  Button,
  Badge,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Input,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { stageOf } from "./PhotoAssessmentsPage";

const TYPE_LABELS = { lawn: "Lawn Assessment", pest: "Pest Identification" };

const dateTimeET = (v) =>
  v
    ? new Date(v).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
    : "—";

function Row({ label, children }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 border-b border-hairline border-zinc-100 last:border-0">
      <div className="text-[14px] text-zinc-500 shrink-0">{label}</div>
      <div className="text-[14px] text-zinc-900 text-right">{children || "—"}</div>
    </div>
  );
}

function SendReportDialog({ open, onClose, type, id, defaultEmail, onSent }) {
  const [email, setEmail] = useState(defaultEmail || "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) { setEmail(defaultEmail || ""); setBusy(false); setResult(null); setError(""); }
  }, [open, defaultEmail]);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await adminFetch(`/admin/photo-assessments/${type}/${id}/send-report`, {
        method: "POST",
        body: { email: email.trim() },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Send failed (${r.status})`);
      setResult(data);
      onSent();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose}>
      <DialogHeader>
        <DialogTitle>Send report to customer</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        {result ? (
          <div className="space-y-2">
            <div className="text-[14px] text-zinc-900">
              {result.sent
                ? `Report emailed to ${email.trim()}.`
                : `Email did not go out (${result.error || "send failed"}) — the link below still works, copy and share it manually.`}
            </div>
            <div className="flex gap-2 items-center">
              <Input readOnly value={result.reportUrl || ""} onFocus={(e) => e.target.select()} />
              <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(result.reportUrl || "")}>Copy</Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[14px] text-zinc-600">
              This emails the tokenized report link. It only ever sends on this click — nothing automated uses it.
            </p>
            <div>
              <label className="block text-[13px] text-zinc-500 mb-1">Recipient email</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prospect@example.com" />
            </div>
            {error ? <div className="text-[14px] text-alert-fg">{error}</div> : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={send} disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send report"}</Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function LinkDialog({ open, onClose, type, id, onLinked }) {
  const [kind, setKind] = useState("lead"); // lead | customer
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) { setKind("lead"); setQuery(""); setResults([]); setError(""); setBusy(false); }
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < 2) { setResults([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const path = kind === "lead"
          ? `/admin/leads?search=${encodeURIComponent(query.trim())}&limit=8`
          : `/admin/customers?search=${encodeURIComponent(query.trim())}&limit=8`;
        const r = await adminFetch(path);
        if (!r.ok) return;
        const data = await r.json();
        const rows = kind === "lead" ? (data.leads || data.rows || []) : (data.customers || data.rows || []);
        setResults(rows.slice(0, 8));
      } catch {
        /* type-ahead is best-effort */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [open, kind, query]);

  const link = async (rowId) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await adminFetch(`/admin/photo-assessments/${type}/${id}/link`, {
        method: "POST",
        body: { [kind === "lead" ? "lead_id" : "customer_id"]: rowId },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Link failed (${r.status})`);
      onLinked();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose}>
      <DialogHeader>
        <DialogTitle>Link to {kind}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Tabs value={kind} onValueChange={setKind}>
          <TabList>
            <Tab value="lead">Lead</Tab>
            <Tab value="customer">Customer</Tab>
          </TabList>
        </Tabs>
        <Input placeholder={`Search ${kind}s by name, phone, email…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {results.length ? (
          <div className="border border-hairline border-zinc-200 rounded-md divide-y divide-zinc-100">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={busy}
                onClick={() => link(r.id)}
                className="w-full text-left px-3 py-2 text-[14px] text-zinc-900 hover:bg-zinc-50"
              >
                {/* Leads return snake_case fields; /api/admin/customers returns camelCase. */}
                {[r.first_name || r.firstName, r.last_name || r.lastName].filter(Boolean).join(" ") || r.name || r.id}
                <span className="text-zinc-500"> {r.phone || r.email || ""}</span>
              </button>
            ))}
          </div>
        ) : query.trim().length >= 2 ? (
          <div className="text-[14px] text-zinc-500">No matches.</div>
        ) : null}
        {error ? <div className="text-[14px] text-alert-fg">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
      </DialogFooter>
    </Dialog>
  );
}

function LawnTechView({ contract }) {
  const findings = Array.isArray(contract?.diagnosis?.findings) ? contract.diagnosis.findings : [];
  if (!findings.length) {
    return <div className="text-[14px] text-zinc-500">No defensible findings — the report released in minimal mode.</div>;
  }
  return (
    <div className="space-y-3">
      {findings.map((f, i) => (
        <div key={f.finding_id || i} className="border border-hairline border-zinc-200 rounded-md p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] text-zinc-900">{f.name}</span>
            <Badge tone="neutral">{f.severity || "—"}</Badge>
            <Badge tone="neutral">{f.confidence || "—"} confidence</Badge>
          </div>
          {f.confirmation_step ? (
            <div className="mt-1.5 text-[14px] text-zinc-600"><span className="text-zinc-500">Verify on-site:</span> {f.confirmation_step}</div>
          ) : null}
          {Array.isArray(f.observed_evidence) && f.observed_evidence.length ? (
            <div className="mt-1 text-[14px] text-zinc-600"><span className="text-zinc-500">Evidence:</span> {f.observed_evidence.join("; ")}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PestTechView({ techView }) {
  if (!techView) return null;
  const safety = techView.safety || {};
  const safetyFlags = [
    safety.venomous && "Venomous",
    safety.stinging && "Stinging",
    safety.disease_vector && "Disease vector",
    safety.structural_threat && "Structural threat",
  ].filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[15px] text-zinc-900">{techView.identification?.label || "No library match"}</span>
        <Badge tone="neutral">{techView.identification?.confidence || "—"} confidence</Badge>
        {techView.identification?.contested ? <Badge tone="neutral">contested across photos</Badge> : null}
        {safetyFlags.map((f) => <Badge key={f} tone="alert">{f}</Badge>)}
      </div>
      <Row label="Service line">{techView.service?.label} {techView.service?.inspection_required ? "(inspection first)" : ""}</Row>
      <Row label="Urgency">{techView.urgency}</Row>
      {techView.tech_notes ? (
        <div>
          <div className="text-[13px] uppercase tracking-label text-zinc-500 mb-1">Tech notes</div>
          <div className="text-[14px] text-zinc-700">{techView.tech_notes}</div>
        </div>
      ) : null}
      {Array.isArray(techView.differentials) && techView.differentials.length ? (
        <div>
          <div className="text-[13px] uppercase tracking-label text-zinc-500 mb-1">Differentials</div>
          {techView.differentials.map((d) => (
            <div key={d.slug} className="text-[14px] text-zinc-700 mb-1"><span className="text-zinc-900">{d.label}:</span> {d.tech_notes}</div>
          ))}
        </div>
      ) : null}
      {Array.isArray(techView.observations) && techView.observations.length ? (
        <div>
          <div className="text-[13px] uppercase tracking-label text-zinc-500 mb-1">Model observations (internal)</div>
          {techView.observations.map((o, i) => <div key={i} className="text-[14px] text-zinc-600 mb-1">{o}</div>)}
        </div>
      ) : null}
    </div>
  );
}

function CustomerPreview({ type, preview }) {
  if (!preview) return null;
  if (type === "lawn") {
    const findings = Array.isArray(preview.findings) ? preview.findings : [];
    return (
      <div className="space-y-3">
        <Row label="Overall status">{preview.overall_status}</Row>
        {preview.summary ? <div className="text-[14px] text-zinc-700">{preview.summary}</div> : null}
        {findings.map((f, i) => (
          <div key={i} className="border border-hairline border-zinc-200 rounded-md p-3">
            <div className="text-[15px] text-zinc-900">{f.name}</div>
            {f.customer_note ? <div className="text-[14px] text-zinc-600 mt-1">{f.customer_note}</div> : null}
          </div>
        ))}
        {Array.isArray(preview.pricing?.tiers) && preview.pricing.tiers.length ? (
          <div>
            <div className="text-[13px] uppercase tracking-label text-zinc-500 mb-1">Pricing shown</div>
            {preview.pricing.tiers.map((t, i) => (
              <Row key={i} label={t.label}>{t.monthly != null ? `$${t.monthly}/mo` : ""} {t.annual != null ? `· $${t.annual}/yr` : ""}</Row>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Row label="Identified as">{preview.identified?.label}</Row>
      <Row label="Urgency">{preview.urgency}</Row>
      {preview.about ? <div className="text-[14px] text-zinc-700">{preview.about}</div> : null}
      {preview.recommendation ? (
        <Row label="Recommendation">
          {preview.recommendation.service_label}{preview.recommendation.inspection_required ? " (free inspection first)" : ""}
        </Row>
      ) : null}
      {Array.isArray(preview.pricing?.tiers) && preview.pricing.tiers.length ? (
        <Row label="Pricing shown">{preview.pricing.tiers.map((t) => `${t.label}: $${t.monthly}/mo`).join(" · ")}</Row>
      ) : null}
    </div>
  );
}

export default function PhotoAssessmentDetailSheet({ open, type, id, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("report");
  const [showSend, setShowSend] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);

  const load = useCallback(async () => {
    if (!open || !type || !id) return;
    setLoading(true);
    try {
      const r = await adminFetch(`/admin/photo-assessments/${type}/${id}`);
      setData(r.ok ? await r.json() : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [open, type, id]);

  useEffect(() => { setTab("report"); setCopied(false); load(); }, [load]);

  const assessment = data?.assessment;
  const stage = assessment ? stageOf(assessment) : null;
  const contactName = assessment
    ? [assessment.contact?.first_name, assessment.contact?.last_name].filter(Boolean).join(" ")
    : "";

  const copyLink = async () => {
    if (!assessment?.report_url) return;
    await navigator.clipboard?.writeText(assessment.report_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Phone-only prospects have no email to send to — mint the link without
  // sending anything and put it on the clipboard for a manual text/read-out.
  const generateLink = async () => {
    if (minting) return;
    setMinting(true);
    try {
      const r = await adminFetch(`/admin/photo-assessments/${type}/${id}/generate-link`, { method: "POST" });
      const body = r.ok ? await r.json() : null;
      if (body?.reportUrl) {
        try {
          await navigator.clipboard?.writeText(body.reportUrl);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard can be denied — the link is minted either way and
          // shows via the reloaded detail's Copy link.
        }
        load();
        onChanged?.();
      }
    } finally {
      setMinting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} width="lg">
      <SheetHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[16px] text-zinc-900">{TYPE_LABELS[type] || "Assessment"}{contactName ? ` — ${contactName}` : ""}</div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {assessment ? <Badge tone={stage.key === "sent" ? "strong" : "neutral"}>{stage.label}</Badge> : null}
              {assessment ? <span className="text-[13px] text-zinc-500">{assessment.headline}</span> : null}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {assessment?.report_url ? (
              <Button variant="secondary" onClick={copyLink}>{copied ? "Copied" : "Copy link"}</Button>
            ) : ["analyzed", "sent"].includes(assessment?.status) ? (
              <Button variant="secondary" onClick={generateLink} disabled={minting}>
                {copied ? "Copied" : minting ? "Getting link…" : "Get link"}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setShowLink(true)}>Link…</Button>
            <Button onClick={() => setShowSend(true)}>Send report</Button>
          </div>
        </div>
      </SheetHeader>
      <SheetBody>
        {loading || !data ? (
          <div className="text-[14px] text-zinc-500 p-4">{loading ? "Loading…" : "Could not load this assessment."}</div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabList>
              <Tab value="report">Customer report</Tab>
              <Tab value="tech">Tech view</Tab>
              <Tab value="photos">Photos ({data.photos?.length || 0})</Tab>
              <Tab value="details">Details</Tab>
            </TabList>
            <TabPanel value="report" className="pt-3">
              <CustomerPreview type={type} preview={data.customer_preview} />
            </TabPanel>
            <TabPanel value="tech" className="pt-3">
              {type === "lawn" ? <LawnTechView contract={data.tech_view?.contract} /> : <PestTechView techView={data.tech_view} />}
            </TabPanel>
            <TabPanel value="photos" className="pt-3">
              {data.photos?.length ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {data.photos.map((p) => (
                    p.url
                      ? <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={`Assessment photo ${p.photo_index + 1}`} className="w-full h-36 object-cover rounded-md border border-hairline border-zinc-200" /></a>
                      : <div key={p.id} className="w-full h-36 rounded-md border border-hairline border-zinc-200 bg-zinc-50 flex items-center justify-center text-[13px] text-zinc-500">No stored image</div>
                  ))}
                </div>
              ) : (
                <div className="text-[14px] text-zinc-500">No photos stored for this assessment.</div>
              )}
            </TabPanel>
            <TabPanel value="details" className="pt-3">
              <Row label="Contact">{contactName}</Row>
              <Row label="Email">{assessment.contact?.email}</Row>
              <Row label="Phone">{assessment.contact?.phone}</Row>
              <Row label="Address">{assessment.address ? [assessment.address.line1, assessment.address.city, assessment.address.zip].filter(Boolean).join(", ") : "—"}</Row>
              <Row label="Prospect note">{assessment.prospect_note}</Row>
              <Row label="Source">{assessment.source}</Row>
              <Row label="Created">{dateTimeET(assessment.created_at)}</Row>
              <Row label="Unlocked">{dateTimeET(assessment.claimed_at)}</Row>
              <Row label="First viewed">{dateTimeET(assessment.report_first_viewed_at)}</Row>
              <Row label="Report sent">{dateTimeET(assessment.last_sent_at)}</Row>
              <Row label="Link expires">{dateTimeET(assessment.report_expires_at)}</Row>
              <Row label="Lead">{data.lead ? `${[data.lead.first_name, data.lead.last_name].filter(Boolean).join(" ")} (${data.lead.status})` : "—"}</Row>
              <Row label="Customer">{data.customer ? [data.customer.first_name, data.customer.last_name].filter(Boolean).join(" ") : "—"}</Row>
            </TabPanel>
          </Tabs>
        )}
      </SheetBody>

      <SendReportDialog
        open={showSend}
        onClose={() => setShowSend(false)}
        type={type}
        id={id}
        // Snapshot email first, then the linked lead/customer — matches the
        // server's recipient fallback, so "link a contact first" prefills.
        defaultEmail={assessment?.contact?.email || data?.lead?.email || data?.customer?.email || ""}
        onSent={() => { load(); onChanged(); }}
      />
      <LinkDialog
        open={showLink}
        onClose={() => setShowLink(false)}
        type={type}
        id={id}
        onLinked={() => { load(); onChanged(); }}
      />
    </Sheet>
  );
}
