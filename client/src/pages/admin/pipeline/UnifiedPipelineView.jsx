import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ClipboardList, Plus, RefreshCw, Search, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  cn,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
import DuplicateCleanupQueue from "./DuplicateCleanupQueue";
import OpportunityActions from "./OpportunityActions";
import OpportunityStageBadge from "./OpportunityStageBadge";
import { PIPELINE_FILTERS } from "./pipelineStages";
import UnifiedPipelineFilters from "./UnifiedPipelineFilters";

const ROBOTO = "'Roboto', Arial, sans-serif";
const DEFAULT_FILTER = "needs_action";
const VALID_FILTERS = new Set(PIPELINE_FILTERS.map((filter) => filter.key));

function filterFromSearchParams(searchParams) {
  const value = searchParams.get("stage") || searchParams.get("filter") || DEFAULT_FILTER;
  return VALID_FILTERS.has(value) ? value : DEFAULT_FILTER;
}

function pageFromSearchParams(searchParams) {
  const value = Number.parseInt(searchParams.get("page") || "1", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function money(valueCents) {
  if (valueCents === null || valueCents === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(valueCents / 100);
}

function shortId(id) {
  if (!id) return "";
  const s = String(id);
  return s.length > 8 ? s.slice(0, 8) : s;
}

function formatDate(value) {
  if (!value) return "No activity";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No activity";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function sourceLabel(opportunity) {
  if (opportunity.campaign) return `${opportunity.source} / ${opportunity.campaign}`;
  return opportunity.source || "Unknown";
}

function WarningBanner({ children }) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-sm border-hairline border-amber-300 bg-amber-50 px-3 py-2 text-13 text-amber-900">
      <AlertTriangle size={16} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

function LoadError({ error, onRetry }) {
  return (
    <div className="p-10 text-center">
      <div className="text-14 text-alert-fg mb-3">Failed to load pipeline</div>
      <div className="text-13 text-ink-tertiary mb-4">{error?.message || String(error)}</div>
      <Button variant="primary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export default function UnifiedPipelineView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [opportunities, setOpportunities] = useState([]);
  const [counts, setCounts] = useState({});
  const [pagination, setPagination] = useState({ page: 1, pageSize: 100, total: 0 });
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [filter, setFilter] = useState(() => filterFromSearchParams(searchParams));
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(() => pageFromSearchParams(searchParams));

  useEffect(() => {
    const urlFilter = filterFromSearchParams(searchParams);
    const urlPage = pageFromSearchParams(searchParams);
    if (urlFilter !== filter) setFilter(urlFilter);
    if (urlPage !== page) setPage(urlPage);
  }, [filter, page, searchParams]);

  const updatePipelineUrl = useCallback((nextFilter, nextPage = 1, { replace = false } = {}) => {
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current);
      nextParams.set("stage", nextFilter);
      nextParams.delete("filter");
      if (nextPage > 1) nextParams.set("page", String(nextPage));
      else nextParams.delete("page");
      return nextParams;
    }, { replace });
  }, [setSearchParams]);

  const changeFilter = useCallback((nextFilter) => {
    setPage(1);
    setFilter(nextFilter);
    updatePipelineUrl(nextFilter, 1);
  }, [updatePipelineUrl]);

  const changePage = useCallback((nextPage) => {
    setPage(nextPage);
    updatePipelineUrl(filter, nextPage);
  }, [filter, updatePipelineUrl]);

  const loadPipeline = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    params.set("stage", filter);
    params.set("page", String(page));
    params.set("pageSize", filter === "duplicate_risk" ? "25" : "100");
    if (search.trim()) params.set("search", search.trim());

    try {
      const data = await adminFetch(`/admin/pipeline/opportunities?${params.toString()}`);
      setOpportunities(data.data || []);
      setCounts(data.counts || {});
      setPagination(data.pagination || { page: 1, pageSize: 100, total: 0 });
      setMeta(data.meta || null);
      setLoading(false);
    } catch (err) {
      setLoadError(err);
      setOpportunities([]);
      setCounts({});
      setPagination({ page: 1, pageSize: 100, total: 0 });
      setMeta(null);
      setLoading(false);
    }
  }, [filter, page, search]);

  useEffect(() => {
    loadPipeline();
  }, [loadPipeline]);

  const visibleOpportunities = useMemo(() => opportunities, [opportunities]);
  const showingDuplicateCleanup = filter === "duplicate_risk" && !search.trim();
  const totalPages = Math.max(1, Math.ceil((pagination.total || 0) / (pagination.pageSize || 100)));
  const truncatedWarning = useMemo(() => {
    if (!meta?.truncated) return null;
    const cap = meta.candidateCap ? `${meta.candidateCap.toLocaleString()}-record` : "server";
    const leadCount = meta.leadCandidatesReturned != null ? `${meta.leadCandidatesReturned.toLocaleString()} leads` : null;
    const estimateCount = meta.estimateCandidatesReturned != null ? `${meta.estimateCandidatesReturned.toLocaleString()} estimates` : null;
    const candidateSummary = [leadCount, estimateCount].filter(Boolean).join(" and ");
    return `Pipeline results hit the ${cap} candidate cap${candidateSummary ? ` (${candidateSummary})` : ""}. Narrow the search or choose a more specific queue for complete counts.`;
  }, [meta]);

  return (
    <div style={{ fontFamily: ROBOTO }}>
      <div className="md:sticky md:top-0 z-20 mb-5 bg-surface-page/95 pb-3">
        <div className="overflow-hidden rounded-md border-hairline border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-hairline border-zinc-200">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-sm bg-zinc-900 text-white flex items-center justify-center flex-shrink-0">
                <ClipboardList size={17} strokeWidth={1.9} aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="m-0 text-22 font-medium text-zinc-900 tracking-normal">Pipeline</h1>
                <div className="mt-1 text-12 text-ink-tertiary">
                  Leads + estimates
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" className="gap-2" onClick={loadPipeline} disabled={loading}>
                <RefreshCw size={14} strokeWidth={1.9} aria-hidden />
                Refresh
              </Button>
              <Button className="gap-2" onClick={() => navigate("/admin/estimates?tab=new")}>
                <Plus size={14} strokeWidth={1.9} aria-hidden />
                Create Estimate
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 p-2">
            <Link
              to="/admin/pipeline"
              className="h-11 px-3 rounded-sm border-hairline text-12 font-medium uppercase tracking-label inline-flex items-center justify-center gap-2 bg-zinc-900 text-white border-zinc-900 u-focus-ring"
            >
              Unified Pipeline
            </Link>
            <Link
              to="/admin/estimates"
              className="h-11 px-3 rounded-sm border-hairline text-12 font-medium uppercase tracking-label inline-flex items-center justify-center gap-2 bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 u-focus-ring"
            >
              Legacy Pipeline
            </Link>
            <Link
              to="/admin/leads"
              className="h-11 px-3 rounded-sm border-hairline text-12 font-medium uppercase tracking-label inline-flex items-center justify-center gap-2 bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 u-focus-ring"
            >
              Leads
            </Link>
          </div>
        </div>
      </div>

      {truncatedWarning && <WarningBanner>{truncatedWarning}</WarningBanner>}

      <Card className="mb-4">
        <CardHeader className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Opportunity Queue</CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-12 text-ink-tertiary">
              <Badge tone="neutral">{opportunities.length} opportunities</Badge>
              <Badge tone="neutral">{counts.needs_action || 0} need action</Badge>
              {pagination.total > opportunities.length && (
                <Badge tone="neutral">{pagination.total} matched</Badge>
              )}
            </div>
          </div>
          <UnifiedPipelineFilters
            activeFilter={filter}
            counts={counts}
            onChange={changeFilter}
          />
          <div className="relative">
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setPage(1);
                setSearch(event.target.value);
                if (page !== 1) updatePipelineUrl(filter, 1, { replace: true });
              }}
              placeholder="Search name, phone, email, address, source, service, or ref"
              aria-label="Search opportunities"
              className={cn(
                "w-full h-10 pl-10 pr-10 text-14 rounded-sm",
                "bg-white border-hairline border-zinc-300",
                "placeholder:text-ink-tertiary u-focus-ring",
              )}
            />
            <Search
              size={16}
              strokeWidth={1.75}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary pointer-events-none"
              aria-hidden
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setPage(1);
                  setSearch("");
                  if (page !== 1) updatePipelineUrl(filter, 1, { replace: true });
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-7 w-7 rounded-full text-ink-tertiary hover:bg-zinc-100 u-focus-ring"
              >
                <X size={14} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="p-10 text-center text-13 text-ink-secondary">Loading pipeline...</div>
          ) : loadError ? (
            <LoadError error={loadError} onRetry={loadPipeline} />
          ) : visibleOpportunities.length === 0 ? (
            <div className="p-10 text-center text-13 text-ink-secondary">
              No opportunities match the current filter.
            </div>
          ) : showingDuplicateCleanup ? (
            <DuplicateCleanupQueue
              opportunities={visibleOpportunities}
              adminFetch={adminFetch}
              onRefresh={loadPipeline}
            />
          ) : (
            <>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Customer</TH>
                    <TH>Stage</TH>
                    <TH>Service</TH>
                    <TH>Source</TH>
                    <TH align="right">Value</TH>
                    <TH>Last Activity</TH>
                    <TH>Next Action</TH>
                    <TH>Owner</TH>
                    <TH align="right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {visibleOpportunities.map((opportunity) => (
                    <TR key={opportunity.opportunityId}>
                      <TD className="min-w-[230px] align-top">
                        <div className="font-medium text-zinc-900">{opportunity.name || "Unknown Customer"}</div>
                        <div className="mt-1 text-12 text-ink-secondary">
                          {[opportunity.phone, opportunity.email].filter(Boolean).join(" / ") || "No contact info"}
                        </div>
                        <div className="mt-1 text-12 text-ink-tertiary truncate max-w-[280px]">
                          {opportunity.address || "No address"}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {opportunity.leadId && <Badge tone="neutral">Lead {shortId(opportunity.leadId)}</Badge>}
                          {opportunity.estimateId && <Badge tone="neutral">Est {shortId(opportunity.estimateId)}</Badge>}
                          {opportunity.isDuplicateRisk && <Badge tone="alert">Duplicate Risk</Badge>}
                        </div>
                      </TD>
                      <TD className="align-top min-w-[150px]">
                        <OpportunityStageBadge stage={opportunity.stage} />
                        <div className="mt-2 text-11 leading-4 text-ink-tertiary max-w-[180px]">
                          {opportunity.stageReason}
                        </div>
                      </TD>
                      <TD className="align-top min-w-[160px]">
                        {opportunity.serviceInterest || "Unknown service"}
                      </TD>
                      <TD className="align-top min-w-[150px]">
                        {sourceLabel(opportunity)}
                      </TD>
                      <TD className="align-top" align="right" nums>
                        <div>{money(opportunity.valueCents)}</div>
                        {opportunity.valueConfidence !== "unknown" && (
                          <div className="mt-1 text-10 text-ink-tertiary uppercase tracking-label">
                            {opportunity.valueConfidence.replace(/_/g, " ")}
                          </div>
                        )}
                      </TD>
                      <TD className="align-top min-w-[140px]">
                        {formatDate(opportunity.lastActivityAt)}
                      </TD>
                      <TD className="align-top min-w-[140px]">
                        <div className={cn("font-medium", opportunity.needsAction ? "text-zinc-900" : "text-ink-secondary")}>
                          {opportunity.nextActionLabel || "None"}
                        </div>
                        {opportunity.nextFollowUpAt && (
                          <div className="mt-1 text-11 text-ink-tertiary">
                            Due {formatDate(opportunity.nextFollowUpAt)}
                          </div>
                        )}
                        {opportunity.isStale && <Badge tone="alert" className="mt-2">Stale</Badge>}
                      </TD>
                      <TD className="align-top min-w-[120px]">
                        {opportunity.owner || "Unassigned"}
                      </TD>
                      <TD className="align-top min-w-[190px]" align="right">
                        <OpportunityActions
                          opportunity={opportunity}
                          adminFetch={adminFetch}
                          onRefresh={loadPipeline}
                        />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {pagination.total > pagination.pageSize && (
                <div className="flex items-center justify-between gap-3 border-t border-hairline border-zinc-200 px-4 py-3">
                  <div className="text-12 text-ink-tertiary">
                    Page {pagination.page} of {totalPages}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pagination.page <= 1 || loading}
                      onClick={() => changePage(Math.max(1, page - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pagination.page >= totalPages || loading}
                      onClick={() => changePage(Math.min(totalPages, page + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
