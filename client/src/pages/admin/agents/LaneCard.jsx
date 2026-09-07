import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Badge, Card, cn } from "../../../components/ui";
import { CONTINUITY } from "./LaneModelCard";
import LaneSparkline from "./LaneSparkline";
import { Metric, MetricDash, ms, nf, pct, shortWhen } from "./Metric";

// One AI lane on the Control center: what it is, whether it needs a look,
// and its numbers for the window. Every number is the server's; a metric
// with nothing behind it renders a dash with the reason. The only red on
// the card is the attention stripe + badge, and only when the server says
// the lane needs attention.

const STATUS = {
  attention: { label: "Needs attention", tone: "alert" },
  active: { label: "Active", tone: "strong" },
  idle: { label: "Idle", tone: "neutral" },
};

// Why a lane has no per-call rows (agent-control lane policy).
const UNRECORDABLE = {
  audio: "audio — no per-call row",
  embedding: "embeddings — no per-call row",
  image: "image generation — no per-call row",
  video: "video generation — no per-call row",
  search: "search probe — no per-call row",
  direct_sdk: "calls the SDK directly — not in the ledger yet",
  no_call_site: "no call site",
};

const NOT_YET = {
  cost: "arrives with cost tracking",
  verification: "arrives with verification",
};

// No single total: providers disagree on what input / output contain
// (OpenAI and Gemini count cached and reasoning tokens INSIDE input and
// output; Anthropic reports cache reads and writes beside input), and a
// lane may have run on more than one — so the line shows the two counts
// every provider agrees on, and says how many rows had no usage at all.
function tokensLine(tokens) {
  if (!tokens) return null;
  const parts = [];
  if ((tokens.input || 0) + (tokens.output || 0) > 0) parts.push(`${nf.format(tokens.input || 0)} in · ${nf.format(tokens.output || 0)} out`);
  if (tokens.unknownRows > 0) parts.push(`${tokens.unknownRows} without usage`);
  return parts.join(" · ") || null;
}

function deltaLine(delta) {
  if (!delta || delta.calls === 0) return null;
  return `${delta.calls > 0 ? "+" : ""}${nf.format(delta.calls)} vs prior`;
}

// The 3×2 grid, as data: { label, value, sub } renders a Metric, { label,
// reason } a MetricDash. Order is the spec's: Calls, Cost, Duration,
// Errors, Corrections, Verified.
export function metricCells(lane, basis) {
  const unrecordable = lane.ledger === "unrecordable";
  const noCalls = !unrecordable && lane.calls === 0;
  const notRecorded = unrecordable ? "not recorded" : "no calls in window";
  const fallback =
    lane.fallbackRate != null ? `fallback ${pct(lane.fallbackRate)}` : basis?.chainRecording === false ? "fallback — (chain recorder off)" : "fallback —";
  return [
    unrecordable
      ? { label: "Calls", reason: UNRECORDABLE[lane.unrecordableReason] || "no per-call row" }
      : { label: "Calls", value: nf.format(lane.calls), sub: deltaLine(lane.deltaVsPrior) || tokensLine(lane.tokens) },
    { label: "Cost", reason: NOT_YET.cost },
    lane.p50LatencyMs == null ? { label: "Duration", reason: notRecorded } : { label: "Duration", value: ms(lane.p50LatencyMs), sub: `p95 ${ms(lane.p95LatencyMs)}` },
    lane.okRate == null
      ? { label: "Errors", reason: noCalls || unrecordable ? notRecorded : "no outcome recorded" }
      : { label: "Errors", value: pct(1 - lane.okRate), sub: fallback },
    { label: "Corrections", reason: NOT_YET.verification },
    { label: "Verified", reason: NOT_YET.verification },
  ];
}

export default function LaneCard({ lane, basis, runsHref }) {
  const status = STATUS[lane.status] || STATUS.idle;
  const attention = lane.status === "attention";
  const cont = CONTINUITY[lane.continuity] || CONTINUITY.unchecked;
  const cells = metricCells(lane, basis);

  return (
    <Card className={cn("relative flex flex-col", attention && "border-l-[3px] border-l-alert-fg")} data-lane={lane.id} data-status={lane.status}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="m-0 text-14 font-medium text-zinc-900 truncate">{lane.name}</h4>
              <Badge tone={status.tone} dot>
                {status.label}
              </Badge>
            </div>
            {lane.describe ? <p className="m-0 mt-0.5 text-13 text-ink-secondary">{lane.describe}</p> : null}
          </div>
          {runsHref ? (
            <Link to={runsHref} className="inline-flex shrink-0 items-center gap-1 text-13 text-ink-secondary hover:text-zinc-900 u-focus-ring rounded-sm">
              Runs <ArrowRight size={13} strokeWidth={2} aria-hidden />
            </Link>
          ) : null}
        </div>

        {attention && lane.attentionReasons?.length > 0 ? (
          <ul className="m-0 list-none p-0 text-13 text-alert-fg" aria-label="Attention reasons">
            {lane.attentionReasons.map((r, i) => (
              <li key={`${r.kind}-${i}`}>{r.detail}</li>
            ))}
          </ul>
        ) : null}

        <div className="grid grid-cols-3 gap-x-3 gap-y-3">
          {cells.map((c) => (c.reason ? <MetricDash key={c.label} label={c.label} reason={c.reason} /> : <Metric key={c.label} label={c.label} value={c.value} sub={c.sub} />))}
        </div>

        <div className="flex items-end justify-between gap-3">
          <LaneSparkline spark={lane.spark} />
          <div className="text-12 text-ink-tertiary whitespace-nowrap">{lane.lastActiveAt ? `Last active ${shortWhen(lane.lastActiveAt)}` : "No activity in this window"}</div>
        </div>
      </div>
      <div className="border-t border-hairline border-zinc-200 px-4 py-2 text-12 text-ink-secondary truncate">
        Runs on <span className="text-zinc-900">{lane.modelNow || "—"}</span>
        {" · "}Backup <span className="text-zinc-900">{lane.backup || "none"}</span>
        {" · "}
        <span title={cont.help}>{cont.label}</span>
      </div>
    </Card>
  );
}
