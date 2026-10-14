import { fmtInt, fmtMoney } from "../../../components/dashboard/charts";
import { Table, TBody, TD, TH, THead, TR, UiSurface } from "../../../components/ui";
import DashboardFeed from "./DashboardFeed";
import SampleBadge from "./SampleBadge";

// "By service line" (/admin/dashboard/service-lines) — four numbers per line for
// the selected period: close rate (accepted / resolved), open estimates over 7
// days, first-90-day retention, and ad cost per new customer. A "—" means the
// server could not compute it (or there was nothing to divide by), never zero.
// Counts sit ON the row (n= everywhere, low-sample pill) — never tooltip-only.
// Strict zinc: these are context for a decision, not alerts.
const dash = "—";
const fmtPct = (v) => (v == null ? dash : `${v}%`);

function Sub({ children }) {
  return <div className="u-nums whitespace-nowrap text-ui-caption text-ink-secondary">{children}</div>;
}

function LineRow({ line }) {
  const resolved = line.resolved ?? 0;
  const ret = line.ret90;
  const cac = line.cac;
  return (
    <TR className="align-top">
      <TD>
        <div className="whitespace-nowrap text-ui-body text-ink-primary">{line.label || line.key}</div>
        <Sub>{line.sent == null ? dash : `${fmtInt(line.sent)} sent`}</Sub>
      </TD>
      <TD align="right" nums className="whitespace-nowrap font-medium text-zinc-900">
        <div>{fmtPct(line.close_rate)}</div>
        {line.accepted != null && (
          <Sub>{fmtInt(line.accepted)}/{fmtInt(resolved)} resolved</Sub>
        )}
        {line.accepted != null && resolved > 0 && <SampleBadge n={resolved} />}
      </TD>
      <TD align="right" nums className="whitespace-nowrap text-ink-secondary">
        {line.aging7 == null ? dash : fmtInt(line.aging7)}
      </TD>
      <TD align="right" nums className="whitespace-nowrap text-ink-secondary">
        <div>{ret ? fmtPct(ret.rate) : dash}</div>
        {ret && ret.cohort > 0 && <Sub>{fmtInt(ret.retained)}/{fmtInt(ret.cohort)} kept</Sub>}
        {ret && ret.cohort > 0 && <SampleBadge n={ret.cohort} />}
      </TD>
      <TD align="right" nums className="whitespace-nowrap text-ink-secondary">
        <div>{cac && cac.value != null ? fmtMoney(cac.value) : dash}</div>
        {cac && cac.converted > 0 && (
          <Sub>{fmtMoney(cac.spend)} / {fmtInt(cac.converted)} won</Sub>
        )}
        {cac && cac.value == null && cac.spend > 0 && <Sub>{fmtMoney(cac.spend)} spend, none won</Sub>}
      </TD>
    </TR>
  );
}

function Tiles({ data }) {
  const lines = data?.lines || [];
  const caveats = data?.caveats || [];
  if (!lines.length) return <div className="text-ui-caption text-ink-secondary">No service-line activity this period.</div>;
  return (
    <UiSurface>
      {/* Wide table scrolls inside the card — never the page. */}
      <Table>
        <THead>
          <TR>
            <TH>Line</TH>
            <TH align="right" className="whitespace-nowrap">Close rate</TH>
            <TH align="right" className="whitespace-nowrap">Open &gt;7d</TH>
            <TH align="right" className="whitespace-nowrap">90-day retention</TH>
            <TH align="right" className="whitespace-nowrap">Cost per new customer</TH>
          </TR>
        </THead>
        <TBody>
          {lines.map((line) => <LineRow key={line.key} line={line} />)}
        </TBody>
      </Table>
      {caveats.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-4 text-ui-caption text-ink-secondary">
          {caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>
      )}
    </UiSurface>
  );
}

export default function ServiceLineTiles({ data, pending, onRetry }) {
  return (
    <DashboardFeed value={data} pending={pending} label="service line numbers" onRetry={onRetry}>
      <Tiles data={data} />
    </DashboardFeed>
  );
}
