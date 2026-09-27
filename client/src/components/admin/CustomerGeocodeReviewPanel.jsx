import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, MapPin } from "lucide-react";
import { adminFetch } from "../../utils/admin-fetch";
import { formatETDateOnly, formatETDateTime } from "../../lib/timezone";
import { Badge, Button, Card, CardBody, UiSurface, cn } from "../ui";
import CustomerGeocodeReviewForm, { canRevokePin, hasCompletePin } from "./CustomerGeocodeReviewForm";

const PAGE_SIZE = 25;

const STATUS_LABELS = {
  needs_details: "Address needs details",
  needs_pin: "Pin needs review",
  outside_area: "Possible outside area",
  provider_unavailable: "Lookup unavailable",
  geocoded: "Automatically located",
  verified: "Verified",
  pending: "Review pending",
};

const STATUS_HELP = {
  needs_details: "Complete or correct the primary service address before verifying its location.",
  needs_pin: "Choose the exact primary service location on the map.",
  outside_area: "The current location appears outside the service area. Confirm it or mark it outside the service area.",
  provider_unavailable: "Automatic address lookup could not finish. Retry it or verify the location manually.",
  geocoded: "Automatic lookup located this primary service address.",
  verified: "The primary service location has been verified.",
  pending: "Automatic address review is waiting to run.",
};

const SOURCE_LABELS = {
  county_records: "County records",
  customer_confirmation: "Customer confirmation",
  site_visit: "Site visit",
  google: "Google address lookup",
};

const REVIEW_REASON_HELP = {
  partial_match: "Lookup matched only part of the address. Confirm the full address and exact property location.",
  no_result: "No address match was found. Confirm the address and exact property location.",
  no_location: "Lookup did not return a map pin. Confirm the exact property location.",
  address_changed: "The address changed after review. Confirm this service location again.",
  pin_changed: "The map pin changed after review. Confirm this service location again.",
  verification_revoked: "The previous pin was revoked. Confirm a new pin before routing to this property.",
};

function reviewHelp(review) {
  if (review?.reason?.startsWith("coarse_result:")) return "Lookup found only a general area. Confirm the exact property location.";
  return REVIEW_REASON_HELP[review?.reason] || STATUS_HELP[review?.status] || "Review the primary service address and location.";
}

