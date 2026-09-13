import React, { useEffect, useState } from "react";
import {
  Button,
  Card,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../../components/ui";
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
    <Table>
      <TBody>
        {rows.map((row) => (
          <TR key={row.key} className="border-b border-hairline last:border-0">
            <TD className="py-1 text-zinc-700">{row.label}</TD>
            <TD className="py-1 text-right font-medium text-zinc-900 tabular-nums">
              {pct(row)}
            </TD>
            <TD className="py-1 text-right text-zinc-500 w-16 tabular-nums">
              n={row.total}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
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
  const stillDeciding =
    data?.stillDeciding && data.stillDeciding.signaled > 0
      ? data.stillDeciding
      : null;
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
  const hasAuditData =
    dispositions.length > 0 ||
    !!stillDeciding ||
    serviceLines.length > 0 ||
    leadSources.length > 0 ||
    hasCohorts;
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
          <div className="text-ui-body text-zinc-500">
            Resolved estimates only — does unverified property data cost
            conversions?
          </div>
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((option) => (
            <Button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              variant={option === days ? "primary" : "secondary"}
              size="sm"
            >
              {option}d
            </Button>
          ))}
        </div>
      </div>

      {loading && <div className="text-ui-body text-zinc-500">Loading…</div>}
      {error && (
        <div className="text-ui-body text-zinc-500">
          Couldn&apos;t load win/loss slices ({error.message}).
        </div>
      )}
      {!loading && !error && data && data.resolved === 0 && !hasAuditData && (
        <div className="text-ui-body text-zinc-500">
          No resolved estimates in the last {days} days.
        </div>
      )}

      {!loading && !error && data && (data.resolved > 0 || hasAuditData) && (
        <div className="grid gap-4 md:grid-cols-2">
          {data.resolved > 0 && (
            <div>
              <div className="text-ui-body text-zinc-500 mb-1">
                Win rate by lookup state ({data.resolved} resolved,{" "}
                {data.winRatePct ?? 0}% overall)
              </div>
              <Table>
                <TBody>
                  <TR className="border-b border-hairline">
                    <TD className="py-1 text-zinc-700">Clean lookup</TD>
                    <TD className="py-1 text-right font-medium text-zinc-900">
                      {pct(data.byFlagPresence?.clean)}
                    </TD>
                    <TD className="py-1 text-right text-zinc-500 w-16">
                      n={n(data.byFlagPresence?.clean)}
                    </TD>
                  </TR>
                  <TR className="border-b border-hairline">
                    <TD className="py-1 text-zinc-700">Verify-flagged</TD>
                    <TD className="py-1 text-right font-medium text-zinc-900">
                      {pct(data.byFlagPresence?.flagged)}
                    </TD>
                    <TD className="py-1 text-right text-zinc-500">
                      n={n(data.byFlagPresence?.flagged)}
                    </TD>
                  </TR>
                  <TR>
                    <TD className="py-1 text-zinc-700">No lookup profile</TD>
                    <TD className="py-1 text-right font-medium text-zinc-900">
                      {pct(data.byFlagPresence?.noProfile)}
                    </TD>
                    <TD className="py-1 text-right text-zinc-500">
                      n={n(data.byFlagPresence?.noProfile)}
                    </TD>
                  </TR>
                </TBody>
              </Table>

              {topFields.length > 0 && (
                <>
                  <div className="text-ui-body text-zinc-500 mt-3 mb-1">
                    Most common verify flags
                  </div>
                  <Table>
                    <TBody>
                      {topFields.map((row) => (
                        <TR
                          key={row.field}
                          className="border-b border-hairline last:border-0"
                        >
                          <TD className="py-1 text-zinc-700">{row.field}</TD>
                          <TD className="py-1 text-right font-medium text-zinc-900">
                            {pct(row)}
                          </TD>
                          <TD className="py-1 text-right text-zinc-500 w-16">
                            n={row.total}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </>
              )}
            </div>
          )}

          {data.resolved > 0 && (
            <div>
              <div className="text-ui-body text-zinc-500 mb-1">
                Recurring price band × lookup state (win rate)
              </div>
              <Table>
                <THead>
                  <TR className="text-zinc-500">
                    <TH className="text-left font-normal py-1">Band</TH>
                    <TH className="text-right font-normal py-1">Clean</TH>
                    <TH className="text-right font-normal py-1">Flagged</TH>
                  </TR>
                </THead>
                <TBody>
                  {bands.map((band) => (
                    <TR
                      key={band.key}
                      className="border-b border-hairline last:border-0"
                    >
                      <TD className="py-1 text-zinc-700">{band.label}</TD>
                      <TD className="py-1 text-right text-zinc-900">
                        {pct(band.clean)}
                        <span className="text-zinc-500">
                          {" "}
                          ({n(band.clean)})
                        </span>
                      </TD>
                      <TD className="py-1 text-right text-zinc-900">
                        {pct(band.flagged)}
                        <span className="text-zinc-500">
                          {" "}
                          ({n(band.flagged)})
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <div className="text-ui-body text-zinc-500 mt-2">
                Bands are display buckets, not pricing config.
              </div>
            </div>
          )}

          {dispositions.length > 0 && (
            <div>
              <div className="text-ui-body text-zinc-500 mb-1">
                Why we lose ({lossTotal} losses
                {data.excludedFromRates > 0
                  ? `, ${data.excludedFromRates} never winnable and kept out of rates`
                  : ""}
                )
              </div>
              <Table>
                <TBody>
                  {dispositions.map((d) => (
                    <TR
                      key={d.code}
                      className="border-b border-hairline last:border-0"
                    >
                      <TD className="py-1 text-zinc-700">{d.label}</TD>
                      <TD className="py-1 text-right font-medium text-zinc-900 tabular-nums">
                        {d.count}
                      </TD>
                      <TD className="py-1 text-right text-zinc-500 w-16 tabular-nums">
                        {d.pctOfLosses == null ? "—" : `${d.pctOfLosses}%`}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}

          {stillDeciding && (
            <div>
              <div className="text-ui-body text-zinc-500 mb-1">
                Said &ldquo;still deciding&rdquo; on the estimate
              </div>
              <Table>
                <TBody>
                  <TR className="border-b border-hairline">
                    <TD className="py-1 text-zinc-700">Signaled</TD>
                    <TD className="py-1 text-right font-medium text-zinc-900 tabular-nums">
                      {stillDeciding.signaled}
                    </TD>
                  </TR>
                  <TR className="border-b border-hairline">
                    <TD className="py-1 text-zinc-700">Accepted afterwards</TD>
                    <TD className="py-1 text-right font-medium text-zinc-900 tabular-nums">
                      {stillDeciding.wonAfter}
                    </TD>
                  </TR>
                  <TR className="border-b border-hairline">
                    <TD className="py-1 text-zinc-700">Lost afterwards</TD>
                    <TD className="py-1 text-right font-medium text-zinc-900 tabular-nums">
                      {stillDeciding.lostAfter}
                    </TD>
                  </TR>
                  <TR>
                    <TD className="py-1 text-zinc-700">
                      Expired after opening (vs. went silent)
                    </TD>
                    <TD className="py-1 text-right font-medium text-zinc-900 tabular-nums">
                      {stillDeciding.expiredViewedAfter}
                    </TD>
                  </TR>
                </TBody>
              </Table>
            </div>
          )}

          {serviceLines.length > 0 && (
            <div>
              <div className="text-ui-body text-zinc-500 mb-1">
                Win rate by service line
              </div>
              <RateTable rows={serviceLines} />
            </div>
          )}

          {(leadSources.length > 0 || tiers.length > 0) && (
            <div>
              {leadSources.length > 0 && (
                <>
                  <div className="text-ui-body text-zinc-500 mb-1">
                    Win rate by lead source
                  </div>
                  <RateTable rows={leadSources} />
                </>
              )}
              {tiers.length > 0 && (
                <>
                  <div className="text-ui-body text-zinc-500 mt-3 mb-1">
                    Win rate by WaveGuard tier
                  </div>
                  <RateTable rows={tiers} />
                </>
              )}
            </div>
          )}

          {hasCohorts && (
            <div>
              <div className="text-ui-body text-zinc-500 mb-1">
                Sent cohorts — outcome as of N days after send
              </div>
              <Table>
                <THead>
                  <TR className="text-zinc-500">
                    <TH className="text-left font-normal py-1">Age</TH>
                    <TH className="text-right font-normal py-1">Won</TH>
                    <TH className="text-right font-normal py-1">Lost</TH>
                    <TH className="text-right font-normal py-1">Open</TH>
                  </TR>
                </THead>
                <TBody>
                  {cohorts.cohorts
                    .filter((c) => c.sent > 0)
                    .map((c) => (
                      <TR
                        key={c.maturityDays}
                        className="border-b border-hairline last:border-0"
                      >
                        <TD className="py-1 text-zinc-700">
                          {c.maturityDays}d{" "}
                          <span className="text-zinc-500">(n={c.sent})</span>
                        </TD>
                        <TD className="py-1 text-right text-zinc-900 tabular-nums">
                          {c.winRatePct}%
                        </TD>
                        <TD className="py-1 text-right text-zinc-900 tabular-nums">
                          {c.lossRatePct}%
                        </TD>
                        <TD className="py-1 text-right text-zinc-900 tabular-nums">
                          {Math.round((c.open / c.sent) * 1000) / 10}%
                        </TD>
                      </TR>
                    ))}
                </TBody>
              </Table>
              {cohorts.sentTotal > 0 && (
                <div className="text-ui-body text-zinc-500 mt-2">
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
