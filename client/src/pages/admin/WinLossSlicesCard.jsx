import React, { useEffect, useState } from "react";
import { Card, cn } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

// Verify-flag win/loss card (estimator accuracy loop). Answers: do
// estimates built on UNVERIFIED property facts (lookup fieldVerifyFlags)
// lose more often, and in which recurring price bands does verification
// matter most? Data from GET /admin/estimates/win-loss-slices —
// resolved-only (won = accepted, lost = declined/expired), same semantics
// as PipelineAnalytics above it. Self-fetching so the pipeline list
// payload stays slim (flags live in estimate_data, not the list API).

const DAY_OPTIONS = [30, 90, 365];

// Uses the shared adminFetch (base URL, auth header, 429/403 handling, retry)
// so this card behaves like every other admin request instead of a bespoke fetch.
function fetchSlices(days) {
  return adminFetch(`/admin/estimates/win-loss-slices?days=${days}`);
}

function pct(cell) {
  if (!cell || cell.winRatePct == null) return "—";
  return `${cell.winRatePct}%`;
}

function n(cell) {
  return cell?.total ?? 0;
}

function RateTable({ rows }) {
  return (
    <table className="w-full text-13">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-hairline last:border-0">
            <td className="py-1 text-zinc-700">{row.label}</td>
            <td className="py-1 text-right font-medium text-zinc-900 tabular-nums">{pct(row)}</td>
            <td className="py-1 text-right text-zinc-500 w-16 tabular-nums">n={row.total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
  // Estimator-audit slices (2026-08-29): why we lose, and win rate by
  // service line / lead source / WaveGuard tier, plus the sent-cohort
  // funnel. Older payloads without these keys render the original card.
  const dispositions = data?.byDisposition || [];
  // "Still deciding" (soft-exit signal): a side channel next to the
  // dispositions so the office can tell went-quiet-while-deciding from
  // never-engaged (GH codex r3 P2). Absent on older payloads.
  const stillDeciding = data?.stillDeciding && data.stillDeciding.signaled > 0 ? data.stillDeciding : null;
  const serviceLines = (data?.byServiceLine || []).slice(0, 8);
  const leadSources = (data?.byLeadSource || []).slice(0, 8);
  const tiers = data?.byWaveguardTier || [];
  const cohorts = data?.sentCohorts;
  // The audit sections carry their own populations (archived outcomes, open
  // offers, shifted cohort windows) — they must render even when the active
  // resolved-rate denominator is zero (codex pre-push P1).
  // A cohort bucket can be populated purely by its SHIFTED window (sends
  // 30-60d back) while the recent window is empty — gate on the buckets,
  // not the recent-send total (GH codex P2).
  const hasCohorts = (cohorts?.cohorts || []).some((c) => c.sent > 0);
  const hasAuditData = dispositions.length > 0
    || !!stillDeciding
    || serviceLines.length > 0
    || leadSources.length > 0
    || hasCohorts;
  // Headline counts REAL losses only — dead leads / converted-elsewhere
  // rows stay listed below with a null percentage (mirrors the server).
  const lossTotal = dispositions
    .filter((d) => d.group === "lost")
    .reduce((sum, d) => sum + d.count, 0);

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
      {!loading && !error && data && data.resolved === 0 && !hasAuditData && (
        <div className="text-13 text-zinc-500">
          No resolved estimates in the last {days} days.
        </div>
      )}

      {!loading && !error && data && (data.resolved > 0 || hasAuditData) && (
        <div className="grid gap-4 md:grid-cols-2">
          {data.resolved > 0 && (
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
          )}

          {data.resolved > 0 && (
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
          )}

          {dispositions.length > 0 && (
            <div>
              <div className="text-13 text-zinc-500 mb-1">
                Why we lose ({lossTotal} losses
                {data.excludedFromRates > 0
                  ? `, ${data.excludedFromRates} never winnable and kept out of rates`
                  : ""}
                )
              </div>
              <table className="w-full text-13">
                <tbody>
                  {dispositions.map((d) => (
                    <tr key={d.code} className="border-b border-hairline last:border-0">
                      <td className="py-1 text-zinc-700">{d.label}</td>
                      <td className="py-1 text-right font-medium text-zinc-900 tabular-nums">
                        {d.count}
                      </td>
                      <td className="py-1 text-right text-zinc-500 w-16 tabular-nums">
                        {d.pctOfLosses == null ? "—" : `${d.pctOfLosses}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {stillDeciding && (
            <div>
              <div className="text-13 text-zinc-500 mb-1">Said &ldquo;still deciding&rdquo; on the estimate</div>
              <table className="w-full text-13">
                <tbody>
                  <tr className="border-b border-hairline">
                    <td className="py-1 text-zinc-700">Signaled</td>
                    <td className="py-1 text-right font-medium text-zinc-900 tabular-nums">{stillDeciding.signaled}</td>
                  </tr>
                  <tr className="border-b border-hairline">
                    <td className="py-1 text-zinc-700">Accepted afterwards</td>
                    <td className="py-1 text-right font-medium text-zinc-900 tabular-nums">{stillDeciding.wonAfter}</td>
                  </tr>
                  <tr className="border-b border-hairline">
                    <td className="py-1 text-zinc-700">Lost afterwards</td>
                    <td className="py-1 text-right font-medium text-zinc-900 tabular-nums">{stillDeciding.lostAfter}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-zinc-700">Expired after opening (vs. went silent)</td>
                    <td className="py-1 text-right font-medium text-zinc-900 tabular-nums">{stillDeciding.expiredViewedAfter}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {serviceLines.length > 0 && (
            <div>
              <div className="text-13 text-zinc-500 mb-1">Win rate by service line</div>
              <RateTable rows={serviceLines} />
            </div>
          )}

          {(leadSources.length > 0 || tiers.length > 0) && (
            <div>
              {leadSources.length > 0 && (
                <>
                  <div className="text-13 text-zinc-500 mb-1">Win rate by lead source</div>
                  <RateTable rows={leadSources} />
                </>
              )}
              {tiers.length > 0 && (
                <>
                  <div className="text-13 text-zinc-500 mt-3 mb-1">Win rate by WaveGuard tier</div>
                  <RateTable rows={tiers} />
                </>
              )}
            </div>
          )}

          {hasCohorts && (
            <div>
              <div className="text-13 text-zinc-500 mb-1">
                Sent cohorts — outcome as of N days after send
              </div>
              <table className="w-full text-13">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="text-left font-normal py-1">Age</th>
                    <th className="text-right font-normal py-1">Won</th>
                    <th className="text-right font-normal py-1">Lost</th>
                    <th className="text-right font-normal py-1">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {cohorts.cohorts
                    .filter((c) => c.sent > 0)
                    .map((c) => (
                      <tr key={c.maturityDays} className="border-b border-hairline last:border-0">
                        <td className="py-1 text-zinc-700">
                          {c.maturityDays}d <span className="text-zinc-500">(n={c.sent})</span>
                        </td>
                        <td className="py-1 text-right text-zinc-900 tabular-nums">{c.winRatePct}%</td>
                        <td className="py-1 text-right text-zinc-900 tabular-nums">{c.lossRatePct}%</td>
                        <td className="py-1 text-right text-zinc-900 tabular-nums">
                          {Math.round(((c.open / c.sent) * 1000)) / 10}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {cohorts.sentTotal > 0 && (
              <div className="text-13 text-zinc-500 mt-2">
                Opened {cohorts.viewRatePct ?? 0}% of {cohorts.sentTotal} sent
                {cohorts.medianHoursToFirstView != null
                  ? ` · median ${cohorts.medianHoursToFirstView} h to first view`
                  : ""}
                {cohorts.medianDaysToDecision != null
                  ? ` · median ${cohorts.medianDaysToDecision} d to decision`
                  : ""}
              </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
