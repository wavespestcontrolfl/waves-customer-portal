import { Fragment, useEffect, useMemo, useState } from "react";
import { Card, Table, TBody, TD, TH, THead, TR } from "../ui";
import { formatETDateOnly } from "../../lib/timezone";

// Ads -> Dashboard: read-only "Ad results" card (owner 2026-11-23, plan v2). One line per campaign with its days
// added up, and a per-day view under each. Counts only: no cost per lead, no return ratio. A paid customer is one
// with a paid invoice on or after the lead day; "Paid 90 d" is what they paid in the 90 days after it.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const PERIODS = ["30d", "90d", "180d"];
const DEFAULT_PERIOD = "90d";
const SUM_KEYS = [
  "spend", "clicks", "leads", "calls", "booked", "paid_customers", "plan_customers", "one_time_customers",
  "paid90", "cancels",
];
const DAY_FORMAT = { month: "short", day: "numeric", year: "numeric" };

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
    "Content-Type": "application/json",
  };
}

const money = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n) => Number(n || 0).toLocaleString("en-US");

// One rain call per date: every campaign row of a date carries the same call, so count each date once. The ads
// follow the 2 PM call (cutoff_call); a later forecast can change `call`, never the ads.
function rainText(rows) {
  const byDate = new Map();
  for (const r of rows) if (r.rain_day && !byDate.has(r.date)) byDate.set(r.date, r);
  const called = [...byDate.values()].filter((r) => r.rain_day.cutoff_call === "rain");
  if (!called.length) return "0";
  const measured = called.filter((r) => r.rain_day.wet_day !== null && r.rain_day.wet_day !== undefined);
  const wet = measured.filter((r) => r.rain_day.wet_day).length;
  return `${called.length} called, ${wet} of ${measured.length} wet`;
}

// The period total counts every recorded day in the window, also a day with no ad row.
function periodRainRows(data) {
  if (!Array.isArray(data.rain_days)) return data.rows;
  return data.rain_days.map(({ date, ...rain_day }) => ({ date, rain_day }));
}

const PLATFORM_NAMES = { google_ads: "Google Ads", google_lsa: "Google LSA", facebook: "Facebook" };

function rainDayText(rain) {
  if (!rain || (!rain.call && !rain.cutoff_call)) return "";
  const measured = rain.wet_day === null || rain.wet_day === undefined ? "not measured yet" : rain.wet_day ? "it rained" : "stayed dry";
  if (!rain.cutoff_call) return `No 2 PM call (later forecast ${rain.call}), ${measured}`;
  return `2 PM call ${rain.cutoff_call}, ${measured}`;
}

// Campaign lines, days added up. A customer is counted on one day only (the server credits their first lead), so the
// day numbers add up without counting anyone twice.
export function rollUp(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.campaign_id || `none:${row.platform || ""}`;
    if (!groups.has(key)) {
      groups.set(key, { key, campaign_id: row.campaign_id, campaign: row.campaign, platform: row.platform, days: [], total: Object.fromEntries(SUM_KEYS.map((k) => [k, 0])) });
    }
    const g = groups.get(key);
    g.days.push(row);
    for (const k of SUM_KEYS) g.total[k] += Number(row[k]) || 0;
  }
  const out = [...groups.values()];
  for (const g of out) g.days.sort((a, b) => b.date.localeCompare(a.date));
  return out.sort((a, b) => b.total.spend - a.total.spend || a.campaign.localeCompare(b.campaign));
}

function Cells({ data, rain }) {
  return (
    <>
      <TD className="text-ui-body text-right whitespace-nowrap">{money(data.spend)}</TD>
      <TD className="text-ui-body text-right">{count(data.clicks)}</TD>
      <TD className="text-ui-body text-right">{count(data.leads)}</TD>
      <TD className="text-ui-body text-right">{count(data.calls)}</TD>
      <TD className="text-ui-body text-right">{count(data.booked)}</TD>
      <TD className="text-ui-body text-right">{count(data.paid_customers)}</TD>
      <TD className="text-ui-body text-right whitespace-nowrap">
        {count(data.plan_customers)} / {count(data.one_time_customers)}
      </TD>
      <TD className="text-ui-body text-right whitespace-nowrap">{money(data.paid90)}</TD>
      <TD className="text-ui-body text-right">{count(data.cancels)}</TD>
      <TD className="text-ui-body whitespace-nowrap">{rain}</TD>
    </>
  );
}

