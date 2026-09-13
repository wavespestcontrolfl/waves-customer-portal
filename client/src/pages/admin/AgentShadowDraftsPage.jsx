/**
 * <AgentShadowDraftsPage> — Shadow Drafts tab inside /admin/agents.
 *
 * Read-only window into the SMS brand-voice loop: every inbound customer
 * SMS gets a silent house-voice draft (message_drafts status='shadow');
 * the nightly judge scores each against the reply a human actually sent.
 * Per-intent score history here is what graduates an intent (Phase E).
 *
 * Tier 1 admin surface using the shared comfortable foundation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

const VERDICT_TONES = {
  draft_better: { label: "Draft better" },
  equivalent: { label: "Equivalent" },
  human_better: { label: "Human better" },
  draft_unsafe: { label: "Unsafe", alert: true },
  human_no_reply: { label: "Human silent" },
  both_no_reply: { label: "Both silent" },
};

function intentLabel(intent) {
  return String(intent || "GENERAL").replace(/_/g, " ");
}

function Chip({ children, tone }) {
  return <Badge tone={tone?.alert ? "alert" : "neutral"}>{children}</Badge>;
}

function timeLabel(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Bubble({ label, text }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-14 font-medium text-ink-secondary">{label}</div>
      <div className="whitespace-pre-wrap break-words rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3 text-ui-body text-zinc-800">
        {text || <span className="text-ink-secondary">(no reply)</span>}
      </div>
    </div>
  );
}

function ScorePills({ scores }) {
  if (!scores) return null;
  const entries = [
    ["Voice", scores.voice],
    ["Safety", scores.safety],
    ["Actions", scores.actions],
    ["Overall", scores.overall],
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([label, value]) => (
        <Badge key={label} tone="neutral">{label} <strong className="u-nums">{value ?? "-"}</strong></Badge>
      ))}
    </div>
  );
}

function DraftCard({ draft }) {
  const judgment = draft.judgment;
  const tone = judgment ? VERDICT_TONES[judgment.verdict] || VERDICT_TONES.human_no_reply : null;
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-14 font-medium text-zinc-900">{draft.customerName || "Unknown customer"}</span>
        <Chip>{intentLabel(draft.intent)}</Chip>
        {draft.schedulingIntent && <Chip>scheduling</Chip>}
        {tone ? <Chip tone={tone}>{tone.label}</Chip> : <Chip>Awaiting judge</Chip>}
        <span className="ml-auto text-ui-caption text-ink-secondary u-nums">{timeLabel(draft.createdAt)}</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Bubble label="Customer" text={draft.inboundMessage} />
        <Bubble label="AI shadow draft" text={draft.draftResponse} />
        <Bubble
          label={judgment?.humanReplied ? "Human reply (sent)" : "Human reply"}
          text={judgment ? judgment.humanReplyText : null}
        />
      </div>

      {judgment?.scores && <ScorePills scores={judgment.scores} />}
      {draft.lintFlags?.length > 0 && (
        <div className="text-ui-body text-ink-secondary">
          <strong className="font-medium text-zinc-900">Comms-lint:</strong>{" "}
          {draft.lintFlags.map((f) => f.detail).join(" · ")}
        </div>
      )}
      {judgment?.notes && (
        <div className="text-ui-body text-ink-secondary">
          <strong className="font-medium text-zinc-900">Judge:</strong> {judgment.notes}
        </div>
      )}
    </Card>
  );
}

function IntentScoreCard({ row }) {
  return (
    <Card className="p-3">
      <div className="mb-2 break-words text-14 font-medium text-zinc-900">{intentLabel(row.intent)}</div>
      <div className="flex flex-wrap gap-2 text-ui-caption text-ink-secondary u-nums">
        <span><strong className="font-medium text-zinc-900">{row.drafts}</strong> drafts</span>
        <span><strong className="font-medium text-zinc-900">{row.judged}</strong> judged</span>
        {row.avg && <span>overall <strong className="font-medium text-zinc-900">{row.avg.overall}</strong>/10</span>}
        {row.verdicts?.draft_unsafe ? (
          <span className="font-medium text-alert-fg">{row.verdicts.draft_unsafe} unsafe</span>
        ) : null}
      </div>
    </Card>
  );
}

const MODE_TONES = {
  shadow: { label: "Shadow" },
  suggest: { label: "Suggest" },
  auto_send: { label: "Auto-send" },
  locked: { label: "Escalation — always shadow", alert: true },
};

// One step DOWN the ladder shadow → suggest → auto_send, or shadow → suggest
// up. The toggle only ever steps shadow⇄suggest or demotes auto_send→suggest:
// promoting INTO auto_send is eligibility-gated (graduation must clear it) and
// happens through the API, never a one-click here. Keyed by current mode.
const MODE_TOGGLE = {
  shadow: { next: "suggest", label: "Enable suggest" },
  suggest: { next: "shadow", label: "Back to shadow" },
  auto_send: { next: "suggest", label: "Back to suggest" },
};
const modeToggle = (mode) => MODE_TOGGLE[mode] || MODE_TOGGLE.shadow;

function ShadowConfirmationDialog({ confirmation, busy, error, onCancel, onConfirm }) {
  return (
    <Dialog open={Boolean(confirmation)} onClose={onCancel} size="sm">
      <DialogHeader>
        <DialogTitle>{confirmation?.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <p className="m-0 whitespace-pre-line text-14 leading-6 text-ink-secondary">
          {confirmation?.description}
        </p>
        {error && <ActionFeedback error>{error}</ActionFeedback>}
      </DialogBody>
      <DialogFooter>
        <Button autoFocus variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onConfirm} loading={busy}>
          {confirmation?.confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// Phase E readiness: shows how close an intent is to its next ladder rung, or
// a green chip when it has earned it. Recommend-only — flips stay manual.
function GraduationNote({ g }) {
  const j = g.judge || {};
  const rungLabel = g.nextRung === "auto_send" ? "auto-send" : g.nextRung;
  const context = [];
  if (j.judged > 0) context.push(`${j.judged} live judged (${Math.round((j.unsafeRate || 0) * 100)}% unsafe)`);
  if (j.backfillJudged > 0) context.push(`${j.backfillJudged} backfill excluded`);
  if (j.priorVersionJudged > 0) context.push(`${j.priorVersionJudged} prior-version excluded`);

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-hairline border-zinc-200 pt-2 text-ui-caption text-ink-secondary">
      {g.eligibleFor === "suggest" && (
        <Badge tone="neutral">Ready — enable suggest</Badge>
      )}
      {g.eligibleFor === "auto_send" && (
        <Badge tone="neutral">Earned the auto-send rung</Badge>
      )}
      {/* Intent is AT auto_send but the send-time gate is blocking (e.g. a
          prompt bump reset the cohort evidence) — mirror the executor. */}
      {g.autoSendHealth && !g.autoSendHealth.sendReady && (
        <>
          <Badge tone="alert">Auto-send gated: {g.autoSendHealth.blockers?.[0] || "readiness not met"}</Badge>
          <span>
            Sends fall back to review cards; unused cards re-enter the judge pool. Demote to shadow to rebuild evidence faster.
          </span>
        </>
      )}
      {!g.eligibleFor && rungLabel && (
        <span>
          <strong className="font-medium text-zinc-900">Next: {rungLabel}:</strong> {g.blockers?.[0] || "gathering data"}
        </span>
      )}
      {context.length > 0 && <span>· {context.join(" · ")}</span>}
    </div>
  );
}

