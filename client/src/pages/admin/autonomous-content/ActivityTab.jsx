import { AlertTriangle, CheckCircle2, RotateCcw, XCircle, RefreshCw, Search, FileText } from "lucide-react";
import { Textarea, cn, CardBody } from "../../../components/ui";
import { useMemo } from "react";
import {
  Section,
  formatDate,
  ActionBtn,
  DecisionButtons,
  gateTag,
  Tag,
  ACTIVITY_STATUSES,
  isNamedCompetitor,
  Field,
  ExternalAnchor,
  RowCard,
  ListHeader,
  Empty,
  KpiRow,
  Kpi,
  Panel,
  PanelHeader,
} from "./shared";

function PipelineStatus({ selected }) {
  const remediation = selected?.run?.remediation;
  return (
    (selected.run?.poll_pending_reason || remediation) && (
      <Section
        icon={selected.run?.poll_pending_reason || remediation?.status === "parked" ? AlertTriangle : CheckCircle2}
        ok={!selected.run?.poll_pending_reason && remediation?.status !== "parked"}
        title="Pipeline status"
      >
        <div className="grid gap-1 text-13 text-zinc-600">
          {selected.run?.poll_pending_reason && (
            <div>
              Auto-merge waiting on{" "}
              <span className="font-medium text-zinc-900">{selected.run.poll_pending_reason}</span>
              {selected.run.poll_pending_since ? ` since ${formatDate(selected.run.poll_pending_since)}` : ""}
            </div>
          )}
          {remediation && (
            <div>
              Codex remediation: <span className="font-medium text-zinc-900">{remediation.status}</span>
              {Number.isFinite(remediation.rounds) ? ` · ${remediation.rounds} round(s)` : ""}
            </div>
          )}
          {remediation?.park_reason && <div className="text-[#B42318]">Parked: {remediation.park_reason}</div>}
        </div>
      </Section>
    )
  );
}

function ContentDecisions({ selected, view, reviewNote, setReviewNote, loading, actionPending, submitDecision }) {
  const reviewActions = selected?.review_actions || {};
  return (
    view === "review" &&
    selected.action_type !== "new_supporting_blog" &&
    selected.status === "pending_review" && (
      <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4">
        <Textarea
          value={reviewNote}
          onChange={(e) => setReviewNote(e.target.value)}
          placeholder="Reviewer note (optional)"
          rows={3}
        />
        <DecisionButtons
          actions={[
            { decision: "requeue", label: "Requeue", icon: RotateCcw, variant: "secondary" },
            ...[
              { decision: "approve_trust_build", label: "Approve", icon: CheckCircle2 },
              { decision: "approve_named_competitor", label: "Approve & publish", icon: CheckCircle2 },
            ].filter(({ decision }) => reviewActions[`can_${decision}`]),
            { decision: "dismiss", label: "Dismiss", icon: XCircle, variant: "danger" },
          ]}
          allowed={reviewActions}
          pending={actionPending}
          disabled={loading}
          onDecision={submitDecision}
        />
      </div>
    )
  );
}

function GateSummary({ selected }) {
  const run = selected.run || {};
  const gateSummary = run.gate_summary || {};
  const selectedGate = gateTag(gateSummary, run.quality_gate_result);
  const hardFailures = gateSummary.hard_failures || [];
  const softFailures = gateSummary.soft_failures || [];
  const uniquenessFailures = gateSummary.uniqueness_failures || [];
  const comparisonFindings = gateSummary.comparison_findings || [];
  const seoCompletion = run.seo_completion;
  return (
    <Section
      icon={{ alert: AlertTriangle, green: CheckCircle2, neutral: RefreshCw }[selectedGate.tone]}
      ok={{ alert: false, green: true }[selectedGate.tone]}
      title="Gate summary"
    >
      <div className="grid gap-1 text-13 text-zinc-600">
        <div>
          Score:{" "}
          <span className="tabular-nums text-zinc-900">
            {gateSummary.quality_score ?? "—"} / {gateSummary.quality_min_score ?? "—"}
          </span>
        </div>
        <div>Hard: {hardFailures.length ? hardFailures.join(", ") : "none"}</div>
        <div>Soft: {softFailures.length ? softFailures.join(", ") : "none"}</div>
        <div>
          Uniqueness:{" "}
          {uniquenessFailures.length
            ? uniquenessFailures.join(", ")
            : gateSummary.uniqueness_ok === false
              ? "failed"
              : "none"}
        </div>
        <div>
          SEO completion:{" "}
          {seoCompletion?.available
            ? `P0 ${seoCompletion.p0} / P1 ${seoCompletion.p1} / P2 ${seoCompletion.p2}`
            : "not run"}
        </div>
        <div>Topic targeting: {gateResult(gateSummary.topic_ok)}</div>
        {(gateSummary.topic_findings || []).map((finding, i) => (
          <div key={`topic-${i}`} className="text-alert-fg">
            {finding.code}: {finding.message}
          </div>
        ))}
        <div>Comparison: {gateResult(gateSummary.comparison_ok)}</div>
        {gateSummary.comparison_ok === false &&
          comparisonFindings.slice(0, 4).map((finding, i) => (
            <div key={`${finding.code}-${i}`} className="text-[#B42318]">
              <span className="font-medium">
                {finding.severity} {finding.code}
              </span>
              : {finding.message}
            </div>
          ))}
      </div>
    </Section>
  );
}

