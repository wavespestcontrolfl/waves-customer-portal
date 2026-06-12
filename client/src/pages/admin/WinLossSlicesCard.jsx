import React, { useEffect, useState } from "react";
import { Card, cn } from "../../components/ui";

// Verify-flag win/loss card (estimator accuracy loop). Answers: do
// estimates built on UNVERIFIED property facts (lookup fieldVerifyFlags)
// lose more often, and in which recurring price bands does verification
// matter most? Data from GET /admin/estimates/win-loss-slices —
// resolved-only (won = accepted, lost = declined/expired), same semantics
// as PipelineAnalytics above it. Self-fetching so the pipeline list
// payload stays slim (flags live in estimate_data, not the list API).

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const DAY_OPTIONS = [30, 90, 365];

function fetchSlices(days) {
  return fetch(`${API_BASE}/admin/estimates/win-loss-slices?days=${days}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`win-loss-slices ${r.status}`);
    return r.json();
  });
}

function pct(cell) {
  if (!cell || cell.winRatePct == null) return "—";
  return `${cell.winRatePct}%`;
}

function n(cell) {
  return cell?.total ?? 0;
}

export default function WinLossSlicesCard() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchSlices(days)
      .then((payload) => {
        if (alive) setData(payload);
      })
      .catch((err) => {
        if (alive) setError(err);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [days]);

  const topFields = (data?.byFlagField || []).slice(0, 6);
  const bands = data?.recurringBandsByFlag || [];

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-14 font-medium text-zinc-900">
            Verify-flag win/loss
          </div>
          <div className="text-13 text-zinc-500">
            Resolved estimates only — does unverified property data cost
            conversions?
          </div>
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              className={cn(
                "text-13 px-2 py-1 rounded-xs border-hairline",
                option === days
                  ? "bg-zinc-900 text-white"
                  : "bg-white text-zinc-600 hover:bg-zinc-50",
              )}
            >
              {option}d
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="text-13 text-zinc-500">Loading…</div>}
      {error && (
        <div className="text-13 text-zinc-500">
          Couldn&apos;t load win/loss slices ({error.message}).
        </div>
      )}
      {!loading && !error && data && data.resolved === 0 && (
        <div className="text-13 text-zinc-500">
          No resolved estimates in the last {days} days.
        </div>
      )}

      {!loading && !error && data && data.resolved > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="text-13 text-zinc-500 mb-1">
              Win rate by lookup state ({data.resolved} resolved,{" "}
              {data.winRatePct ?? 0}% overall)
            </div>
            <table className="w-full text-13">
              <tbody>
                <tr className="border-b border-hairline">
                  <td className="py-1 text-zinc-700">Clean lookup</td>
                  <td className="py-1 text-right font-medium text-zinc-900">
                    {pct(data.byFlagPresence?.clean)}
                  </td>
                  <td className="py-1 text-right text-zinc-500 w-16">
                    n={n(data.byFlagPresence?.clean)}
                  </td>
                </tr>
                <tr className="border-b border-hairline">
                  <td className="py-1 text-zinc-700">Verify-flagged</td>
                  <td className="py-1 text-right font-medium text-zinc-900">
                    {pct(data.byFlagPresence?.flagged)}
                  </td>
                  <td className="py-1 text-right text-zinc-500">
                    n={n(data.byFlagPresence?.flagged)}
                  </td>
                </tr>
                <tr>
                  <td className="py-1 text-zinc-700">No lookup profile</td>
                  <td className="py-1 text-right font-medium text-zinc-900">
                    {pct(data.byFlagPresence?.noProfile)}
                  </td>
                  <td className="py-1 text-right text-zinc-500">
                    n={n(data.byFlagPresence?.noProfile)}
                  </td>
                </tr>
              </tbody>
            </table>

            {topFields.length > 0 && (
              <>
                <div className="text-13 text-zinc-500 mt-3 mb-1">
                  Most common verify flags
                </div>
                <table className="w-full text-13">
                  <tbody>
                    {topFields.map((row) => (
                      <tr key={row.field} className="border-b border-hairline last:border-0">
                        <td className="py-1 text-zinc-700">{row.field}</td>
                        <td className="py-1 text-right font-medium text-zinc-900">
                          {pct(row)}
                        </td>
                        <td className="py-1 text-right text-zinc-500 w-16">
                          n={row.total}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          <div>
            <div className="text-13 text-zinc-500 mb-1">
              Recurring price band × lookup state (win rate)
            </div>
            <table className="w-full text-13">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left font-normal py-1">Band</th>
                  <th className="text-right font-normal py-1">Clean</th>
                  <th className="text-right font-normal py-1">Flagged</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((band) => (
                  <tr key={band.key} className="border-b border-hairline last:border-0">
                    <td className="py-1 text-zinc-700">{band.label}</td>
                    <td className="py-1 text-right text-zinc-900">
                      {pct(band.clean)}
                      <span className="text-zinc-500"> ({n(band.clean)})</span>
                    </td>
                    <td className="py-1 text-right text-zinc-900">
                      {pct(band.flagged)}
                      <span className="text-zinc-500"> ({n(band.flagged)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-13 text-zinc-500 mt-2">
              Bands are display buckets, not pricing config.
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
