import { useCallback, useEffect, useRef, useState } from "react";
import { Utensils } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Table, THead, TBody, TR, TH, TD, UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { formatETDate, formatETDateOnly } from "../../lib/timezone";

// Restaurants (admin only, read only). New restaurants, new owners and inspections that found pests, from the state's
// public restaurant files, so the owner can choose who to pitch. Nothing here is sent to anyone and no AI is used.

const PERIODS = [
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];
const REASON_LABELS = { new_restaurant: "New restaurant", new_owner: "New owner", pest_finding: "Pests found" };

// An error answer may carry no JSON body. A success whose body cannot be read (cut off on the way) is an error
// too, so the page shows Try again, never a broken list.
async function readRestaurants(days) {
  const res = await adminFetch(`/admin/prospects/restaurants?days=${days}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json().catch(() => { throw new Error("The answer could not be read."); });
}

const dayText = (value) => (value ? formatETDateOnly(value, { month: "short", day: "numeric", year: "numeric" }) : "");
const shortDay = (value) => (value ? formatETDateOnly(value, { month: "short", day: "numeric" }) : "");
const countText = (count) => Number(count || 0).toLocaleString("en-US");
const plural = (count, word) => `${countText(count)} ${word}${count === 1 ? "" : "s"}`;
// The state's phone, stored as the 10 national digits.
const phoneText = (phone) => (/^\d{10}$/.test(phone || "") ? `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}` : phone || "Not listed");
// At 1100 px and under the table shows each restaurant as a stacked record (the shared records layout): counts read left there.
const COUNT_CELL = "align-middle max-[1100px]:text-left";

const readDay = (value) => formatETDate(value, { month: "short", day: "numeric", year: "numeric" });

// The line counts the two reasons a full read of the license files proves: new restaurants and new owners. The period
// runs to today, but the list knows only what the last full read found (readAt: the weekly job's last run that read all
// three state files without a failure), so the counts name that read. It gives no pest count: an inspection shows only
// once its report has been read, so a count of them would say nothing about the period. Pest rows show in the list as
// their reports are read.
export function summaryText(data) {
  const { counts, from, through, readAt } = data;
  return `${plural(counts.new_restaurant, "new restaurant")} and ${plural(counts.new_owner, "new owner")} from ${shortDay(from)} to ${shortDay(through)}, as of the state files read on ${readDay(readAt)}.`;
}

// While a weekly run has not finished (readUnfinishedSince), or after one failed (readFailedAt), the job may have
// committed some files and not others: the rows may mix two reads.
export function stateText(data) {
  const full = `The state files were last read in full on ${readDay(data.readAt)}.`;
  if (data.readUnfinishedSince) {
    return `The weekly read that started on ${readDay(data.readUnfinishedSince)} has not finished, so this list may be missing restaurants. ${full}`;
  }
  return `The weekly read on ${readDay(data.readFailedAt)} failed, so this list may be missing restaurants. ${full}`;
}

// The line above the list. Before the first run that read all three files (readAt null), while a run has not finished
// (readUnfinishedSince) or after one failed (readFailedAt), the rows may come from one file or mix two reads: counts
// would claim what the state has not answered, so the line says the list may be missing restaurants. The counts cover
// the whole period; the list stops at its newest 1,000 rows, and then says so.
export function headlineText(data) {
  if (!data.readAt) return "Not every state file has been read yet, so this list may be missing restaurants.";
  if (data.readUnfinishedSince || data.readFailedAt) return stateText(data);
  const total = data.counts.new_restaurant + data.counts.new_owner + data.counts.pest_finding;
  const cut = data.rows.length < total ? `The list shows the newest ${countText(data.rows.length)}.` : "";
  return [summaryText(data), cut].filter(Boolean).join(" ");
}

// One request per period. A late answer for a period the owner already left is dropped.
function useRestaurants(days) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const latest = useRef(0);
  const load = useCallback(() => {
    const ticket = ++latest.current;
    setState({ loading: true, error: "", data: null });
    readRestaurants(days)
      .then((data) => ticket === latest.current && setState({ loading: false, error: "", data }))
      .catch((err) => ticket === latest.current && setState({ loading: false, error: err.message, data: null }));
  }, [days]);
  useEffect(() => {
    load();
    return () => { latest.current += 1; };
  }, [load]);
  return { ...state, load };
}

function RestaurantTable({ rows }) {
  return (
    <Card>
      <CardBody className="p-0">
        <Table aria-label="Restaurants" layout="records" className="min-[1101px]:min-w-[760px]">
          <THead>
            <TR>
              <TH>Date</TH>
              <TH>Restaurant</TH>
              <TH>Why</TH>
              <TH>Address</TH>
              <TH>Phone</TH>
              <TH align="right">Seats</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD data-label="Date" nums className="whitespace-nowrap align-top">{dayText(row.eventDate)}</TD>
                <TD data-label="Restaurant" className="align-top">
                  <span className="text-ui-body font-medium text-zinc-900">{row.name || "No name"}</span>
                  {row.isNew && <span className="ml-2 inline-flex align-middle"><Badge tone="neutral">New</Badge></span>}
                </TD>
                <TD data-label="Why" className="align-top">
                  {REASON_LABELS[row.reason] || row.reason}
                  {row.findings.length > 0 && (
                    <ul className="m-0 mt-1 list-none p-0 text-ui-body text-ink-secondary">
                      {row.findings.map((finding, index) => <li key={`${finding.code}-${index}`}>{finding.text || finding.code}</li>)}
                    </ul>
                  )}
                </TD>
                <TD data-label="Address" className="align-top">{[row.address, row.city, row.zip].filter(Boolean).join(", ") || "Not listed"}</TD>
                <TD data-label="Phone" nums className="whitespace-nowrap align-top">{phoneText(row.phone)}</TD>
                <TD data-label="Seats" nums align="right" className={COUNT_CELL}>{row.seats == null ? "Not listed" : countText(row.seats)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

export default function RestaurantProspectsPage({ embedded = false }) {
  const [days, setDays] = useState(PERIODS[0].days);
  const period = PERIODS.find((entry) => entry.days === days);
  const { loading, error, data, load } = useRestaurants(days);

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1100px]">
      {!embedded && <AdminCommandHeader variant="workspace" title="Restaurants" icon={Utensils} />}

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        New restaurants, new owners and inspections that found pests, from the state&apos;s public restaurant files. Manatee,
        Sarasota and Charlotte counties, without Punta Gorda. Food trucks are left out. The state files are read each Monday.
        An inspection shows once its report has been read.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Period">
        {PERIODS.map((entry) => (
          <Button key={entry.days} size="sm" variant={days === entry.days ? "primary" : "secondary"} aria-pressed={days === entry.days} onClick={() => setDays(entry.days)}>
            {entry.label}
          </Button>
        ))}
      </div>

      {loading && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading restaurants…</div>}
      {error && <ActionFeedback error onRetry={load} className="mb-3">{error}</ActionFeedback>}
      {/* Before the first full read there is no window to claim counts for; a first run may have read one file. */}
      {data && !data.readAt && data.rows.length === 0 && (
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Not every state file has been read yet.</div>
      )}
      {data && (data.readAt || data.rows.length > 0) && (
        <>
          <p className="mb-3 text-ui-body text-zinc-900">{headlineText(data)}</p>
          {data.rows.length === 0
            ? <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Nothing in the {period.label.toLowerCase()} so far.</div>
            : <RestaurantTable rows={data.rows} />}
        </>
      )}
    </UiSurface>
  );
}
