// Consultations analytics section for the Leads page → Analytics tab.
// Reads the existing GET /api/admin/consultations/stats endpoint
// (server/routes/admin-consultations.js) — no backend changes here.
//
// Fetched independently of LeadsTabs' loadAnalytics Promise.all so a
// failure here never breaks the rest of the Analytics tab; failure and
// loading are handled entirely inside this component.
import React, { useCallback, useEffect, useState } from "react";
import { adminFetch as sharedAdminFetch } from "../../utils/admin-fetch";
import {
  ActionFeedback,
  Card,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../../components/ui";

// server/services/consultation-outcomes.js LOST_REASON_VALUES.
const LOST_REASON_LABELS = {
  price: "Price",
  competitor: "Competitor",
  diy: "DIY",
  not_ready: "Not ready",
  no_show: "No-show",
  other: "Other",
};
// Known won_via values (consultation-outcomes.js) — 'closeout_booking' is
// reachable only from a future tech-closeout caller, so this map is ready
// for it without needing a change here when that lane ships.
const WON_VIA_LABELS = {
  estimate_accept: "Accepted estimate",
  office_booking: "Office booking",
  closeout_booking: "Closed at the door",
};

function humanize(key) {
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function pct(numerator, denominator) {
  if (!denominator) return "—";
  return `${((Number(numerator) / Number(denominator)) * 100).toFixed(1)}%`;
}
function sortedEntries(obj) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
}

function StatTile({ label, value, sub }) {
  return (
    <Card className="flex-[1_1_160px] min-w-[150px] p-4">
      <div className="text-ui-body text-ink-secondary mb-[4px]">{label}</div>
      <div className="text-[22px] font-medium text-zinc-900">{value}</div>
      {sub && <div className="text-ui-body text-ink-secondary mt-[2px]">{sub}</div>}
    </Card>
  );
}

function BreakdownCard({ title, entries, labelOf, emptyText }) {
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return (
    <Card className="flex-[1_1_260px] p-5">
      <h3 className="m-0 mb-[12px] text-zinc-900 text-ui-body font-medium">
        {title}
      </h3>
      {entries.length === 0 ? (
        <div className="text-ink-secondary text-ui-body">{emptyText}</div>
      ) : (
        <div className="grid gap-[6px]">
          {entries.map(([key, count]) => (
            <div
              key={key}
              className="flex items-center justify-between text-ui-body"
            >
              <span className="text-zinc-900">{labelOf(key)}</span>
              <span className="text-ink-secondary">
                {count} · {pct(count, total)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function RateTable({ title, rows, nameLabel, emptyText }) {
  return (
    <Card className="flex-[1_1_320px] p-[0px] overflow-auto">
      <div className="border-b border-hairline border-zinc-200 px-5 py-4">
        <h3 className="m-0 text-zinc-900 text-ui-body font-medium">{title}</h3>
      </div>
      <Table className="w-full min-w-[420px]">
        <THead>
          <TR>
            <TH>{nameLabel}</TH>
            <TH align="right">Showed</TH>
            <TH align="right">Won</TH>
            <TH align="right">Close rate</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.key}>
              <TD className="text-zinc-900">{row.label}</TD>
              <TD align="right" className="text-zinc-900">
                {row.showed}
              </TD>
              <TD align="right" className="text-zinc-700">
                {row.won}
              </TD>
              <TD align="right" className="text-zinc-700">
                {pct(row.won, row.showed)}
              </TD>
            </TR>
          ))}
          {rows.length === 0 && (
            <TR>
              <TD colSpan={4} className="p-[30px] text-center text-ink-secondary">
                {emptyText}
              </TD>
            </TR>
          )}
        </TBody>
      </Table>
    </Card>
  );
}

// `adminFetch` is injectable (default: the shared client/src/utils/admin-fetch.js
// helper) so tests can stub it directly, same pattern as CompletionPricingCard.
export default function ConsultationStatsPanel({ adminFetch = sharedAdminFetch }) {
  const [status, setStatus] = useState("loading");
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setStatus("loading");
    setError(null);
    adminFetch("/admin/consultations/stats")
      .then((data) => {
        setStats(data);
        setStatus("ready");
      })
      .catch((err) => {
        setError(err);
        setStatus("error");
      });
  }, [adminFetch]);

  useEffect(() => {
    load();
  }, [load]);

  if (status === "loading") {
    return (
      <Card className="p-5 mb-[24px] text-ink-secondary text-ui-body">
        Loading consultation stats…
      </Card>
    );
  }

  if (status === "error") {
    return (
      <Card className="p-5 mb-[24px]">
        <h2 className="m-0 mb-[12px] text-zinc-900 text-ui-body font-medium">
          Consultations · visits in the last 90 days
        </h2>
        <ActionFeedback error onRetry={load}>
          Couldn&apos;t load consultation stats
          {error?.message ? `: ${error.message}` : "."}
        </ActionFeedback>
      </Card>
    );
  }

  const s = stats || {};
  const booked = s.booked || 0;

  if (booked === 0) {
    return (
      <Card className="p-5 mb-[24px]">
        <h2 className="m-0 mb-[6px] text-zinc-900 text-ui-body font-medium">
          Consultations · visits in the last 90 days
        </h2>
        <div className="text-ink-secondary text-ui-body">
          No Waves Assessment visits in the last 90 days.
        </div>
      </Card>
    );
  }

  const showed = s.showed || 0;
  const won = s.won || 0;
  const warm = s.warm || 0;
  const cold = s.cold || 0;
  const lostReasons = sortedEntries(s.lost_by_reason);
  const wonByVia = sortedEntries(s.won_by_via);
  const byTechnician = (s.by_technician || []).map((t) => ({
    key: t.technician_id || "unassigned",
    label: t.name || "Unassigned",
    showed: t.showed || 0,
    won: t.won || 0,
  }));
  const bySource = (s.by_source || []).map((row) => ({
    key: row.lead_source || "unknown",
    label: row.lead_source || "Unknown",
    showed: row.showed || 0,
    won: row.won || 0,
  }));
  const medianDays =
    s.median_days_to_close != null
      ? `${Number(s.median_days_to_close).toFixed(1)} days`
      : "—";

  return (
    <div className="mb-[24px]">
      <div className="mb-[10px]">
        <h2 className="m-0 mb-[6px] text-zinc-900 text-ui-body font-medium">
          Consultations · visits in the last 90 days
        </h2>
        <div className="m-0 text-ink-secondary text-ui-body">
          Waves Assessment outcomes for the selected window.
        </div>
      </div>
      <div className="flex gap-[16px] flex-wrap mb-[16px]">
        <StatTile label="Booked" value={booked} />
        <StatTile
          label="Showed"
          value={showed}
          sub={`Show rate ${pct(showed, booked)}`}
        />
        <StatTile
          label="Won"
          value={won}
          sub={`Close rate ${pct(won, showed)}`}
        />
        <StatTile
          label="Still open"
          value={warm + cold}
          sub={`Warm ${warm} · Cold ${cold}`}
        />
        <StatTile label="Median days to close" value={medianDays} />
      </div>
      <div className="flex gap-[16px] flex-wrap mb-[16px]">
        <BreakdownCard
          title="Lost by reason"
          entries={lostReasons}
          labelOf={(k) => LOST_REASON_LABELS[k] || humanize(k)}
          emptyText="No lost consultations yet"
        />
        <BreakdownCard
          title="Won by channel"
          entries={wonByVia}
          labelOf={(k) => WON_VIA_LABELS[k] || humanize(k)}
          emptyText="No wins yet"
        />
      </div>
      <div className="flex gap-[16px] flex-wrap">
        <RateTable
          title="By technician"
          rows={byTechnician}
          nameLabel="Technician"
          emptyText="No technician data yet"
        />
        <RateTable
          title="By lead source"
          rows={bySource}
          nameLabel="Source"
          emptyText="No source data yet"
        />
      </div>
    </div>
  );
}
