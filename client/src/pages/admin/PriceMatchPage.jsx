import { useCallback, useEffect, useRef, useState } from "react";
import {
  Tag,
  RefreshCw,
  Send,
  XCircle,
  RotateCcw,
  ChevronRight,
  ExternalLink,
  AlertTriangle,
  Search,
  Play,
  X,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  UiSurface,
  Button,
  Badge,
  Card,
  CardHeader,
  CardBody,
  ActionFeedback,
  buttonStyles,
  cn,
} from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

// status query -> human label. 'active' = pending + sending (a stuck send stays visible).
const FILTERS = [
  { key: "active", label: "Active" },
  { key: "sent", label: "Sent" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

function fmt(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

// Defensive parse — the column is jsonb (returns an array), but tolerate a string.
function parseMatches(m) {
  if (Array.isArray(m)) return m;
  if (typeof m === "string") {
    try {
      return JSON.parse(m);
    } catch {
      return [];
    }
  }
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
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

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
      if (seq === loadSeqRef.current)
        setError(err.message || "Failed to load drafts");
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  // Load the selected draft's full body whenever the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setConfirmSend(false);
    adminFetch(`/admin/price-match/drafts/${selectedId}`)
      .then((d) => {
        if (active) setDetail((d && d.draft) || null);
      })
      .catch(() => {
        if (active) setDetail(null);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const refreshDetail = useCallback(async (id) => {
    try {
      const d = await adminFetch(`/admin/price-match/drafts/${id}`);
      // Only apply if this draft is STILL selected — the operator may have clicked
      // another draft while the action/refresh was in flight (would otherwise show
      // and let them act on the wrong draft).
      if (selectedIdRef.current === id) setDetail((d && d.draft) || null);
    } catch {
      /* leave existing detail */
    }
  }, []);

  // send | dismiss | reset. The send target is an external rep, so send is two-step.
  const act = useCallback(
    async (id, action) => {
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
          setNotice(
            res && res.reconcile
              ? "Email sent, but its status couldn't be recorded automatically — verify in SendGrid before any resend."
              : `Price-match request sent to ${recipient || "the rep"}.`,
          );
        } else if (action === "dismiss") {
          setNotice("Draft dismissed.");
        } else if (action === "reset") {
          setNotice("Draft reset to pending for re-review.");
        }
      } catch (err) {
        // ACTIONABLE send failures (config/recipient) — the email did NOT go out and
        // the draft is still actionable; show the real problem instead of hiding it as
        // a stale race, or the operator just keeps clicking Send into the same failure.
        const actionable =
          action === "send" &&
          (err.code === "not_configured" ||
            err.code === "rejected" ||
            err.code === "send_attempt_unrecorded");
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
    },
    [recipient, loadDrafts, refreshDetail],
  );

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
        const vendorList = (res && res.vendors) || [];
        const preview = names.length
          ? ` — ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}`
          : "";
        const across = vendorList.length
          ? ` across ${vendorList.join(", ")}`
          : "";
        setNotice(
          `Selection preview: ${(res && res.evaluated) || 0} product${res && res.evaluated === 1 ? "" : "s"} would be scanned${across}${preview}.`,
        );
      } else {
        setNotice(
          "Scan started — it runs in the background; refresh in a few minutes to see any new draft.",
        );
      }
    } catch (err) {
      setError(err.message || "Could not start the scan");
    } finally {
      setScanning(false);
    }
  }, []);

  const matches = detail ? parseMatches(detail.matches) : [];
  const proofRows = matches.filter(
    (m) => m && m.competitor && m.competitor.source_url,
  );

  // The backend protects a fresh claim: reset/dismiss only act once claimed_at is
  // older than the stale window (server STALE_CLAIM_MS). Gate the recovery controls
  // on the same window so a fresh 'sending' row shows a wait state instead of a
  // button that just 409s. (Recomputed each render; Refresh re-evaluates.)
  const STALE_CLAIM_MS = 10 * 60 * 1000;
  const claimedAtMs =
    detail && detail.claimed_at ? new Date(detail.claimed_at).getTime() : null;
  const staleElapsed =
    !claimedAtMs || Number.isNaN(claimedAtMs)
      ? true
      : Date.now() - claimedAtMs >= STALE_CLAIM_MS;
  const staleInMin =
    !claimedAtMs || Number.isNaN(claimedAtMs)
      ? 0
      : Math.max(
          1,
          Math.ceil((STALE_CLAIM_MS - (Date.now() - claimedAtMs)) / 60000),
        );

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader
        variant="workspace"
        title="Price match"
        icon={Tag}
        actions={[
          {
            key: "refresh",
            label: "Refresh",
            variant: "ghost",
            icon: RefreshCw,
            onClick: loadDrafts,
          },
          {
            key: "preview",
            label: "Preview scan",
            variant: "ghost",
            icon: Search,
            disabled: scanning,
            onClick: () => triggerScan("select"),
          },
          {
            key: "run",
            label: scanning ? "Starting…" : "Run scan",
            icon: Play,
            disabled: scanning,
            onClick: () => triggerScan("run"),
          },
        ]}
      />
      <p className="mb-5 max-w-[720px] text-ui-body text-ink-secondary">
        Vendor price-match request drafts for{" "}
        {recipient ? (
          <strong className="font-medium">{recipient}</strong>
        ) : (
          "the SiteOne rep"
        )}
        . The weekly scan stages a draft when a competitor's published per-unit
        price beats our SiteOne price, with a proof link for each line. Nothing
        is emailed until you review and click send.
      </p>
      <div
        className="mb-5 flex flex-wrap gap-2"
        role="group"
        aria-label="Draft status"
      >
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            variant={filter === f.key ? "primary" : "secondary"}
            aria-pressed={filter === f.key}
            onClick={() => {
              setFilter(f.key);
              setSelectedId(null);
            }}
          >
            {f.label}
          </Button>
        ))}
      </div>
      {error && (
        <ActionFeedback error className="mb-4">
          {error}
        </ActionFeedback>
      )}
      {notice && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <ActionFeedback>{notice}</ActionFeedback>
          <Button
            variant="ghost"
            aria-label="Dismiss notice"
            onClick={() => setNotice(null)}
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
      )}
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <h2 className="text-ui-body font-medium">Drafts</h2>
          </CardHeader>
          {loading ? (
            <CardBody>
              <p role="status" className="text-ui-body text-ink-secondary">
                Loading…
              </p>
            </CardBody>
          ) : drafts.length === 0 ? (
            <CardBody>
              <p className="text-ui-body text-ink-secondary">
                No drafts in this view.
              </p>
            </CardBody>
          ) : (
            drafts.map((d) => (
              <Button
                key={d.id}
                variant="ghost"
                aria-pressed={selectedId === d.id}
                onClick={() => setSelectedId(d.id)}
                className={cn(
                  "h-auto w-full justify-start whitespace-normal rounded-none border-b border-l-2 border-hairline border-zinc-200 p-4 text-left",
                  selectedId === d.id
                    ? "border-l-zinc-900 bg-zinc-100"
                    : "border-l-transparent",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone={d.status === "sending" ? "strong" : "neutral"}>
                      {d.status}
                    </Badge>
                    <span className="text-ui-caption font-normal text-ink-secondary u-nums">
                      {d.included_count} item{d.included_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="break-words text-ui-body font-medium text-ink-primary">
                    {d.subject}
                  </div>
                  <div className="mt-1 text-ui-caption font-normal text-ink-secondary u-nums">
                    {d.status === "sent"
                      ? `Sent ${fmt(d.sent_at)}`
                      : `Created ${fmt(d.created_at)}`}
                  </div>
                </div>
                <ChevronRight
                  size={18}
                  aria-hidden="true"
                  className="shrink-0 text-ink-secondary"
                />
              </Button>
            ))
          )}
        </Card>
        <Card className="min-w-0 overflow-hidden" aria-label="Draft review">
          <CardHeader>
            <h2 className="text-ui-body font-medium">Review</h2>
          </CardHeader>
          {!selectedId ? (
            <CardBody>
              <p className="text-ui-body text-ink-secondary">
                Select a draft to review what will be sent.
              </p>
            </CardBody>
          ) : detailLoading ? (
            <CardBody>
              <p role="status" className="text-ui-body text-ink-secondary">
                Loading…
              </p>
            </CardBody>
          ) : !detail ? (
            <CardBody>
              <p className="text-ui-body text-ink-secondary">
                Couldn't load this draft.
              </p>
            </CardBody>
          ) : (
            <CardBody>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge
                  tone={detail.status === "sending" ? "strong" : "neutral"}
                >
                  {detail.status}
                </Badge>
                <span className="break-words text-ui-caption text-ink-secondary u-nums">
                  To {detail.recipient} · {detail.included_count} item
                  {detail.included_count === 1 ? "" : "s"} ·{" "}
                  {detail.status === "sent"
                    ? `sent ${fmt(detail.sent_at)}`
                    : `created ${fmt(detail.created_at)}`}
                  {detail.sent_by ? ` by ${detail.sent_by}` : ""}
                </span>
              </div>
              <h3 className="mb-3 break-words text-ui-body font-medium">
                {detail.subject}
              </h3>
              <div className="ui-record-actions mb-4">
                {detail.status === "pending" && !confirmSend && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() => setConfirmSend(true)}
                    >
                      <Send size={16} aria-hidden="true" />
                      Send to rep…
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => act(detail.id, "dismiss")}
                    >
                      <XCircle size={16} aria-hidden="true" />
                      Dismiss
                    </Button>
                  </>
                )}
                {detail.status === "pending" && confirmSend && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="basis-full break-words text-ui-body font-medium">
                      Email this price-match request to {detail.recipient}?
                    </span>
                    <Button
                      disabled={busy}
                      onClick={() => act(detail.id, "send")}
                    >
                      <Send size={16} aria-hidden="true" />
                      {busy ? "Sending…" : "Confirm send"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmSend(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
                {detail.status === "sending" && !detail.send_attempted_at && (
                  <>
                    <span className="flex items-start gap-2 text-ui-body font-medium text-alert-fg">
                      <AlertTriangle
                        size={18}
                        aria-hidden="true"
                        className="shrink-0"
                      />{" "}
                      Claimed but the send wasn't attempted
                      {staleElapsed
                        ? " — if it's stuck, reset to re-review."
                        : ` — a send may be in progress. Reset becomes available in ~${staleInMin}m.`}
                    </span>
                    {staleElapsed && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => act(detail.id, "reset")}
                      >
                        <RotateCcw size={16} aria-hidden="true" />
                        Reset
                      </Button>
                    )}
                  </>
                )}
                {detail.status === "sending" && detail.send_attempted_at && (
                  <>
                    <span className="flex items-start gap-2 text-ui-body font-medium text-alert-fg">
                      <AlertTriangle
                        size={18}
                        aria-hidden="true"
                        className="shrink-0"
                      />{" "}
                      A send was attempted — it may already have reached{" "}
                      {detail.recipient}. Verify in SendGrid before acting; if
                      it went out, dismiss it (never resend).
                      {staleElapsed
                        ? ""
                        : ` Dismiss becomes available in ~${staleInMin}m.`}
                    </span>
                    {staleElapsed && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => act(detail.id, "dismiss")}
                      >
                        <XCircle size={16} aria-hidden="true" />
                        Dismiss
                      </Button>
                    )}
                  </>
                )}
                {detail.status === "sent" && (
                  <span className="break-all text-ui-body font-medium">
                    Sent{detail.message_id ? ` · ${detail.message_id}` : ""}
                  </span>
                )}
                {detail.status === "dismissed" && (
                  <span className="text-ui-body text-ink-secondary">
                    Dismissed — not sent.
                  </span>
                )}
              </div>
              {proofRows.length > 0 && (
                <Card className="mb-4 overflow-hidden">
                  <CardHeader>
                    <h4 className="text-ui-body font-medium">Proof links</h4>
                  </CardHeader>
                  {proofRows.map((m, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline border-zinc-200 p-3 last:border-b-0"
                    >
                      <span className="min-w-0 break-words text-ui-body">
                        {m.product ||
                          (m.competitor && m.competitor.name) ||
                          "Item"}
                        {m.competitor && m.competitor.vendor ? (
                          <span className="text-ink-secondary">
                            {" "}
                            · {m.competitor.vendor}
                          </span>
                        ) : null}
                      </span>
                      <a
                        href={m.competitor.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonStyles({
                          variant: "ghost",
                          density: "comfortable",
                        })}
                      >
                        View listing{" "}
                        <ExternalLink size={16} aria-hidden="true" />
                      </a>
                    </div>
                  ))}
                </Card>
              )}
              <h4 className="mb-2 text-ui-body font-medium">Email preview</h4>
              <iframe
                title="Price-match email preview"
                srcDoc={detail.html}
                sandbox=""
                className="h-[560px] w-full rounded-md border border-hairline border-zinc-200 bg-white"
              />
            </CardBody>
          )}
        </Card>
      </div>
    </UiSurface>
  );
}
