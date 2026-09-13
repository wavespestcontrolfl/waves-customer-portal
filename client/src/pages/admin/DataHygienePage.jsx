import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { CheckCircle2, DatabaseZap, Eye, EyeOff, Play, RefreshCw, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

const STATUSES = ["pending", "auto_applied", "approved", "reverted", "rejected", "stale", "all"];

function fieldLabel(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function valueText(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object" && value.masked) return `${value.masked} (${value.length} chars)`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function confidence(value) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Number(value) * 100)}%`;
}

function percent(value) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Number(value) * 100)}%`;
}

export default function DataHygienePage({ embedded = false } = {}) {
  const location = useLocation();
  const [status, setStatus] = useState(() => {
    // Digest bells deep-link to ?status=auto_applied.
    const fromUrl = new URLSearchParams(window.location.search).get("status");
    return STATUSES.includes(fromUrl) ? fromUrl : "pending";
  });
  // The Agents hub keeps this page mounted across tab/URL changes — a digest
  // click while already on the tab only updates the query string, so the
  // initializer never reruns. Follow ?status= whenever the URL changes.
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get("status");
    if (fromUrl && STATUSES.includes(fromUrl)) setStatus(fromUrl);
  }, [location.search]);
  const [data, setData] = useState({ proposals: [] });
  const [metrics, setMetrics] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [revealingId, setRevealingId] = useState("");
  const [revealed, setRevealed] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [revertTarget, setRevertTarget] = useState(null);
  const [revertError, setRevertError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [next, nextMetrics] = await Promise.all([
        adminFetch(`/admin/data-hygiene/proposals?status=${encodeURIComponent(status)}&limit=100`),
        adminFetch("/admin/data-hygiene/metrics?days=30"),
      ]);
      setData(next);
      setMetrics(nextMetrics);
      setSelectedId((current) => (
        next.proposals?.some((p) => p.id === current) ? current : next.proposals?.[0]?.id || null
      ));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => data.proposals?.find((p) => p.id === selectedId) || data.proposals?.[0] || null,
    [data.proposals, selectedId]
  );

  useEffect(() => {
    setRevealed(null);
  }, [selectedId]);

  useEffect(() => {
    if (!revealed) return undefined;
    const timer = setTimeout(() => setRevealed(null), 60000);
    return () => clearTimeout(timer);
  }, [revealed]);

  const runScan = useCallback(async (mode) => {
    setScanning(true);
    setNotice("");
    setError("");
    try {
      const result = await adminFetch("/admin/data-hygiene/scan", {
        method: "POST",
        body: JSON.stringify({ mode, phases: ["extraction"] }),
      });
      setNotice(`Scan ${result.status}: run ${result.run_id || "-"}`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }, [load]);

  const approve = useCallback(async (proposal) => {
    if (!proposal) return;
    setBusyId(proposal.id);
    setError("");
    try {
      await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/approve`, { method: "POST", body: "{}" });
      setNotice("Proposal approved and applied.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [load]);

  const reject = useCallback(async (proposal, reason = "other") => {
    if (!proposal) return;
    setBusyId(proposal.id);
    setError("");
    try {
      await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setNotice("Proposal rejected.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [load]);

  const revert = useCallback(async (proposal) => {
    if (!proposal) return;
    setRevertError("");
    setBusyId(proposal.id);
    setError("");
    try {
      await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/revert`, {
        method: "POST",
        body: "{}",
      });
      setNotice("Proposal reverted.");
      setRevertTarget(null);
      await load();
    } catch (err) {
      setRevertError(err.status === 409 ? "Cannot revert because the live value changed after approval." : err.message);
    } finally {
      setBusyId("");
    }
  }, [load]);

  const reveal = useCallback(async (proposal) => {
    if (!proposal) return;
    if (revealed?.proposalId === proposal.id) {
      setRevealed(null);
      return;
    }
    setRevealingId(proposal.id);
    setError("");
    try {
      const result = await adminFetch(`/admin/data-hygiene/proposals/${proposal.id}/reveal`, {
        method: "POST",
        body: "{}",
      });
      setRevealed(result);
      setNotice("Sensitive value revealed. This access was audited.");
    } catch (err) {
      setError(err.message);
    } finally {
      setRevealingId("");
    }
  }, [revealed]);

  const pendingCount = data.proposals?.filter((p) => p.status === "pending").length || 0;

  return (
    <UiSurface density="comfortable" className="min-h-full space-y-5 text-zinc-800">
      {!embedded && (
        <AdminCommandHeader
          eyebrow="System"
          title="Data hygiene"
          description="Review proposed cleanup from customer communications before it updates live property data."
          icon={DatabaseZap}
        />
      )}

      <div className="space-y-5 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Proposal status">
            {STATUSES.map((s) => (
              <Button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                variant={status === s ? "primary" : "secondary"}
                aria-pressed={status === s}
              >
                {fieldLabel(s)}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => runScan("dry_run")} loading={scanning}>
              <Play size={16} aria-hidden /> Dry run
            </Button>
            <Button onClick={() => runScan("manual")} loading={scanning}>
              <RefreshCw size={16} aria-hidden /> Create proposals
            </Button>
          </div>
        </div>

        {error && <ActionFeedback error>{error}</ActionFeedback>}
        {notice && <ActionFeedback>{notice}</ActionFeedback>}

        <MetricsPanel metrics={metrics} />

        <div className="grid gap-3 lg:grid-cols-2 items-start">
          <Card className="overflow-hidden">
            <CardHeader className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Proposals</CardTitle>
                <p className="text-ui-caption text-ink-secondary mt-1">{pendingCount} pending in current view</p>
              </div>
              <Button type="button" onClick={load} loading={loading} variant="secondary" aria-label="Refresh proposals">
                <RefreshCw size={16} aria-hidden />
              </Button>
            </CardHeader>
            <div className="max-h-[calc(100dvh-260px)] overflow-auto">
              {loading ? (
                <ActionFeedback className="m-4">Loading proposals...</ActionFeedback>
              ) : data.proposals?.length ? data.proposals.map((proposal) => (
                <button
                  key={proposal.id}
                  type="button"
                  onClick={() => setSelectedId(proposal.id)}
                  aria-pressed={proposal.id === selected?.id}
                  className="block min-h-11 w-full border-0 border-b border-hairline border-zinc-200 bg-white p-4 text-left text-ui-body text-zinc-800 hover:bg-zinc-50 aria-pressed:bg-zinc-100 u-focus-ring"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate font-medium text-zinc-900">
                      {proposal.customer?.name || proposal.customer?.phone || "Unknown customer"}
                    </div>
                    <Badge tone="neutral">{fieldLabel(proposal.status)}</Badge>
                  </div>
                  <div className="mt-1 text-ui-caption text-ink-secondary">{fieldLabel(proposal.field)} · {confidence(proposal.confidence)}</div>
                  <div className="mt-2 break-words text-ui-body">{valueText(proposal.proposedValue)}</div>
                </button>
              )) : (
                <ActionFeedback className="m-4">No proposals found.</ActionFeedback>
              )}
            </div>
          </Card>

          <Card className="min-h-[360px]">
            <CardBody>
            {selected ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-18 font-medium text-zinc-900">{fieldLabel(selected.field)}</h2>
                    <p className="text-ui-caption text-ink-secondary mt-1">{selected.customer?.name || selected.scopeId}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {selected.isSensitive && <Badge tone="alert"><ShieldAlert size={14} aria-hidden /> Sensitive</Badge>}
                    <Badge tone="neutral">{fieldLabel(selected.status)}</Badge>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Info label="Current" value={valueText(selected.currentValue)} />
                  <Info label="Proposed" value={valueText(selected.proposedValue)} />
                  <Info label="Source" value={selected.source} />
                  <Info label="Confidence" value={confidence(selected.confidence)} />
                </div>

                {selected.isSensitive && (
                  <Card>
                    <CardBody className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-14 font-medium text-alert-fg">Sensitive value</div>
                        <div className="text-ui-caption text-ink-secondary mt-1">
                          Reveal decrypts the vault value and writes an audit event.
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => reveal(selected)}
                        loading={revealingId === selected.id}
                      >
                        {revealed?.proposalId === selected.id ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                        {revealed?.proposalId === selected.id ? "Hide" : "Reveal"}
                      </Button>
                    </div>
                    {revealed?.proposalId === selected.id && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Info label="Raw Current" value={valueText(revealed.currentValue)} />
                        <Info label="Raw Proposed" value={valueText(revealed.proposedValue)} />
                      </div>
                    )}
                    </CardBody>
                  </Card>
                )}

                <Card>
                  <CardBody>
                  <div className="text-14 font-medium text-zinc-900">Evidence</div>
                  <div className="text-ui-body text-zinc-800 mt-2">
                    {selected.evidence?.source_excerpt || "No excerpt available."}
                  </div>
                  <div className="text-ui-caption text-ink-secondary mt-2">
                    {selected.evidence?.channel || "-"} · {selected.evidence?.matched_label || "-"}
                  </div>
                  </CardBody>
                </Card>

                {selected.status === "pending" && (
                  <div className="ui-record-actions justify-end">
                    <Button variant="secondary" onClick={() => reject(selected, "bad_parse")} loading={busyId === selected.id}>
                      <XCircle size={16} aria-hidden /> Reject
                    </Button>
                    <Button onClick={() => approve(selected)} loading={busyId === selected.id}>
                      <CheckCircle2 size={16} aria-hidden /> Approve
                    </Button>
                  </div>
                )}
                {(selected.status === "approved" || selected.status === "auto_applied") && (
                  <div className="ui-record-actions justify-end">
                    <Button variant="secondary" onClick={() => { setRevertError(""); setRevertTarget(selected); }} disabled={busyId === selected.id}>
                      <RotateCcw size={16} aria-hidden /> Revert
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <ActionFeedback>Select a proposal.</ActionFeedback>
            )}
            </CardBody>
          </Card>
        </div>
        <Dialog open={Boolean(revertTarget)} onClose={() => !busyId && setRevertTarget(null)} size="sm">
          <DialogHeader><DialogTitle>Revert approved change?</DialogTitle></DialogHeader>
          <DialogBody className="space-y-3">
            <p className="text-ui-body text-zinc-800">Restore the previous value for this proposal?</p>
            {revertError && <ActionFeedback error>{revertError}</ActionFeedback>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRevertTarget(null)} disabled={Boolean(busyId)}>Cancel</Button>
            <Button variant="danger" onClick={() => revert(revertTarget)} loading={busyId === revertTarget?.id}>Revert change</Button>
          </DialogFooter>
        </Dialog>
      </div>
    </UiSurface>
  );
}

function MetricsPanel({ metrics }) {
  const topField = metrics?.byField?.[0];
  const topLabel = metrics?.byMatchedLabel?.[0];
  const topVersion = metrics?.byExtractorVersion?.[0];
  const rejected = metrics?.statusCounts?.rejected || 0;
  const approved = metrics?.statusCounts?.approved || 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Quality signals</CardTitle>
          <p className="text-ui-caption text-ink-secondary mt-1">Last {metrics?.days || 30} days</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge tone="neutral">{approved} approved</Badge>
          <Badge tone={rejected ? "alert" : "neutral"}>{rejected} rejected</Badge>
        </div>
      </CardHeader>
      <CardBody className="grid gap-3 sm:grid-cols-3">
        <MetricCard title="Noisiest field" bucket={topField} />
        <MetricCard title="Noisiest label" bucket={topLabel} />
        <MetricCard title="Extractor" bucket={topVersion} />
      </CardBody>
      <div className="grid gap-3 px-4 pb-4 lg:grid-cols-2">
        <MetricTable title="By field" rows={metrics?.byField || []} keyLabel="Field" />
        <MetricTable title="By label" rows={metrics?.byMatchedLabel || []} keyLabel="Label" />
      </div>
      <div className="px-4 pb-4">
        <Card className="overflow-hidden">
          <CardHeader><CardTitle>Rejected excerpts</CardTitle></CardHeader>
          {metrics?.topRejected?.length ? metrics.topRejected.map((row) => (
            <div key={row.id} className="space-y-2 border-b border-hairline border-zinc-200 p-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="alert">{fieldLabel(row.field)}</Badge>
                <span className="text-ui-caption text-ink-secondary">{row.matchedLabel || "unknown"} · {row.extractorVersion || "unknown"} · {row.rejectReason || "rejected"}</span>
              </div>
              <div className="break-words text-ui-body text-zinc-800">
                {row.sourceExcerpt || "No excerpt available."}
              </div>
            </div>
          )) : (
            <ActionFeedback className="m-3">No rejected excerpts in this window.</ActionFeedback>
          )}
        </Card>
      </div>
    </Card>
  );
}

function MetricCard({ title, bucket }) {
  return (
    <Card className="min-h-[92px] p-3">
      <div className="text-14 font-medium text-ink-secondary">{title}</div>
      <div className="mt-2 break-words text-16 font-medium text-zinc-900">{bucket?.key ? fieldLabel(bucket.key) : "-"}</div>
      <div className="mt-2 flex flex-wrap gap-2 text-ui-caption text-ink-secondary u-nums">
        <span>{bucket?.total || 0} total</span>
        <span>{percent(bucket?.rejectionRate)} rejected</span>
      </div>
    </Card>
  );
}

function MetricTable({ title, rows, keyLabel }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
        <Table aria-label={title} className="min-w-[520px]">
          <THead>
            <TR>
              <TH>{keyLabel}</TH><TH>Total</TH><TH>Approved</TH><TH>Rejected</TH><TH>Reject %</TH>
            </TR>
          </THead>
          <TBody>
            {rows.slice(0, 6).map((row) => (
              <TR key={row.key}>
                <TD className="break-words font-medium">{fieldLabel(row.key)}</TD>
                <TD className="u-nums">{row.total}</TD><TD className="u-nums">{row.approved}</TD>
                <TD className="u-nums">{row.rejected}</TD><TD className="u-nums">{percent(row.rejectionRate)}</TD>
              </TR>
            ))}
            {!rows.length && (
              <TR><TD colSpan={5} className="text-ink-secondary">No metrics yet.</TD></TR>
            )}
          </TBody>
        </Table>
    </Card>
  );
}

function Info({ label, value }) {
  return (
    <Card className="p-3">
      <div className="text-14 font-medium text-ink-secondary">{label}</div>
      <div className="mt-2 break-words text-ui-body text-zinc-800">{value || "-"}</div>
    </Card>
  );
}
