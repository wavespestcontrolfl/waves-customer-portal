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
  booking_assessment: "Assessment booking",
  service_report_cta: "Report card tap",
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
          <div className="text-ui-body text-zinc-500">
            Do AI drafts close like manual quotes — and how often do they go out
            untouched?
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
          Couldn&apos;t load source performance ({error.message}).
        </div>
      )}
      {!loading && !error && data && sources.length === 0 && (
        <div className="text-ui-body text-zinc-500">
          No estimates in the last {days} days.
        </div>
      )}

      {!loading && !error && sources.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="text-ui-body text-zinc-500 mb-1">
              Funnel and close rate ({data.drafted} drafted, {data.resolved}{" "}
              resolved)
            </div>
            <Table>
              <THead>
                <TR className="text-zinc-500">
                  <TH className="text-left font-normal py-1">Source</TH>
                  <TH className="text-right font-normal py-1">Drafted</TH>
                  <TH className="text-right font-normal py-1">Sent</TH>
                  <TH className="text-right font-normal py-1">Win rate</TH>
                  <TH className="text-right font-normal py-1">Hrs to send</TH>
                </TR>
              </THead>
              <TBody>
                {sources.map((row) => (
                  <TR
                    key={row.source}
                    className="border-b border-hairline last:border-0"
                  >
                    <TD className="py-1 text-zinc-700">
                      {SOURCE_LABELS[row.source] || row.source}
                    </TD>
                    <TD className="py-1 text-right text-zinc-900">
                      {row.drafted}
                    </TD>
                    <TD className="py-1 text-right text-zinc-900">
                      {row.sent}
                    </TD>
                    <TD className="py-1 text-right font-medium text-zinc-900">
                      {pct(row.winRatePct)}
                      <span className="text-zinc-500"> (n={row.resolved})</span>
                    </TD>
                    <TD className="py-1 text-right text-zinc-900">
                      {num(row.sendLatencyHoursMedian)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>

          <div>
            <div className="text-ui-body text-zinc-500 mb-1">
              AI drafts — how much editing before send?
            </div>
            {aiSources.length === 0 && (
              <div className="text-ui-body text-zinc-500">
                No AI-drafted estimates sent in this window yet.
              </div>
            )}
            {aiSources.length > 0 && (
              <Table>
                <THead>
                  <TR className="text-zinc-500">
                    <TH className="text-left font-normal py-1">Source</TH>
                    <TH className="text-right font-normal py-1">Sent as-is</TH>
                    <TH className="text-right font-normal py-1">Avg revises</TH>
                    <TH className="text-right font-normal py-1">
                      Price edited
                    </TH>
                    <TH className="text-right font-normal py-1">
                      Services edited
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {aiSources.map((row) => (
                    <TR
                      key={row.source}
                      className="border-b border-hairline last:border-0"
                    >
                      <TD className="py-1 text-zinc-700">
                        {SOURCE_LABELS[row.source] || row.source}
                      </TD>
                      <TD className="py-1 text-right font-medium text-zinc-900">
                        {pct(row.edits.sentUneditedPct)}
                        <span className="text-zinc-500">
                          {" "}
                          (n={row.edits.events})
                        </span>
                      </TD>
                      <TD className="py-1 text-right text-zinc-900">
                        {num(row.edits.avgReviseCount)}
                      </TD>
                      <TD className="py-1 text-right text-zinc-900">
                        {row.edits.totalsChanged}
                      </TD>
                      <TD className="py-1 text-right text-zinc-900">
                        {row.edits.servicesChanged}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <div className="text-ui-body text-zinc-500 mt-2">
              Edit stats start accumulating from first send after this ships —
              older sends have no baseline.
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