function customerName(customer) {
  return [customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || "Unnamed customer";
}

function addressText(customer) {
  return [
    customer?.address_line1,
    customer?.address_line2,
    customer?.city,
    customer?.state,
    customer?.zip,
  ].filter(Boolean).join(", ");
}

function reviewStatus(review) {
  const status = review?.status || "pending";
  const reviewedOutsideArea = status === "outside_area" && Boolean(review?.reviewed_at);
  return {
    status,
    label: reviewedOutsideArea ? "Confirmed outside service area" : STATUS_LABELS[status] || "Needs review",
    help: reviewedOutsideArea
      ? "Staff confirmed this primary service address is outside the service area."
      : reviewHelp(review),
  };
}

function ReviewEvidence({ review }) {
  if (review?.status !== "verified" || !(review.source || review.reviewed_at || review.evidence)) return null;
  return (
    <div className="mt-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-2.5 text-14 text-ink-secondary">
      <div>
        Verified by {SOURCE_LABELS[review.source] || "staff review"}
        {review.reviewed_at ? ` on ${formatETDateTime(review.reviewed_at, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
      </div>
      {review.evidence && <div className="mt-1 text-zinc-900">{review.evidence}</div>}
    </div>
  );
}

function ReviewSummary({ record, onSelectCustomer }) {
  const { status, label, help } = reviewStatus(record.review);
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {onSelectCustomer ? (
            <button type="button" className="p-0 border-0 bg-transparent text-left text-14 font-medium text-zinc-900 hover:underline cursor-pointer u-focus-ring" onClick={() => onSelectCustomer(record.customer.id)}>{customerName(record.customer)}</button>
          ) : <div className="text-14 font-medium text-zinc-900">Primary service location</div>}
          <div className="text-14 text-ink-secondary break-words">{addressText(record.customer) || "No complete address on file"}</div>
        </div>
        <Badge tone={status === "outside_area" ? "alert" : "neutral"}>{label}</Badge>
      </div>
      <div className="mt-1 text-14 text-ink-secondary">{help}</div>
      <ReviewEvidence review={record.review} />
      {record.next_visit_date && <div className="mt-1 text-14 text-ink-tertiary">Next visit: {formatETDateOnly(record.next_visit_date, { month: "short", day: "numeric", year: "numeric" })}</div>}
    </>
  );
}

function ReviewActions({ record, disabled, saving, onEdit, onResolve }) {
  const retryAvailable = record.review?.status === "provider_unavailable" && !hasCompletePin(record.customer);
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      <Button variant="secondary" disabled={disabled} onClick={onEdit}>Review location</Button>
      {retryAvailable && <Button variant="secondary" disabled={disabled} loading={saving} onClick={() => onResolve({ revision: record.revision, action: "retry" })}>Retry saved address</Button>}
      {canRevokePin(record) && <Button variant="secondary" disabled={disabled} loading={saving} onClick={() => onResolve({ revision: record.revision, action: "revoke" })}>Revoke verification</Button>}
    </div>
  );
}

function ReviewRecord({ record, active, actionsDisabled, saving, error, conflicted, unavailable, onAcknowledgeConflict, onEdit, onResolve, onSelectCustomer }) {
  return (
    <div className="py-3 border-t border-hairline border-zinc-200 first:border-t-0">
      {!unavailable && (
        <>
          <ReviewSummary record={record} onSelectCustomer={onSelectCustomer} />
          {!active && <ReviewActions record={record} disabled={actionsDisabled} saving={saving} onEdit={onEdit} onResolve={onResolve} />}
        </>
      )}
      {active && !unavailable && (
        <div className="mt-2 text-14 text-ink-secondary">
          Latest saved pin: {hasCompletePin(record.customer) ? `${record.customer.latitude}, ${record.customer.longitude}` : "No saved pin"}
        </div>
      )}
      {active && <CustomerGeocodeReviewForm record={record} saving={saving} error={error} conflicted={conflicted} unavailable={unavailable} cancelDisabled={saving || (conflicted && !unavailable)} onAcknowledgeConflict={onAcknowledgeConflict} onResolve={onResolve} onCancel={onEdit} />}
    </div>
  );
}

function loadedReviewRecords(payload, customerId, previousRecords, editingId) {
  const records = customerId && payload?.customer ? [payload] : payload?.records || [];
  return {
    records,
    total: payload?.total ?? records.length,
    previousRecord: editingId ? previousRecords.find((record) => record.customer.id === editingId) : null,
    refreshedRecord: editingId ? records.find((record) => record.customer.id === editingId) : null,
  };
}

function useGeocodeReview({ customerId, onResolved, refreshToken }) {
  const [state, setState] = useState({ enabled: null, records: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [activeId, setActiveId] = useState(null);
  const [conflictId, setConflictId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const requestRef = useRef(0);
  const abortRef = useRef(null);
  const saveAbortRef = useRef(null);
  const mountedRef = useRef(false);
  const scopeRef = useRef(0);
  const recordsRef = useRef(state.records);
  const activeIdRef = useRef(activeId);
  recordsRef.current = state.records;
  activeIdRef.current = activeId;

  const acceptLoad = useCallback((payload, { preserveDraft, editingId }) => {
    const { records, total, previousRecord, refreshedRecord } = loadedReviewRecords(payload, customerId, recordsRef.current, editingId);
    if (payload?.enabled !== true) {
      setState({ enabled: false, records: [], total: 0 });
      setLoadError("");
      setError("");
      return false;
    }
    if (previousRecord && !refreshedRecord) {
      setLoadError("The current saved review is unavailable. Your entries are preserved, but saving is paused until it can be loaded. Refresh to try again.");
      return false;
    }
    if (!customerId && offset > 0 && offset >= total) {
      setOffset(total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : 0);
      return true;
    }
    setState({ enabled: true, records, total });
    setLoadError("");
    if (previousRecord && refreshedRecord && previousRecord.revision !== refreshedRecord.revision) {
      setConflictId(editingId);
      setError("This review changed elsewhere. Your entries are preserved, but saving is paused until you review the latest address and pin.");
    } else if (!preserveDraft) setError("");
    return true;
  }, [customerId, offset]);

  const load = useCallback(async ({ preserveDraft = false } = {}) => {
    const scope = scopeRef.current;
    const current = () => mountedRef.current && scope === scopeRef.current;
    abortRef.current?.abort();
    const request = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setLoadError("");
    setDetailLoading(true);
    try {
      const editingId = activeIdRef.current;
      const path = customerId
        ? `/admin/customer-geocodes/${encodeURIComponent(customerId)}?scope=primary`
        : `/admin/customer-geocodes?limit=${PAGE_SIZE}&offset=${offset}`;
      const payload = await adminFetch(path, { signal: controller.signal });
      if (request !== requestRef.current || !current()) return;
      return acceptLoad(payload, { preserveDraft, editingId });
    } catch (loadFailure) {
      if (loadFailure.name === "AbortError" || request !== requestRef.current || !current()) return;
      if (loadFailure.status === 404) {
        setState({ enabled: false, records: [], total: 0 });
        setLoadError("");
        setError("");
        return false;
      }
      setLoadError(loadFailure.message || "Address review could not load.");
      return false;
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setDetailLoading(false);
      }
    }
  }, [customerId, offset, acceptLoad]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeRef.current += 1;
      abortRef.current?.abort();
      saveAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    scopeRef.current += 1;
    saveAbortRef.current?.abort();
    activeIdRef.current = null;
    setActiveId(null);
    setConflictId(null);
    setSavingId(null);
    setError("");
    setLoadError("");
    return () => {
      scopeRef.current += 1;
      saveAbortRef.current?.abort();
    };
  }, [customerId, offset]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load, refreshToken]);

  const resolve = async (record, body) => {
    if (saveAbortRef.current) return;
    const scope = scopeRef.current;
    const controller = new AbortController();
    saveAbortRef.current = controller;
    const current = () => mountedRef.current && scope === scopeRef.current && !controller.signal.aborted;
    setSavingId(record.customer.id);
    setError("");
    try {
      await adminFetch(`/admin/customer-geocodes/${encodeURIComponent(record.customer.id)}/resolve`, {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!current()) return;
      activeIdRef.current = null;
      setActiveId(null);
      setConflictId(null);
      let refreshFailed = false;
      try {
        await onResolved?.();
      } catch {
        refreshFailed = true;
      }
      if (!current()) return;
      await load({ preserveDraft: refreshFailed });
      if (current() && refreshFailed) setError("Address review saved, but the customer profile could not refresh. Reload the profile to see the latest details.");
    } catch (saveError) {
      if (saveError.name === "AbortError" || !current()) return;
      if (saveError.status === 404) {
        setState({ enabled: false, records: [], total: 0 });
        return;
      }
      if (saveError.status === 409) {
        const conflictMessage = saveError.message || "This review changed elsewhere.";
        await load({ preserveDraft: true });
        if (!current()) return;
        if (activeIdRef.current !== record.customer.id) {
          activeIdRef.current = record.customer.id;
          setActiveId(record.customer.id);
        }
        setConflictId(record.customer.id);
        setError(`${conflictMessage}${/[.!?]$/.test(conflictMessage) ? "" : "."} Your entries are preserved, but saving is paused until you review the latest address and pin.`);
      } else {
        setError(saveError.message || "Address review could not be saved.");
      }
    } finally {
      if (current()) setSavingId(null);
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
    }
  };

  const acknowledgeConflict = () => { setConflictId(null); setError(""); };
  const editRecord = (customerId) => {
    if (activeIdRef.current === customerId) {
      activeIdRef.current = null;
      setActiveId(null);
      setConflictId(null);
      setError("");
      if (loadError) void load();
      return;
    }
    activeIdRef.current = customerId;
    setActiveId((id) => id === customerId ? null : customerId);
    setError("");
  };
  return { state, offset, setOffset, activeId, conflictId, savingId, error, loadError, detailLoading, load, resolve, acknowledgeConflict, editRecord };
}

function ReviewContents({ customerId, onSelectCustomer, model }) {
  const { state, offset, setOffset, activeId, conflictId, savingId, error, loadError, detailLoading, load, resolve, acknowledgeConflict, editRecord } = model;
  const recordsUnavailable = detailLoading || Boolean(loadError);
  const visibleRecords = recordsUnavailable
    ? state.records.filter((record) => record.customer.id === activeId)
    : state.records;
  const panelError = loadError || (!activeId ? error : "");
  const showEmpty = !detailLoading && !loadError && !error && state.records.length === 0;
  const showPagination = !detailLoading && !loadError && !customerId && state.total > PAGE_SIZE;
  return (
    <CardBody className="pt-0">
      {panelError && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div role="alert" className="text-14 text-alert-fg">{panelError}</div>
          <Button variant="secondary" onClick={async () => {
            await load({ preserveDraft: Boolean(activeId) });
          }}>Refresh</Button>
        </div>
      )}
      {detailLoading && <div className="pt-3 border-t border-hairline border-zinc-200 text-14 text-ink-secondary">Loading address review…</div>}
      {showEmpty ? <div className="pt-3 border-t border-hairline border-zinc-200 text-14 text-ink-secondary">No addresses need review.</div> : visibleRecords.map((record) => (
        <ReviewRecord
          key={record.customer.id}
          record={record}
          active={activeId === record.customer.id}
          actionsDisabled={Boolean(savingId) || Boolean(conflictId === record.customer.id) || Boolean(activeId && activeId !== record.customer.id)}
          saving={savingId === record.customer.id}
          error={activeId === record.customer.id ? error : ""}
          conflicted={conflictId === record.customer.id}
          unavailable={recordsUnavailable}
          onAcknowledgeConflict={acknowledgeConflict}
          onEdit={() => editRecord(record.customer.id)}
          onResolve={(body) => resolve(record, body)}
          onSelectCustomer={onSelectCustomer}
        />
      ))}
      {showPagination && (
        <div className="pt-3 border-t border-hairline border-zinc-200 flex flex-wrap items-center justify-between gap-2 text-14 text-ink-secondary">
          <span>Showing {offset + 1}–{Math.min(offset + state.records.length, state.total)} of {state.total}</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={offset === 0 || Boolean(savingId) || Boolean(activeId)} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Previous</Button>
            <Button variant="secondary" disabled={offset + PAGE_SIZE >= state.total || Boolean(savingId) || Boolean(activeId)} onClick={() => setOffset((value) => value + PAGE_SIZE)}>Next</Button>
          </div>
        </div>
      )}
    </CardBody>
  );
}

export default function CustomerGeocodeReviewPanel({ customerId = null, onSelectCustomer, onResolved, refreshToken = 0 }) {
  const [open, setOpen] = useState(false);
  const model = useGeocodeReview({ customerId, onResolved, refreshToken });
  const { state, loadError, error } = model;
  if (state.enabled === false) return null;
  if (state.enabled === null && !loadError && !error) return null;
  return (
    <UiSurface density="comfortable" className={cn("mb-3", customerId && "mt-3")}>
    <Card>
      <button
        type="button"
        className="w-full min-h-11 px-4 py-3 flex items-center justify-between gap-3 text-left bg-transparent border-0 cursor-pointer u-focus-ring"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex items-center gap-2 text-14 font-medium text-zinc-900"><MapPin size={16} />{customerId ? "Primary service location review" : "Address review queue"}</span>
        <span className="flex items-center gap-2 text-14 text-ink-secondary">{!customerId && state.total > 0 ? state.total : ""}<ChevronDown size={16} className={cn("transition-transform", open && "rotate-180")} /></span>
      </button>
      <div hidden={!open}><ReviewContents customerId={customerId} onSelectCustomer={onSelectCustomer} model={model} /></div>
    </Card>
    </UiSurface>
  );
}
