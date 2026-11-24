import { useCallback, useEffect, useRef, useState } from "react";
import { Mail } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Button, Card, CardBody, Table, THead, TBody, TR, TH, TD, UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { formatETDate, formatETDateOnly } from "../../lib/timezone";

// Mail (admin only, read only). The new-home list: buyers of a new home, from the county's public deed list, who would
// get a postcard in a later step, with each home's shadow price. Nothing here is sent to anyone, no AI is used and no row
// is written.

const VIEWS = [
  { key: "live", label: "Homes" },
  { key: "not_eligible", label: "Not eligible" },
  { key: "unmatched", label: "No match yet" },
];
const GROUP_LABELS = { eligible: "Card", held_back: "Held back" };
// One plain label for each reason the run writes (services/mail/new-home-list.js). An unknown code shows as it is.
const REASON_LABELS = {
  company_buyer: "Company buyer",
  trust_buyer: "Trust buyer",
  unclear_buyer: "Buyer not clear",
  no_lot: "No lot in the deed",
  known_address: "Address already known to Waves",
  duplicate_parcel: "Home already on the list",
  duplicate_permit: "Permit already used for another home",
  lookup_failed: "County map did not answer",
  no_parcel: "No parcel found",
  no_permit: "No new-home permit",
  unknown_plat: "Plat not recognized",
  ambiguous: "More than one parcel fits",
  no_address: "No street address",
};
const reasonLabel = (reason) => (reason ? REASON_LABELS[reason] || reason : "Not given");

// The shadow price (mailer step 2b): the quarterly pest plan price the price pass stored for an eligible home. Nobody is
// quoted from it. One plain label for each price status and reason (services/mail/home-price.js, home-facts.js,
// home-quote.js). An unknown code shows as it is.
const PRICE_STATUS_LABELS = {
  priced: "Priced",
  not_clean: "No price",
  missing_fact: "Waiting for a fact",
  failed: "Will try again",
  untried: "Not priced yet",
};
const PRICE_REASON_LABELS = {
  no_home_size: "No home size yet",
  no_stories: "No story count yet",
  no_lot_size: "No lot size yet",
  permit_row: "Permit not found",
  parcel_map: "County map did not answer",
  permit_page: "Permit page did not answer",
  permit_canceled: "Permit canceled",
  not_single_family: "Not a single-family home",
  member_address: "A customer already lives there",
  member_unchecked: "A customer may live there",
  member_check: "Customer check did not answer",
  engine: "Price engine did not answer",
  engine_review: "Price needs a review",
  not_server_price: "Not a list price",
  not_one_line: "More than one line",
  no_amount: "No amount",
  save_refused: "Estimate check refused it",
};
const SIZE_SOURCE_LABELS = { parcel_map: "county map", permit_plan: "permit plan" };
const money = (value) => Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function priceText(price) {
  if (!price) return "";
  if (price.status === "priced" && price.monthly != null) {
    return `${money(price.monthly)} a month${price.setupFee ? ` + ${money(price.setupFee)} setup` : ""}`;
  }
  const status = PRICE_STATUS_LABELS[price.status] || price.status;
  return price.reason ? `${status}: ${PRICE_REASON_LABELS[price.reason] || price.reason}` : status;
}

export function factsText(price) {
  if (!price || !price.homeSqft) return "";
  const parts = [`${countText(price.homeSqft)} sq ft${price.sizeSource ? ` (${SIZE_SOURCE_LABELS[price.sizeSource] || price.sizeSource})` : ""}`];
  if (price.stories) parts.push(`${price.stories} ${Number(price.stories) === 1 ? "story" : "stories"}`);
  if (price.lotSqft) parts.push(`lot ${countText(price.lotSqft)} sq ft`);
  return parts.join(", ");
}