function SeoCompletion({ seoCompletion }) {
  const seoFindings = seoCompletion?.findings || [];
  const recommendedLinks = seoCompletion?.recommended_links || [];
  return (
    seoCompletion?.available && (
      <Section
        icon={seoCompletion.p0 === 0 ? CheckCircle2 : AlertTriangle}
        ok={seoCompletion.p0 === 0}
        title="SEO completion"
      >
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          <Tag tone={seoCompletion.p0 > 0 ? "alert" : "green"}>P0 {seoCompletion.p0}</Tag>
          <Tag>P1 {seoCompletion.p1}</Tag>
          <Tag>P2 {seoCompletion.p2}</Tag>
          <Tag>{seoCompletion.faq_count || 0} FAQs</Tag>
          <Tag>{recommendedLinks.length} links</Tag>
        </div>
        {seoFindings.length > 0 && (
          <div className="mb-2.5 grid gap-1.5">
            {seoFindings.slice(0, 6).map((finding) => (
              <div
                key={`${finding.severity}-${finding.code}`}
                className={cn("text-13 leading-snug", finding.severity === "P0" ? "text-[#B42318]" : "text-zinc-600")}
              >
                <span className="font-medium">
                  {finding.severity} {finding.code}
                </span>
                : {finding.message}
              </div>
            ))}
          </div>
        )}
        {recommendedLinks.length > 0 && (
          <div className="grid gap-1.5">
            <div className="text-12 uppercase tracking-label text-zinc-400">Recommended links</div>
            {recommendedLinks.slice(0, 6).map((link) => (
              <div key={`${link.reason}-${link.url}`} className="text-13 leading-snug text-zinc-600">
                <span className="font-medium text-zinc-900">{link.url}</span>
                <br />
                Anchor: {link.anchorText || "—"} · Reason: {link.reason || "—"}
              </div>
            ))}
          </div>
        )}
      </Section>
    )
  );
}

