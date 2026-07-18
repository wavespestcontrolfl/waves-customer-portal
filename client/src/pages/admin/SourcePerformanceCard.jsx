import React, { useEffect, useState } from "react";
import { Card, cn } from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

// Estimate performance by source (learning loop). Answers: do AI-drafted
// estimates close at the same rate as manual ones, how fast do drafts reach
// the customer, and how often does an AI draft go out untouched? Data from
// GET /admin/estimates/source-performance — win/loss uses the same
// resolved-only semantics as the win/loss card above it; edit stats come
// from the estimate_learning_events ledger (AI sources only). Self-fetching
// so the pipeline list payload stays slim.

const DAY_OPTIONS = [30, 90, 365];

const SOURCE_LABELS = {
  manual: "Manual",
  estimator_engine: "Estimator engine",
  ai_agent: "IB quoting agent",
  quote_wizard: "Quote wizard",
  email_inquiry: "Email inquiry",
  lead_webhook: "Lead form",
  sms_intake: "SMS intake",
  lead_agent: "Lead agent",
  other: "Other",
};

function fetchReport(days) {
  return adminFetch(`/admin/estimates/source-performance?days=${days}`);
}

function pct(value) {
  return value == null ? "—" : `${value}%`;
}

function num(value) {
  return value == null ? "—" : value;
}

export default function SourcePerformanceCard() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchReport(days)
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

  const sources = data?.sources || [];
  const aiSources = sources.filter((s) => s.edits?.events > 0);

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-14 font-medium text-zinc-900">
            Estimate performance by source
          </div>
          <div className="text-13 text-zinc-500">
            Do AI drafts close like manual quotes — and how often do they go
            out untouched?
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
          Couldn&apos;t load source performance ({error.message}).
        </div>
      )}
      {!loading && !error && data && sources.length === 0 && (
        <div className="text-13 text-zinc-500">
          No estimates in the last {days} days.
        </div>
      )}

      {!loading && !error && sources.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="text-13 text-zinc-500 mb-1">
              Funnel and close rate ({data.drafted} drafted,{" "}
              {data.resolved} resolved)
            </div>
            <table className="w-full text-13">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left font-normal py-1">Source</th>
                  <th className="text-right font-normal py-1">Drafted</th>
                  <th className="text-right font-normal py-1">Sent</th>
                  <th className="text-right font-normal py-1">Win rate</th>
                  <th className="text-right font-normal py-1">Hrs to send</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((row) => (
                  <tr
                    key={row.source}
                    className="border-b border-hairline last:border-0"
                  >
                    <td className="py-1 text-zinc-700">
                      {SOURCE_LABELS[row.source] || row.source}
                    </td>
                    <td className="py-1 text-right text-zinc-900">
                      {row.drafted}
                    </td>
                    <td className="py-1 text-right text-zinc-900">{row.sent}</td>
                    <td className="py-1 text-right font-medium text-zinc-900">
                      {pct(row.winRatePct)}
                      <span className="text-zinc-500"> (n={row.resolved})</span>
                    </td>
                    <td className="py-1 text-right text-zinc-900">
                      {num(row.sendLatencyHoursMedian)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="text-13 text-zinc-500 mb-1">
              AI drafts — how much editing before send?
            </div>
            {aiSources.length === 0 && (
              <div className="text-13 text-zinc-500">
                No AI-drafted estimates sent in this window yet.
              </div>
            )}
            {aiSources.length > 0 && (
              <table className="w-full text-13">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="text-left font-normal py-1">Source</th>
                    <th className="text-right font-normal py-1">Sent as-is</th>
                    <th className="text-right font-normal py-1">Avg revises</th>
                    <th className="text-right font-normal py-1">Price edited</th>
                    <th className="text-right font-normal py-1">
                      Services edited
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aiSources.map((row) => (
                    <tr
                      key={row.source}
                      className="border-b border-hairline last:border-0"
                    >
                      <td className="py-1 text-zinc-700">
                        {SOURCE_LABELS[row.source] || row.source}
                      </td>
                      <td className="py-1 text-right font-medium text-zinc-900">
                        {pct(row.edits.sentUneditedPct)}
                        <span className="text-zinc-500">
                          {" "}
                          (n={row.edits.events})
                        </span>
                      </td>
                      <td className="py-1 text-right text-zinc-900">
                        {num(row.edits.avgReviseCount)}
                      </td>
                      <td className="py-1 text-right text-zinc-900">
                        {row.edits.totalsChanged}
                      </td>
                      <td className="py-1 text-right text-zinc-900">
                        {row.edits.servicesChanged}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="text-13 text-zinc-500 mt-2">
              Edit stats start accumulating from first send after this ships —
              older sends have no baseline.
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
