/**
 * <RecruitingPage> — /admin/recruiting. The applicant queue for the public
 * careers funnel (GATE_JOB_APPLICATIONS).
 *
 * Read → decide → contact, all owner-driven: the AI screen only ranks and
 * summarizes (best-first ordering, strengths/flags); every status change
 * is a click here, and contacting the applicant happens over tel:/sms:
 * links — the portal never messages applicants.
 *
 * Deep link: ?application=<id> opens that application's detail (the bell
 * notification links here).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { UserPlus, Phone, MessageSquare, Mail } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Button,
  Badge,
  Card,
  CardBody,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Textarea,
  Input,
  Checkbox,
  UiSurface,
  Tabs,
  TabList,
  Tab,
  ActionFeedback,
  buttonStyles,
  cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function adminFetch(path, options = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      const d = await r.clone().json();
      message = d.error || d.message || message;
    } catch {
      /* noop */
    }
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export const STATUS_TABS = [
  { key: "new", label: "New" },
  { key: "reviewed", label: "Reviewed" },
  { key: "interview", label: "Interview" },
  { key: "offer", label: "Offer" },
  { key: "hired", label: "Hired" },
  { key: "rejected", label: "Rejected" },
  { key: "withdrawn", label: "Withdrawn" },
];

const ROLE_LABELS = {
  technician: "Technician",
  sales: "Sales",
  other: "Other",
};

const roleLabel = (role) => ROLE_LABELS[role] || role;

// Contact actions in the detail dialog, in display order. Each renders only
// when its snapshot field is present; the label falls back to the value.
const CONTACT_LINKS = [
  { key: "phone", scheme: "tel", Icon: Phone },
  { key: "phone", scheme: "sms", Icon: MessageSquare, label: "Text" },
  { key: "email", scheme: "mailto", Icon: Mail },
];

const contactLinkClass = buttonStyles({
  variant: "ghost",
  density: "comfortable",
  className: "max-w-full break-all whitespace-normal",
});

export const ANSWER_LABELS = {
  drivers_license: "FL driver's license / insurable record",
  experience: "Pest control / trade experience",
  outdoor_work: "Florida-summer outdoor work",
  judgment_gate_code: "Gate-code scenario (judgment)",
  phone_apps: "Daily phone-app comfort",
  availability: "Availability & earliest start",
  pay_expectation: "Pay expectation",
  why_waves: "Why Waves / why this trade",
  physical_limitations: "Lifting / ladder limitations",
  referral_source: "How they heard about us",
};

// Admin stays monochrome (the colored-score exception is Customers-only):
// weight and shade carry the ranking, not color.
export function scoreTone(score) {
  if (score == null) return "text-zinc-400";
  if (score >= 70) return "text-zinc-900";
  return "text-zinc-500";
}