// A home marked as mailed: the day, the print batch and how often its typed address was used. Its price no longer changes.
export function mailedText(row) {
  if (!row || !row.mailedAt) return "";
  const parts = [`Mailed ${formatETDate(row.mailedAt, { month: "short", day: "numeric", year: "numeric" })}`];
  if (row.mailBatch) parts.push(`batch ${row.mailBatch}`);
  parts.push(`${countText(row.typedViews)} typed ${Number(row.typedViews) === 1 ? "visit" : "visits"}`);
  return parts.join(" · ");
}

// The line under the runs: how far the price pass got on the homes that get a card.
export function priceCountsText(priceCounts) {
  if (!priceCounts) return "";
  const parts = [
    ["Priced", priceCounts.priced],
    ["no price", priceCounts.notClean],
    ["waiting for a fact", priceCounts.missingFact],
    ["will try again", priceCounts.failed],
    ["not priced yet", priceCounts.untried],
  ].filter(([, count], i) => i === 0 || count > 0);
  return `Shadow prices: ${parts.map(([label, count]) => `${label} ${countText(count)}`).join(" · ")}`;
}

// An error answer may carry no JSON body. A success whose body cannot be read (cut off on the way) is an error
// too, so the page shows Try again, never a broken list.
async function readMail(view) {
  const res = await adminFetch(`/admin/prospects/mail?view=${view}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json().catch(() => { throw new Error("The answer could not be read."); });
}

const dayText = (value) => (value ? formatETDateOnly(value, { month: "short", day: "numeric", year: "numeric" }) : "");
const timeText = (value) => formatETDate(value, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const countText = (count) => Number(count || 0).toLocaleString("en-US");

// The line under the counts: the newest deed the list holds and when the run last checked a row, or that no run has
// stored anything yet.
export function runText(data) {
  if (!data.newestRecordedDate && !data.lastCheckedAt) return "No run yet.";
  return `Newest deed: ${data.newestRecordedDate ? dayText(data.newestRecordedDate) : "none"} · Last checked: ${data.lastCheckedAt ? timeText(data.lastCheckedAt) : "never"}`;
}

// One request per view. A late answer for a view the owner already left is dropped.
function useMail(view) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const latest = useRef(0);
  const load = useCallback(() => {
    const ticket = ++latest.current;
    setState({ loading: true, error: "", data: null });
    readMail(view)
      .then((data) => ticket === latest.current && setState({ loading: false, error: "", data }))
      .catch((err) => ticket === latest.current && setState({ loading: false, error: err.message, data: null }));
  }, [view]);
  useEffect(() => {
    load();
    return () => { latest.current += 1; };
  }, [load]);
  return { ...state, load };
}

function CountCard({ label, value, note }) {
  return (
    <Card>
      <CardBody>
        <div className="text-ui-body text-ink-secondary">{label}</div>
        <div className="text-2xl font-semibold text-zinc-900">{countText(value)}</div>
        {note && <div className="text-ui-body text-ink-secondary">{note}</div>}
      </CardBody>
    </Card>
  );
}

const buyerText = (row) => (row.recipientNames.length ? row.recipientNames.join(", ") : "Not listed");

function HomesTable({ rows }) {
  return (
    <Card>
      <CardBody className="p-0">
        <Table aria-label="Homes" layout="records" className="min-[1101px]:min-w-[760px]">
          <THead>
            <TR>
              <TH>Recorded</TH>
              <TH>Buyer</TH>
              <TH>Address</TH>
              <TH>Subdivision</TH>
              <TH>Group</TH>
              <TH>Shadow price</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD data-label="Recorded" nums className="whitespace-nowrap align-top">{dayText(row.recordedDate)}</TD>
                <TD data-label="Buyer" className="align-top"><span className="text-ui-body font-medium text-zinc-900">{buyerText(row)}</span></TD>
                <TD data-label="Address" className="align-top">
                  {[row.addressLine1, row.city, row.zip].filter(Boolean).join(", ") || "Not listed"}
                  {row.pageSlug && <div className="text-ui-body text-ink-secondary">{`gowavesfl.com/${row.pageSlug}`}</div>}
                </TD>
                <TD data-label="Subdivision" className="align-top">{row.subdivision || "Not listed"}</TD>
                <TD data-label="Group" className="align-top">{GROUP_LABELS[row.status] || row.status}</TD>
                <TD data-label="Shadow price" className="align-top">
                  {row.status === "eligible" ? (
                    <>
                      <span className="text-ui-body text-zinc-900">{priceText(row.price)}</span>
                      {factsText(row.price) && <div className="text-ui-body text-ink-secondary">{factsText(row.price)}</div>}
                      {mailedText(row) && <div className="text-ui-body text-ink-secondary">{mailedText(row)}</div>}
                    </>
                  ) : <span className="text-ui-body text-ink-secondary">No card</span>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function MissedTable({ rows, label }) {
  return (
    <Card>
      <CardBody className="p-0">
        <Table aria-label={label} layout="records" className="min-[1101px]:min-w-[760px]">
          <THead>
            <TR>
              <TH>Recorded</TH>
              <TH>Buyer</TH>
              <TH>Lot</TH>
              <TH>Reason</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD data-label="Recorded" nums className="whitespace-nowrap align-top">{dayText(row.recordedDate)}</TD>
                <TD data-label="Buyer" className="align-top"><span className="text-ui-body font-medium text-zinc-900">{buyerText(row)}</span></TD>
                <TD data-label="Lot" className="align-top">{row.legalDescription || "Not listed"}</TD>
                <TD data-label="Reason" className="align-top">{reasonLabel(row.reason)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

export default function MailProspectsPage({ embedded = false }) {
  const [view, setView] = useState(VIEWS[0].key);
  const { loading, error, data, load } = useMail(view);
  const reasons = data ? data.reasons.filter((entry) => entry.status === view) : [];

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1100px]">
      {!embedded && <AdminCommandHeader variant="workspace" title="Mail" icon={Mail} />}

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        New-home buyers from the county deed list. The prices are shadow prices until a home is marked as mailed; a mailed home's price is frozen.
      </div>

      {loading && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading the mail list…</div>}
      {error && <ActionFeedback error onRetry={load} className="mb-3">{error}</ActionFeedback>}

      {data && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <CountCard label="Get a card" value={data.counts.eligible} />
            <CountCard label="Held back" value={data.counts.heldBack} note="No card: the comparison group" />
            <CountCard label="Not eligible" value={data.counts.notEligible} />
            <CountCard label="No match yet" value={data.counts.unmatched} />
          </div>
          <p className="mb-1 text-ui-body text-zinc-900">{runText(data)}</p>
          {data.priceCounts && <p className="mb-3 text-ui-body text-zinc-900">{priceCountsText(data.priceCounts)}</p>}
        </>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="View">
        {VIEWS.map((entry) => (
          <Button key={entry.key} size="sm" variant={view === entry.key ? "primary" : "secondary"} aria-pressed={view === entry.key} onClick={() => setView(entry.key)}>
            {entry.label}
          </Button>
        ))}
      </div>

      {data && (
        <>
          {reasons.length > 0 && (
            <ul className="m-0 mb-3 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-ui-body text-zinc-900" aria-label="Reasons">
              {reasons.map((entry) => <li key={`${entry.status}-${entry.reason}`}>{reasonLabel(entry.reason)}: {countText(entry.count)}</li>)}
            </ul>
          )}
          {data.rows.length > 0 && view === "live" && <HomesTable rows={data.rows} />}
          {data.rows.length > 0 && view !== "live" && <MissedTable rows={data.rows} label={VIEWS.find((entry) => entry.key === view).label} />}
          {data.truncated && <p className="mt-3 text-ui-body text-ink-secondary">Showing the newest 300.</p>}
          {data.rows.length === 0 && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Nothing here yet.</div>}
        </>
      )}
    </UiSurface>
  );
}
