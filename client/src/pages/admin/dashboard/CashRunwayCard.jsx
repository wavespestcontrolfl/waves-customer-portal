import { Link } from "react-router-dom";
import { UiSurface } from "../../../components/ui";
import { EmptyState, fmtMoney } from "../../../components/dashboard/charts";

// 13-week Cash Forecast summary card for the Cash section (owner-only read via
// /api/admin/banking/cash-forecast). Shows live bank balance, credit card owed,
// and the lowest projected balance across the next 13 weeks.
function fmtSignedMoney(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return n < 0 ? `-${fmtMoney(Math.abs(n))}` : fmtMoney(n);
}

function CashStat({ label, value, sub, alert = false }) {
  return (
    <div className="rounded-md border border-hairline border-zinc-200 bg-surface-primary px-3 py-2.5">
      <div className="text-ui-caption font-medium text-ink-secondary">{label}</div>
      <div className={`mt-1 text-20 font-semibold u-nums ${alert ? "text-alert-fg" : "text-ink-primary"}`}>
        {value}
      </div>
      <div className="mt-0.5 text-ui-caption text-ink-secondary">{sub}</div>
    </div>
  );
}

export default function CashRunwayCard({ data }) {
  if (!data || !data.opening) return <EmptyState>Cash forecast unavailable</EmptyState>;
  const bankUsd = data.opening.bank_usd;
  const cardOwed = data.opening.card_owed_usd;
  const lowBooked = data.lowest?.booked;
  const lowExpected = data.lowest?.expected;

  return (
    <UiSurface>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <CashStat
          label="Checking Balance"
          value={fmtSignedMoney(bankUsd)}
          sub={data.opening.partial ? "partial bank feed" : "live bank pool"}
          alert={bankUsd != null && bankUsd < 0}
        />
        <CashStat
          label="Card Balance Owed"
          value={fmtSignedMoney(cardOwed)}
          sub="open credit card balance"
        />
        <CashStat
          label="13-Wk Low (Booked)"
          value={fmtSignedMoney(lowBooked?.usd)}
          sub={lowBooked?.week_start ? `week of ${lowBooked.week_start}` : "booked work only"}
          alert={lowBooked?.usd != null && lowBooked.usd < 0}
        />
        <CashStat
          label="13-Wk Low (Expected)"
          value={fmtSignedMoney(lowExpected?.usd)}
          sub={
            lowExpected?.week_start
              ? `week of ${lowExpected.week_start}`
              : data.expected_available === false
                ? "needs prior-year receipts"
                : "booked + seasonal new work"
          }
          alert={lowExpected?.usd != null && lowExpected.usd < 0}
        />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 text-ui-caption text-ink-secondary">
        <span className="u-nums">
          {data.window_end ? `13-week window through ${data.window_end}` : "13-week rolling cash forecast"}
        </span>
        <Link to="/admin/banking?tab=cash-forecast" className="font-medium hover:text-ink-primary underline-offset-2 hover:underline">
          Open cash forecast →
        </Link>
      </div>
    </UiSurface>
  );
}
