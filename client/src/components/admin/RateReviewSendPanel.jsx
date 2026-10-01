// Rate review → Send letters (annual rate review comms lane, plan
// annual-rate-review-2026-09-30 step 4). Mounted in the Pricing hub → Rate
// review screen under the batch table, after the owner approves the batch.
//
// Approval and sending happen HERE, in the authenticated admin screen —
// never by replying to an email (CLAUDE.md rule 14). The panel reads the
// send preview (who gets a letter, on which channels, every suppression and
// its reason), and Send posts the preview's digest: if the list or the cost
// block changed in between, the server refuses and the panel reloads.
// Dark behind GATE_RATE_REVIEW — every route answers 404 while it is off.
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "../../utils/admin-fetch";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle,
  Table, TBody, TD, TH, THead, TR,
} from "../ui";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function fmtDay(day) {
  if (!day) return "";
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function channelText(c) {
  if (c.reason) return "—";
  return [c.channels?.email && "Email", c.channels?.sms && "Text"].filter(Boolean).join(" + ") || "—";
}

function SendRow({ customer }) {
  const lines = customer.lines || [];
  const suppressed = customer.suppressedLines || [];
  return (
    <TR>
      <TD data-label="Customer">{customer.name}</TD>
      <TD data-label="Letter">
        {lines.map((l) => (
          <div key={l.noticeId} className="text-ui-body">{l.service}: {l.now} → {l.new} · from {fmtDay(l.effectiveDate)}</div>
        ))}
        {suppressed.map((l) => (
          <div key={l.noticeId} className="text-ui-caption text-ink-secondary">Held: {l.service} · {l.label}</div>
        ))}
        {customer.alreadySent > 0 && <div className="text-ui-caption text-ink-tertiary">{plural(customer.alreadySent, "line")} already sent</div>}
      </TD>
      <TD data-label="Channels">{channelText(customer)}</TD>
      <TD data-label="Status" align="right">
        {customer.reason
          ? <Badge tone="warn">{customer.reasonLabel}</Badge>
          : lines.length ? <Badge tone="neutral">Will send</Badge> : <Badge tone="neutral">Nothing to send</Badge>}
      </TD>
    </TR>
  );
}

const COUNT_LABELS = [["letters", "letters"], ["email", "by email"], ["sms", "by text"], ["suppressedLines", "held back"], ["alreadySent", "already sent"]];

// One place for the preview's defaults, so the render never re-guards them.
function normalizePreview(preview) {
  const counts = Object.fromEntries(COUNT_LABELS.map(([key]) => [key, Number(preview?.counts?.[key]) || 0]));
  return { counts, customers: preview?.customers || [], costBlockReady: !!preview?.costBlockReady, unscheduled: Number(preview?.unscheduled) || 0 };
}

function PanelBody({ state, error, view, onRetry }) {
  if (state === "loading") return <div className="text-ui-body text-ink-secondary">Loading the send list…</div>;
  if (state === "error") return <ActionFeedback error onRetry={onRetry}>{error}</ActionFeedback>;
  return (
    <>
      {!view.costBlockReady && (
        <ActionFeedback error>Write the cost block in Settings first. The letter prints it, and nothing sends without it.</ActionFeedback>
      )}
      <div className="flex flex-wrap gap-4 text-ui-body text-ink-secondary">
        {COUNT_LABELS.map(([key, label]) => (
          <span key={key}><span className="u-nums text-zinc-900">{view.counts[key]}</span> {label}</span>
        ))}
      </div>
      {view.customers.length ? (
        <Table>
          <THead>
            <TR><TH>Customer</TH><TH>Letter</TH><TH>Channels</TH><TH align="right">Status</TH></TR>
          </THead>
          <TBody>
            {view.customers.map((c) => <SendRow key={c.customerId} customer={c} />)}
          </TBody>
        </Table>
      ) : (
        <div className="text-ui-body text-ink-secondary">No notices are prepared for this batch yet.</div>
      )}
    </>
  );
}

export default function RateReviewSendPanel({ batchKey }) {
  const [preview, setPreview] = useState(null);
  const [state, setState] = useState("loading"); // loading | ready | off | error
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const load = useCallback(async () => {
    if (!batchKey) return;
    setState("loading");
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${batchKey}/send-preview`);
      setPreview(data);
      setState("ready");
    } catch (e) {
      if (e.status === 404) setState("off");
      else { setError(e.message || "Could not load the send preview."); setState("error"); }
    }
  }, [batchKey]);

  useEffect(() => { load(); }, [load]);

  const scheduleDrafts = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${batchKey}/schedule`, { method: "POST", body: JSON.stringify({}) });
      setFeedback({ ok: true, text: `${plural(data.created || 0, "notice")} ready to send${data.held?.length ? `, ${data.held.length} held` : ""}.` });
    } catch (e) {
      setFeedback({ ok: false, text: e.message || "Could not create the notices." });
    } finally {
      setBusy(false);
      load();
    }
  };

  const send = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const data = await adminFetch(`/admin/rate-review/batches/${batchKey}/send`, { method: "POST", body: JSON.stringify({ expectedDigest: preview?.digest || "" }) });
      const extra = [data.unreachable && `${data.unreachable} unreachable`, data.failed && `${data.failed} failed`].filter(Boolean).join(", ");
      setFeedback({ ok: !data.failed, text: `${plural(data.sent || 0, "letter")} sent (${data.emailed || 0} emailed, ${data.texted || 0} texted)${extra ? `; ${extra}` : ""}.` });
    } catch (e) {
      setFeedback({ ok: false, text: e.message || "Could not send the letters." });
    } finally {
      setBusy(false);
      setConfirming(false);
      load();
    }
  };

  if (state === "off") return null;

  const view = normalizePreview(preview);
  const canSend = state === "ready" && view.costBlockReady && view.counts.letters > 0;
  const lettersLabel = plural(view.counts.letters, "letter");

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-18 font-medium tracking-tight text-zinc-900">Send letters</div>
            <div className="text-ui-body text-ink-secondary">
              One letter per customer by email, with a short text pointing to it. The 30 days count from delivery.
            </div>
          </div>
          <div className="flex gap-2">
            {view.unscheduled > 0 && (
              <Button variant="secondary" onClick={scheduleDrafts} disabled={busy}>Prepare {plural(view.unscheduled, "notice")}</Button>
            )}
            <Button onClick={() => setConfirming(true)} disabled={!canSend || busy}>Send {lettersLabel}</Button>
          </div>
        </div>
        {feedback && <ActionFeedback error={!feedback.ok}>{feedback.text}</ActionFeedback>}
        <PanelBody state={state} error={error} view={view} onRetry={load} />
      </CardBody>

      <Dialog open={confirming} onClose={() => !busy && setConfirming(false)} size="md">
        <DialogHeader><DialogTitle>Send {lettersLabel}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          <p className="m-0">
            {view.counts.email} by email and {view.counts.sms} by text go out now. Each customer's new rate applies to
            their first application on or after the date in their letter, at least 30 days from today.
          </p>
          <p className="m-0 text-ink-secondary">
            {plural(view.counts.suppressedLines, "line")} held back stay unsent. If the list or the cost block changed
            since this preview, nothing sends and the list reloads.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
          <Button onClick={send} loading={busy}>Send {lettersLabel}</Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
