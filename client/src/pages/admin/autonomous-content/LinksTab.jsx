import { Textarea, CardBody, cn } from "../../../components/ui";
import { RotateCcw, CheckCircle2, XCircle, Link2, GitPullRequest } from "lucide-react";
import {
  DecisionButtons,
  Tag,
  linkTagTone,
  Field,
  formatDate,
  ExternalAnchor,
  LinkContext,
  Section,
  yesNo,
  KpiRow,
  Kpi,
  ListHeader,
  Empty,
  RowCard,
  scorePercent,
  Panel,
  PanelHeader,
} from "./shared";

function LinkDecisions({ linkReviewNote, setLinkReviewNote, selectedLink, linkActionPending, submitLinkDecision }) {
  return (
    <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4">
      <Textarea
        value={linkReviewNote}
        onChange={(e) => setLinkReviewNote(e.target.value)}
        placeholder="Reviewer note (optional)"
        rows={3}
      />
      <DecisionButtons
        actions={[
          { decision: "requeue", label: "Requeue", icon: RotateCcw, variant: "secondary" },
          { decision: "verify_now", label: "Verify", icon: CheckCircle2 },
          { decision: "dismiss", label: "Dismiss", icon: XCircle, variant: "danger" },
        ]}
        allowed={selectedLink.review_actions || {}}
        pending={linkActionPending}
        onDecision={submitLinkDecision}
      />
    </div>
  );
}

function LinkDetail({
  linkDetailLoading,
  selectedLink,
  linkReviewNote,
  setLinkReviewNote,
  linkActionPending,
  submitLinkDecision,
}) {
  return (
    <CardBody className={cn("flex flex-col gap-4", linkDetailLoading && "opacity-60")}>
      <div>
        <div className="text-16 font-medium leading-snug text-zinc-900">
          {selectedLink.anchor_text || "Untitled link"}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Tag tone={linkTagTone(selectedLink.status)}>{selectedLink.status}</Tag>
          {selectedLink.anchor_type && <Tag>{selectedLink.anchor_type}</Tag>}
          {selectedLink.topic_cluster && <Tag>{selectedLink.topic_cluster}</Tag>}
        </div>
      </div>

      <div className="grid gap-2">
        <Field label="Source" value={selectedLink.source_url || selectedLink.source_file || "—"} />
        <Field label="Target" value={selectedLink.target_url || "—"} />
        <Field label="Source file" value={selectedLink.source_file || "—"} />
        <Field label="Target file" value={selectedLink.target_file || "—"} />
        <Field
          label="Reason"
          value={selectedLink.failure_reason || selectedLink.skip_reason || selectedLink.dismissed_reason || "—"}
        />
        <Field label="Verified" value={formatDate(selectedLink.verified_at)} />
      </div>

      {selectedLink.astro_pr_url && <ExternalAnchor href={selectedLink.astro_pr_url} label="Open Astro PR" />}

      <LinkDecisions
        linkReviewNote={linkReviewNote}
        setLinkReviewNote={setLinkReviewNote}
        selectedLink={selectedLink}
        linkActionPending={linkActionPending}
        submitLinkDecision={submitLinkDecision}
      />

      <LinkContext title="Before" value={selectedLink.link_context_before || selectedLink.context_snippet} />
      <LinkContext title="After" value={selectedLink.link_context_after} />

      <Section title="Validation">
        <div className="grid gap-1 text-13 text-zinc-600">
          <div>
            Target: HTTP {selectedLink.target_http_status ?? "—"} · indexable {yesNo(selectedLink.target_indexable)} ·
            canonical {yesNo(selectedLink.target_canonical_matches)}
          </div>
          <div>
            Source: HTTP {selectedLink.source_http_status ?? "—"} · indexable {yesNo(selectedLink.source_indexable)} ·
            canonical {yesNo(selectedLink.source_canonical_matches)}
          </div>
          <div>
            Links: source {selectedLink.source_existing_internal_links_count ?? "—"} · target inlinks{" "}
            {selectedLink.target_existing_inlinks_count ?? "—"}
          </div>
        </div>
      </Section>

      {selectedLink.reviewer_notes && (
        <Section title="Reviewer notes">
          <div className="whitespace-pre-wrap text-13 leading-relaxed text-zinc-600">{selectedLink.reviewer_notes}</div>
        </Section>
      )}
    </CardBody>
  );
}

export default function LinksTab({
  linkData,
  mobileDetailOpen,
  linkItems,
  linkLoading,
  selectedLinkId,
  openLink,
  setMobileDetailOpen,
  selectedLink,
  linkDetailLoading,
  linkReviewNote,
  setLinkReviewNote,
  linkActionPending,
  submitLinkDecision,
}) {
  const linkCounts = linkData?.counts || {};
  return (
    <div className="pt-4">
      <KpiRow>
        <Kpi
          label="Candidates"
          value={linkCounts.patch_candidate || 0}
          emphasize={(linkCounts.patch_candidate || 0) > 0}
        />
        <Kpi label="PR open" value={linkCounts.pr_open || 0} emphasize={(linkCounts.pr_open || 0) > 0} />
        <Kpi label="Merged / deployed" value={(linkCounts.merged || 0) + (linkCounts.deployed || 0)} />
        <Kpi label="Verified" value={linkCounts.verified || 0} />
      </KpiRow>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-start">
        {/* List */}
        <div className={cn(mobileDetailOpen ? "hidden" : "block", "lg:block")}>
          <ListHeader icon={Link2} title="Internal-link tasks" count={linkItems.length} />
          {linkLoading ? (
            <Empty>Loading…</Empty>
          ) : linkItems.length === 0 ? (
            <Empty>No internal-link tasks.</Empty>
          ) : (
            <div className="flex flex-col gap-2.5">
              {linkItems.map((item) => (
                <RowCard key={item.id} active={item.id === selectedLinkId} onClick={() => openLink(item.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-14 font-medium text-zinc-900">{item.anchor_text || "—"}</div>
                      <div className="mt-0.5 truncate text-12 text-zinc-500">
                        {[item.anchor_type, scorePercent(item.topical_relevance_score)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <Tag tone={linkTagTone(item.status)} className="shrink-0">
                      {item.status}
                    </Tag>
                  </div>
                  <div className="mt-2 grid gap-0.5 text-12 text-zinc-500">
                    <div className="truncate">
                      <span className="text-zinc-400">→</span> {item.target_url || "—"}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="truncate">{item.source_url || item.source_file || "—"}</span>
                      <span className="ml-auto shrink-0 text-zinc-400">
                        {formatDate(item.updated_at || item.planned_at)}
                      </span>
                    </div>
                  </div>
                </RowCard>
              ))}
            </div>
          )}
        </div>

        {/* Detail */}
        <div className={cn(mobileDetailOpen ? "block" : "hidden", "lg:block lg:sticky lg:top-4")}>
          <Panel>
            <PanelHeader icon={GitPullRequest} title="Link detail" onBack={() => setMobileDetailOpen(false)} />
            {!selectedLink ? (
              <Empty>Select a task.</Empty>
            ) : (
              <LinkDetail
                linkDetailLoading={linkDetailLoading}
                selectedLink={selectedLink}
                linkReviewNote={linkReviewNote}
                setLinkReviewNote={setLinkReviewNote}
                linkActionPending={linkActionPending}
                submitLinkDecision={submitLinkDecision}
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