function CampaignRows({ group }) {
  const [open, setOpen] = useState(false);
  const name = group.campaign_id ? group.campaign : `${group.campaign} · ${PLATFORM_NAMES[group.platform] || group.platform || "unknown"}`;
  const label = `${open ? "Hide" : "Show"} days for ${name}`;
  return (
    <Fragment>
      <TR>
        <TD className="text-ui-body">
          <button
            type="button"
            aria-expanded={open}
            aria-label={label}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-[44px] items-center gap-2 text-left font-medium text-zinc-900 sm:min-h-0"
          >
            <span aria-hidden="true">{open ? "−" : "+"}</span>
            {name}
          </button>
        </TD>
        <Cells data={group.total} rain={rainText(group.days)} />
      </TR>
      {open &&
        group.days.map((day) => (
          <TR key={`${group.key}|${day.date}`} className="bg-zinc-50">
            <TD className="text-ui-body [padding-left:32px]">
              <div>{formatETDateOnly(day.date, DAY_FORMAT)}</div>
              {day.customers?.length > 0 && (
                <div className="text-ui-body text-ink-secondary">
                  Paid: {day.customers.map((c) => `${String(c.customer_id).slice(0, 8)} (${c.plan ? "plan" : "one-time"}${c.service ? `, ${c.service}` : ""})`).join("; ")}
                </div>
              )}
            </TD>
            <Cells data={day} rain={rainDayText(day.rain_day)} />
          </TR>
        ))}
    </Fragment>
  );
}

export default function AdsResultsCard() {
  // state: "loading" | "error" | "ready"
  const [state, setState] = useState("loading");
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [data, setData] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/admin/ads/results?period=${period}`, { headers: authHeaders() });
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        if (!body || !Array.isArray(body.rows) || !body.totals) throw new Error("Unexpected reply");
        setData(body);
        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setMessage(err.message || "Request failed");
        setState("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [period]);

  const groups = useMemo(() => (data ? rollUp(data.rows) : []), [data]);

  return (
    <Card className="[padding:16px_20px] [margin-bottom:24px]" data-qa="ads-results-card">
      <div className="flex flex-wrap items-center justify-between [gap:8px_16px]">
        <h2 className="text-18 font-medium text-zinc-900 [margin:0]">Ad results</h2>
        <div role="group" aria-label="Period" className="flex [gap:4px]">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === period}
              onClick={() => setPeriod(p)}
              className={`min-h-[44px] rounded-sm border-hairline [padding:0_12px] text-ui-body font-medium ${
                p === period ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-900 border-zinc-300"
              }`}
            >
              {p.replace("d", " days")}
            </button>
          ))}
        </div>
      </div>
      <div className="text-ui-body text-ink-secondary [margin:4px_0_12px]">
        Leads from paid ads and what they paid. Paid means a paid invoice on or after the lead day. Plan / one-time
        is the customer today. Each customer counts once, on their first lead in the period shown, so a shorter period can move a customer
        to another campaign. Calls are leads linked to a call (links start Aug 9, 2026). Rain days use the recorded 2 PM forecast call (test mode: the ads do not change yet).
        Leads are tracked funnel leads: an LSA message or call with no
        funnel record is not counted here.
      </div>
      {state === "loading" && <div className="text-ui-body text-ink-secondary">Loading.</div>}
      {state === "error" && <div className="text-ui-body text-ink-secondary">Ad results could not load: {message}</div>}
      {state === "ready" && groups.length === 0 && (
        <div className="text-ui-body text-ink-secondary">
          No ad spend or leads in this period. Rain days: {rainText(periodRainRows(data))}.
        </div>
      )}
      {state === "ready" && groups.length > 0 && (
        <Table aria-label="Ad results by campaign">
          <THead>
            <TR>
              <TH className="text-ui-body">Campaign</TH>
              <TH className="text-ui-body text-right">Spend</TH>
              <TH className="text-ui-body text-right">Clicks</TH>
              <TH className="text-ui-body text-right">Leads</TH>
              <TH className="text-ui-body text-right">Calls</TH>
              <TH className="text-ui-body text-right">Booked</TH>
              <TH className="text-ui-body text-right">Paid</TH>
              <TH className="text-ui-body text-right">Plan / one-time</TH>
              <TH className="text-ui-body text-right">Paid 90 d</TH>
              <TH className="text-ui-body text-right">Cancels</TH>
              <TH className="text-ui-body">Rain days</TH>
            </TR>
          </THead>
          <TBody>
            {groups.map((g) => (
              <CampaignRows key={g.key} group={g} />
            ))}
            <TR>
              <TD className="text-ui-body font-medium">All campaigns</TD>
              <Cells data={data.totals} rain={rainText(periodRainRows(data))} />
            </TR>
          </TBody>
        </Table>
      )}
    </Card>
  );
}