function IntentModeCard({ row, busy, onToggle, onPromote, autoSendGateOff }) {
  const tone = row.locked ? MODE_TONES.locked : MODE_TONES[row.mode] || MODE_TONES.shadow;
  const s = row.suggest || {};
  const hasHistory = (s.suggested || 0) > 0;
  // The intent has EARNED auto-send and is sitting at suggest → offer the
  // one-click promote. The server re-checks eligibility (409 if it slipped).
  const canPromote = !row.locked && row.mode === "suggest" && row.graduation?.eligibleFor === "auto_send";
  return (
    <Card className="p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-words text-14 font-medium text-zinc-900">{intentLabel(row.intent)}</span>
        <Chip tone={tone}>{tone.label}</Chip>
        {!row.locked && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => onToggle(row)}
            loading={busy}
            variant="secondary"
            className="ml-auto"
          >
            {modeToggle(row.mode).label}
          </Button>
        )}
      </div>
      {hasHistory && (
        <div className="flex flex-wrap gap-2 text-ui-caption text-ink-secondary u-nums">
          <span><strong className="font-medium text-zinc-900">{s.suggested}</strong> suggested</span>
          {s.pending ? <span><strong className="font-medium text-zinc-900">{s.pending}</strong> pending</span> : null}
          <span><strong className="font-medium text-zinc-900">{s.accepted || 0}</strong> accepted</span>
          <span><strong className="font-medium text-zinc-900">{s.corrected || 0}</strong> corrected</span>
          <span><strong className="font-medium text-zinc-900">{s.ignored || 0}</strong> ignored</span>
          {s.expired ? <span><strong className="font-medium text-zinc-900">{s.expired}</strong> expired</span> : null}
        </div>
      )}
      {!row.locked && row.graduation && <GraduationNote g={row.graduation} />}
      {canPromote && (
        <Button
          type="button"
          disabled={busy}
          onClick={(event) => onPromote(row, event.currentTarget)}
          loading={busy}
        >
          Enable auto-send
        </Button>
      )}
      {(canPromote || row.mode === "auto_send") && autoSendGateOff && (
        <ActionFeedback error>
          GATE_SMS_AUTO_SEND is off — the mode saves, but drafts keep going to the review queue until the gate is enabled.
        </ActionFeedback>
      )}
      {row.updatedBy && row.updatedBy !== "migration" && (
        <div className="text-ui-caption text-ink-secondary">
          Set by {row.updatedBy} · {timeLabel(row.updatedAt)}{row.reason ? ` · ${row.reason}` : ""}
        </div>
      )}
    </Card>
  );
}

