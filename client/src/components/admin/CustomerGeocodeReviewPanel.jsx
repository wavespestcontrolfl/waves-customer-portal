import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, MapPin } from "lucide-react";
import { adminFetch } from "../../utils/admin-fetch";
import { formatETDateOnly, formatETDateTime } from "../../lib/timezone";
import { Badge, Button, Card, CardBody, UiSurface, cn } from "../ui";

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

function ReviewRecord({ record, onSelectCustomer }) {
  const status = record.review?.status || "pending";
  const reviewedOutsideArea = status === "outside_area" && Boolean(record.review?.reviewed_at);
  const statusLabel = reviewedOutsideArea
    ? "Confirmed outside service area"
    : STATUS_LABELS[status] || "Needs review";
  const statusHelp = reviewedOutsideArea
    ? "Staff confirmed this primary service address is outside the service area."
    : reviewHelp(record.review);
  const showVerifiedEvidence = status === "verified"
    && (record.review?.source || record.review?.reviewed_at || record.review?.evidence);

  return (
    <div className="py-3 border-t border-hairline border-zinc-200 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {onSelectCustomer ? (
            <button type="button" className="p-0 border-0 bg-transparent text-left text-14 font-medium text-zinc-900 hover:underline cursor-pointer u-focus-ring" onClick={() => onSelectCustomer(record.customer.id)}>{customerName(record.customer)}</button>
          ) : <div className="text-14 font-medium text-zinc-900">Primary service location</div>}
          <div className="text-14 text-ink-secondary break-words">{addressText(record.customer) || "No complete address on file"}</div>
        </div>
        <Badge tone={status === "outside_area" ? "alert" : "neutral"}>{statusLabel}</Badge>
      </div>
      <div className="mt-1 text-14 text-ink-secondary">{statusHelp}</div>
      {showVerifiedEvidence && (
        <div className="mt-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-2.5 text-14 text-ink-secondary">
          <div>
            Verified by {SOURCE_LABELS[record.review.source] || "staff review"}
            {record.review.reviewed_at ? ` on ${formatETDateTime(record.review.reviewed_at, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
          </div>
          {record.review.evidence && <div className="mt-1 text-zinc-900">{record.review.evidence}</div>}
        </div>
      )}
      {record.next_visit_date && <div className="mt-1 text-14 text-ink-tertiary">Next visit: {formatETDateOnly(record.next_visit_date, { month: "short", day: "numeric", year: "numeric" })}</div>}
    </div>
  );
}

export default function CustomerGeocodeReviewPanel({ customerId = null, onSelectCustomer, refreshToken = 0 }) {
  const [state, setState] = useState({ enabled: null, records: [], total: 0 });
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const request = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const path = customerId
        ? `/admin/customer-geocodes/${encodeURIComponent(customerId)}?scope=primary`
        : `/admin/customer-geocodes?limit=${PAGE_SIZE}&offset=${offset}`;
      const payload = await adminFetch(path, { signal: controller.signal });
      if (request !== requestRef.current || controller.signal.aborted) return;
      const records = customerId && payload?.customer ? [payload] : payload?.records || [];
      const total = payload?.total ?? records.length;
      if (!customerId && offset > 0 && offset >= total) {
        setOffset(total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : 0);
        return;
      }
      setState({ enabled: payload?.enabled === true, records, total });
      setError("");
    } catch (loadError) {
      if (loadError.name === "AbortError" || request !== requestRef.current) return;
      if (loadError.status === 404) {
        setState({ enabled: false, records: [], total: 0 });
        setError("");
        return;
      }
      setError(loadError.message || "Address review could not load.");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [customerId, offset, refreshToken]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  if (state.enabled === false) return null;
  if (state.enabled === null && !error) return null;
  const title = customerId ? "Primary service location review" : "Address review queue";
  return (
    <UiSurface density="comfortable" className={cn("mb-3", customerId && "mt-3")}>
    <Card>
      <button
        type="button"
        className="w-full min-h-11 px-4 py-3 flex items-center justify-between gap-3 text-left bg-transparent border-0 cursor-pointer u-focus-ring"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex items-center gap-2 text-14 font-medium text-zinc-900"><MapPin size={16} />{title}</span>
        <span className="flex items-center gap-2 text-14 text-ink-secondary">{!customerId && state.total > 0 ? state.total : ""}<ChevronDown size={16} className={cn("transition-transform", open && "rotate-180")} /></span>
      </button>
      {open && (
        <CardBody className="pt-0">
          {error && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div role="alert" className="text-14 text-alert-fg">{error}</div>
              <Button variant="secondary" onClick={load}>Refresh</Button>
            </div>
          )}
          {!error && state.records.length === 0 ? <div className="pt-3 border-t border-hairline border-zinc-200 text-14 text-ink-secondary">No addresses need review.</div> : state.records.map((record) => (
            <ReviewRecord key={record.customer.id} record={record} onSelectCustomer={onSelectCustomer} />
          ))}
          {!customerId && state.total > PAGE_SIZE && (
            <div className="pt-3 border-t border-hairline border-zinc-200 flex flex-wrap items-center justify-between gap-2 text-14 text-ink-secondary">
              <span>Showing {offset + 1}–{Math.min(offset + state.records.length, state.total)} of {state.total}</span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Previous</Button>
                <Button variant="secondary" disabled={offset + PAGE_SIZE >= state.total} onClick={() => setOffset((value) => value + PAGE_SIZE)}>Next</Button>
              </div>
            </div>
          )}
        </CardBody>
      )}
    </Card>
    </UiSurface>
  );
}