function ContentDetail({
  detailLoading,
  selected,
  view,
  reviewNote,
  setReviewNote,
  loading,
  actionPending,
  submitDecision,
}) {
  const run = selected.run || {};
  const draft = selected.draft || {};
  return (
    <CardBody className={cn("flex flex-col gap-4", detailLoading && "opacity-60")}>
      <div>
        <div className="text-16 font-medium leading-snug text-zinc-900">
          {draft.title || selected.target_keyword || "Untitled run"}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Tag lifecycle>{ACTIVITY_STATUSES[selected.status] || selected.status}</Tag>
          <Tag>{selected.action_type}</Tag>
          {run.shadow_mode && <Tag>shadow</Tag>}
          {isNamedCompetitor(selected) && <Tag tone="forest">Named competitor</Tag>}
        </div>
      </div>

      <div className="grid gap-2">
        <Field label="Target" value={selected.target_url || "—"} />
        <Field label="Keyword" value={selected.target_keyword || "—"} />
        <Field label="Reason" value={selected.skip_reason || "—"} />
        <Field
          label="Run"
          value={
            view === "content" && run.outcome === "completed_pending_review"
              ? "Automatic processing"
              : run.outcome || "—"
          }
        />
      </div>

      {run.astro_pr_url && <ExternalAnchor href={run.astro_pr_url} label="Open Astro PR" />}

      <PipelineStatus selected={selected} />

      <ContentDecisions
        selected={selected}
        view={view}
        reviewNote={reviewNote}
        setReviewNote={setReviewNote}
        loading={loading}
        actionPending={actionPending}
        submitDecision={submitDecision}
      />

      <GateSummary selected={selected} />

      {run.reviewer_notes && (
        <Section title="Run notes">
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-13 leading-relaxed text-zinc-600">
            {run.reviewer_notes}
          </div>
        </Section>
      )}

      <SeoCompletion seoCompletion={run.seo_completion} />

      {draft.meta_description && (
        <Section title="Meta">
          <div className="text-14 leading-snug text-zinc-600">{draft.meta_description}</div>
        </Section>
      )}

      {draft.body_preview && (
        <Section title="Draft preview">
          <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-[#FAF7EF] p-3 text-14 leading-relaxed text-zinc-800">
            {draft.body || draft.body_preview}
          </div>
        </Section>
      )}
    </CardBody>
  );
}

function ActivityRow({ item, selectedId, openContent }) {
  const gt = gateTag(item.run?.gate_summary, item.run?.quality_gate_result);
  const named = isNamedCompetitor(item);
  const meta = [item.city, item.service, item.bucket].filter(Boolean).join(" · ");

  return (
    <RowCard key={item.id} active={item.id === selectedId} onClick={() => openContent(item.id)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-14 font-medium text-zinc-900">
            {item.target_keyword || item.query || item.target_url || "Untitled"}
          </div>
          {meta && <div className="mt-0.5 truncate text-12 text-zinc-500">{meta}</div>}
        </div>
        {named && (
          <Tag tone="forest" className="shrink-0">
            Named competitor
          </Tag>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Tag lifecycle>{ACTIVITY_STATUSES[item.status] || item.status}</Tag>
        <Tag>{item.action_type}</Tag>
        <Tag tone={gt.tone}>{gt.label}</Tag>
        <span className="text-12 tabular-nums text-zinc-500">Score {item.final_score ?? item.score ?? "—"}</span>
        <span className="ml-auto text-12 text-zinc-400">{formatDate(item.updated_at || item.completed_at)}</span>
      </div>
    </RowCard>
  );
}

function ActivityList({
  mobileDetailOpen,
  status,
  setStatus,
  setOffset,
  data,
  loading,
  items,
  selectedId,
  openContent,
  offset,
}) {
  return (
    <div className={cn(mobileDetailOpen ? "hidden" : "block", "lg:block")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <label className="text-14 text-zinc-700">
          Status{" "}
          <select
            aria-label="Activity status"
            className="ml-2 rounded border border-zinc-200 p-2"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="all">All activity</option>
            {Object.entries(ACTIVITY_STATUSES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-14 text-zinc-500">Updates every 30 seconds</span>
      </div>
      <ListHeader icon={Search} title="Activity" count={data?.total || 0} />
      {loading ? (
        <Empty>Loading…</Empty>
      ) : items.length === 0 ? (
        <Empty>
          {data?.unavailable
            ? "Review queue unavailable — the review tables are missing or the query failed. Check server logs."
            : "No runs match this filter."}
        </Empty>
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} selectedId={selectedId} openContent={openContent} />
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2 text-14 text-zinc-600">
        <ActionBtn
          variant="secondary"
          disabled={loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous
        </ActionBtn>
        <span>
          {items.length ? offset + 1 : 0}–{items.length ? offset + items.length : 0} of {data?.total || 0}
        </span>
        <ActionBtn
          variant="secondary"
          disabled={loading || offset + items.length >= (data?.total || 0)}
          onClick={() => setOffset(offset + 50)}
        >
          Next
        </ActionBtn>
      </div>
    </div>
  );
}

export default function ContentTab({
  data,
  items,
  mobileDetailOpen,
  status,
  setStatus,
  setOffset,
  loading,
  selectedId,
  openContent,
  offset,
  setMobileDetailOpen,
  selected,
  detailLoading,
  view,
  reviewNote,
  setReviewNote,
  actionPending,
  submitDecision,
}) {
  const counts = data?.counts || {};
  const pendingCount = (counts.pending || 0) + (counts.claimed || 0) + (counts.pending_review || 0);
  const shadowCount = useMemo(() => items.filter((item) => item.run?.shadow_mode).length, [items]);
  return (
    <div className="pt-4">
      <KpiRow>
        <Kpi label="In progress" value={pendingCount} emphasize={pendingCount > 0} />
        <Kpi label="Shadow rows" value={shadowCount} />
        <Kpi label="Done" value={counts.done || 0} />
        <Kpi label="Skipped" value={counts.skipped || 0} />
      </KpiRow>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start">
        {/* List */}
        <ActivityList
          mobileDetailOpen={mobileDetailOpen}
          status={status}
          setStatus={setStatus}
          setOffset={setOffset}
          data={data}
          loading={loading}
          items={items}
          selectedId={selectedId}
          openContent={openContent}
          offset={offset}
        />

        {/* Detail */}
        <div className={cn(mobileDetailOpen ? "block" : "hidden", "lg:block lg:sticky lg:top-4")}>
          <Panel>
            <PanelHeader icon={FileText} title="Run detail" onBack={() => setMobileDetailOpen(false)} />
            {!selected ? (
              <Empty>Select a run to see its status.</Empty>
            ) : (
              <ContentDetail
                detailLoading={detailLoading}
                selected={selected}
                view={view}
                reviewNote={reviewNote}
                setReviewNote={setReviewNote}
                loading={loading}
                actionPending={actionPending}
                submitDecision={submitDecision}
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function gateResult(value) {
  return { true: "ok", false: "failed" }[value] || "not run";
}
