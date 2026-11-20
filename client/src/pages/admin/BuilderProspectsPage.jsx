import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Hammer } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, Table, THead, TBody, TR, TH, TD, UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { formatETDateOnly } from "../../lib/timezone";

// Builders (admin only, read only). Which builders pull permits in unincorporated Manatee County, so the owner can pitch
// pre-slab termite treatment. Pool builders come first. Nothing here is sent to anyone and no AI is used.

const KINDS = [
  { key: "pool", label: "Pool builders", noun: "pool permit", empty: "No pool builders pulled a permit in the last 12 months." },
  { key: "home", label: "Home builders", noun: "new-home permit", empty: "No home builders pulled a new-home permit in the last 12 months." },
];

async function api(path) {
  const res = await adminFetch(`/admin/prospects${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const dayText = (value) => (value ? formatETDateOnly(value, { month: "short", day: "numeric", year: "numeric" }) : "");
const shortDay = (value) => (value ? formatETDateOnly(value, { month: "short", day: "numeric" }) : "");
// At 1100 px and under the table shows each builder as a stacked record (the shared records layout): counts read left there.
const COUNT_CELL = "align-middle max-[1100px]:text-left";
const countText = (count) => Number(count || 0).toLocaleString("en-US");
const plural = (count, word) => `${countText(count)} ${word}${count === 1 ? "" : "s"}`;

// The county list arrives once a week, so the summary is the newest 7 days on file, named by its last day.
export function summaryText(data, noun) {
  const { permits, builders, through } = data.week;
  const span = through ? `in the 7 days to ${shortDay(through)}` : "in the newest 7 days on file";
  return `${plural(permits, noun)} ${span}, from ${plural(builders, "builder")}.`;
}

// One request per kind. A late answer for a kind the owner already left is dropped.
function useBuilders(kind) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  const latest = useRef(0);
  const load = useCallback(() => {
    const ticket = ++latest.current;
    setState({ loading: true, error: "", data: null });
    api(`/builders?kind=${kind}`)
      .then((data) => ticket === latest.current && setState({ loading: false, error: "", data }))
      .catch((err) => ticket === latest.current && setState({ loading: false, error: err.message, data: null }));
  }, [kind]);
  useEffect(() => {
    load();
    return () => { latest.current += 1; };
  }, [load]);
  return { ...state, load };
}

function useJobSites(kind) {
  const [open, setOpen] = useState("");
  const [sites, setSites] = useState({});
  const latest = useRef({});
  useEffect(() => { setOpen(""); setSites({}); latest.current = {}; }, [kind]);

  const fetchSites = useCallback((key) => {
    const ticket = (latest.current[key] || 0) + 1;
    latest.current[key] = ticket;
    setSites((prev) => ({ ...prev, [key]: { loading: true, error: "", permits: null } }));
    api(`/builders/permits?kind=${kind}&builder=${encodeURIComponent(key)}`)
      .then((body) => latest.current[key] === ticket && setSites((prev) => ({ ...prev, [key]: { loading: false, error: "", permits: body.permits } })))
      .catch((err) => latest.current[key] === ticket && setSites((prev) => ({ ...prev, [key]: { loading: false, error: err.message, permits: null } })));
  }, [kind]);

  const toggle = (key) => {
    if (open === key) { setOpen(""); return; }
    setOpen(key);
    if (!sites[key] || sites[key].error) fetchSites(key);
  };
  return { open, sites, toggle, retry: fetchSites };
}

function JobSites({ state, kind, onRetry }) {
  if (!state || state.loading) return <div className="py-3 text-ui-body text-ink-secondary">Loading job sites…</div>;
  if (state.error) return <ActionFeedback error onRetry={onRetry}>{state.error}</ActionFeedback>;
  if (!state.permits.length) return <div className="py-3 text-ui-body text-ink-secondary">No job sites on file.</div>;
  return (
    <Table aria-label="Newest job sites" layout="records">
      <THead>
        <TR>
          <TH>Issued</TH>
          <TH>Address</TH>
          <TH>{kind === "home" ? "ZIP" : "City and ZIP"}</TH>
          {kind === "home" && <TH>Type of work</TH>}
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {state.permits.map((permit) => (
          <TR key={permit.id}>
            <TD data-label="Issued" nums className="whitespace-nowrap">{dayText(permit.issuedDate)}</TD>
            <TD data-label="Address">{permit.address || "No address"}</TD>
            <TD data-label={kind === "home" ? "ZIP" : "City and ZIP"}>{[permit.city, permit.zip].filter(Boolean).join(" ") || "Not listed"}</TD>
            {kind === "home" && <TD data-label="Type of work">{permit.typeOfWork || "Not listed"}</TD>}
            <TD data-label="Status">{permit.status || "Not listed"}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function BuilderRow({ builder, kind, isOpen, sites, onToggle, onRetry }) {
  const panelId = `builder-sites-${builder.key.replace(/[^A-Z0-9]+/g, "-")}`;
  return (
    <Fragment>
      <TR className="cursor-pointer" onClick={onToggle}>
        <TD>
          <button
            type="button"
            className="u-focus-ring min-h-11 max-w-full border-0 bg-transparent p-0 text-left text-ui-body font-medium text-zinc-900"
            aria-expanded={isOpen}
            aria-controls={panelId}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
          >
            {builder.name}
          </button>
          {(builder.isNew || builder.isCustomer) && (
            <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
              {builder.isNew && <Badge tone="neutral">New</Badge>}
              {builder.isCustomer && <Badge tone="strong">Customer</Badge>}
            </span>
          )}
        </TD>
        <TD data-label="License" className="whitespace-nowrap align-middle">{builder.license || "Not listed"}</TD>
        <TD data-label="30 days" nums align="right" className={COUNT_CELL}>{countText(builder.permits30)}</TD>
        <TD data-label="90 days" nums align="right" className={COUNT_CELL}>{countText(builder.permits90)}</TD>
        <TD data-label="12 months" nums align="right" className={COUNT_CELL}>{countText(builder.permits365)}</TD>
        <TD data-label="Newest permit" nums className="whitespace-nowrap align-middle">{dayText(builder.lastPermit)}</TD>
      </TR>
      {isOpen && (
        <TR id={panelId} className="bg-zinc-50">
          <TD colSpan={6}>
            <JobSites state={sites} kind={kind} onRetry={onRetry} />
          </TD>
        </TR>
      )}
    </Fragment>
  );
}

function BuilderTable({ data, kind, jobSites }) {
  return (
    <Card>
      <CardBody className="p-0">
        <Table aria-label="Builders" layout="records" className="min-[1101px]:min-w-[640px]">
          <THead>
            <TR>
              <TH>Builder</TH>
              <TH>License</TH>
              <TH align="right">30 days</TH>
              <TH align="right">90 days</TH>
              <TH align="right">12 months</TH>
              <TH>Newest permit</TH>
            </TR>
          </THead>
          <TBody>
            {data.builders.map((builder) => (
              <BuilderRow
                key={builder.key}
                builder={builder}
                kind={kind}
                isOpen={jobSites.open === builder.key}
                sites={jobSites.sites[builder.key]}
                onToggle={() => jobSites.toggle(builder.key)}
                onRetry={() => jobSites.retry(builder.key)}
              />
            ))}
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

export default function BuilderProspectsPage({ embedded = false }) {
  const [kind, setKind] = useState("pool");
  const active = KINDS.find((entry) => entry.key === kind);
  const { loading, error, data, load } = useBuilders(kind);
  const jobSites = useJobSites(kind);

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1100px]">
      {!embedded && <AdminCommandHeader variant="workspace" title="Builders" icon={Hammer} />}

      <div className="mb-3 rounded-sm border-hairline border-zinc-200 bg-white px-3 py-2 text-ui-body text-ink-secondary">
        Builders who pull permits from the county, so you can pitch them pre-slab termite treatment. Unincorporated Manatee County only.
        The county list updates each Monday. Press a builder to see the job sites it opened most recently.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Kind of builder">
        {KINDS.map((entry) => (
          <Button key={entry.key} size="sm" variant={kind === entry.key ? "primary" : "secondary"} aria-pressed={kind === entry.key} onClick={() => setKind(entry.key)}>
            {entry.label}
          </Button>
        ))}
      </div>

      {loading && <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Loading builders…</div>}
      {error && <ActionFeedback error onRetry={load} className="mb-3">{error}</ActionFeedback>}
      {data && (
        <>
          <p className="mb-3 text-ui-body text-zinc-900">{summaryText(data, active.noun)}</p>
          {data.builders.length === 0
            ? <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">{active.empty}</div>
            : <BuilderTable data={data} kind={kind} jobSites={jobSites} />}
        </>
      )}
    </UiSurface>
  );
}