// Loop 2 review surface: the weekly distilled voice profile parks here as
// PENDING until the owner approves or rejects it. Approving is what makes it
// live (the dark phone agent reads only the approved row) — style guidance
// only, so the whole review is a read + one click.
function VoiceProfileSection({ profiles, busy, onReview }) {
  const pending = profiles?.pending || null;
  const approved = profiles?.approved || null;
  const [expanded, setExpanded] = useState(false);
  if (!pending && !approved) return null;
  const row = pending || approved;
  const flags = (() => {
    try {
      const s = typeof row.source_stats === "string" ? JSON.parse(row.source_stats) : row.source_stats;
      return s?.flags || [];
    } catch { return []; }
  })();
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-18 font-medium text-zinc-900">Voice profile</h2>
        <div className="text-ui-body text-ink-secondary">
          Distilled daily from real Waves calls + texts. Green profiles auto-apply to the phone agent; exceptions park here. Style only, never facts.
        </div>
      </div>
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-14 font-medium text-zinc-900 u-nums">v{row.version}</span>
          {pending ? (
            <Badge tone="alert">Exception — review needed</Badge>
          ) : (
            <Badge tone="neutral">
              {row.reviewed_by === "auto:distiller" ? "Live (auto-approved)" : `Approved${row.reviewed_by ? ` by ${row.reviewed_by}` : ""}`}
            </Badge>
          )}
          {flags.length > 0 && (
            <Badge tone="alert">Style-only check flagged: {flags.join(", ")}</Badge>
          )}
          <Button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            variant="secondary"
            className="ml-auto"
          >
            {expanded ? "Collapse" : "Read profile"}
          </Button>
        </div>
        <div className={`whitespace-pre-wrap break-words text-ui-body text-ink-secondary ${expanded ? "" : "max-h-[90px] overflow-hidden"}`}>
          {row.profile_text}
        </div>
        {pending && (
          <div className="ui-record-actions">
            <Button
              type="button"
              disabled={busy}
              onClick={(event) => onReview(pending, "approve", event.currentTarget)}
              loading={busy}
            >
              Approve — make this the live voice
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={(event) => onReview(pending, "reject", event.currentTarget)}
              loading={busy}
              variant="secondary"
            >
              Reject
            </Button>
          </div>
        )}
      </Card>
      {/* The LIVE profile's revoke is rendered independently of any pending
          exception — a normal state is "v5 live (auto), v6 parked as an
          exception", and killing the live voice must never wait on resolving
          an unrelated review. */}
      {approved && (
        <div className="flex flex-wrap items-center gap-2 text-ui-caption text-ink-secondary">
          <span>
            Live now: <strong className="font-medium text-zinc-900 u-nums">v{approved.version}</strong>
            {approved.reviewed_by === "auto:distiller" ? " (auto-approved)" : approved.reviewed_by ? ` (approved by ${approved.reviewed_by})` : ""}
          </span>
          <Button
            type="button"
            disabled={busy}
            onClick={(event) => onReview(approved, "revoke", event.currentTarget)}
            loading={busy}
            variant="secondary"
          >
            Revoke — back to base voice
          </Button>
        </div>
      )}
    </section>
  );
}

// Sealed exam — the locked eval set. Frozen (inbound, day-of facts, human
// reply) items replayed through the CURRENT drafter per provider leg and
// graded by the live judge; a McNemar test against the baseline run decides
// "real improvement or luck". Read-mostly: sealing is cheap and idempotent,
// exam runs burn real LLM spend so both are deliberate button clicks.
function significanceChip(sig) {
  if (!sig) return null;
  if (sig.significant && sig.direction === "improved") {
    return <Badge tone="neutral">Improved (p={sig.pValue})</Badge>;
  }
  if (sig.significant && sig.direction === "regressed") {
    return <Badge tone="alert">Regressed (p={sig.pValue})</Badge>;
  }
  return <Badge tone="neutral">No significant change (p={sig.pValue})</Badge>;
}

// Live legs first, then the measurement-only candidates (owner 07-30 six-
// model ranking). The backend accepts exactly these keys (EXAM_LEG_ROUTES).
const LEG_LABELS = { anthropic: "Claude leg", openai: "GPT Sol leg", gemini: "Gemini (measure)", luna: "GPT Luna (measure)", opus: "Opus (measure)", fable: "Fable (measure)" };

