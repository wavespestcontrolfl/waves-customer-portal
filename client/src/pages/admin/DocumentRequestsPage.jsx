import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  FileClock,
  Link2,
  Mail,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Badge, Button, Card, CardBody, Table, TBody, TD, TH, THead, TR, cn } from "../../components/ui";
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

export default function DocumentRequestsPage() {
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
    const ok = window.confirm(`Cancel ${request.title || "this document request"}?`);
    if (!ok) return;
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

  return (
    <div className="mx-auto max-w-[1500px]">
      <AdminCommandHeader
        title="Document Requests"
        icon={FileClock}
        sections={STATUS_TABS}
        activeKey={status}
        onSectionChange={setStatus}
        navGridClassName="grid-cols-2 md:grid-cols-6"
        actions={[
          { label: "Refresh", icon: RefreshCw, variant: "secondary", onClick: loadRequests, disabled: loading },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[260px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-secondary" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customer, document, phone, or email"
            className="h-9 w-full rounded-xs border-hairline border-zinc-300 bg-white pl-8 pr-2 text-13 text-zinc-900 u-focus-ring"
          />
        </div>
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
          <div key={label} className="rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2">
            <div className="u-label text-ink-secondary">{label}</div>
            <div className="u-nums mt-1 text-20 font-medium text-zinc-900">{value ?? "—"}</div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-3 rounded-sm border-hairline border-red-200 bg-red-50 px-3 py-2 text-12 text-red-900">
          {error}
        </div>
      )}
      {toast && (
        <div className="mb-3 rounded-sm border-hairline border-emerald-200 bg-emerald-50 px-3 py-2 text-12 text-emerald-950">
          {toast}
        </div>
      )}
      {latestLink && (
        <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-12 font-medium text-zinc-900">
            <Link2 size={14} />
            Fresh link ready
          </div>
          <div className="break-all text-11 text-ink-secondary">{latestLink}</div>
          <Button size="sm" variant="secondary" className="mt-2" onClick={copyLatestLink}>
            Copy
          </Button>
        </div>
      )}

      <Card>
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <Table>
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
                      <TD>
                        <Badge tone={statusTone(request.requestStatus || request.status)}>
                          {statusLabel(request.requestStatus || request.status)}
                        </Badge>
                      </TD>
                      <TD>
                        <div className="max-w-[280px]">
                          <div className="truncate text-13 font-medium text-zinc-900">
                            {request.title || "Document request"}
                          </div>
                          <div className="truncate text-11 text-ink-secondary">
                            {request.documentTemplateKey || "template"}
                          </div>
                        </div>
                      </TD>
                      <TD>
                        <div className="max-w-[260px]">
                          <Link
                            to={`/admin/customers?customerId=${encodeURIComponent(request.customerId || "")}`}
                            className="truncate text-13 font-medium text-zinc-900 underline-offset-2 hover:underline"
                          >
                            {customerName(request)}
                          </Link>
                          <div className="truncate text-11 text-ink-secondary">
                            {[request.customer?.phone, request.customer?.email].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </TD>
                      <TD className="u-nums">{fmtDate(request.createdAt)}</TD>
                      <TD className="u-nums">{fmtDate(request.shareTokenExpiresAt)}</TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          <span className={cn("h-5 px-1.5 inline-flex items-center rounded-xs border-hairline text-10 uppercase tracking-label", delivery.emailSent ? "bg-zinc-900 border-zinc-900 text-white" : "bg-zinc-50 border-zinc-200 text-ink-secondary")}>
                            Email {delivery.emailSent || 0}
                          </span>
                          <span className={cn("h-5 px-1.5 inline-flex items-center rounded-xs border-hairline text-10 uppercase tracking-label", delivery.smsSent ? "bg-zinc-900 border-zinc-900 text-white" : "bg-zinc-50 border-zinc-200 text-ink-secondary")}>
                            SMS {delivery.smsSent || 0}
                          </span>
                          <span className={cn("h-5 px-1.5 inline-flex items-center rounded-xs border-hairline text-10 uppercase tracking-label", delivery.remindersSent ? "bg-zinc-900 border-zinc-900 text-white" : "bg-zinc-50 border-zinc-200 text-ink-secondary")}>
                            Remind {delivery.remindersSent || 0}
                          </span>
                          {delivery.deliveryFailures ? (
                            <span className="h-5 px-1.5 inline-flex items-center rounded-xs border-hairline border-red-200 bg-red-50 text-10 uppercase tracking-label text-red-900">
                              Failed {delivery.deliveryFailures}
                            </span>
                          ) : null}
                        </div>
                      </TD>
                      <TD>
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
                              <Button size="sm" variant="danger" disabled={acting} onClick={() => cancelRequest(request)}>
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
          {!loading && requests.length === 0 && (
            <div className="px-4 py-10 text-center text-13 text-ink-secondary">
              No document requests match this view.
            </div>
          )}
          {loading && (
            <div className="px-4 py-10 text-center text-13 text-ink-secondary">
              Loading document requests...
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
