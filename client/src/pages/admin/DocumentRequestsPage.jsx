import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Bell,
  FileClock,
  Link2,
  Mail,
  MessageSquare,
  PenLine,
  RotateCcw,
  XCircle,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, ActionFeedback, Badge, Button, Card, CardBody, Field, Input, Table, TBody, TD, TH, THead, TR, UiSurface } from "../../components/ui";
import useVisiblePageRefresh from "../../hooks/useVisiblePageRefresh";
import { adminFetch as rawAdminFetch } from "../../lib/adminFetch";

const STATUS_TABS = [
  { key: "open", label: "Open" },
  { key: "viewed", label: "Viewed" },
  { key: "signed", label: "Signed" },
  { key: "expired", label: "Expired" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];

function api(path, options = {}) {
  return rawAdminFetch(path, options).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || body.reason || `HTTP ${res.status}`);
    return body;
  });
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function customerName(request) {
  return request?.customer?.name || request?.recipientName || "Customer";
}

function statusTone(status) {
  if (status === "signed") return "strong";
  if (status === "expired" || status === "cancelled" || status === "voided") return "alert";
  return "neutral";
}

function statusLabel(status) {
  return String(status || "draft").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function canAct(request) {
  return request?.contractType === "document_template" && !["signed", "cancelled", "voided"].includes(request.status);
}

// Waves Subterranean Termite Protection — annual agreement template key
// (server/services/termite-program-agreement.js ANNUAL_TEMPLATE_KEY). Owner
// ruling 2026-09-25 (A-14): a certified-operator countersignature is a
// RECORD step after the customer signs — never a gate on activation/billing.
const TERMITE_ANNUAL_TEMPLATE_KEY = "service_agreement.termite_annual_protection";

function canCountersign(request) {
  return request?.contractType === "document_template"
    && request?.documentTemplateKey === TERMITE_ANNUAL_TEMPLATE_KEY
    && request?.status === "signed"
    && !request?.countersignedAt;
}

function CountersignBadge({ request }) {
  if (request.countersignedAt) return <Badge tone="strong" className="ml-1">Countersigned</Badge>;
  if (canCountersign(request)) return <Badge tone="alert" className="ml-1">Needs countersignature</Badge>;
  return null;
}

// The executed copy, countersignature stamp included — the only place a
// countersigned PDF can be obtained (the customer's signing link is burned).
function SignedPdfButton({ request, disabled, onError }) {
  if (!request?.countersignedAt) return null;
  const openPdf = async () => {
    const tab = window.open("", "_blank");
    try {
      const res = await rawAdminFetch(`/admin/contracts/${request.id}/pdf`);
      if (!res.ok) throw new Error(`Could not load the signed PDF (HTTP ${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      if (tab) tab.close();
      onError(err.message || "Could not load the signed PDF");
    }
  };
  return (
    <Button size="sm" variant="secondary" disabled={disabled} onClick={openPdf}>
      Signed PDF
    </Button>
  );
}

function CountersignButton({ request, disabled, onClick }) {
  if (!canCountersign(request)) return null;
  return (
    <Button size="sm" variant="primary" disabled={disabled} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onClick(request); }}>
      <PenLine size={13} className="mr-1" />
      Countersign
    </Button>
  );
}

// The certified operator types their own name — evidence mirroring the
// customer's typed e-signature; never pre-filled from the logged-in account.
function CountersignDialog({ request, onClose, onConfirm }) {
  const [name, setName] = useState("");
  useEffect(() => { setName(""); }, [request]);
  const ready = name.trim().length >= 2;
  return (
    <Dialog open={Boolean(request)} onClose={onClose} size="sm">
      <DialogHeader><DialogTitle>Countersign agreement</DialogTitle></DialogHeader>
      <DialogBody>
        <p>
          Countersign {request?.title || "this agreement"} for {customerName(request)} as the certified operator on
          record? This records your countersignature only — it does not change billing, scheduling, or activation.
        </p>
        <Field label="Type your full name" className="mt-3">
          <Input value={name} maxLength={180} autoComplete="name" onChange={(event) => setName(event.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Not yet</Button>
        <Button variant="primary" disabled={!ready} onClick={() => onConfirm(request, name)}>Countersign</Button>
      </DialogFooter>
    </Dialog>
  );
}

// `embedded` (under ContractsPage): the hub owns the header card, so this
// page hands its status tabs up via `onSecondaryNav` instead of rendering its
// own header. Standalone rendering is unchanged.
export default function DocumentRequestsPage({ embedded = false, onSecondaryNav } = {}) {
  const [cancelTarget, setCancelTarget] = useState(null);
  const [countersignTarget, setCountersignTarget] = useState(null);
  // ?status=<tab> preselects a tab (the countersign-needed bell links to
  // ?tab=requests&status=signed); anything unrecognised falls back to Open.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStatus = searchParams.get("status");
  const [status, setStatus] = useState(() => (
    STATUS_TABS.some((tab) => tab.key === requestedStatus) ? requestedStatus : "open"
  ));
  // The page stays mounted when the bell link navigates to it again, so the
  // initializer alone would keep the old tab — follow the URL whenever its
  // ?status= changes (tab clicks don't touch the URL, so they're unaffected).
  useEffect(() => {
    if (STATUS_TABS.some((tab) => tab.key === requestedStatus)) setStatus(requestedStatus);
  }, [requestedStatus]);
  // A tab click mirrors itself into ?status= (other params kept, history
  // replaced), so the URL never holds a stale status. Otherwise a later bell
  // link to the SAME ?status=signed would be no change and the effect above
  // wouldn't fire (codex #4842 r2 P2).
  const selectStatus = useCallback((key) => {
    setStatus(key);
    setSearchParams((prev) => {
      if (prev.get("status") === key) return prev;
      const next = new URLSearchParams(prev);
      next.set("status", key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [search, setSearch] = useState("");
  const [requests, setRequests] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionKey, setActionKey] = useState("");
  const [latestLink, setLatestLink] = useState("");
  const listRequestRef = useRef(0);
  const listPendingRef = useRef(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ status, limit: "100" });
    if (search.trim()) params.set("search", search.trim());
    return params.toString();
  }, [status, search]);

  const loadRequests = useCallback(async ({ background = false } = {}) => {
    if (background && listPendingRef.current === listRequestRef.current) return;
    const request = ++listRequestRef.current;
    listPendingRef.current = request;
    if (!background) {
      setError("");
      setLoading(true);
      setLoadError("");
    }
    try {
      const [data, statsData] = await Promise.all([
        api(`/admin/contracts/requests?${query}`),
        api("/admin/contracts/requests/stats").catch(() => ({ stats: null })),
      ]);
      if (request !== listRequestRef.current) return;
      setRequests(data.requests || []);
      if (statsData.stats) setStats(statsData.stats);
      setLoadError("");
    } catch (err) {
      if (request === listRequestRef.current) {
        setLoadError(err.message || "Could not load document requests");
      }
    } finally {
      if (listPendingRef.current === request) listPendingRef.current = null;
      if (request === listRequestRef.current) {
        setLoading(false);
      }
    }
  }, [query]);

  useEffect(() => {
    loadRequests();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadRequests]);

  useVisiblePageRefresh(() => loadRequests({ background: true }));

  const runDeliveryAction = async (request, channel, action = "send") => {
    if (!request?.id) return;
    const key = `${request.id}:${channel}:${action}`;
    setActionKey(key);
    setError("");
    setToast("");
    setLatestLink("");
    try {
      const endpoint = action === "reminder"
        ? `/admin/contracts/${request.id}/remind`
        : `/admin/contracts/${request.id}/send-${channel}`;
      const result = await api(endpoint, {
        method: "POST",
        body: action === "reminder" ? { channel } : {},
      });
      setLatestLink(result.signingUrl || result.contract?.signingUrl || "");
      setToast(action === "reminder" ? `${channel.toUpperCase()} reminder sent` : `${channel.toUpperCase()} sent`);
      await loadRequests();
    } catch (err) {
      setError(err.message || "Document delivery failed");
    } finally {
      setActionKey("");
    }
  };

  const reissueLink = async (request) => {
    if (!request?.id) return;
    setActionKey(`${request.id}:link`);
    setError("");
    setToast("");
    setLatestLink("");
    try {
      const result = await api(`/admin/contracts/${request.id}/share-link`, { method: "POST" });
      setLatestLink(result.signingUrl || result.contract?.signingUrl || "");
      setToast("Fresh signing link created");
      await loadRequests();
    } catch (err) {
      setError(err.message || "Could not create signing link");
    } finally {
      setActionKey("");
    }
  };

  const cancelRequest = async (request) => {
    if (!request?.id) return;
    setCancelTarget(null);
    setActionKey(`${request.id}:cancel`);
    setError("");
    setToast("");
    try {
      await api(`/admin/contracts/${request.id}/cancel`, {
        method: "POST",
        body: { reason: "Cancelled from document requests queue" },
      });
      setToast("Document request cancelled");
      await loadRequests();
    } catch (err) {
      setError(err.message || "Could not cancel document request");
    } finally {
      setActionKey("");
    }
  };

  const countersignRequest = async (request, name) => {
    if (!request?.id || name.trim().length < 2) return;
    setCountersignTarget(null);
    setActionKey(`${request.id}:countersign`);
    setError("");
    setToast("");
    try {
      await api(`/admin/contracts/${request.id}/countersign`, { method: "POST", body: { name: name.trim() } });
      setToast("Countersigned");
      await loadRequests();
    } catch (err) {
      setError(err.message || "Could not countersign this agreement");
    } finally {
      setActionKey("");
    }
  };

  const copyLatestLink = async () => {
    if (!latestLink) return;
    await navigator.clipboard?.writeText(latestLink).catch(() => {});
    setToast("Signing link copied");
  };

  const hubNavRef = useRef({});
  hubNavRef.current = { setStatus: selectStatus };
  useEffect(() => {
    if (!embedded || !onSecondaryNav) return undefined;
    onSecondaryNav({
      sections: STATUS_TABS,
      activeKey: status,
      onChange: (key) => hubNavRef.current.setStatus(key),
      ariaLabel: "Request status",
      navGridClassName: "grid-cols-2 md:grid-cols-6",
      actions: [],
    });
    return () => onSecondaryNav(null);
  }, [embedded, onSecondaryNav, status]);

  return (
    <UiSurface density="comfortable" className="mx-auto min-w-0 max-w-[1500px] text-ui-body">
      {!embedded && (
      <AdminCommandHeader
        variant="workspace"
        title="Document requests"
        icon={FileClock}
        sections={STATUS_TABS}
        activeKey={status}
        onSectionChange={selectStatus}
        navGridClassName="grid-cols-2 md:grid-cols-6"
      />
      )}

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <Field label="Search requests" className="min-w-0 flex-1">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, document, phone, or email" />
        </Field>
        <Button variant="secondary" onClick={() => setSearch("")} disabled={!search}>
          Clear
        </Button>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Open", stats?.open],
          ["Viewed unsigned", stats?.viewedUnsigned],
          ["Expiring soon", stats?.expiringSoon],
          ["Failed delivery", stats?.failedDelivery],
          ["Signed this week", stats?.signedThisWeek],
        ].map(([label, value]) => (
          <Card key={label}><CardBody>
            <div className="ui-label text-ink-secondary">{label}</div>
            <div className="u-nums mt-1 text-20 font-medium text-zinc-900">{value ?? "—"}</div>
          </CardBody></Card>
        ))}
      </div>

      {loadError && (
        <ActionFeedback error onRetry={() => loadRequests()} className="mb-3">{loadError}</ActionFeedback>
      )}
      {error && (
        <ActionFeedback error className="mb-3">{error}</ActionFeedback>
      )}
      {toast && (
        <ActionFeedback className="mb-3">{toast}</ActionFeedback>
      )}
      {latestLink && (
        <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-ui-body font-medium text-zinc-900">
            <Link2 size={14} />
            Fresh link ready
          </div>
          <div className="break-all text-ui-body text-ink-secondary">{latestLink}</div>
          <Button size="sm" variant="secondary" className="mt-2" onClick={copyLatestLink}>
            Copy
          </Button>
        </div>
      )}

      <Card>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <Table layout="records">
              <THead>
                <TR>
                  <TH>Status</TH>
                  <TH>Document</TH>
                  <TH>Customer</TH>
                  <TH>Created</TH>
                  <TH>Expires</TH>
                  <TH>Delivery</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {requests.map((request) => {
                  const delivery = request.deliverySummary || {};
                  const acting = actionKey.startsWith(`${request.id}:`);
                  return (
                    <TR key={request.id}>
                      <TD data-label="Status">
                        <Badge tone={statusTone(request.requestStatus || request.status)}>
                          {statusLabel(request.requestStatus || request.status)}
                        </Badge>
                        <CountersignBadge request={request} />
                      </TD>
                      <TD data-label="Document">
                        <div className="min-w-0">
                          <div className="break-words text-ui-body font-medium text-zinc-900">
                            {request.title || "Document request"}
                          </div>
                          <div className="break-words text-ui-body text-ink-secondary">
                            {request.documentTemplateKey || "template"}
                          </div>
                        </div>
                      </TD>
                      <TD data-label="Customer">
                        <div className="min-w-0">
                          <Link
                            to={`/admin/customers?customerId=${encodeURIComponent(request.customerId || "")}`}
                            className="break-words text-ui-body font-medium text-zinc-900 underline-offset-2 hover:underline"
                          >
                            {customerName(request)}
                          </Link>
                          <div className="break-words text-ui-body text-ink-secondary">
                            {[request.customer?.phone, request.customer?.email].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </TD>
                      <TD data-label="Created" className="u-nums">{fmtDate(request.createdAt)}</TD>
                      <TD data-label="Expires" className="u-nums">{fmtDate(request.shareTokenExpiresAt)}</TD>
                      <TD data-label="Delivery">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={delivery.emailSent ? "strong" : "neutral"}>Email {delivery.emailSent || 0}</Badge>
                          <Badge tone={delivery.smsSent ? "strong" : "neutral"}>SMS {delivery.smsSent || 0}</Badge>
                          <Badge tone={delivery.remindersSent ? "strong" : "neutral"}>Remind {delivery.remindersSent || 0}</Badge>
                          {delivery.deliveryFailures ? (
                            <Badge tone="alert">Failed {delivery.deliveryFailures}</Badge>
                          ) : null}
                        </div>
                      </TD>
                      <TD data-label="Actions">
                        <div className="flex flex-wrap gap-1.5">
                          {canAct(request) && (
                            <>
                              <Button size="sm" variant="secondary" disabled={acting} onClick={() => runDeliveryAction(request, "email")}>
                                <Mail size={13} className="mr-1" />
                                Email
                              </Button>
                              <Button size="sm" variant="secondary" disabled={acting} onClick={() => runDeliveryAction(request, "sms")}>
                                <MessageSquare size={13} className="mr-1" />
                                SMS
                              </Button>
                              <Button size="sm" variant="secondary" disabled={acting} onClick={() => runDeliveryAction(request, "email", "reminder")}>
                                <Bell size={13} className="mr-1" />
                                Remind
                              </Button>
                              <Button size="sm" variant="secondary" disabled={acting} onClick={() => reissueLink(request)}>
                                <RotateCcw size={13} className="mr-1" />
                                Link
                              </Button>
                              <Button size="sm" variant="danger" disabled={acting} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setCancelTarget(request); }}>
                                <XCircle size={13} className="mr-1" />
                                Cancel
                              </Button>
                            </>
                          )}
                          <CountersignButton request={request} disabled={acting} onClick={setCountersignTarget} />
                          <SignedPdfButton request={request} disabled={acting} onError={setError} />
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          {!loading && !loadError && !error && requests.length === 0 && (
            <div className="px-4 py-10 text-center text-ui-body text-ink-secondary">
              No document requests match this view.
            </div>
          )}
          {loading && (
            <div className="px-4 py-10 text-center text-ui-body text-ink-secondary">
              Loading document requests...
            </div>
          )}
        </CardBody>
      </Card>
      <Dialog open={Boolean(cancelTarget)} onClose={() => setCancelTarget(null)} size="sm">
        <DialogHeader><DialogTitle>Cancel document request</DialogTitle></DialogHeader>
        <DialogBody>Cancel {cancelTarget?.title || "this document request"}?</DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setCancelTarget(null)}>Keep request</Button>
          <Button variant="danger" onClick={() => cancelRequest(cancelTarget)}>Cancel request</Button>
        </DialogFooter>
      </Dialog>
      <CountersignDialog
        request={countersignTarget}
        onClose={() => setCountersignTarget(null)}
        onConfirm={countersignRequest}
      />
    </UiSurface>
  );
}