function SealedRunRow({ run, runsById }) {
  const pct = run.unsafeRate == null ? "-" : `${Math.round(run.unsafeRate * 100)}%`;
  const baseline = run.baselineRunId ? runsById.get(run.baselineRunId) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-hairline border-zinc-200 pt-2 text-ui-caption text-ink-secondary u-nums">
      <strong className="font-medium text-zinc-900">{run.promptVersion}</strong>
      <Chip>{LEG_LABELS[run.providerLeg] || run.providerLeg}</Chip>
      {run.status === "running" && <Chip>Running… {run.itemsJudged}/{run.itemsTotal}</Chip>}
      {run.status === "failed" && <Badge tone="alert">Failed</Badge>}
      {run.status === "complete" && (
        <>
          <span><strong className={run.unsafeRate > 0.08 ? "font-medium text-alert-fg" : "font-medium text-zinc-900"}>{pct}</strong> unsafe ({run.unsafeCount}/{run.itemsJudged})</span>
          {run.avgSafety != null && <span>safety <strong className="font-medium text-zinc-900">{run.avgSafety}</strong>/10</span>}
          {significanceChip(run.significance)}
          {baseline && <span>vs {baseline.promptVersion}</span>}
        </>
      )}
      <span className="ml-auto">{timeLabel(run.startedAt)}</span>
    </div>
  );
}

function SealedExamSection({ exam, busy, onSeal, onRun, onResume }) {
  if (!exam) return null;
  const runs = exam.runs || [];
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const inFlight = runs.find((r) => r.status === "running") || null;
  // A failed run keeps every result already paid for — offer to resume it
  // instead of re-billing a fresh run. Only current-version failures: the
  // server refuses stale-version resumes (one run = one drafter version).
  const resumableFailure = !inFlight
    ? runs.find((r) => r.status === "failed" && r.promptVersion === exam.currentVersion) || null
    : null;
  const items = exam.items || { active: 0, total: 0 };
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-18 font-medium text-zinc-900">Sealed exam</h2>
        <div className="text-ui-body text-ink-secondary">
          A locked set of real past texts (with that day&apos;s facts frozen) the drafter never trains on. Each run replays the whole set on one provider and compares against the last examined version.
        </div>
      </div>
      {exam.gateEnabled === false && (
        <ActionFeedback error>
          GATE_SMS_SEALED_EVAL is off — sealing and exam runs are disabled until the gate is enabled.
        </ActionFeedback>
      )}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-ui-body text-ink-secondary u-nums">
          <span><strong className="font-medium text-zinc-900">{items.active}</strong> sealed items</span>
          <span>drafter <strong className="font-medium text-zinc-900">{exam.currentVersion}</strong></span>
          {exam.examRequiredForGraduation && (
            <Chip>Required for graduation</Chip>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy || exam.gateEnabled === false}
              onClick={onSeal}
              variant="secondary"
            >
              Top up sealed items
            </Button>
            {inFlight ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => onResume(inFlight)}
                variant="secondary"
              >
                Resume stalled run
              </Button>
            ) : (
              <>
                {resumableFailure && (
                  <Button
                    type="button"
                    disabled={busy || exam.gateEnabled === false}
                    onClick={() => onResume(resumableFailure)}
                    variant="secondary"
                  >
                    Resume failed run ({LEG_LABELS[resumableFailure.providerLeg] || resumableFailure.providerLeg})
                  </Button>
                )}
                {Object.entries(LEG_LABELS).map(([leg, label]) => (
                  <Button
                    key={leg}
                    type="button"
                    disabled={busy || exam.gateEnabled === false || !items.active}
                    onClick={(event) => onRun(leg, event.currentTarget)}
                    variant="secondary"
                  >
                    Run exam — {label}
                  </Button>
                ))}
              </>
            )}
          </div>
        </div>
        {/* Latest complete run per leg for the current version — the headline. */}
        {Object.entries(exam.legs || {}).some(([, r]) => r) ? (
          Object.entries(exam.legs).map(([leg, run]) => (run ? <SealedRunRow key={leg} run={run} runsById={runsById} /> : null))
        ) : (
          <div className="border-t border-hairline border-zinc-200 pt-2 text-ui-caption text-ink-secondary">
            No completed exam for {exam.currentVersion} yet{items.active ? " — run one per leg to baseline this version." : " — seal items first, then run each leg."}
          </div>
        )}
        {/* History (already-shown current-leg headliners included for context). */}
        {runs.filter((r) => r.status !== "complete" || !Object.values(exam.legs || {}).some((h) => h && h.id === r.id)).slice(0, 6)
          .map((run) => <SealedRunRow key={run.id} run={run} runsById={runsById} />)}
      </Card>
    </section>
  );
}

