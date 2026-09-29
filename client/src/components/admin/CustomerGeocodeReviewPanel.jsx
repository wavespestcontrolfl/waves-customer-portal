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

// A confirmed discard here can still be followed, in the same synchronous
// click, by a REAL document navigation this module cannot see directly — a
// same-tab plain <a href> whose capture-phase click guard called this
// function and, once confirmed, lets the click become a normal browser
// navigation. That navigation fires its own native 'beforeunload' prompt a
// moment later (the effect below) unless it knows the discard was already
// approved. Record that approval for one tick only: a setTimeout(0) always
// clears it shortly after, so a confirm that did NOT lead to a real
// navigation (a same-page link, a declined-then-reverted history pop, an
// "All customers"/tab-switch click that just unmounts in place) never
// leaves the unload guard silently off for the rest of the draft's life;
// useGeocodeReview's own effect clears it again on every draft change for
// the same reason. A plain module-level flag, not React state — nothing
// here renders, and it must be readable synchronously from a native browser
// event.
let discardApproved = false;
function approveDiscard() {
  discardApproved = true;
  setTimeout(() => { discardApproved = false; }, 0);
}

// Shared by every control that would discard an open address-review draft —
// the queue's own customer links here, and the profile/workspace navigation
// guard in Customer360ProfileV2 (tab switches, All customers, customer
// switching, closing the profile) — so the wording never drifts between them.
export function confirmDiscardDraft() {
  const confirmed = window.confirm("This will discard the unsaved address review draft. Continue?");
  if (confirmed) approveDiscard();
  return confirmed;
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

function ReviewSummary({ record, draftActive, onSelectCustomer }) {
  const { status, label, help } = reviewStatus(record.review);
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {onSelectCustomer ? (
            <button
              type="button"
              className="p-0 border-0 bg-transparent text-left text-14 font-medium text-zinc-900 hover:underline cursor-pointer u-focus-ring"
              onClick={() => {
                if (draftActive && !confirmDiscardDraft()) return;
                onSelectCustomer(record.customer.id);
              }}
            >
              {customerName(record.customer)}
            </button>
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
      {canRevokePin(record) && (
        <Button
          variant="secondary"
          disabled={disabled}
          loading={saving}
          onClick={() => {
            if (!window.confirm("Revoke this verified location? This clears the customer's, primary property's, and any matching future visit's routing coordinates until it is reviewed again.")) return;
            onResolve({ revision: record.revision, action: "revoke" });
          }}
        >
          Revoke verification
        </Button>
      )}
    </div>
  );
}

function ReviewRecord({ record, active, draftActive, actionsDisabled, saving, error, conflicted, unavailable, onAcknowledgeConflict, onEdit, onResolve, onSelectCustomer }) {
  return (
    <div className="py-3 border-t border-hairline border-zinc-200 first:border-t-0">
      {!unavailable && (
        <>
          <ReviewSummary record={record} draftActive={draftActive} onSelectCustomer={onSelectCustomer} />
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

function useGeocodeReview({ customerId, onResolved, refreshToken, onDraftActiveChange }) {
  const [state, setState] = useState({ enabled: null, records: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [activeId, setActiveId] = useState(null);
  const [conflictId, setConflictId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [profileRefreshPending, setProfileRefreshPending] = useState(false);
  const [retryingProfileRefresh, setRetryingProfileRefresh] = useState(false);
  const requestRef = useRef(0);
  const abortRef = useRef(null);
  const saveAbortRef = useRef(null);
  const mountedRef = useRef(false);
  const scopeRef = useRef(0);
  const recordsRef = useRef(state.records);
  const activeIdRef = useRef(activeId);
  const retryInFlightRef = useRef(false);
  recordsRef.current = state.records;
  activeIdRef.current = activeId;

  // Lets a caller embedding this panel inside a larger navigation shell
  // (Customer 360's profile/workspace) guard its own tab switches, back
  // controls, and customer-switch links against silently discarding an
  // open draft — the same "draft active" signal this panel already uses
  // for its own row-level active/disabled state.
  useEffect(() => {
    onDraftActiveChange?.(Boolean(activeId));
    return () => onDraftActiveChange?.(false);
  }, [activeId, onDraftActiveChange]);

  // A closed tab/window loses an open draft just as silently as an in-app
  // navigation would — warn the same way the codebase's other unsaved-draft
  // surfaces do (e.g. TechServicePhotosModal, useServiceRecapDraft). Skip the
  // native prompt when confirmDiscardDraft() already approved THIS
  // navigation (a same-tab plain link guarded above it) — one browser
  // confirm is enough. A fresh or changed draft always re-arms the guard.
  useEffect(() => {
    if (!activeId) return undefined;
    discardApproved = false;
    const warn = (event) => {
      if (discardApproved) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [activeId]);

  // The one place that owns the "queue became disabled/unavailable" transition
  // (a refresh reporting enabled:false, or a resolve 404 whose code means the
  // whole route/gate went away) — clears every piece of active-draft state so
  // an invisible, disabled panel can never keep reporting a draft as active
  // (onDraftActiveChange, the beforeunload warning) or hold a stale conflict.
  const disablePanel = useCallback(() => {
    activeIdRef.current = null;
    setActiveId(null);
    setConflictId(null);
    setState({ enabled: false, records: [], total: 0 });
    setLoadError("");
    setError("");
  }, []);

  const acceptLoad = useCallback((payload, { preserveDraft, editingId }) => {
    const { records, total, previousRecord, refreshedRecord } = loadedReviewRecords(payload, customerId, recordsRef.current, editingId);
    if (payload?.enabled !== true) {
      disablePanel();
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
    // Sync immediately rather than waiting for this render to commit — a
    // caller awaiting load() right after (e.g. the 409 handler checking
    // whether its target is still queued) must see the refreshed records,
    // not the stale ones from before this fetch.
    recordsRef.current = records;
    setLoadError("");
    // editingId is captured when the request starts; if the admin canceled
    // the draft before this response arrived, activeIdRef no longer matches
    // it and there is no open form left to acknowledge a conflict on — treat
    // this the same as no conflict rather than re-opening a stale one.
    const stillEditing = editingId && activeIdRef.current === editingId;
    if (stillEditing && previousRecord && refreshedRecord && previousRecord.revision !== refreshedRecord.revision) {
      setConflictId(editingId);
      setError("This review changed elsewhere. Your entries are preserved, but saving is paused until you review the latest address and pin.");
    } else if (!preserveDraft) setError("");
    return true;
  }, [customerId, offset, disablePanel]);

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
        disablePanel();
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
  }, [customerId, offset, acceptLoad, disablePanel]);

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
    setProfileRefreshPending(false);
    return () => {
      scopeRef.current += 1;
      saveAbortRef.current?.abort();
    };
  }, [customerId, offset]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load, refreshToken]);

  // A resolve 404 means either the whole review route/gate went away, or
  // (distinguished by code) just the one record this admin was looking at.
  // Split out so `resolve`'s own branching stays under the complexity cap.
  const handleResolveNotFound = useCallback(async (saveError) => {
    if (saveError.code !== "customer_not_found") {
      disablePanel();
      return;
    }
    // This one queued customer disappeared (deleted elsewhere) — the review
    // route and gate are still live. Drop the stale draft and reload so
    // only that record clears from the queue.
    activeIdRef.current = null;
    setActiveId(null);
    setConflictId(null);
    await load({ preserveDraft: false });
  }, [load, disablePanel]);

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
      setProfileRefreshPending(refreshFailed);
      await load({ preserveDraft: refreshFailed });
      if (current() && refreshFailed) setError("Address review saved, but the customer profile could not refresh. Reload the profile to see the latest details.");
    } catch (saveError) {
      if (saveError.name === "AbortError" || !current()) return;
      if (saveError.status === 404) {
        await handleResolveNotFound(saveError);
        return;
      }
      if (saveError.status === 409) {
        const conflictMessage = saveError.message || "This review changed elsewhere.";
        await load({ preserveDraft: true });
        if (!current()) return;
        // The refreshed queue can legitimately omit this customer (e.g. another
        // admin's action just resolved it). With no row left, there is nothing
        // to acknowledge or cancel a conflict on — clear the stale target and
        // let the refreshed queue stand instead of pinning every row's actions
        // disabled behind a conflict that can never be dismissed.
        const stillQueued = recordsRef.current.some((queued) => queued.customer.id === record.customer.id);
        if (!stillQueued) {
          activeIdRef.current = null;
          setActiveId(null);
          setConflictId(null);
          setError("");
          return;
        }
        if (activeIdRef.current !== record.customer.id) {
          activeIdRef.current = record.customer.id;
          setActiveId(record.customer.id);
        }
        setConflictId(record.customer.id);
        setError(`${conflictMessage}${/[.!?]$/.test(conflictMessage) ? "" : "."} Your entries are preserved, but saving is paused until you review the latest address and pin.`);
      } else {
        // Retry commits pending before ensureCustomerGeocoded, and every
        // action does a final getReviewDetail after commit — so a non-409,
        // non-404 failure here can still arrive after the server committed.
        // Reload the authoritative queue rather than assert the save
        // definitely failed.
        await load({ preserveDraft: true });
        if (!current()) return;
        setError("Address review may not have saved. The latest record is loaded; check it before trying again.");
      }
    } finally {
      if (current()) setSavingId(null);
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
    }
  };

  // The one action offered while a resolve succeeded but the profile-scoped
  // onResolved reload failed: retry that same reload rather than the
  // geocode-review load() (which has already refreshed and would otherwise
  // clear this warning without the customer profile ever having recovered).
  // Guarded against re-entry: a double-click used to start a second reload
  // that the profile's own stale-response guard would abort and resolve as
  // null, letting the FIRST click's success handler clear the pending flag
  // before the customer profile had actually recovered. Serializing here
  // means only one retry is ever in flight, so that race cannot happen.
  const retryProfileRefresh = async () => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    setRetryingProfileRefresh(true);
    const scope = scopeRef.current;
    const current = () => mountedRef.current && scope === scopeRef.current;
    try {
      await onResolved?.();
      if (!current()) return;
      setProfileRefreshPending(false);
      setError("");
    } catch {
      if (!current()) return;
      setError("Address review saved, but the customer profile could not refresh. Reload the profile to see the latest details.");
    } finally {
      retryInFlightRef.current = false;
      if (current()) setRetryingProfileRefresh(false);
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
  return { state, offset, setOffset, activeId, conflictId, savingId, error, loadError, detailLoading, profileRefreshPending, retryingProfileRefresh, load, resolve, retryProfileRefresh, acknowledgeConflict, editRecord };
}

function ReviewContents({ customerId, onSelectCustomer, model }) {
  const { state, offset, setOffset, activeId, conflictId, savingId, error, loadError, detailLoading, profileRefreshPending, retryingProfileRefresh, load, resolve, retryProfileRefresh, acknowledgeConflict, editRecord } = model;
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
          <Button
            variant="secondary"
            // retryingProfileRefresh is only ever set while profileRefreshPending
            // is also true (it's set inside the branch below that requires it) —
            // no need to re-check that here.
            disabled={retryingProfileRefresh}
            loading={retryingProfileRefresh}
            onClick={async () => {
              // A pending profile refresh has nothing to do with the geocode
              // queue itself — retry the failed profile reload so the warning
              // clears only once the customer profile has actually recovered.
              if (profileRefreshPending) {
                await retryProfileRefresh();
                return;
              }
              await load({ preserveDraft: Boolean(activeId) });
            }}
          >Refresh</Button>
        </div>
      )}
      {detailLoading && <div className="pt-3 border-t border-hairline border-zinc-200 text-14 text-ink-secondary">Loading address review…</div>}
      {showEmpty ? <div className="pt-3 border-t border-hairline border-zinc-200 text-14 text-ink-secondary">No addresses need review.</div> : visibleRecords.map((record) => (
        <ReviewRecord
          key={record.customer.id}
          record={record}
          active={activeId === record.customer.id}
          draftActive={Boolean(activeId)}
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

export default function CustomerGeocodeReviewPanel({ customerId = null, onSelectCustomer, onResolved, refreshToken = 0, onDraftActiveChange }) {
  const [open, setOpen] = useState(false);
  const model = useGeocodeReview({ customerId, onResolved, refreshToken, onDraftActiveChange });
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
