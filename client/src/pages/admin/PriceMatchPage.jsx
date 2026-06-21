import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Send, XCircle, RotateCcw, ChevronRight, ExternalLink, AlertTriangle, Search, Play } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { adminFetch } from "../../utils/admin-fetch";

// Light neutral palette — mirrors the read-only operator pages (AutoDispatchPage,
// AgentDecisionsPage). Admin stays monochrome; the one accent here is the send CTA.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  heading: "#09090B",
  text: "#27272A",
  muted: "#71717A",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  blue: "#1D4ED8",
};

const STATUS_TONE = {
  pending: "blue",
  sending: "amber",
  sent: "green",
  dismissed: "neutral",
};

// status query -> human label. 'active' = pending + sending (a stuck send stays visible).
const FILTERS = [
  { key: "active", label: "Active" },
  { key: "sent", label: "Sent" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

function Chip({ children, tone = "neutral" }) {
  const colors = {
    green: { bg: "#DCFCE7", fg: D.green },
    amber: { bg: "#FEF3C7", fg: D.amber },
    red: { bg: "#FEE2E2", fg: D.red },
    blue: { bg: "#DBEAFE", fg: D.blue },
    neutral: { bg: D.bg, fg: D.text },
  }[tone] || { bg: D.bg, fg: D.text };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", minHeight: 22, padding: "0 8px",
      borderRadius: 6, background: colors.bg, color: colors.fg, fontSize: 12,
      fontWeight: 700, whiteSpace: "nowrap", textTransform: "capitalize",
    }}>
      {children}
    </span>
  );
}

function fmt(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return String(ts); }
}

// Defensive parse — the column is jsonb (returns an array), but tolerate a string.
function parseMatches(m) {
  if (Array.isArray(m)) return m;
  if (typeof m === "string") { try { return JSON.parse(m); } catch { return []; } }
  return [];
}