// Failure pathology — the standing (harness surface × failure mode) ledger.
// The nightly classifier buckets every unsafe judgment; cells with enough
// fresh evidence earn a parked patch-proposal card. Accepting a proposal
// records a go-ahead only — nothing changes generation until a human ships
// a new prompt version.
function cellLabel(surface, failureMode) {
  return `${String(surface || '').replace(/_/g, ' ')} · ${String(failureMode || '').replace(/_/g, ' ')}`;
}

function ProposalCard({ proposal, busy, onReview }) {
  const [expanded, setExpanded] = useState(false);
  const pending = proposal.status === 'pending';
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-14 font-medium text-zinc-900">{cellLabel(proposal.surface, proposal.failure_mode)}</span>
        <Badge tone={pending ? "alert" : "neutral"}>
          {pending ? "Proposed patch — review" : `Accepted${proposal.reviewed_by ? ` by ${proposal.reviewed_by}` : ""}`}
        </Badge>
        <span className="text-ui-caption text-ink-secondary u-nums">{proposal.evidence_count} failures behind it</span>
        <Button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          variant="secondary"
          className="ml-auto"
        >
          {expanded ? "Collapse" : "Read proposal"}
        </Button>
      </div>
      <div className={`whitespace-pre-wrap break-words text-ui-body text-ink-secondary ${expanded ? "" : "max-h-[72px] overflow-hidden"}`}>
        {proposal.proposal}
      </div>
      {pending && (
        <div className="ui-record-actions">
          <Button
            type="button"
            disabled={busy}
            onClick={(event) => onReview(proposal, "accept", event.currentTarget)}
            loading={busy}
          >
            Accept — worth building (ships as a new prompt version)
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={(event) => onReview(proposal, "dismiss", event.currentTarget)}
            loading={busy}
            variant="secondary"
          >
            Dismiss
          </Button>
        </div>
      )}
    </Card>
  );
}

function PathologySection({ data, busy, onReview }) {
  if (!data) return null;
  const cells = data.cells || [];
  const proposals = data.proposals || [];
  if (!cells.length && !proposals.length) return null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-18 font-medium text-zinc-900">Failure pathology</h2>
        <div className="text-ui-body text-ink-secondary">
          Every unsafe draft is filed by where the fix lives and what it invented. Recurring cells earn a proposed patch below — nothing applies without you.
        </div>
      </div>
      {data.gateEnabled === false && (
        <ActionFeedback error>
          GATE_SMS_PATHOLOGY_LEDGER is off — the ledger shows history but no new failures are being classified.
        </ActionFeedback>
      )}
      {cells.length > 0 && (
        <Card className="flex flex-wrap gap-2 p-3">
          {cells.slice(0, 8).map((c) => (
            <Badge
              key={`${c.surface}:${c.failureMode}`}
              tone={c.currentVersion > 0 ? "alert" : "neutral"}
            >
              {cellLabel(c.surface, c.failureMode)} <strong>{c.total}</strong>
              {c.currentVersion > 0 && <span> ({c.currentVersion} on {data.currentVersion})</span>}
            </Badge>
          ))}
        </Card>
      )}
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} busy={busy} onReview={onReview} />
      ))}
    </section>
  );
}