function formatETDateTime(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_LABEL = Object.fromEntries(STATUS_TABS.map(({ key, label }) => [key, label]));

const SMS_UNAVAILABLE_REASON = {
  no_phone: "no phone on file",
  suppressed: "suppressed",
};

const EMAIL_UNAVAILABLE_REASON = {
  no_email: "no email on file",
};

const STAGE_LABEL = {
  application_received: "Application received",
  interview_invite: "Interview invite",
  interview_confirmation: "Interview confirmation",
};

// "Link sent" means a delivery attempt that may have reached the applicant
// (sent / uncertain / an unreconciled handoff) — never just a minted token.
export function inviteDelivered(app) {
  const history = Array.isArray(app?.comms_history) ? app.comms_history : [];
  return history.some(
    (e) => e && e.stage === "interview_invite" && ["sent", "uncertain", "handoff"].includes(e.outcome),
  );
}

const OUTCOME_LABEL = {
  deferred: "held for the 8 AM–8 PM ET window — sends automatically",
  stale: "not sent — the stage changed before the send",
  sent: "sent",
  blocked: "blocked",
  failed: "failed",
  skipped: "skipped",
  disabled: "disabled",
  uncertain: "uncertain — may have been delivered",
};

// "Text sent · Email sent" / "Text blocked" — joins only the channels that
// were actually requested (PATCH reports 'not_requested' for the other).
function summarizeSent(sent) {
  if (!sent) return null;
  const parts = [];
  if (sent.sms && sent.sms !== "not_requested") {
    parts.push(`Text ${OUTCOME_LABEL[sent.sms] || sent.sms}`);
  }
  if (sent.email && sent.email !== "not_requested") {
    parts.push(`Email ${OUTCOME_LABEL[sent.email] || sent.email}`);
  }
  return parts.length ? parts.join(" · ") : "No message sent.";
}

function channelLabel(kind, channel) {
  const base = kind === "sms" ? "Text" : "Email";
  if (!channel) return base;
  if (channel.available) return `${base} ${channel.to || ""}`.trim();
  const reasonMap = kind === "sms" ? SMS_UNAVAILABLE_REASON : EMAIL_UNAVAILABLE_REASON;
  const reason = reasonMap[channel.reason] || "unavailable";
  return `${base} — ${reason}`;
}

function RecommendationBadge({ recommendation }) {
  if (!recommendation) return <Badge>Unscored</Badge>;
  const label =
    { strong: "Strong", possible: "Possible", weak: "Weak" }[recommendation] ||
    recommendation;
  return <Badge>{label}</Badge>;
}

// comms_history is append-only, newest last — reverse for display.
function MessagesList({ history, replyMedia }) {
  const [openKey, setOpenKey] = useState(null);
  if (!history?.length) return null;
  const items = [...history].reverse();
  return (
    <div className="mb-4">
      <div className="text-ui-caption font-medium text-ink-secondary mb-1.5">
        Messages
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((entry, i) => {
          const key = `${entry.at}-${entry.channel}-${i}`;
          const open = openKey === key;
          return (
            <div key={key} className="border-hairline border rounded p-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-14 text-zinc-600">
                  {formatETDateTime(entry.at)} · {entry.channel} ·{" "}
                  {STAGE_LABEL[entry.stage] || entry.stage} · {entry.outcome}
                </span>
                {entry.body && (
                  <button
                    type="button"
                    className="text-13 text-zinc-500 underline u-focus-ring min-h-11 md:min-h-0"
                    onClick={() => setOpenKey(open ? null : key)}
                  >
                    {open ? "Hide" : "Show"}
                  </button>
                )}
              </div>
              {Array.isArray(replyMedia?.[entry.id]) && replyMedia[entry.id].length > 0 && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {replyMedia[entry.id].map((m, j) => (
                    m.url ? (
                      <a key={j} className="text-14 underline text-zinc-700" href={m.url} target="_blank" rel="noopener noreferrer">
                        Attachment {j + 1}
                      </a>
                    ) : (
                      <span key={j} className="text-14 text-zinc-500">Attachment {j + 1} (unavailable)</span>
                    )
                  ))}
                </div>
              )}
              {open && entry.body && (
                <div className="mt-1.5 text-14 text-zinc-800 whitespace-pre-wrap">
                  {entry.body}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The dialog's post-send state: a plain outcome summary, nothing editable.
// Split out from the channel-editing form so neither branch drags the
// other's decisions into StageChangeDialog's own complexity.
function StageChangeResult({ sendResult }) {
  return <ActionFeedback>{summarizeSent(sendResult)}</ActionFeedback>;
}

// The channel-editing form: note + (when the target stage is templated) the
// SMS/email checkboxes and their editable bodies, plus "move without
// notifying". Owns none of the values itself (the workflow hook does, so
// Confirm can read them) but is a substantive, self-contained piece of the
// dialog with its own well-defined props.
function StageChangeForm({
  preview,
  note,
  onNoteChange,
  smsChecked,
  onSmsCheckedChange,
  emailChecked,
  onEmailCheckedChange,
  smsBody,
  onSmsBodyChange,
  emailSubject,
  onEmailSubjectChange,
  emailBody,
  onEmailBodyChange,
  moveWithoutNotifying,
  onMoveWithoutNotifyingChange,
  error,
}) {
  const templated = Boolean(preview?.templated);
  const smsAvailable = Boolean(preview?.channels?.sms?.available);
  const emailAvailable = Boolean(preview?.channels?.email?.available);

  return (
    <>
      <Textarea
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="Optional note for this status change…"
        rows={2}
        className="mb-4"
      />

      {templated && (
        <div className="flex flex-col gap-3 border-hairline border rounded p-3">
          {!preview.sending_enabled && (
            <div className="text-13 text-zinc-500">
              Sending is off (GATE_RECRUITING_COMMS)
            </div>
          )}

          <Checkbox
            id="stage-notify-sms"
            label={channelLabel("sms", preview.channels?.sms)}
            checked={smsChecked}
            disabled={!smsAvailable || moveWithoutNotifying}
            onChange={(e) => onSmsCheckedChange(e.target.checked)}
          />
          {smsChecked && !moveWithoutNotifying && (
            <div>
              <Textarea
                value={smsBody}
                onChange={(e) => onSmsBodyChange(e.target.value.slice(0, 320))}
                rows={3}
                maxLength={320}
              />
              <div className="text-13 text-zinc-400 text-right mt-0.5">
                {smsBody.length}/320
              </div>
            </div>
          )}

          <Checkbox
            id="stage-notify-email"
            label={channelLabel("email", preview.channels?.email)}
            checked={emailChecked}
            disabled={!emailAvailable || moveWithoutNotifying}
            onChange={(e) => onEmailCheckedChange(e.target.checked)}
          />
          {emailChecked && !moveWithoutNotifying && (
            <div className="flex flex-col gap-2">
              <Input
                value={emailSubject}
                onChange={(e) => onEmailSubjectChange(e.target.value.slice(0, 150))}
                maxLength={150}
                placeholder="Subject"
              />
              <Textarea
                value={emailBody}
                onChange={(e) => onEmailBodyChange(e.target.value.slice(0, 4000))}
                rows={6}
                maxLength={4000}
              />
            </div>
          )}

          <Checkbox
            id="stage-move-without-notifying"
            label="Move without notifying"
            checked={moveWithoutNotifying}
            onChange={(e) => onMoveWithoutNotifyingChange(e.target.checked)}
          />
        </div>
      )}

      {error && (
        <ActionFeedback error className="mt-3">
          {error}
        </ActionFeedback>
      )}
    </>
  );
}

// Preview-before-send: click a stage → GET stage-preview → this dialog.
// Stacks above the detail Dialog (layer 130 over the default 120 — the
// pattern in _DesignSystemExamples' NestedOverlaysExample). Confirm sends
// the PATCH; on success the form gives way to a plain outcome summary and
// a single Close button.
function StageChangeDialog({
  open,
  title,
  preview,
  previewLoading,
  previewError,
  note,
  onNoteChange,
  smsChecked,
  onSmsCheckedChange,
  emailChecked,
  onEmailCheckedChange,
  smsBody,
  onSmsBodyChange,
  emailSubject,
  onEmailSubjectChange,
  emailBody,
  onEmailBodyChange,
  moveWithoutNotifying,
  onMoveWithoutNotifyingChange,
  sendResult,
  busy,
  error,
  onConfirm,
  onClose,
}) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} layer={130} size="lg">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {previewLoading && (
          <div className="text-14 text-zinc-500 py-4 text-center">Loading preview…</div>
        )}
        {previewError && (
          <ActionFeedback error className="mb-3">
            {previewError}
          </ActionFeedback>
        )}

        {!previewLoading && !previewError && preview && (
          sendResult ? (
            <StageChangeResult sendResult={sendResult} />
          ) : (
            <StageChangeForm
              preview={preview}
              note={note}
              onNoteChange={onNoteChange}
              smsChecked={smsChecked}
              onSmsCheckedChange={onSmsCheckedChange}
              emailChecked={emailChecked}
              onEmailCheckedChange={onEmailCheckedChange}
              smsBody={smsBody}
              onSmsBodyChange={onSmsBodyChange}
              emailSubject={emailSubject}
              onEmailSubjectChange={onEmailSubjectChange}
              emailBody={emailBody}
              onEmailBodyChange={onEmailBodyChange}
              moveWithoutNotifying={moveWithoutNotifying}
              onMoveWithoutNotifyingChange={onMoveWithoutNotifyingChange}
              error={error}
            />
          )
        )}
      </DialogBody>
      <DialogFooter>
        {sendResult ? (
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onConfirm}
              disabled={busy || previewLoading || !preview}
            >
              {busy ? "Sending…" : "Confirm"}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

// The whole preview/send workflow behind a stage-change: mint a preview,
// hold the editable note/channel state while it's open, and PATCH the
// status on Confirm. Isolating this in its own hook keeps every one of its
// decisions (which channels to include, whether a resend was requested, the
// preview-vs-stale-response guard) out of RecruitingPage's own complexity —
// the same way openDetail/load already stayed out as their own callbacks.
function useStageChangeWorkflow(detail, tab, load, onApplicationUpdated) {
  const [stageDialog, setStageDialog] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [note, setNote] = useState("");
  const [smsChecked, setSmsChecked] = useState(false);
  const [emailChecked, setEmailChecked] = useState(false);
  const [smsBody, setSmsBody] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [moveWithoutNotifying, setMoveWithoutNotifying] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [stageError, setStageError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Invalidates an in-flight preview fetch the same way detailSeq guards
  // openDetail — closing the dialog (or reopening it for a different
  // stage) must not let a slow response land on the wrong stage.
  const previewSeq = useRef(0);

  const openStageDialog = useCallback(
    async (status, { resend = false } = {}) => {
      if (!detail) return;
      const seq = ++previewSeq.current;
      setStageDialog({ status, resend });
      setPreview(null);
      setPreviewError(null);
      setSendResult(null);
      setStageError(null);
      setNote("");
      setMoveWithoutNotifying(false);
      setPreviewLoading(true);
      try {
        const data = await adminFetch(
          `/admin/careers/${detail.id}/stage-preview?status=${encodeURIComponent(status)}`,
        );
        if (seq !== previewSeq.current) return;
        setPreview(data);
        setSmsChecked(Boolean(data.templated && data.channels?.sms?.available));
        setEmailChecked(Boolean(data.templated && data.channels?.email?.available));
        setSmsBody(data.sms_body || "");
        setEmailSubject(data.email_subject || "");
        setEmailBody(data.email_body || "");
      } catch (err) {
        if (seq === previewSeq.current) setPreviewError(err.message);
      } finally {
        if (seq === previewSeq.current) setPreviewLoading(false);
      }
    },
    [detail],
  );

  const closeStageDialog = useCallback(() => {
    previewSeq.current += 1; // invalidate any in-flight preview fetch
    setStageDialog(null);
  }, []);

  const confirmStage = async () => {
    if (!stageDialog || !detail) return;
    setBusy(true);
    setStageError(null);
    try {
      const body = { status: stageDialog.status };
      if (note.trim()) body.note = note.trim();
      if (stageDialog.resend) body.resend = true;
      const wantsNotify =
        preview?.templated &&
        !moveWithoutNotifying &&
        (smsChecked || emailChecked);
      if (wantsNotify) {
        body.notify = {
          sms: smsChecked,
          email: emailChecked,
          sms_body: smsBody,
          email_subject: emailSubject,
          email_body: emailBody,
        };
      }
      const data = await adminFetch(`/admin/careers/${detail.id}/status`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onApplicationUpdated(data.application);
      setSendResult(data.sent || null);
      setNote("");
      await load(tab);
    } catch (err) {
      setStageError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resetForNewApplicant = useCallback(() => {
    setNote("");
  }, []);

  const title = stageDialog
    ? stageDialog.resend
      ? "Resend interview link"
      : `Move to ${STATUS_LABEL[stageDialog.status] || stageDialog.status}`
    : "";

  return {
    stageDialog,
    title,
    preview,
    previewLoading,
    previewError,
    note,
    setNote,
    smsChecked,
    setSmsChecked,
    emailChecked,
    setEmailChecked,
    smsBody,
    setSmsBody,
    emailSubject,
    setEmailSubject,
    emailBody,
    setEmailBody,
    moveWithoutNotifying,
    setMoveWithoutNotifying,
    sendResult,
    busy,
    error: stageError,
    openStageDialog,
    closeStageDialog,
    confirmStage,
    resetForNewApplicant,
  };
}

// The interview-scheduling block inside the detail dialog: whether to show
// it at all (an active Interview-stage applicant, or an offer/hired one who
// already has a booking), and — once shown — whether there's a booked time
// with a resend option, or no link yet with a send/resend CTA. A distinct
// component because this sub-tree carries most of the dialog's own
// branching (the booked/unbooked split, the link-status copy).
function InterviewSchedulingBlock({ detail, onOpenStageDialog }) {
  const relevant = ["offer", "hired"].includes(detail.status)
    ? Boolean(detail.interview_booked_at || detail.interview_url)
    : detail.status === "interview";
  if (!relevant) return null;

  return (
    <div className="mb-4 border-hairline border rounded p-3">
      <div className="text-ui-caption font-medium text-ink-secondary mb-1">
        Interview
      </div>
      {detail.interview_booked_at ? (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-14 text-zinc-800">
            {detail.interview_mode === "in_person" ? "In person" : "Phone call"} ·{" "}
            {formatETDateTime(detail.interview_at)}
          </div>
          {detail.status === "interview" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onOpenStageDialog("interview", { resend: true })}
            >
              Resend link
            </Button>
          )}
        </div>
      ) : (
        // A candidate moved to Interview "without notifying" has no link
        // yet — offer to send one from here (the same resend path mints
        // the token) instead of forcing a stage round-trip (local audit
        // P1).
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-14 text-zinc-600">
            {inviteDelivered(detail)
              ? "Link sent, waiting for the applicant to pick a time."
              : detail.interview_url
                ? "Link created but not delivered — resend it."
                : "No scheduling link sent yet."}
          </span>
          {detail.status === "interview" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onOpenStageDialog("interview", { resend: true })}
            >
              {detail.interview_url ? "Resend link" : "Send link"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// The applicant detail dialog's content: contact links, the AI screen
// summary, submitted answers, the interview-scheduling block, message
// history, and the per-stage action buttons. A substantive component in its
// own right (derives contact/screen from `detail`, owns the interview-block
// branching) rather than a one-use helper — moving it out is what actually
// removes those decisions from RecruitingPage.
function ApplicationDetailContent({ detail, replyMedia, onOpenStageDialog, onClose }) {
  const contact = detail?.contact_snapshot || {};
  const screen = detail?.ai_screen || null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {contact.name || "Applicant"} — {roleLabel(detail.role)}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {CONTACT_LINKS.filter(({ key }) => contact[key]).map(
            ({ key, scheme, Icon, label }) => (
              <a
                key={scheme}
                className={contactLinkClass}
                href={`${scheme}:${contact[key]}`}
              >
                <Icon className="w-4 h-4" />
                {label || contact[key]}
              </a>
            ),
          )}
          {contact.city && (
            <span className="text-14 text-zinc-500">{contact.city}</span>
          )}
          <Badge>{detail.status}</Badge>
        </div>

        {screen && (
          <div className="mb-4 border-hairline border rounded p-3">
            <div className="flex items-center gap-3 mb-1.5">
              <span
                className={cn(
                  "text-20 tabular-nums font-medium",
                  scoreTone(detail.ai_score),
                )}
              >
                {detail.ai_score}
              </span>
              <RecommendationBadge
                recommendation={detail.ai_recommendation}
              />
              <span className="text-14 text-zinc-400">
                AI screen — ranking assist only
              </span>
            </div>
            {screen.summary && (
              <div className="text-14 text-zinc-700 mb-1.5">
                {screen.summary}
              </div>
            )}
            {screen.strengths?.length > 0 && (
              <div className="text-14 text-zinc-600">
                Strengths: {screen.strengths.join(" · ")}
              </div>
            )}
            {screen.flags?.length > 0 && (
              <div className="text-ui-body text-ink-secondary mt-0.5">
                Probe: {screen.flags.join(" · ")}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2.5 mb-4">
          {Object.entries(ANSWER_LABELS)
            .filter(([key]) => detail.answers?.[key])
            .map(([key, label]) => (
              <div key={key}>
                <div className="text-ui-caption font-medium text-ink-secondary">
                  {label}
                </div>
                <div className="text-14 text-zinc-800 whitespace-pre-wrap">
                  {detail.answers[key]}
                </div>
              </div>
            ))}
        </div>

        <InterviewSchedulingBlock detail={detail} onOpenStageDialog={onOpenStageDialog} />

        <MessagesList history={detail.comms_history} replyMedia={replyMedia} />
      </DialogBody>
      <DialogFooter>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_TABS.filter(({ key }) => key !== detail.status).map(
            ({ key, label }) => (
              <Button
                key={key}
                size="sm"
                variant="secondary"
                onClick={() => onOpenStageDialog(key)}
              >
                {label}
              </Button>
            ),
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

export default function RecruitingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState("new");
  const [applications, setApplications] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [replyMedia, setReplyMedia] = useState({});

  // Monotonic request id: a slow response from a previously selected tab
  // must never overwrite the current tab's list (codex P2).
  const requestSeq = useRef(0);

  const load = useCallback(
    async (status, { offset = 0, append = false } = {}) => {
      const seq = ++requestSeq.current;
      if (!append) setLoading(true);
      setError(null);
      try {
        const data = await adminFetch(
          `/admin/careers?status=${encodeURIComponent(status)}&offset=${offset}`,
        );
        if (seq !== requestSeq.current) return; // superseded by a newer request
        setApplications((prev) =>
          append
            ? [...prev, ...(data.applications || [])]
            : data.applications || [],
        );
        setCounts(data.counts || {});
      } catch (err) {
        if (seq === requestSeq.current) setError(err.message);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  // Same monotonic guard as the list: a slow response for applicant A must
  // not replace an already-opened applicant B (a status/note could land on
  // the wrong person), and closing the dialog invalidates pending opens.
  const detailSeq = useRef(0);

  const stageWorkflow = useStageChangeWorkflow(detail, tab, load, setDetail);

  const openDetail = useCallback(async (id) => {
    const seq = ++detailSeq.current;
    try {
      const data = await adminFetch(`/admin/careers/${id}`);
      if (seq !== detailSeq.current) return; // superseded or dialog closed
      setDetail(data.application);
      setReplyMedia(data.reply_media || {});
      stageWorkflow.resetForNewApplicant();
    } catch (err) {
      if (seq === detailSeq.current) setError(err.message);
    }
  }, [stageWorkflow]);

  const closeDetail = useCallback(() => {
    detailSeq.current += 1; // invalidate any in-flight open
    setDetail(null);
    // The stage dialog nests inside the detail dialog's lifetime — closing
    // the outer one must not leave the inner one open over a null detail.
    stageWorkflow.closeStageDialog();
  }, [stageWorkflow]);

  // Bell deep link: consume ?application=<id> and clear it. Reacts to the
  // param (not mount-only): clicking a second notification while already on
  // this page updates only the query string — the mounted route must still
  // reopen the dialog (codex round 4). Clearing the param makes the effect's
  // rerun a no-op.
  useEffect(() => {
    const id = searchParams.get("application");
    if (!id) return;
    openDetail(id);
    const next = new URLSearchParams(searchParams);
    next.delete("application");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openDetail]);

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader
        variant="workspace"
        title="Recruiting"
        icon={UserPlus}
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        variant="section"
        className="mb-5"
      >
        <TabList scrollable aria-label="Application status">
          {STATUS_TABS.map(({ key, label }) => (
            <Tab key={key} value={key}>
              {label}
              {counts[key] ? (
                <span className="ml-1 u-nums">{counts[key]}</span>
              ) : null}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      {error && (
        <ActionFeedback error className="mb-3">
          {error}
        </ActionFeedback>
      )}
      {loading ? (
        <div className="text-14 text-zinc-500 p-8 text-center">
          Loading applications…
        </div>
      ) : applications.length === 0 ? (
        <Card>
          <CardBody>
            <div className="text-14 text-zinc-500 text-center py-6">
              No {STATUS_TABS.find((t) => t.key === tab)?.label.toLowerCase()}{" "}
              applications.
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {applications.map((app) => {
            const c = app.contact_snapshot || {};
            return (
              <Card key={app.id}>
                <CardBody>
                  <button
                    type="button"
                    className="min-h-11 w-full text-left appearance-none border-0 bg-transparent p-0 cursor-pointer rounded-md u-focus-ring"
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      openDetail(app.id);
                    }}
                  >
                    <div className="flex flex-col items-start justify-between gap-3 lg:flex-row lg:items-center">
                      <div className="min-w-0">
                        <div className="text-14 font-medium text-zinc-900 truncate">
                          {c.name || "Unknown"}
                          <span className="text-zinc-400 font-normal">
                            {" "}
                            · {roleLabel(app.role)}
                          </span>
                          {app.language === "es" && (
                            <span className="text-zinc-400 font-normal">
                              {" "}
                              · ES
                            </span>
                          )}
                        </div>
                        {app.ai_summary && (
                          <div className="text-14 text-zinc-500 mt-0.5 truncate">
                            {app.ai_summary}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <RecommendationBadge
                          recommendation={app.ai_recommendation}
                        />
                        <span
                          className={cn(
                            "text-16 tabular-nums font-medium",
                            scoreTone(app.ai_score),
                          )}
                        >
                          {app.ai_score != null ? app.ai_score : "—"}
                        </span>
                        {app.interview_at && (
                          <span className="text-14 text-zinc-500">
                            {app.interview_mode === "in_person" ? "In person" : "Phone"} ·{" "}
                            {formatETDateTime(app.interview_at)}
                          </span>
                        )}
                        <span className="text-14 text-zinc-400">
                          {formatETDateTime(app.created_at)}
                        </span>
                      </div>
                    </div>
                  </button>
                </CardBody>
              </Card>
            );
          })}
          {applications.length < (counts[tab] || 0) && (
            <div className="text-center mt-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  load(tab, { offset: applications.length, append: true })
                }
              >
                Load more ({applications.length} of {counts[tab]})
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={Boolean(detail)} onClose={closeDetail}>
        {detail && (
          <ApplicationDetailContent
            detail={detail}
            replyMedia={replyMedia}
            onOpenStageDialog={stageWorkflow.openStageDialog}
            onClose={closeDetail}
          />
        )}
      </Dialog>

      <StageChangeDialog
        open={Boolean(stageWorkflow.stageDialog)}
        title={stageWorkflow.title}
        preview={stageWorkflow.preview}
        previewLoading={stageWorkflow.previewLoading}
        previewError={stageWorkflow.previewError}
        note={stageWorkflow.note}
        onNoteChange={stageWorkflow.setNote}
        smsChecked={stageWorkflow.smsChecked}
        onSmsCheckedChange={stageWorkflow.setSmsChecked}
        emailChecked={stageWorkflow.emailChecked}
        onEmailCheckedChange={stageWorkflow.setEmailChecked}
        smsBody={stageWorkflow.smsBody}
        onSmsBodyChange={stageWorkflow.setSmsBody}
        emailSubject={stageWorkflow.emailSubject}
        onEmailSubjectChange={stageWorkflow.setEmailSubject}
        emailBody={stageWorkflow.emailBody}
        onEmailBodyChange={stageWorkflow.setEmailBody}
        moveWithoutNotifying={stageWorkflow.moveWithoutNotifying}
        onMoveWithoutNotifyingChange={stageWorkflow.setMoveWithoutNotifying}
        sendResult={stageWorkflow.sendResult}
        busy={stageWorkflow.busy}
        error={stageWorkflow.error}
        onConfirm={stageWorkflow.confirmStage}
        onClose={stageWorkflow.closeStageDialog}
      />
    </UiSurface>
  );
}