export default function PriceMatchPage() {
  const [filter, setFilter] = useState("active");
  const [recipient, setRecipient] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [busy, setBusy] = useState(false); // an action (send/dismiss/reset) is in flight
  const [confirmSend, setConfirmSend] = useState(false);
  const [scanning, setScanning] = useState(false); // a manual scan trigger is in flight

  // Always-current selection, so an in-flight refresh can't clobber the pane after
  // the operator has moved on to a different draft.
  const selectedIdRef = useRef(null);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // Monotonic load id — a slow earlier request (e.g. operator switched tabs) must
  // not overwrite the list with the wrong filter's results when it lands last.
  const loadSeqRef = useRef(0);

  const loadDrafts = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch(`/admin/price-match/drafts?status=${filter}`);
      if (seq !== loadSeqRef.current) return; // superseded by a newer load
      setDrafts((data && data.drafts) || []);
      setRecipient((data && data.recipient) || null);
    } catch (err) {
      if (seq === loadSeqRef.current) setError(err.message || "Failed to load drafts");
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // Load the selected draft's full body whenever the selection changes.
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let active = true;
    setDetailLoading(true);
    setConfirmSend(false);
    adminFetch(`/admin/price-match/drafts/${selectedId}`)
      .then((d) => { if (active) setDetail((d && d.draft) || null); })
      .catch(() => { if (active) setDetail(null); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId]);

  const refreshDetail = useCallback(async (id) => {
    try {
      const d = await adminFetch(`/admin/price-match/drafts/${id}`);
      // Only apply if this draft is STILL selected — the operator may have clicked
      // another draft while the action/refresh was in flight (would otherwise show
      // and let them act on the wrong draft).
      if (selectedIdRef.current === id) setDetail((d && d.draft) || null);
    } catch { /* leave existing detail */ }
  }, []);

  // send | dismiss | reset. The send target is an external rep, so send is two-step.
  const act = useCallback(async (id, action) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminFetch(`/admin/price-match/drafts/${id}/${action}`, { method: "POST" });
      // Resync FIRST, then set the message LAST — loadDrafts() runs setError(null)
      // at its start, so any message set before it would be wiped before the
      // operator sees it.
      await loadDrafts();
      await refreshDetail(id);
      if (action === "send") {
        setNotice(res && res.reconcile
          ? "Email sent, but its status couldn't be recorded automatically — verify in SendGrid before any resend."
          : `Price-match request sent to ${recipient || "the rep"}.`);
      } else if (action === "dismiss") {
        setNotice("Draft dismissed.");
      } else if (action === "reset") {
        setNotice("Draft reset to pending for re-review.");
      }
    } catch (err) {
      // ACTIONABLE send failures (config/recipient) — the email did NOT go out and
      // the draft is still actionable; show the real problem instead of hiding it as
      // a stale race, or the operator just keeps clicking Send into the same failure.
      const actionable = action === "send" && (err.code === "not_configured" || err.code === "rejected" || err.code === "send_attempt_unrecorded");
      // Resync FIRST (the backend may have advanced the draft, e.g. pending ->
      // sending), THEN set the message LAST so loadDrafts()'s setError(null) can't
      // wipe an actionable failure explanation before the operator reads it.
      await loadDrafts();
      await refreshDetail(id);
      if (actionable) {
        setError(err.message || "The email could not be sent.");
      } else if (err.status === 409) {
        // Benign state race (already sent/sending, claim lost, or not stale enough
        // to reset/dismiss) — resynced above; just note it.
        setNotice("That draft already changed state — showing the latest.");
      } else {
        // Ambiguous failure (e.g. a transport error left the backend holding the
        // draft in 'sending'); surface it (resynced above so the pane reflects it).
        setError(err.message || `Could not ${action} the draft`);
      }
    } finally {
      setBusy(false);
      setConfirmSend(false);
    }
  }, [recipient, loadDrafts, refreshDetail]);

  // Manually trigger the weekly scan to validate it before the cron is enabled.
  // 'select' = fast preview of which products would be scanned; 'run' = full live
  // scan + draft, which runs in the background (poll/refresh for the new draft).
  const triggerScan = useCallback(async (mode) => {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminFetch(`/admin/price-match/scan`, { method: "POST", body: JSON.stringify({ mode }) });
      if (mode === "select") {
        const names = (res && res.products) || [];
        const preview = names.length ? ` — ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}` : "";
        setNotice(`Selection preview: ${(res && res.evaluated) || 0} product${res && res.evaluated === 1 ? "" : "s"} would be scanned${preview}.`);
      } else {
        setNotice("Scan started — it runs in the background; refresh in a few minutes to see any new draft.");
      }
    } catch (err) {
      setError(err.message || "Could not start the scan");
    } finally {
      setScanning(false);
    }
  }, []);

  const matches = detail ? parseMatches(detail.matches) : [];
  const proofRows = matches.filter((m) => m && m.competitor && m.competitor.source_url);

  // The backend protects a fresh claim: reset/dismiss only act once claimed_at is
  // older than the stale window (server STALE_CLAIM_MS). Gate the recovery controls
  // on the same window so a fresh 'sending' row shows a wait state instead of a
  // button that just 409s. (Recomputed each render; Refresh re-evaluates.)
  const STALE_CLAIM_MS = 10 * 60 * 1000;
  const claimedAtMs = detail && detail.claimed_at ? new Date(detail.claimed_at).getTime() : null;
  const staleElapsed = !claimedAtMs || Number.isNaN(claimedAtMs) ? true : (Date.now() - claimedAtMs) >= STALE_CLAIM_MS;
  const staleInMin = !claimedAtMs || Number.isNaN(claimedAtMs) ? 0 : Math.max(1, Math.ceil((STALE_CLAIM_MS - (Date.now() - claimedAtMs)) / 60000));

  return (
    <div style={{ background: D.bg, minHeight: "100%", padding: 16 }}>
      <AdminCommandHeader
        title="Price Match"
        actions={[
          { key: "refresh", label: "Refresh", size: "sm", variant: "ghost", icon: RefreshCw, onClick: loadDrafts },
          { key: "preview", label: "Preview scan", size: "sm", variant: "ghost", icon: Search, disabled: scanning, onClick: () => triggerScan("select") },
          { key: "run", label: scanning ? "Starting…" : "Run scan", size: "sm", icon: Play, disabled: scanning, onClick: () => triggerScan("run") },
        ]}
      />

      <p style={{ color: D.muted, fontSize: 13, margin: "8px 2px 14px", maxWidth: 720 }}>
        Vendor price-match request drafts for {recipient ? <strong>{recipient}</strong> : "the SiteOne rep"}. The weekly
        scan stages a draft when a competitor's published per-unit price beats our SiteOne price, with a proof link for
        each line. Nothing is emailed until you review and click send.
      </p>

      {/* Status filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => { setFilter(f.key); setSelectedId(null); }}
            style={{
              padding: "5px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${filter === f.key ? D.blue : D.border}`,
              background: filter === f.key ? "#EFF6FF" : D.card,
              color: filter === f.key ? D.blue : D.text,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: "#FEE2E2", color: D.red, padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: "#ECFDF5", color: D.green, padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} style={{ border: "none", background: "transparent", color: D.green, cursor: "pointer", fontWeight: 700 }}>✕</button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 1fr) minmax(380px, 1.5fr)", gap: 16, alignItems: "start" }}>
        {/* Drafts list */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}`, fontWeight: 700, color: D.heading, fontSize: 13 }}>
            Drafts
          </div>
          {loading ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>Loading…</div>
          ) : drafts.length === 0 ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>No drafts in this view.</div>
          ) : drafts.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelectedId(d.id)}
              style={{
                width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderBottom: `1px solid ${D.border}`,
                background: selectedId === d.id ? D.bg : D.card, cursor: "pointer", border: "none",
                borderLeft: selectedId === d.id ? `3px solid ${D.blue}` : "3px solid transparent",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <Chip tone={STATUS_TONE[d.status] || "neutral"}>{d.status}</Chip>
                  <span style={{ color: D.muted, fontSize: 12 }}>{d.included_count} item{d.included_count === 1 ? "" : "s"}</span>
                </div>
                <div style={{ color: D.text, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.subject}
                </div>
                <div style={{ color: D.muted, fontSize: 12, marginTop: 2 }}>
                  {d.status === "sent" ? `Sent ${fmt(d.sent_at)}` : `Created ${fmt(d.created_at)}`}
                </div>
              </div>
              <ChevronRight size={16} color={D.muted} />
            </button>
          ))}
        </div>

        {/* Draft detail */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}`, fontWeight: 700, color: D.heading, fontSize: 13 }}>
            Review
          </div>
          {!selectedId ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>Select a draft to review what will be sent.</div>
          ) : detailLoading ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>Loading…</div>
          ) : !detail ? (
            <div style={{ padding: 24, color: D.muted, fontSize: 13 }}>Couldn't load this draft.</div>
          ) : (
            <div style={{ padding: 14 }}>
              {/* Meta */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <Chip tone={STATUS_TONE[detail.status] || "neutral"}>{detail.status}</Chip>
                <span style={{ color: D.muted, fontSize: 12 }}>
                  To {detail.recipient} · {detail.included_count} item{detail.included_count === 1 ? "" : "s"} ·{" "}
                  {detail.status === "sent" ? `sent ${fmt(detail.sent_at)}` : `created ${fmt(detail.created_at)}`}
                  {detail.sent_by ? ` by ${detail.sent_by}` : ""}
                </span>
              </div>
              <div style={{ color: D.heading, fontSize: 14, fontWeight: 700, marginBottom: 12 }}>{detail.subject}</div>

              {/* Action bar */}
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                {detail.status === "pending" && !confirmSend && (
                  <>
                    <ActionButton tone="primary" icon={Send} disabled={busy} onClick={() => setConfirmSend(true)}>Send to rep…</ActionButton>
                    <ActionButton tone="ghost" icon={XCircle} disabled={busy} onClick={() => act(detail.id, "dismiss")}>Dismiss</ActionButton>
                  </>
                )}
                {detail.status === "pending" && confirmSend && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ color: D.text, fontSize: 13, fontWeight: 600 }}>Email this price-match request to {detail.recipient}?</span>
                    <ActionButton tone="primary" icon={Send} disabled={busy} onClick={() => act(detail.id, "send")}>{busy ? "Sending…" : "Confirm send"}</ActionButton>
                    <ActionButton tone="ghost" disabled={busy} onClick={() => setConfirmSend(false)}>Cancel</ActionButton>
                  </div>
                )}
                {detail.status === "sending" && !detail.send_attempted_at && (
                  <>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: D.amber, fontSize: 13, fontWeight: 600 }}>
                      <AlertTriangle size={15} /> Claimed but the send wasn't attempted{staleElapsed ? " — if it's stuck, reset to re-review." : ` — a send may be in progress. Reset becomes available in ~${staleInMin}m.`}
                    </span>
                    {staleElapsed && (
                      <ActionButton tone="ghost" icon={RotateCcw} disabled={busy} onClick={() => act(detail.id, "reset")}>Reset</ActionButton>
                    )}
                  </>
                )}
                {detail.status === "sending" && detail.send_attempted_at && (
                  <>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: D.red, fontSize: 13, fontWeight: 600 }}>
                      <AlertTriangle size={15} /> A send was attempted — it may already have reached {detail.recipient}. Verify in SendGrid before acting; if it went out, dismiss it (never resend).{staleElapsed ? "" : ` Dismiss becomes available in ~${staleInMin}m.`}
                    </span>
                    {staleElapsed && (
                      <ActionButton tone="ghost" icon={XCircle} disabled={busy} onClick={() => act(detail.id, "dismiss")}>Dismiss</ActionButton>
                    )}
                  </>
                )}
                {detail.status === "sent" && (
                  <span style={{ color: D.green, fontSize: 13, fontWeight: 600 }}>
                    Sent{detail.message_id ? ` · ${detail.message_id}` : ""}
                  </span>
                )}
                {detail.status === "dismissed" && (
                  <span style={{ color: D.muted, fontSize: 13 }}>Dismissed — not sent.</span>
                )}
              </div>

              {/* Proof links (clickable, open in a new tab) */}
              {proofRows.length > 0 && (
                <div style={{ border: `1px solid ${D.border}`, borderRadius: 10, marginBottom: 14, overflow: "hidden" }}>
                  <div style={{ padding: "8px 12px", borderBottom: `1px solid ${D.border}`, fontSize: 12, fontWeight: 700, color: D.heading }}>
                    Proof links
                  </div>
                  {proofRows.map((m, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px", borderBottom: i < proofRows.length - 1 ? `1px solid ${D.border}` : "none" }}>
                      <span style={{ color: D.text, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.product || (m.competitor && m.competitor.name) || "Item"}
                        {m.competitor && m.competitor.vendor ? <span style={{ color: D.muted }}> · {m.competitor.vendor}</span> : null}
                      </span>
                      <a href={m.competitor.source_url} target="_blank" rel="noopener noreferrer"
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, color: D.blue, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
                        View listing <ExternalLink size={13} />
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {/* Exact email preview (sandboxed — no scripts, no navigation) */}
              <div style={{ fontSize: 12, fontWeight: 700, color: D.heading, marginBottom: 6 }}>Email preview</div>
              <iframe
                title="Price-match email preview"
                srcDoc={detail.html}
                sandbox=""
                style={{ width: "100%", height: 560, border: `1px solid ${D.border}`, borderRadius: 10, background: "#fff" }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({ children, onClick, disabled, icon: Icon, tone = "ghost" }) {
  const styles = tone === "primary"
    ? { background: disabled ? "#93C5FD" : D.blue, color: "#fff", border: "none" }
    : { background: D.card, color: D.text, border: `1px solid ${D.border}` };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8,
        fontSize: 13, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", ...styles,
      }}
    >
      {Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}