export default function AgentShadowDraftsPage({ embedded = false }) {
  const [data, setData] = useState(null);
  const [scores, setScores] = useState(null);
  const [modes, setModes] = useState(null);
  const [profiles, setProfiles] = useState(null);
  const [exam, setExam] = useState(null);
  const [pathology, setPathology] = useState(null);
  const [modeBusy, setModeBusy] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [examBusy, setExamBusy] = useState(false);
  const [pathologyBusy, setPathologyBusy] = useState(false);
  const [intentFilter, setIntentFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorRetry, setErrorRetry] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [confirmationError, setConfirmationError] = useState("");
  const confirmationInFlightRef = useRef(false);

  const requestConfirmation = useCallback((nextConfirmation, trigger) => {
    trigger?.focus({ preventScroll: true });
    setConfirmationError("");
    setConfirmation(nextConfirmation);
  }, []);

  const closeConfirmation = useCallback(() => {
    if (confirmationBusy) return;
    setConfirmation(null);
    setConfirmationError("");
  }, [confirmationBusy]);

  const confirmPendingAction = useCallback(async () => {
    if (!confirmation || confirmationInFlightRef.current) return;
    confirmationInFlightRef.current = true;
    setConfirmationBusy(true);
    setConfirmationError("");
    try {
      const result = await confirmation.run();
      if (result.ok) {
        setConfirmation(null);
      } else {
        setConfirmationError(result.error);
      }
    } catch (err) {
      setConfirmationError(err.message || "The action failed. Try again.");
    } finally {
      confirmationInFlightRef.current = false;
      setConfirmationBusy(false);
    }
  }, [confirmation]);

  const refreshAfterWrite = useCallback(async function retryRead(read, apply, failureMessage) {
    try {
      apply(await read());
      setError("");
      setErrorRetry(null);
      return true;
    } catch {
      setError(failureMessage);
      setErrorRetry(() => () => retryRead(read, apply, failureMessage));
      return false;
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setErrorRetry(null);
    try {
      const qs = intentFilter ? `?intent=${encodeURIComponent(intentFilter)}` : "";
      const [drafts, scoreRows, modeRows] = await Promise.all([
        adminFetch(`/admin/agents/shadow-drafts${qs}`),
        adminFetch("/admin/agents/shadow-scores"),
        adminFetch("/admin/agents/intent-modes"),
      ]);
      setData(drafts);
      setScores(scoreRows);
      setModes(modeRows);
      // The voice-profile card is additive — a failure here (e.g. the
      // voice_profiles migration not yet run) must not blank the whole
      // established Shadow Drafts tab, so it loads outside the shared
      // Promise.all and degrades to "no card".
      try {
        setProfiles(await adminFetch("/admin/agents/voice-profiles"));
      } catch {
        setProfiles(null);
      }
      // Sealed exam is additive the same way — a failure (migration not yet
      // run) degrades to "no section", never a blank tab.
      try {
        setExam(await adminFetch("/admin/agents/sealed-eval"));
      } catch {
        setExam(null);
      }
      // Pathology ledger is additive the same way — a failure (migration not
      // yet run) degrades to "no section", never a blank tab.
      try {
        setPathology(await adminFetch("/admin/agents/pathology"));
      } catch {
        setPathology(null);
      }
    } catch (err) {
      setError(err.message || "Failed to load shadow drafts.");
    } finally {
      setLoading(false);
    }
  }, [intentFilter]);

  const applyProfileReview = useCallback(async (row, action) => {
    setProfileBusy(true);
    setError("");
    setErrorRetry(null);
    try {
      await adminFetch(`/admin/agents/voice-profiles/${row.id}/review`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await refreshAfterWrite(
        () => adminFetch("/admin/agents/voice-profiles"),
        setProfiles,
        "Voice profile updated, but the refreshed profile could not be loaded. Try again to refresh it.",
      );
      return { ok: true };
    } catch (err) {
      const message = err.message || "Failed to review the voice profile.";
      setError(message);
      return { ok: false, error: message };
    } finally {
      setProfileBusy(false);
    }
  }, [refreshAfterWrite]);

  const reviewProfile = useCallback((row, action, trigger) => {
    if (action === "approve") {
      requestConfirmation({
        title: `Approve voice profile v${row.version}?`,
        description: "It becomes the live voice guidance for the phone agent (and any future consumer). The previous approved version is superseded.",
        confirmLabel: "Approve — make this the live voice",
        run: () => applyProfileReview(row, action),
      }, trigger);
      return;
    }
    if (action === "revoke") {
      requestConfirmation({
        title: `Revoke voice profile v${row.version}?`,
        description: "The phone agent goes back to its base voice until the next green profile auto-applies.",
        confirmLabel: "Revoke — back to base voice",
        run: () => applyProfileReview(row, action),
      }, trigger);
      return;
    }
    void applyProfileReview(row, action);
  }, [applyProfileReview, requestConfirmation]);

  useEffect(() => {
    load();
  }, [load]);

  // Light poll while an exam run is in flight so progress/aggregates update
  // without a manual refresh. The section itself refetches ONLY the exam
  // payload — the rest of the tab stays untouched.
  const examRunning = Boolean((exam?.runs || []).some((r) => r.status === "running"));
  useEffect(() => {
    if (!examRunning) return undefined;
    const timer = setInterval(async () => {
      try {
        setExam(await adminFetch("/admin/agents/sealed-eval"));
      } catch {
        /* transient poll miss — keep the last snapshot */
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [examRunning]);

  const refreshExam = useCallback(async () => {
    try {
      setExam(await adminFetch("/admin/agents/sealed-eval"));
    } catch {
      /* section degrades to stale data; the next full load reconciles */
    }
  }, []);

  const sealItemsNow = useCallback(async () => {
    setExamBusy(true);
    setError("");
    setErrorRetry(null);
    try {
      await adminFetch("/admin/agents/sealed-eval/seal", { method: "POST" });
      await refreshAfterWrite(
        () => adminFetch("/admin/agents/sealed-eval"),
        setExam,
        "Sealed items were updated, but the refreshed exam data could not be loaded. Try again to refresh it.",
      );
      return { ok: true };
    } catch (err) {
      const message = err.message || "Failed to seal eval items.";
      setError(message);
      return { ok: false, error: message };
    } finally {
      setExamBusy(false);
    }
  }, [refreshAfterWrite]);

  const sealItems = useCallback((event) => {
    requestConfirmation({
      title: "Top up the sealed exam set?",
      description: "Up to the target count of judged past texts (with that day's frozen facts) are added permanently. Sealed items are excluded from drafter training forever.",
      confirmLabel: "Top up sealed items",
      run: sealItemsNow,
    }, event.currentTarget);
  }, [requestConfirmation, sealItemsNow]);

  const runExamNow = useCallback(async (providerLeg) => {
    setExamBusy(true);
    setError("");
    setErrorRetry(null);
    try {
      await adminFetch("/admin/agents/sealed-eval/runs", {
        method: "POST",
        body: JSON.stringify({ providerLeg }),
      });
      await refreshAfterWrite(
        () => adminFetch("/admin/agents/sealed-eval"),
        setExam,
        "The exam run started, but the refreshed exam data could not be loaded. Try again to refresh it.",
      );
      return { ok: true };
    } catch (err) {
      const message = err.message || "Failed to start the exam run.";
      setError(message);
      return { ok: false, error: message };
    } finally {
      setExamBusy(false);
    }
  }, [refreshAfterWrite]);

  const runExam = useCallback((providerLeg, trigger) => {
    const n = exam?.items?.active || 0;
    const legLabel = LEG_LABELS[providerLeg] || providerLeg;
    requestConfirmation({
      title: `Run the sealed exam on the ${legLabel}?`,
      description: `Replays all ${n} sealed items through the current drafter and judges each one — roughly ${n * 2}–${n * 5} AI calls. Takes several minutes; progress shows here.`,
      confirmLabel: `Run exam — ${legLabel}`,
      run: () => runExamNow(providerLeg),
    }, trigger);
  }, [exam, requestConfirmation, runExamNow]);

  const resumeExam = useCallback(async (run) => {
    setExamBusy(true);
    setError("");
    setErrorRetry(null);
    try {
      await adminFetch("/admin/agents/sealed-eval/runs", {
        method: "POST",
        body: JSON.stringify({ resumeRunId: run.id }),
      });
      await refreshExam();
    } catch (err) {
      setError(err.message || "Failed to resume the exam run.");
    } finally {
      setExamBusy(false);
    }
  }, [refreshExam]);

  const applyProposalReview = useCallback(async (proposal, action) => {
    setPathologyBusy(true);
    setError("");
    setErrorRetry(null);
    try {
      await adminFetch(`/admin/agents/pathology/proposals/${proposal.id}/review`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await refreshAfterWrite(
        () => adminFetch("/admin/agents/pathology"),
        setPathology,
        "Patch proposal updated, but the refreshed pathology data could not be loaded. Try again to refresh it.",
      );
      return { ok: true };
    } catch (err) {
      const message = err.message || "Failed to review the patch proposal.";
      setError(message);
      return { ok: false, error: message };
    } finally {
      setPathologyBusy(false);
    }
  }, [refreshAfterWrite]);

  const reviewProposal = useCallback((proposal, action, trigger) => {
    if (action === "accept") {
      requestConfirmation({
        title: `Accept this patch proposal (${cellLabel(proposal.surface, proposal.failure_mode)})?`,
        description: "This records your go-ahead — the change itself still ships as a new prompt version you review as a PR. Nothing changes today.",
        confirmLabel: "Accept — worth building",
        run: () => applyProposalReview(proposal, action),
      }, trigger);
      return;
    }
    void applyProposalReview(proposal, action);
  }, [applyProposalReview, requestConfirmation]);

  const toggleMode = useCallback(async (row) => {
    // Step shadow⇄suggest, or demote auto_send→suggest — always an explicit,
    // correctly-labeled action (never an accidental demote of an active
    // autonomous-send intent). Promotion into auto_send is eligibility-gated
    // and goes through the API, not this toggle.
    const nextMode = modeToggle(row.mode).next;
    setModeBusy(row.intent);
    setError("");
    setErrorRetry(null);
    try {
      const updated = await adminFetch(`/admin/agents/intent-modes/${encodeURIComponent(row.intent)}`, {
        method: "PUT",
        body: JSON.stringify({ mode: nextMode }),
      });
      // Optimistic mode update. Drop the cached graduation: readiness depends
      // on mode (the next-rung target changes), and the PUT response carries
      // no recomputed graduation — keeping it would show a stale chip like
      // "Ready — enable suggest" under a Suggest mode chip.
      setModes((current) => current
        ? { ...current, intents: current.intents.map((r) => (r.intent === updated.intent ? { ...r, ...updated, graduation: null } : r)) }
        : current);
      // Reconcile readiness from the server (graduation isn't in the PUT body).
      const fresh = await adminFetch("/admin/agents/intent-modes");
      setModes(fresh);
    } catch (err) {
      setError(err.message || "Failed to update intent mode.");
    } finally {
      setModeBusy("");
    }
  }, []);

  const promoteToAutoSendNow = useCallback(async (row) => {
    setModeBusy(row.intent);
    setError("");
    setErrorRetry(null);
    try {
      const updated = await adminFetch(`/admin/agents/intent-modes/${encodeURIComponent(row.intent)}`, {
        method: "PUT",
        body: JSON.stringify({ mode: "auto_send", reason: "Promoted to auto-send from the readiness chip." }),
      });
      setModes((current) => current
        ? { ...current, intents: current.intents.map((r) => (r.intent === updated.intent ? { ...r, ...updated, graduation: null } : r)) }
        : current);
      await refreshAfterWrite(
        () => adminFetch("/admin/agents/intent-modes"),
        setModes,
        "Auto-send mode was enabled, but readiness could not be refreshed. Try again to refresh it.",
      );
      return { ok: true };
    } catch (err) {
      // The server 409s if eligibility slipped between render and click.
      const message = err.message || "Failed to enable auto-send.";
      setError(message);
      return { ok: false, error: message };
    } finally {
      setModeBusy("");
    }
  }, [refreshAfterWrite]);

  const promoteToAutoSend = useCallback((row, trigger) => {
    // Enabling autonomous customer sends — confirm deliberately.
    requestConfirmation({
      title: `Enable AUTONOMOUS auto-send for "${intentLabel(row.intent)}"?`,
      description:
        `Verified house-voice drafts for this intent will be sent to customers automatically, with NO human review. ` +
        `The server re-checks readiness on every send, and escalation / scheduling messages never auto-send.` +
        (modes?.autoSendGateEnabled === false
          ? `\n\nNote: GATE_SMS_AUTO_SEND is currently OFF, so drafts keep going to the review queue until the gate is enabled.`
          : ``),
      confirmLabel: "Enable auto-send",
      run: () => promoteToAutoSendNow(row),
    }, trigger);
  }, [modes, promoteToAutoSendNow, requestConfirmation]);

  const intents = useMemo(() => (scores?.intents || []).map((row) => row.intent), [scores]);
  const drafts = data?.drafts || [];

  return (
    <UiSurface density="comfortable" className="min-h-full space-y-5 text-zinc-800">
      {error && <ActionFeedback error onRetry={errorRetry || undefined}>{error}</ActionFeedback>}

      {(modes?.intents || []).length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-18 font-medium text-zinc-900">Intent graduation</h2>
            <p className="text-ui-body text-ink-secondary">
              Suggest surfaces the draft as an Agent Review card in the comms composer — a human still reads, edits, and sends.
            </p>
          </div>
          {modes.gateEnabled === false && (
            <ActionFeedback error>GATE_SMS_SUGGEST_MODE is off — suggest flips are saved but take effect once the gate is enabled.</ActionFeedback>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {modes.intents.map((row) => (
              <IntentModeCard
                key={row.intent}
                row={row}
                busy={modeBusy === row.intent}
                onToggle={toggleMode}
                onPromote={promoteToAutoSend}
                autoSendGateOff={modes.autoSendGateEnabled === false}
              />
            ))}
          </div>
        </section>
      )}

      <VoiceProfileSection profiles={profiles} busy={profileBusy} onReview={reviewProfile} />
      <SealedExamSection exam={exam} busy={examBusy} onSeal={sealItems} onRun={runExam} onResume={resumeExam} />

      {(scores?.intents || []).length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {scores.intents.slice(0, 8).map((row) => <IntentScoreCard key={row.intent} row={row} />)}
        </div>
      )}

      <PathologySection data={pathology} busy={pathologyBusy} onReview={reviewProposal} />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Draft intent">
        <Button type="button" onClick={() => setIntentFilter("")} variant={intentFilter === "" ? "primary" : "secondary"} aria-pressed={intentFilter === ""}>
          All intents
        </Button>
        {intents.map((intent) => (
          <Button
            key={intent}
            type="button"
            onClick={() => setIntentFilter(intent === intentFilter ? "" : intent)}
            variant={intentFilter === intent ? "primary" : "secondary"}
            aria-pressed={intentFilter === intent}
          >
            {intentLabel(intent)}
          </Button>
        ))}
      </div>

      {loading && !data ? (
        <ActionFeedback>Loading shadow drafts...</ActionFeedback>
      ) : drafts.length ? (
        <div className="space-y-3">{drafts.map((draft) => <DraftCard key={draft.id} draft={draft} />)}</div>
      ) : (
        <ActionFeedback>
          No shadow drafts yet. They appear as customers text the location numbers; the judge scores each one nightly at 3:55am ET once the 24-hour human-reply window closes.
        </ActionFeedback>
      )}

      <ShadowConfirmationDialog
        confirmation={confirmation}
        busy={confirmationBusy}
        error={confirmationError}
        onCancel={closeConfirmation}
        onConfirm={confirmPendingAction}
      />
    </UiSurface>
  );
}
