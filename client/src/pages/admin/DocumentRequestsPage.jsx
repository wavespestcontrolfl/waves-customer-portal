import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  FileClock,
  Link2,
  Mail,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, ActionFeedback, Badge, Button, Card, CardBody, Field, Input, Table, TBody, TD, TH, THead, TR, UiSurface } from "../../components/ui";
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

// `embedded` (under ContractsPage): the hub owns the header card, so this
// page hands its status tabs + Refresh up via `onSecondaryNav` instead of
// rendering its own header. Standalone rendering is unchanged.
export default function DocumentRequestsPage({ embedded = false, onSecondaryNav } = {}) {
  const [cancelTarget, setCancelTarget] = useState(null);
  const [status, setStatus] = useState("open");
  const [search, setSearch] = useState("");
  const [requests, setRequests] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionKey, setActionKey] = useState("");
  const [latestLink, setLatestLink] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ status, limit: "100" });
    if (search.trim()) params.set("search", search.trim());
    return params.toString();
  }, [status, search]);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [data, statsData] = await Promise.all([
        api(`/admin/contracts/requests?${query}`),
        api("/admin/contracts/requests/stats").catch(() => ({ stats: null })),
      ]);
      setRequests(data.requests || []);
      setStats(statsData.stats || null);
    } catch (err) {
      setError(err.message || "Could not load document requests");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

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

  const copyLatestLink = async () => {
    if (!latestLink) return;
    await navigator.clipboard?.writeText(latestLink).catch(() => {});
    setToast("Signing link copied");
  };

  const hubNavRef = useRef({});
  hubNavRef.current = { setStatus, loadRequests };
  useEffect(() => {
    if (!embedded || !onSecondaryNav) return undefined;
    onSecondaryNav({
      sections: STATUS_TABS,
      activeKey: status,
      onChange: (key) => hubNavRef.current.setStatus(key),
      ariaLabel: "Request status",
      navGridClassName: "grid-cols-2 md:grid-cols-6",
      actions: [
        { label: "Refresh", icon: RefreshCw, variant: "secondary", onClick: () => hubNavRef.current.loadRequests(), disabled: loading },
      ],
    });
    return () => onSecondaryNav(null);
  }, [embedded, onSecondaryNav, status, loading]);

  return (
    <UiSurface density="comfortable" className="mx-auto min-w-0 max-w-[1500px] text-ui-body">
      {!embedded && (
      <AdminCommandHeader
        variant="workspace"
        title="Document requests"
        icon={FileClock}
        sections={STATUS_TABS}
        activeKey={status}
        onSectionChange={setStatus}
        navGridClassName="grid-cols-2 md:grid-cols-6"
        actions={[
          { label: "Refresh", icon: RefreshCw, variant: "secondary", onClick: loadRequests, disabled: loading },
        ]}
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
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          {!loading && !error && requests.length === 0 && (
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
    </UiSurface>
  );
}
