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
  locked: { bg: "#FEE2E2", fg: D.red, label: "Escalation — always shadow" },
};

// Phase E readiness: shows how close an intent is to its next ladder rung, or
// a green chip when it has earned it. Recommend-only — flips stay manual.
function GraduationNote({ g }) {
  const j = g.judge || {};
  const rungLabel = g.nextRung === "auto_send" ? "auto-send" : g.nextRung;
  const context = [];
  if (j.judged > 0) context.push(`${j.judged} live judged (${Math.round((j.unsafeRate || 0) * 100)}% unsafe)`);
  if (j.backfillJudged > 0) context.push(`${j.backfillJudged} backfill excluded`);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, borderTop: `1px dashed ${D.border}`, paddingTop: 8 }}>
      {g.eligibleFor === "suggest" && (
        <span style={{ background: "#DCFCE7", color: D.green, fontWeight: 800, borderRadius: 6, padding: "2px 8px" }}>✓ Ready — enable suggest</span>
      )}
      {g.eligibleFor === "auto_send" && (
        <span style={{ background: "#DBEAFE", color: "#1D4ED8", fontWeight: 800, borderRadius: 6, padding: "2px 8px" }}>✓ Send-ready — auto-send rung ships next</span>
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

function IntentModeCard({ row, busy, onToggle }) {
  const tone = row.locked ? MODE_TONES.locked : MODE_TONES[row.mode] || MODE_TONES.shadow;
  const s = row.suggest || {};
  const hasHistory = (s.suggested || 0) > 0;
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
              color: row.mode === "suggest" ? D.zinc : D.green,
              fontSize: 12,
              fontWeight: 750,
              padding: "0 10px",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {row.mode === "suggest" ? "Back to shadow" : "Enable suggest"}
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
      {row.updatedBy && row.updatedBy !== "migration" && (
        <div style={{ fontSize: 11, color: D.muted }}>
          Set by {row.updatedBy} · {timeLabel(row.updatedAt)}{row.reason ? ` · ${row.reason}` : ""}
        </div>
      )}
    </div>
  );
}

export default function AgentShadowDraftsPage({ embedded = false }) {
  const [data, setData] = useState(null);
  const [scores, setScores] = useState(null);
  const [modes, setModes] = useState(null);
  const [modeBusy, setModeBusy] = useState("");
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
    } catch (err) {
      setError(err.message || "Failed to load shadow drafts.");
    } finally {
      setLoading(false);
    }
  }, [intentFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleMode = useCallback(async (row) => {
    const nextMode = row.mode === "suggest" ? "shadow" : "suggest";
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
                <IntentModeCard key={row.intent} row={row} busy={modeBusy === row.intent} onToggle={toggleMode} />
              ))}
            </div>
          </div>
        )}

        {(scores?.intents || []).length > 0 && (
          <div className="shadow-scores-grid">
            {scores.intents.slice(0, 8).map((row) => (
              <IntentScoreCard key={row.intent} row={row} />
            ))}
          </div>
        )}

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
