/**
 * <TypedDecisionsReviewPage> — owner labeling queue for typed-decision shadow
 * rows (Agents hub, ?tab=typed). Each row shows Jev's typed answer next to the
 * baselines, the customer-facing subject text, and three label buttons.
 *
 * Server: /api/admin/typed-decisions (GET /reviews, POST /reviews/:id/label).
 * A "Jev wrong" click on a yes/no question sends correct_value = !jevAnswer.yes
 * on its own; choice/score questions only offer Jev right / Unclear.
 *
 * Customer text is rendered live only — it is never logged or stored.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { ActionFeedback, Badge, Button, Card, Input, UiSurface } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

const STATUS_OPTIONS = [
  { value: "unreviewed", label: "Unreviewed" },
  { value: "disagreement", label: "Disagreement" },
  { value: "suspected_error", label: "Suspected error" },
  { value: "confirmed_correct", label: "Confirmed right" },
  { value: "confirmed_error", label: "Confirmed wrong" },
  { value: "all", label: "All" },
];

const titleCase = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

function timeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const isYesNo = (answer) => typeof answer?.yes === "boolean";

// "Yes (0.91)" for yes/no answers; choice and score answers fall back to
// whichever field they carry.
export function formatAnswer(answer) {
  if (answer === null || answer === undefined) return "-";
  if (typeof answer !== "object") return titleCase(String(answer));
  let main;
  if (typeof answer.yes === "boolean") main = answer.yes ? "Yes" : "No";
  else if (answer.choice !== undefined && answer.choice !== null) main = titleCase(answer.choice);
  else if (answer.score !== undefined && answer.score !== null) main = String(answer.score);
  else main = "-";
  const conf = typeof answer.p === "number" ? answer.p : null;
  return conf === null ? main : `${main} (${conf.toFixed(2)})`;
}

function SubjectText({ subject }) {
  const [open, setOpen] = useState(false);
  if (!subject || !subject.text) {
    return <div className="text-14 text-ink-secondary">Subject text unavailable.</div>;
  }
  if (subject.type === "call_log") {
    const outbound = String(subject.direction || "").startsWith("outbound");
    const long = subject.text.length > 280;
    const shown = open || !long ? subject.text : `${subject.text.slice(0, 280)}…`;
    return (
      <div className="min-w-0 space-y-1">
        <div className="text-12 font-medium uppercase text-ink-secondary">
          {outbound ? "Outbound call" : "Inbound call"}{subject.at ? ` · ${timeLabel(subject.at)}` : ""}
        </div>
        {outbound && (
          // The same warning Jev's call_direction line carries (call-self-audit.js).
          <div className="text-14 text-ink-secondary">Waves placed this call. Speaker labels can be swapped on outbound calls; judge who is staff by what each person says.</div>
        )}
        <div className="whitespace-pre-wrap break-words text-ui-body text-zinc-800">{shown}</div>
        {long && (
          <button type="button" className="inline-flex min-h-11 items-center gap-1 text-14 text-zinc-700 underline sm:min-h-0" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {open ? "Collapse transcript" : "Show full transcript"}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-2">
      {subject.previousText && (
        <div>
          <div className="text-12 font-medium uppercase text-ink-secondary">Waves said</div>
          <div className="whitespace-pre-wrap break-words text-ui-body text-zinc-400">{subject.previousText}</div>
        </div>
      )}
      <div>
        <div className="text-12 font-medium uppercase text-ink-secondary">
          {subject.direction === "outbound" ? "Waves text" : "Customer text"}{subject.at ? ` · ${timeLabel(subject.at)}` : ""}
        </div>
        <div className="whitespace-pre-wrap break-words text-ui-body text-zinc-800">{subject.text}</div>
      </div>
    </div>
  );
}

function AnswersBlock({ review }) {
  const baselines = Object.entries(review.baselineAnswers || {});
  return (
    <div className="space-y-1 text-ui-body">
      <div className="font-medium text-zinc-900">Jev: {formatAnswer(review.jevAnswer)}</div>
      {baselines.map(([name, value]) => (
        <div key={name} className="text-zinc-700">{name.replace(/_/g, " ")}: {formatAnswer(value)}</div>
      ))}
    </div>
  );
}

// What a failed label POST means for the row (server 409 codes).
function labelFailure(err) {
  if (err?.status !== 409) return "error";
  if (err.code === "subject_changed") return "moved";
  if (err.code === "answer_changed") return "stale";
  return "conflict";
}

function ReviewRow({ review, onLabeled, onStale }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(null);
  // The call was reprocessed after Jev answered (server: subjectChanged, or a
  // 409 subject_changed): the transcript shown is not the one Jev judged.
  const [moved, setMoved] = useState(review.subjectChanged === true);

  const yesNo = isYesNo(review.jevAnswer);

  const submit = async (verdict, force = false) => {
    setBusy(verdict);
    setError("");
    const body = { verdict, seen_answer: review.jevAnswer };
    if (verdict === "jev_wrong") body.correct_value = !review.jevAnswer.yes;
    if (note.trim()) body.note = note.trim();
    if (force) body.force = true;
    try {
      const result = await adminFetch(`/admin/typed-decisions/reviews/${encodeURIComponent(review.id)}/label`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setConflict(null);
      onLabeled(review.id, result?.review || null);
    } catch (err) {
      const kind = labelFailure(err);
      if (kind === "conflict") setConflict({ verdict, status: err.details?.labelStatus || review.labelStatus || "labeled" });
      else setConflict(null);
      if (kind === "moved") setMoved(true);
      if (kind === "stale") onStale();
      if (kind === "error") setError(err?.message || "Could not save the label.");
    } finally {
      setBusy("");
    }
  };

  return (
    <Card className="space-y-3 p-4" data-testid="typed-review-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-14 font-medium text-zinc-900">{titleCase(review.capability)}</span>
        {review.sampledFor && <Badge tone={review.sampledFor === "disagreement" ? "warn" : "neutral"}>{titleCase(review.sampledFor)}</Badge>}
        {review.labelStatus && review.labelStatus !== "unreviewed" && <Badge tone="strong">{titleCase(review.labelStatus)}</Badge>}
        <span className="ml-auto text-12 text-ink-secondary">{timeLabel(review.createdAt)}</span>
      </div>
      <div className="text-ui-body text-zinc-800">{review.question}</div>

      <SubjectText subject={review.subject} />

      <AnswersBlock review={review} />

      {review.label?.verdict && (
        <div className="text-14 text-ink-secondary">
          Labeled {titleCase(review.label.verdict)}{review.label.note ? ` — ${review.label.note}` : ""}
        </div>
      )}

      {moved ? (
        <div role="status" className="text-14 text-ink-secondary">
          This call was reprocessed after Jev answered, so the transcript above is not the one Jev judged. It can't be labeled.
        </div>
      ) : (
      <>
      <Input
        aria-label="Note (optional)"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
      />

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!!busy} loading={busy === "jev_right" ? true : undefined} onClick={() => submit("jev_right")}>Jev right</Button>
        {yesNo && (
          <Button variant="secondary" disabled={!!busy} loading={busy === "jev_wrong" ? true : undefined} onClick={() => submit("jev_wrong")}>Jev wrong</Button>
        )}
        <Button variant="ghost" disabled={!!busy} loading={busy === "unclear" ? true : undefined} onClick={() => submit("unclear")}>Unclear</Button>
      </div>
      </>
      )}

      {error && <ActionFeedback error>{error}</ActionFeedback>}
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-14 text-alert-fg">
          <span>Already labeled ({String(conflict.status).replace(/_/g, " ")}) — replace?</span>
          <Button variant="danger" disabled={!!busy} onClick={() => submit(conflict.verdict, true)}>Replace</Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => setConflict(null)}>Cancel</Button>
        </div>
      )}
    </Card>
  );
}

const PAGE_SIZE = 50;

export default function TypedDecisionsReviewPage({ embedded = false } = {}) {
  const [status, setStatus] = useState("unreviewed");
  const [sampledOnly, setSampledOnly] = useState(true);
  const [reviews, setReviews] = useState([]);
  const [cursor, setCursor] = useState(null); // id of the last row fetched
  const [notice, setNotice] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const buildUrl = useCallback((beforeId) => {
    const params = new URLSearchParams({ status, limit: String(PAGE_SIZE) });
    if (sampledOnly) params.set("sampled_for", "disagreement,random_audit");
    if (beforeId) params.set("before_id", beforeId);
    return `/admin/typed-decisions/reviews?${params.toString()}`;
  }, [status, sampledOnly]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setReviews([]);
    setCursor(null);
    setHasMore(false);
    try {
      const data = await adminFetch(buildUrl());
      if (request !== requestRef.current) return;
      const rows = Array.isArray(data?.reviews) ? data.reviews : [];
      setReviews(rows);
      setCursor(rows.length ? rows[rows.length - 1].id : null);
      setHasMore(rows.length >= PAGE_SIZE);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(err?.message || "Could not load typed decisions.");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [buildUrl]);

  useEffect(() => { load(); }, [load]);

  // Older rows: strictly after the last row fetched (created_at desc, id desc), appended below.
  const loadOlder = useCallback(async () => {
    if (!cursor) return;
    const request = ++requestRef.current;
    setLoadingMore(true);
    setError("");
    try {
      const data = await adminFetch(buildUrl(cursor));
      if (request !== requestRef.current) return;
      const rows = Array.isArray(data?.reviews) ? data.reviews : [];
      setReviews((current) => {
        const seen = new Set(current.map((r) => r.id));
        return [...current, ...rows.filter((r) => !seen.has(r.id))];
      });
      if (rows.length) setCursor(rows[rows.length - 1].id);
      setHasMore(rows.length >= PAGE_SIZE);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(err?.message || "Could not load older rows.");
    } finally {
      if (request === requestRef.current) setLoadingMore(false);
    }
  }, [buildUrl, cursor]);

  // Labeling the whole loaded page empties the list while older rows remain:
  // fetch the next page from the same cursor so the queue never dead-ends.
  useEffect(() => {
    if (!loading && !loadingMore && !error && hasMore && reviews.length === 0) loadOlder();
  }, [loading, loadingMore, error, hasMore, reviews.length, loadOlder]);

  // After a label: drop the row when it no longer belongs to the current
  // filter, otherwise update it in place (keeping the loaded subject text).
  const handleLabeled = useCallback((id, updated) => {
    setReviews((current) => current.flatMap((row) => {
      if (row.id !== id) return [row];
      if (!updated) return [];
      const next = { ...row, ...updated, subject: updated.subject || row.subject };
      return status !== "all" && next.labelStatus !== status ? [] : [next];
    }));
  }, [status]);

  // The server saw a different Jev answer than the one displayed: reload.
  const handleStale = useCallback(() => {
    setNotice("Jev's answer changed since this loaded — reloaded");
    load();
  }, [load]);

  return (
    <UiSurface density="comfortable" className="min-h-full space-y-4 text-zinc-800">
      {!embedded && <AdminCommandHeader title="Typed decisions" subtitle="Label Jev's typed answers against the baselines." />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <label htmlFor="typed-status" className="text-14 font-medium text-ink-secondary">Status</label>
          <select
            id="typed-status"
            value={status}
            onChange={(e) => { setNotice(""); setStatus(e.target.value); }}
            className="h-11 rounded-sm border border-zinc-300 bg-white px-3 text-ui-body text-zinc-900 sm:h-9"
          >
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <label htmlFor="typed-sampled" className="flex min-h-11 items-center gap-2 text-14 font-medium text-ink-secondary sm:min-h-0">
          <input id="typed-sampled" type="checkbox" checked={sampledOnly} onChange={(e) => { setNotice(""); setSampledOnly(e.target.checked); }} />
          Sampled only
        </label>
      </div>
      {notice && <ActionFeedback>{notice}</ActionFeedback>}
      {error && <ActionFeedback error onRetry={reviews.length ? undefined : load}>{error}</ActionFeedback>}
      {loading && !reviews.length && !error ? (
        <div className="text-ui-body text-ink-secondary">Loading…</div>
      ) : !error && !reviews.length ? (
        <div className="text-ui-body text-ink-secondary">Nothing to review.</div>
      ) : (
        <div className="space-y-3 min-w-0">
          {reviews.map((review) => <ReviewRow key={review.id} review={review} onLabeled={handleLabeled} onStale={handleStale} />)}
        </div>
      )}
      {hasMore && reviews.length > 0 && (
        <Button variant="secondary" loading={loadingMore ? true : undefined} onClick={loadOlder}>Load older</Button>
      )}
    </UiSurface>
  );
}
