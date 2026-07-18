/**
 * <AgentShadowDraftsPage> — Shadow Drafts tab inside /admin/agents.
 *
 * Read-only window into the SMS brand-voice loop: every inbound customer
 * SMS gets a silent house-voice draft (message_drafts status='shadow');
 * the nightly judge scores each against the reply a human actually sent.
 * Per-intent score history here is what graduates an intent (Phase E).
 *
 * Tier 2 styling (inline + light D palette) to match the sibling
 * AgentOpsPage; the hub shell stays Tier 1.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch } from "../../utils/admin-fetch";

const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  heading: "#09090B",
  text: "#27272A",
  muted: "#71717A",
  green: "#15803D",
  amber: "#A16207",
  red: "#B91C1C",
  blue: "#1D4ED8",
  zinc: "#3F3F46",
};

const VERDICT_TONES = {
  draft_better: { bg: "#DCFCE7", fg: D.green, label: "Draft better" },
  equivalent: { bg: "#DBEAFE", fg: D.blue, label: "Equivalent" },
  human_better: { bg: "#FEF3C7", fg: D.amber, label: "Human better" },
  draft_unsafe: { bg: "#FEE2E2", fg: D.red, label: "Unsafe" },
  human_no_reply: { bg: D.bg, fg: D.muted, label: "Human silent" },
  both_no_reply: { bg: "#DBEAFE", fg: D.blue, label: "Both silent" },
};

function intentLabel(intent) {
  return String(intent || "GENERAL").replace(/_/g, " ");
}

function Chip({ children, tone }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 22,
        padding: "0 8px",
        borderRadius: 6,
        background: tone.bg,
        color: tone.fg,
        fontSize: 12,
        fontWeight: 750,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
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

function Bubble({ label, text, tone }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: D.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      <div
        style={{
          background: tone || D.bg,
          border: `1px solid ${D.border}`,
          borderRadius: 8,
          padding: "8px 10px",
          fontSize: 14,
          color: D.text,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {text || <span style={{ color: D.muted }}>(no reply)</span>}
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
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {entries.map(([label, value]) => (
        <span key={label} style={{ fontSize: 12, fontWeight: 750, color: D.heading, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, padding: "2px 7px" }}>
          {label} <strong>{value ?? "-"}</strong>
        </span>
      ))}
    </div>
  );
}

function DraftCard({ draft }) {
  const judgment = draft.judgment;
  const tone = judgment ? VERDICT_TONES[judgment.verdict] || VERDICT_TONES.human_no_reply : null;
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 850, color: D.heading }}>{draft.customerName || "Unknown customer"}</span>
        <Chip tone={{ bg: D.bg, fg: D.zinc }}>{intentLabel(draft.intent)}</Chip>
        {draft.schedulingIntent && <Chip tone={{ bg: "#FEF3C7", fg: D.amber }}>scheduling</Chip>}
        {tone ? <Chip tone={tone}>{tone.label}</Chip> : <Chip tone={{ bg: D.bg, fg: D.muted }}>Awaiting judge</Chip>}
        <span style={{ marginLeft: "auto", fontSize: 12, color: D.muted }}>{timeLabel(draft.createdAt)}</span>
      </div>

      <div className="shadow-draft-grid">
        <Bubble label="Customer" text={draft.inboundMessage} />
        <Bubble label="AI shadow draft" text={draft.draftResponse} tone="#F0F9FF" />
        <Bubble
          label={judgment?.humanReplied ? "Human reply (sent)" : "Human reply"}
          text={judgment ? judgment.humanReplyText : null}
          tone="#F7FEE7"
        />
      </div>

      {judgment?.scores && <ScorePills scores={judgment.scores} />}
      {judgment?.notes && (
        <div style={{ fontSize: 13, color: D.muted, lineHeight: 1.4 }}>
          <strong style={{ color: D.zinc }}>Judge:</strong> {judgment.notes}
        </div>
      )}
    </div>
  );
}

function IntentScoreCard({ row }) {
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 850, color: D.heading, marginBottom: 6, overflowWrap: "anywhere" }}>{intentLabel(row.intent)}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: D.muted }}>
        <span><strong style={{ color: D.heading }}>{row.drafts}</strong> drafts</span>
        <span><strong style={{ color: D.heading }}>{row.judged}</strong> judged</span>
        {row.avg && <span>overall <strong style={{ color: D.heading }}>{row.avg.overall}</strong>/10</span>}
        {row.verdicts?.draft_unsafe ? (
          <span style={{ color: D.red, fontWeight: 750 }}>{row.verdicts.draft_unsafe} unsafe</span>
        ) : null}
      </div>
    </div>
  );
}

const MODE_TONES = {
  shadow: { bg: "#F4F4F5", fg: D.zinc, label: "Shadow" },
  suggest: { bg: "#DCFCE7", fg: D.green, label: "Suggest" },
  auto_send: { bg: "#DBEAFE", fg: D.blue, label: "Auto-send" },
  locked: { bg: "#FEE2E2", fg: D.red, label: "Escalation — always shadow" },
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, borderTop: `1px dashed ${D.border}`, paddingTop: 8 }}>
      {g.eligibleFor === "suggest" && (
        <span style={{ background: "#DCFCE7", color: D.green, fontWeight: 800, borderRadius: 6, padding: "2px 8px" }}>✓ Ready — enable suggest</span>
      )}
      {g.eligibleFor === "auto_send" && (
        <span style={{ background: "#DBEAFE", color: "#1D4ED8", fontWeight: 800, borderRadius: 6, padding: "2px 8px" }}>✓ Earned the auto-send rung</span>
      )}
      {/* Intent is AT auto_send but the send-time gate is blocking (e.g. a
          prompt bump reset the cohort evidence) — mirror the executor. */}
      {g.autoSendHealth && !g.autoSendHealth.sendReady && (
        <>
          <span style={{ background: "#FEF3C7", color: "#92400E", fontWeight: 800, borderRadius: 6, padding: "2px 8px" }}>
            ⚠ Auto-send gated: {g.autoSendHealth.blockers?.[0] || "readiness not met"}
          </span>
          <span style={{ color: D.muted }}>
            Sends fall back to review cards; unused cards re-enter the judge pool. Demote to shadow to rebuild evidence faster.
          </span>
        </>
      )}
      {!g.eligibleFor && rungLabel && (
        <span style={{ color: D.muted }}>
          <strong style={{ color: D.zinc }}>→ {rungLabel}:</strong> {g.blockers?.[0] || "gathering data"}
        </span>
      )}
      {context.length > 0 && <span style={{ color: D.muted }}>· {context.join(" · ")}</span>}
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
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 850, color: D.heading, overflowWrap: "anywhere" }}>{intentLabel(row.intent)}</span>
        <Chip tone={tone}>{tone.label}</Chip>
        {!row.locked && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onToggle(row)}
            style={{
              marginLeft: "auto",
              minHeight: 28,
              borderRadius: 6,
              border: `1px solid ${D.border}`,
              background: D.card,
              // Green = stepping UP from shadow; zinc = stepping down a rung.
              color: row.mode === "shadow" ? D.green : D.zinc,
              fontSize: 12,
              fontWeight: 750,
              padding: "0 10px",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {modeToggle(row.mode).label}
          </button>
        )}
      </div>
      {hasHistory && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: D.muted }}>
          <span><strong style={{ color: D.heading }}>{s.suggested}</strong> suggested</span>
          {s.pending ? <span><strong style={{ color: D.heading }}>{s.pending}</strong> pending</span> : null}
          <span style={{ color: D.green }}><strong>{s.accepted || 0}</strong> accepted</span>
          <span style={{ color: D.amber }}><strong>{s.corrected || 0}</strong> corrected</span>
          <span><strong style={{ color: D.heading }}>{s.ignored || 0}</strong> ignored</span>
          {s.expired ? <span><strong style={{ color: D.heading }}>{s.expired}</strong> expired</span> : null}
        </div>
      )}
      {!row.locked && row.graduation && <GraduationNote g={row.graduation} />}
      {canPromote && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onPromote(row)}
          style={{
            minHeight: 30,
            borderRadius: 6,
            border: `1px solid #1D4ED8`,
            background: "#1D4ED8",
            color: "#FFFFFF",
            fontSize: 12,
            fontWeight: 800,
            padding: "0 12px",
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Enabling…" : "Enable auto-send →"}
        </button>
      )}
      {(canPromote || row.mode === "auto_send") && autoSendGateOff && (
        <div style={{ fontSize: 11, color: D.amber }}>
          GATE_SMS_AUTO_SEND is off — the mode saves, but drafts keep going to the review queue until the gate is enabled.
        </div>
      )}
      {row.updatedBy && row.updatedBy !== "migration" && (
        <div style={{ fontSize: 11, color: D.muted }}>
          Set by {row.updatedBy} · {timeLabel(row.updatedAt)}{row.reason ? ` · ${row.reason}` : ""}
        </div>
      )}
    </div>
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
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 850, color: D.heading }}>Voice profile</div>
        <div style={{ fontSize: 12, color: D.muted }}>
          Distilled daily from real Waves calls + texts. Green profiles auto-apply to the phone agent; exceptions park here. Style only, never facts.
        </div>
      </div>
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 850, color: D.heading }}>v{row.version}</span>
          {pending ? (
            <Chip tone={{ bg: "#FEF3C7", fg: "#92400E", label: "Exception" }}>Exception — review needed</Chip>
          ) : (
            <Chip tone={{ bg: "#DCFCE7", fg: D.green, label: "Approved" }}>
              {row.reviewed_by === "auto:distiller" ? "Live (auto-approved)" : `Approved${row.reviewed_by ? ` by ${row.reviewed_by}` : ""}`}
            </Chip>
          )}
          {flags.length > 0 && (
            <span style={{ background: "#FEE2E2", color: D.red, fontWeight: 750, borderRadius: 6, padding: "2px 8px", fontSize: 12 }}>
              ⚠ style-only check flagged: {flags.join(", ")}
            </span>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${D.border}`, color: D.text, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
          >
            {expanded ? "Collapse" : "Read profile"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: D.muted, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: expanded ? "none" : 90, overflow: "hidden" }}>
          {row.profile_text}
        </div>
        {pending && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReview(pending, "approve")}
              style={{ background: "#DCFCE7", border: `1px solid ${D.green}`, color: D.green, borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
            >
              Approve — make this the live voice
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReview(pending, "reject")}
              style={{ background: "transparent", border: `1px solid ${D.border}`, color: D.muted, borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 750, cursor: "pointer" }}
            >
              Reject
            </button>
          </div>
        )}
      </div>
      {/* The LIVE profile's revoke is rendered independently of any pending
          exception — a normal state is "v5 live (auto), v6 parked as an
          exception", and killing the live voice must never wait on resolving
          an unrelated review. */}
      {approved && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: D.muted }}>
          <span>
            Live now: <strong style={{ color: D.heading }}>v{approved.version}</strong>
            {approved.reviewed_by === "auto:distiller" ? " (auto-approved)" : approved.reviewed_by ? ` (approved by ${approved.reviewed_by})` : ""}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReview(approved, "revoke")}
            style={{ background: "transparent", border: `1px solid ${D.border}`, color: D.muted, borderRadius: 6, padding: "4px 12px", fontSize: 12, fontWeight: 750, cursor: "pointer" }}
          >
            Revoke — back to base voice
          </button>
        </div>
      )}
    </div>
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
    return <Chip tone={{ bg: "#DCFCE7", fg: D.green }}>✓ improved (p={sig.pValue})</Chip>;
  }
  if (sig.significant && sig.direction === "regressed") {
    return <Chip tone={{ bg: "#FEE2E2", fg: D.red }}>✗ regressed (p={sig.pValue})</Chip>;
  }
  return <Chip tone={{ bg: D.bg, fg: D.muted }}>no significant change (p={sig.pValue})</Chip>;
}

const LEG_LABELS = { anthropic: "Claude leg", openai: "GPT leg" };

function SealedRunRow({ run, runsById }) {
  const pct = run.unsafeRate == null ? "-" : `${Math.round(run.unsafeRate * 100)}%`;
  const baseline = run.baselineRunId ? runsById.get(run.baselineRunId) : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: D.muted, borderTop: `1px dashed ${D.border}`, paddingTop: 8 }}>
      <strong style={{ color: D.heading }}>{run.promptVersion}</strong>
      <Chip tone={{ bg: D.bg, fg: D.zinc }}>{LEG_LABELS[run.providerLeg] || run.providerLeg}</Chip>
      {run.status === "running" && <Chip tone={{ bg: "#DBEAFE", fg: D.blue }}>running… {run.itemsJudged}/{run.itemsTotal}</Chip>}
      {run.status === "failed" && <Chip tone={{ bg: "#FEE2E2", fg: D.red }}>failed</Chip>}
      {run.status === "complete" && (
        <>
          <span><strong style={{ color: run.unsafeRate > 0.08 ? D.red : D.heading }}>{pct}</strong> unsafe ({run.unsafeCount}/{run.itemsJudged})</span>
          {run.avgSafety != null && <span>safety <strong style={{ color: D.heading }}>{run.avgSafety}</strong>/10</span>}
          {significanceChip(run.significance)}
          {baseline && <span>vs {baseline.promptVersion}</span>}
        </>
      )}
      <span style={{ marginLeft: "auto" }}>{timeLabel(run.startedAt)}</span>
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
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 850, color: D.heading }}>Sealed exam</div>
        <div style={{ fontSize: 12, color: D.muted }}>
          A locked set of real past texts (with that day&apos;s facts frozen) the drafter never trains on. Each run replays the whole set on one provider and compares against the last examined version.
        </div>
      </div>
      {exam.gateEnabled === false && (
        <div style={{ background: "#FEF3C7", border: `1px solid ${D.amber}`, color: D.amber, borderRadius: 8, padding: 10, fontSize: 12, fontWeight: 750 }}>
          GATE_SMS_SEALED_EVAL is off — sealing and exam runs are disabled until the gate is enabled.
        </div>
      )}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: D.muted }}>
          <span><strong style={{ color: D.heading }}>{items.active}</strong> sealed items</span>
          <span>drafter <strong style={{ color: D.heading }}>{exam.currentVersion}</strong></span>
          {exam.examRequiredForGraduation && (
            <Chip tone={{ bg: "#DBEAFE", fg: D.blue }}>required for graduation</Chip>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || exam.gateEnabled === false}
              onClick={onSeal}
              style={{ minHeight: 28, borderRadius: 6, border: `1px solid ${D.border}`, background: D.card, color: D.zinc, fontSize: 12, fontWeight: 750, padding: "0 10px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
            >
              Top up sealed items
            </button>
            {inFlight ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onResume(inFlight)}
                style={{ minHeight: 28, borderRadius: 6, border: `1px solid ${D.amber}`, background: D.card, color: D.amber, fontSize: 12, fontWeight: 750, padding: "0 10px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
              >
                Resume stalled run
              </button>
            ) : (
              <>
                {resumableFailure && (
                  <button
                    type="button"
                    disabled={busy || exam.gateEnabled === false}
                    onClick={() => onResume(resumableFailure)}
                    style={{ minHeight: 28, borderRadius: 6, border: `1px solid ${D.amber}`, background: D.card, color: D.amber, fontSize: 12, fontWeight: 750, padding: "0 10px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
                  >
                    Resume failed run ({LEG_LABELS[resumableFailure.providerLeg] || resumableFailure.providerLeg})
                  </button>
                )}
                {Object.entries(LEG_LABELS).map(([leg, label]) => (
                  <button
                    key={leg}
                    type="button"
                    disabled={busy || exam.gateEnabled === false || !items.active}
                    onClick={() => onRun(leg)}
                    style={{ minHeight: 28, borderRadius: 6, border: `1px solid ${D.blue}`, background: D.card, color: D.blue, fontSize: 12, fontWeight: 750, padding: "0 10px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
                  >
                    Run exam — {label}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
        {/* Latest complete run per leg for the current version — the headline. */}
        {Object.entries(exam.legs || {}).some(([, r]) => r) ? (
          Object.entries(exam.legs).map(([leg, run]) => (run ? <SealedRunRow key={leg} run={run} runsById={runsById} /> : null))
        ) : (
          <div style={{ fontSize: 12, color: D.muted, borderTop: `1px dashed ${D.border}`, paddingTop: 8 }}>
            No completed exam for {exam.currentVersion} yet{items.active ? " — run one per leg to baseline this version." : " — seal items first, then run each leg."}
          </div>
        )}
        {/* History (already-shown current-leg headliners included for context). */}
        {runs.filter((r) => r.status !== "complete" || !Object.values(exam.legs || {}).some((h) => h && h.id === r.id)).slice(0, 6)
          .map((run) => <SealedRunRow key={run.id} run={run} runsById={runsById} />)}
      </div>
    </div>
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
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 850, color: D.heading }}>{cellLabel(proposal.surface, proposal.failure_mode)}</span>
        <Chip tone={pending ? { bg: "#FEF3C7", fg: "#92400E" } : { bg: "#DCFCE7", fg: D.green }}>
          {pending ? "Proposed patch — review" : `Accepted${proposal.reviewed_by ? ` by ${proposal.reviewed_by}` : ""}`}
        </Chip>
        <span style={{ fontSize: 12, color: D.muted }}>{proposal.evidence_count} failures behind it</span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${D.border}`, color: D.text, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
        >
          {expanded ? "Collapse" : "Read proposal"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: D.muted, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: expanded ? "none" : 72, overflow: "hidden" }}>
        {proposal.proposal}
      </div>
      {pending && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReview(proposal, "accept")}
            style={{ background: "#DCFCE7", border: `1px solid ${D.green}`, color: D.green, borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
          >
            Accept — worth building (ships as a new prompt version)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReview(proposal, "dismiss")}
            style={{ background: "transparent", border: `1px solid ${D.border}`, color: D.muted, borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 750, cursor: "pointer" }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function PathologySection({ data, busy, onReview }) {
  if (!data) return null;
  const cells = data.cells || [];
  const proposals = data.proposals || [];
  if (!cells.length && !proposals.length) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 850, color: D.heading }}>Failure pathology</div>
        <div style={{ fontSize: 12, color: D.muted }}>
          Every unsafe draft is filed by where the fix lives and what it invented. Recurring cells earn a proposed patch below — nothing applies without you.
        </div>
      </div>
      {data.gateEnabled === false && (
        <div style={{ background: "#FEF3C7", border: `1px solid ${D.amber}`, color: D.amber, borderRadius: 8, padding: 10, fontSize: 12, fontWeight: 750 }}>
          GATE_SMS_PATHOLOGY_LEDGER is off — the ledger shows history but no new failures are being classified.
        </div>
      )}
      {cells.length > 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {cells.slice(0, 8).map((c) => (
            <span
              key={`${c.surface}:${c.failureMode}`}
              style={{ fontSize: 12, fontWeight: 750, color: D.heading, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, padding: "4px 9px" }}
            >
              {cellLabel(c.surface, c.failureMode)} <strong>{c.total}</strong>
              {c.currentVersion > 0 && <span style={{ color: D.red }}> ({c.currentVersion} on {data.currentVersion})</span>}
            </span>
          ))}
        </div>
      )}
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} busy={busy} onReview={onReview} />
      ))}
    </div>
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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
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

  const reviewProfile = useCallback(async (row, action) => {
    if (action === "approve") {
      const ok = window.confirm(
        `Approve voice profile v${row.version}?\n\nIt becomes the live voice guidance for the phone agent (and any future consumer). The previous approved version is superseded.`
      );
      if (!ok) return;
    }
    if (action === "revoke") {
      const ok = window.confirm(
        `Revoke voice profile v${row.version}?\n\nThe phone agent goes back to its base voice until the next green profile auto-applies.`
      );
      if (!ok) return;
    }
    setProfileBusy(true);
    setError("");
    try {
      await adminFetch(`/admin/agents/voice-profiles/${row.id}/review`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      const fresh = await adminFetch("/admin/agents/voice-profiles");
      setProfiles(fresh);
    } catch (err) {
      setError(err.message || "Failed to review the voice profile.");
    } finally {
      setProfileBusy(false);
    }
  }, []);

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

  const sealItems = useCallback(async () => {
    const ok = window.confirm(
      "Top up the sealed exam set?\n\nUp to the target count of judged past texts (with that day's frozen facts) are added permanently. Sealed items are excluded from drafter training forever."
    );
    if (!ok) return;
    setExamBusy(true);
    setError("");
    try {
      await adminFetch("/admin/agents/sealed-eval/seal", { method: "POST" });
      await refreshExam();
    } catch (err) {
      setError(err.message || "Failed to seal eval items.");
    } finally {
      setExamBusy(false);
    }
  }, [refreshExam]);

  const runExam = useCallback(async (providerLeg) => {
    const n = exam?.items?.active || 0;
    const ok = window.confirm(
      `Run the sealed exam on the ${LEG_LABELS[providerLeg] || providerLeg}?\n\nReplays all ${n} sealed items through the current drafter and judges each one — roughly ${n * 2}–${n * 5} AI calls. Takes several minutes; progress shows here.`
    );
    if (!ok) return;
    setExamBusy(true);
    setError("");
    try {
      await adminFetch("/admin/agents/sealed-eval/runs", {
        method: "POST",
        body: JSON.stringify({ providerLeg }),
      });
      await refreshExam();
    } catch (err) {
      setError(err.message || "Failed to start the exam run.");
    } finally {
      setExamBusy(false);
    }
  }, [exam, refreshExam]);

  const resumeExam = useCallback(async (run) => {
    setExamBusy(true);
    setError("");
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

  const reviewProposal = useCallback(async (proposal, action) => {
    if (action === "accept") {
      const ok = window.confirm(
        `Accept this patch proposal (${cellLabel(proposal.surface, proposal.failure_mode)})?\n\nThis records your go-ahead — the change itself still ships as a new prompt version you review as a PR. Nothing changes today.`
      );
      if (!ok) return;
    }
    setPathologyBusy(true);
    setError("");
    try {
      await adminFetch(`/admin/agents/pathology/proposals/${proposal.id}/review`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setPathology(await adminFetch("/admin/agents/pathology"));
    } catch (err) {
      setError(err.message || "Failed to review the patch proposal.");
    } finally {
      setPathologyBusy(false);
    }
  }, []);

  const toggleMode = useCallback(async (row) => {
    // Step shadow⇄suggest, or demote auto_send→suggest — always an explicit,
    // correctly-labeled action (never an accidental demote of an active
    // autonomous-send intent). Promotion into auto_send is eligibility-gated
    // and goes through the API, not this toggle.
    const nextMode = modeToggle(row.mode).next;
    setModeBusy(row.intent);
    setError("");
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

  const promoteToAutoSend = useCallback(async (row) => {
    // Enabling autonomous customer sends — confirm deliberately.
    const ok = window.confirm(
      `Enable AUTONOMOUS auto-send for "${intentLabel(row.intent)}"?\n\n` +
      `Verified house-voice drafts for this intent will be sent to customers automatically, with NO human review. ` +
      `The server re-checks readiness on every send, and escalation / scheduling messages never auto-send.` +
      (modes?.autoSendGateEnabled === false
        ? `\n\nNote: GATE_SMS_AUTO_SEND is currently OFF, so drafts keep going to the review queue until the gate is enabled.`
        : ``)
    );
    if (!ok) return;
    setModeBusy(row.intent);
    setError("");
    try {
      const updated = await adminFetch(`/admin/agents/intent-modes/${encodeURIComponent(row.intent)}`, {
        method: "PUT",
        body: JSON.stringify({ mode: "auto_send", reason: "Promoted to auto-send from the readiness chip." }),
      });
      setModes((current) => current
        ? { ...current, intents: current.intents.map((r) => (r.intent === updated.intent ? { ...r, ...updated, graduation: null } : r)) }
        : current);
      const fresh = await adminFetch("/admin/agents/intent-modes");
      setModes(fresh);
    } catch (err) {
      // The server 409s if eligibility slipped between render and click.
      setError(err.message || "Failed to enable auto-send.");
    } finally {
      setModeBusy("");
    }
  }, [modes]);

  const intents = useMemo(() => (scores?.intents || []).map((row) => row.intent), [scores]);
  const drafts = data?.drafts || [];

  return (
    <div style={{ minHeight: "100%", background: D.bg, color: D.text }}>
      <style>{`
        .shadow-drafts-wrap { padding: ${embedded ? "16px 24px 32px" : "0 24px 32px"}; display: grid; gap: 14px; }
        .shadow-scores-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
        .shadow-draft-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
        @media (max-width: 1180px) {
          .shadow-scores-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 900px) {
          .shadow-draft-grid { grid-template-columns: 1fr; }
        }
        @media (max-width: 720px) {
          .shadow-drafts-wrap { padding: ${embedded ? "14px 14px 96px" : "0 14px 96px"}; }
          .shadow-scores-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="shadow-drafts-wrap">
        {error && (
          <div style={{ background: "#FEE2E2", border: `1px solid ${D.red}`, color: D.red, borderRadius: 8, padding: 12, fontSize: 13, fontWeight: 750 }}>
            {error}
          </div>
        )}

        {(modes?.intents || []).length > 0 && (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 850, color: D.heading }}>Intent graduation</div>
              <div style={{ fontSize: 12, color: D.muted }}>
                Suggest surfaces the draft as an Agent Review card in the comms composer — a human still reads, edits, and sends.
              </div>
            </div>
            {modes.gateEnabled === false && (
              <div style={{ background: "#FEF3C7", border: `1px solid ${D.amber}`, color: D.amber, borderRadius: 8, padding: 10, fontSize: 12, fontWeight: 750 }}>
                GATE_SMS_SUGGEST_MODE is off — suggest flips are saved but take effect once the gate is enabled.
              </div>
            )}
            <div className="shadow-scores-grid">
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
          </div>
        )}

        <VoiceProfileSection profiles={profiles} busy={profileBusy} onReview={reviewProfile} />

        <SealedExamSection exam={exam} busy={examBusy} onSeal={sealItems} onRun={runExam} onResume={resumeExam} />

        {(scores?.intents || []).length > 0 && (
          <div className="shadow-scores-grid">
            {scores.intents.slice(0, 8).map((row) => (
              <IntentScoreCard key={row.intent} row={row} />
            ))}
          </div>
        )}

        <PathologySection data={pathology} busy={pathologyBusy} onReview={reviewProposal} />

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setIntentFilter("")}
            style={{
              minHeight: 30,
              borderRadius: 6,
              border: `1px solid ${intentFilter === "" ? D.heading : D.border}`,
              background: intentFilter === "" ? D.heading : D.card,
              color: intentFilter === "" ? "#fff" : D.text,
              fontSize: 12,
              fontWeight: 750,
              padding: "0 10px",
              cursor: "pointer",
            }}
          >
            All intents
          </button>
          {intents.map((intent) => (
            <button
              key={intent}
              type="button"
              onClick={() => setIntentFilter(intent === intentFilter ? "" : intent)}
              style={{
                minHeight: 30,
                borderRadius: 6,
                border: `1px solid ${intentFilter === intent ? D.heading : D.border}`,
                background: intentFilter === intent ? D.heading : D.card,
                color: intentFilter === intent ? "#fff" : D.text,
                fontSize: 12,
                fontWeight: 750,
                padding: "0 10px",
                cursor: "pointer",
              }}
            >
              {intentLabel(intent)}
            </button>
          ))}
        </div>

        {loading && !data ? (
          <div style={{ padding: 18, color: D.muted, fontSize: 13 }}>Loading shadow drafts...</div>
        ) : drafts.length ? (
          drafts.map((draft) => <DraftCard key={draft.id} draft={draft} />)
        ) : (
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 24, color: D.muted, fontSize: 13 }}>
            No shadow drafts yet. They appear as customers text the location numbers; the judge scores each one nightly at 3:55am ET once the 24-hour human-reply window closes.
          </div>
        )}
      </div>
    </div>
  );
}
