/**
 * <PendingDraftsTab> — "Pending Drafts" tab inside /admin/agents.
 *
 * The owner-approval queue for message_drafts rows parked at
 * status='pending' (click follow-ups, campaign/upsell drafts, seasonal
 * reactivation, estimate clarify asks, legacy webhook drafts). The
 * approve/revise/reject API (/api/admin/drafts) has existed since the
 * lanes shipped — this is its first list surface; until now a pending
 * draft was reachable only through a ?draftId= deep link nothing
 * generated. Approving or revising SENDS the SMS through the full
 * messaging gate server-side; both actions confirm first. Mutations are
 * owner-only at the route (requireAdmin) — a 403 here means a
 * technician session.
 *
 * Tier 2 styling (inline + light D palette) to match the sibling
 * AgentShadowDraftsPage; the hub shell stays Tier 1.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// Lane = which pipeline parked the draft. campaign_type is authoritative
// when present; the webhook/reply drafter rows carry only an intent.
function laneOf(draft) {
  if (draft.campaignType) return draft.campaignType;
  if (draft.intent === "estimate_clarify") return "estimate_clarify";
  return "reply_draft";
}

const LANE_LABELS = {
  click_followup: "Click follow-up",
  upsell: "Upsell",
  seasonal_reactivation: "Seasonal",
  estimate_clarify: "Estimate clarify",
  reply_draft: "Reply draft",
};

function laneLabel(lane) {
  return LANE_LABELS[lane] || String(lane).replace(/_/g, " ");
}

// Deep link that keeps the composer on the draft's own thread: phone pins
// the recipient; the From comes from the composer's own draft fetch
// (resolvedFromNumber/-Label are server-config-resolved on GET /:id), so
// the link carries no number literal and the client's hardcoded list is
// never the authority.
function communicationsHref(draft) {
  const params = new URLSearchParams({ draftId: draft.id });
  const to = draft.recipientPhone || draft.customerPhone;
  if (to) params.set("phone", to);
  return `/admin/communications?${params.toString()}`;
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

function Chip({ children, bg, fg }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 22,
        padding: "0 8px",
        borderRadius: 6,
        background: bg || D.bg,
        color: fg || D.zinc,
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Bubble({ label, text, tone }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
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
        {text || <span style={{ color: D.muted }}>(none)</span>}
      </div>
    </div>
  );
}

function ActionButton({ children, onClick, disabled, tone }) {
  const palette = {
    primary: { bg: D.heading, fg: "#FFFFFF", border: D.heading },
    danger: { bg: "#FFFFFF", fg: D.red, border: "#FECACA" },
    neutral: { bg: "#FFFFFF", fg: D.text, border: D.border },
  }[tone || "neutral"];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: "7px 14px",
        fontSize: 14,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function DraftCard({ draft, busy, onApprove, onRevise, onReject }) {
  const [revising, setRevising] = useState(false);
  const [revisedText, setRevisedText] = useState("");
  const lane = laneOf(draft);
  const toPhone = draft.recipientPhone || draft.customerPhone;

  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>{draft.customerName || "Unknown customer"}</span>
        {toPhone && <span style={{ fontSize: 12, color: D.muted }}>{toPhone}</span>}
        <Chip>{laneLabel(lane)}</Chip>
        {draft.intent && lane === "reply_draft" && <Chip bg="#DBEAFE" fg={D.blue}>{String(draft.intent).replace(/_/g, " ")}</Chip>}
        <span style={{ marginLeft: "auto", fontSize: 12, color: D.muted }}>{timeLabel(draft.createdAt)}</span>
      </div>

      <div className="pending-draft-grid">
        {draft.inboundMessage && <Bubble label="Customer" text={draft.inboundMessage} />}
        <Bubble label="Draft to send" text={draft.draftResponse} tone="#F0F9FF" />
      </div>

      {draft.contextSummary && (
        <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.5 }}>{draft.contextSummary}</div>
      )}

      {revising ? (
        <div style={{ display: "grid", gap: 8 }}>
          <textarea
            value={revisedText}
            onChange={(e) => setRevisedText(e.target.value)}
            rows={4}
            style={{
              width: "100%",
              boxSizing: "border-box",
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 14,
              color: D.text,
              lineHeight: 1.45,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <ActionButton tone="primary" disabled={busy || !revisedText.trim()} onClick={() => onRevise(draft, revisedText.trim())}>
              Send revised
            </ActionButton>
            <ActionButton disabled={busy} onClick={() => { setRevising(false); setRevisedText(""); }}>
              Cancel
            </ActionButton>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <ActionButton tone="primary" disabled={busy} onClick={() => onApprove(draft)}>
            Approve &amp; send
          </ActionButton>
          <ActionButton disabled={busy} onClick={() => { setRevising(true); setRevisedText(draft.draftResponse || ""); }}>
            Revise
          </ActionButton>
          <ActionButton tone="danger" disabled={busy} onClick={() => onReject(draft)}>
            Reject
          </ActionButton>
          <a
            href={communicationsHref(draft)}
            style={{ marginLeft: "auto", fontSize: 13, color: D.blue, textDecoration: "none" }}
          >
            Open in Communications
          </a>
        </div>
      )}
    </div>
  );
}

export default function PendingDraftsTab({ embedded = false }) {
  const [drafts, setDrafts] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [laneFilter, setLaneFilter] = useState("all");
  // Monotonic load sequence: a mutation bumps it, and a GET that started
  // before the bump throws its response away — otherwise a Refresh in
  // flight across an approve could resolve late and restore the actioned
  // card (already sent/rejected) to the list.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch("/admin/drafts?status=pending");
      if (seq !== loadSeq.current) return; // superseded by a mutation
      setDrafts(Array.isArray(data?.drafts) ? data.drafts : []);
      setPendingCount(Number(data?.pendingCount) || 0);
      setNextCursor(data?.nextCursor || null);
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message || "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, []);

  // The API pages newest-first, 50 at a time, by a server-issued
  // (created_at, id) cursor — a client-derived offset would shift under
  // concurrent inserts/approvals and could loop on duplicates forever.
  // Without paging, older drafts past the first page silently starve.
  const loadOlder = useCallback(async () => {
    if (!nextCursor) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    try {
      const data = await adminFetch(`/admin/drafts?status=pending&before=${encodeURIComponent(nextCursor)}`);
      if (seq !== loadSeq.current) return; // superseded by a mutation
      const older = Array.isArray(data?.drafts) ? data.drafts : [];
      setPendingCount(Number(data?.pendingCount) || 0);
      setNextCursor(data?.nextCursor || null);
      setDrafts((current) => {
        const seen = new Set(current.map((d) => d.id));
        return [...current, ...older.filter((d) => !seen.has(d.id))];
      });
    } catch (err) {
      setNotice({ tone: "err", text: err.message || "Failed to load older drafts" });
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor]);

  useEffect(() => {
    load();
  }, [load]);

  const lanes = useMemo(() => {
    const seen = new Map();
    for (const d of drafts) {
      const lane = laneOf(d);
      seen.set(lane, (seen.get(lane) || 0) + 1);
    }
    return [...seen.entries()];
  }, [drafts]);

  // A filtered lane whose last draft was just actioned would otherwise
  // strand the tab on an empty view (the chips row hides itself when only
  // one lane remains) — a vanished selection falls back to All.
  const effectiveFilter = laneFilter !== "all" && !lanes.some(([lane]) => lane === laneFilter)
    ? "all"
    : laneFilter;
  const visible = effectiveFilter === "all" ? drafts : drafts.filter((d) => laneOf(d) === effectiveFilter);

  // 409 = another session (or an auto-send race) already actioned the
  // draft; 422 = a campaign gate retired the row as terminally ineligible.
  // Both mean the card no longer reflects reality — reload the live queue.
  // 503 = the pre-send gate was unreachable and the draft was left
  // pending; the card stays for a retry.
  const runAction = useCallback(async (draft, label, fn) => {
    loadSeq.current += 1; // invalidate any in-flight list read
    setBusyId(draft.id);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: "ok", text: `${label} — ${draft.customerName || "draft"}` });
      setDrafts((current) => current.filter((d) => d.id !== draft.id));
      setPendingCount((n) => Math.max(0, n - 1));
    } catch (err) {
      setNotice({ tone: "err", text: err.message || `${label} failed` });
      if (err.status === 409 || err.status === 422) load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const approve = useCallback((draft) => {
    const to = draft.recipientPhone || draft.customerPhone || "the customer";
    // Clarify drafts may be narrowed at dispatch: if the customer already
    // answered some questions, the lane's deterministic composer trims the
    // copy to what's STILL missing before sending (designed behavior —
    // estimate-clarify-asks.js claimClarifyDispatch).
    const ok = window.confirm(draft.intent === "estimate_clarify"
      ? `Send this clarify ask to ${to}? If the customer already answered part of it, only the still-missing questions are sent.`
      : `Send this draft to ${to} as-is?`);
    if (!ok) return;
    runAction(draft, "Sent", () => adminFetch(`/admin/drafts/${encodeURIComponent(draft.id)}/approve`, { method: "PUT" }));
  }, [runAction]);

  const revise = useCallback((draft, revisedResponse) => {
    const to = draft.recipientPhone || draft.customerPhone || "the customer";
    const ok = window.confirm(`Send the revised text to ${to}?`);
    if (!ok) return;
    runAction(draft, "Sent (revised)", () => adminFetch(`/admin/drafts/${encodeURIComponent(draft.id)}/revise`, {
      method: "PUT",
      body: JSON.stringify({ revisedResponse }),
    }));
  }, [runAction]);

  const reject = useCallback((draft) => {
    const ok = window.confirm("Reject this draft? Nothing is sent.");
    if (!ok) return;
    runAction(draft, "Rejected", () => adminFetch(`/admin/drafts/${encodeURIComponent(draft.id)}/reject`, { method: "PUT" }));
  }, [runAction]);

  return (
    <div className="pending-drafts-wrap">
      <style>{`
        .pending-drafts-wrap { padding: ${embedded ? "16px 24px 32px" : "0 24px 32px"}; display: grid; gap: 14px; align-content: start; }
        .pending-draft-grid { display: grid; gap: 10px; grid-template-columns: 1fr; }
        @media (min-width: 900px) { .pending-draft-grid { grid-template-columns: 1fr 1fr; } }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
          {loading ? "Loading pending drafts" : `${pendingCount} pending draft${pendingCount === 1 ? "" : "s"}`}
          {!loading && drafts.length < pendingCount && (
            <span style={{ fontWeight: 500, color: D.muted }}> (showing {drafts.length})</span>
          )}
        </span>
        {lanes.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginLeft: 8 }}>
            <button type="button" onClick={() => setLaneFilter("all")} style={{ background: effectiveFilter === "all" ? D.heading : "#FFFFFF", color: effectiveFilter === "all" ? "#FFFFFF" : D.text, border: `1px solid ${D.border}`, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              All
            </button>
            {lanes.map(([lane, count]) => (
              <button key={lane} type="button" onClick={() => setLaneFilter(lane)} style={{ background: effectiveFilter === lane ? D.heading : "#FFFFFF", color: effectiveFilter === lane ? "#FFFFFF" : D.text, border: `1px solid ${D.border}`, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                {laneLabel(lane)} {count}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={load}
          disabled={loading || busyId !== null}
          style={{ marginLeft: "auto", background: "#FFFFFF", color: D.text, border: `1px solid ${D.border}`, borderRadius: 8, padding: "5px 12px", fontSize: 13, fontWeight: 500, cursor: loading ? "default" : "pointer" }}
        >
          Refresh
        </button>
      </div>

      {notice && (
        <div style={{ fontSize: 14, color: notice.tone === "ok" ? D.green : D.red }}>{notice.text}</div>
      )}
      {error && <div style={{ fontSize: 14, color: D.red }}>{error}</div>}

      {!loading && !error && visible.length === 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 24, fontSize: 14, color: D.muted }}>
          No pending drafts. Parked drafts from the click follow-up, campaign, seasonal, and estimate-clarify lanes land here for approval.
        </div>
      )}

      {visible.map((draft) => (
        <DraftCard
          // draftResponse participates in the key: a server-side clarify
          // rewrite (409 -> reload) must REMOUNT the card so stale
          // revising/revisedText state can't send the old multi-question
          // copy against the narrowed missing set.
          key={`${draft.id}:${draft.draftResponse || ""}`}
          draft={draft}
          busy={busyId === draft.id || loading || loadingMore}
          onApprove={approve}
          onRevise={revise}
          onReject={reject}
        />
      ))}

      {!loading && nextCursor && (
        <button
          type="button"
          onClick={loadOlder}
          disabled={loadingMore || busyId !== null}
          style={{ justifySelf: "start", background: "#FFFFFF", color: D.text, border: `1px solid ${D.border}`, borderRadius: 8, padding: "7px 14px", fontSize: 14, fontWeight: 500, cursor: loadingMore ? "default" : "pointer" }}
        >
          {loadingMore ? "Loading older drafts" : "Load older drafts"}
        </button>
      )}
    </div>
  );
}
