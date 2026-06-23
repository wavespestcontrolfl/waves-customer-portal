import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ExternalLink,
  FileText,
  GitPullRequest,
  Lightbulb,
  Link2,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { CardBody, Textarea, cn } from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body,
  }).then(async (r) => {
    if (!r.ok) {
      let message = `${r.status} ${r.statusText}`;
      try {
        const data = await r.clone().json();
        message = data?.error || message;
      } catch {
        /* keep default */
      }
      throw new Error(message);
    }
    return r.json();
  });
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function gateTag(summary) {
  if (!summary) return { tone: "neutral", label: "—" };
  if ((summary.hard_failures || []).length > 0 || summary.quality_ok === false || summary.uniqueness_ok === false || summary.seo_completion_ok === false) {
    return { tone: "alert", label: "Needs fix" };
  }
  if ((summary.soft_failures || []).length > 0) return { tone: "neutral", label: "Soft flags" };
  if (summary.quality_ok === true && summary.uniqueness_ok !== false) return { tone: "green", label: "Gate passed" };
  return { tone: "neutral", label: "In review" };
}

function linkTagTone(status) {
  if (status === "failed" || status === "dismissed") return "alert";
  if (["patch_candidate", "pr_open", "merged", "deployed"].includes(status)) return "forest";
  if (status === "verified" || status === "applied") return "green";
  return "neutral";
}

function isNamedCompetitor(item) {
  return item?.skip_reason === "named_competitor_review";
}

export default function AutonomousContentReviewPage({ embedded = false } = {}) {
  const [view, setView] = useState("content");
  const [data, setData] = useState(null);
  const [linkData, setLinkData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedLinkId, setSelectedLinkId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [linkDetail, setLinkDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linkLoading, setLinkLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [linkDetailLoading, setLinkDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [linkReviewNote, setLinkReviewNote] = useState("");
  const [actionPending, setActionPending] = useState("");
  const [linkActionPending, setLinkActionPending] = useState("");
  const [ideaData, setIdeaData] = useState(null);
  const [ideaLoading, setIdeaLoading] = useState(true);
  const [ideaActionPending, setIdeaActionPending] = useState("");
  // On phones the list and the detail can't share the screen — tapping a row
  // opens the detail; "Back" returns to the list. Desktop shows both columns.
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminFetch("/admin/content/autonomous/review?status=pending_review&limit=50");
      setData(next);
      setSelectedId((current) => next.items?.some((item) => item.id === current) ? current : next.items?.[0]?.id || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadLinks = async () => {
    setLinkLoading(true);
    setError("");
    try {
      const next = await adminFetch("/admin/content/internal-links?status=all&limit=100");
      setLinkData(next);
      setSelectedLinkId((current) => next.items?.some((item) => item.id === current) ? current : next.items?.[0]?.id || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLinkLoading(false);
    }
  };

  const loadIdeas = async () => {
    setIdeaLoading(true);
    setError("");
    try {
      // Blog ideas live in the legacy blog pipeline (blog_posts), separate from
      // the opportunity queue. Surface idea + draft rows here so the backlog can
      // be generated + published from the same review surface. Drafts first
      // (closer to publish), then ideas.
      const [ideas, drafts] = await Promise.all([
        adminFetch("/admin/content/blog?status=idea&sort=created_at&order=desc&limit=100"),
        adminFetch("/admin/content/blog?status=draft&sort=created_at&order=desc&limit=100"),
      ]);
      setIdeaData({
        posts: [...(drafts.posts || []), ...(ideas.posts || [])],
        counts: ideas.counts || drafts.counts || {},
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setIdeaLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadLinks();
    loadIdeas();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    adminFetch(`/admin/content/autonomous/review/${selectedId}`)
      .then((next) => {
        setDetail(next.item);
        setReviewNote("");
      })
      .catch((err) => setError(err.message))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedLinkId) {
      setLinkDetail(null);
      return;
    }
    setLinkDetail(null);
    setLinkDetailLoading(true);
    adminFetch(`/admin/content/internal-links/${selectedLinkId}`)
      .then((next) => {
        setLinkDetail(next.item);
        setLinkReviewNote("");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLinkDetailLoading(false));
  }, [selectedLinkId]);

  const submitDecision = async (decision) => {
    if (!selectedId || actionPending) return;
    setActionPending(decision);
    setError("");
    try {
      const next = await adminFetch(`/admin/content/autonomous/review/${selectedId}/decision`, {
        method: "POST",
        // Bind the decision to the run currently displayed — the server rejects
        // it if a requeue/re-run replaced it since this view loaded.
        body: { decision, note: reviewNote, run_id: selected?.run?.id || null },
      });
      setDetail(next.item);
      setReviewNote("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionPending("");
    }
  };

  const runIdeaAction = async (id, action) => {
    if (!id || ideaActionPending) return;
    setIdeaActionPending(`${action}:${id}`);
    setError("");
    try {
      if (action === "generate") {
        await adminFetch(`/admin/content/blog/${id}/generate`, { method: "POST" });
      } else if (action === "publish") {
        await adminFetch(`/admin/content/blog/${id}/publish-astro`, { method: "POST" });
      }
      await loadIdeas();
    } catch (err) {
      setError(err.message);
    } finally {
      setIdeaActionPending("");
    }
  };

  const submitLinkDecision = async (decision) => {
    if (!selectedLinkId || linkActionPending) return;
    setLinkActionPending(decision);
    setError("");
    try {
      const next = await adminFetch(`/admin/content/internal-links/${selectedLinkId}/decision`, {
        method: "POST",
        body: { decision, note: linkReviewNote },
      });
      setLinkDetail(next.item);
      setLinkReviewNote("");
      await loadLinks();
    } catch (err) {
      setError(err.message);
    } finally {
      setLinkActionPending("");
    }
  };

  const items = data?.items || [];
  const linkItems = linkData?.items || [];
  const selected = detail || items.find((item) => item.id === selectedId) || null;
  const selectedLink = linkDetail || linkItems.find((item) => item.id === selectedLinkId) || null;
  const counts = data?.counts || {};
  const linkCounts = linkData?.counts || {};
  const gateSummary = selected?.run?.gate_summary;
  const hardFailures = gateSummary?.hard_failures || [];
  const softFailures = gateSummary?.soft_failures || [];
  const uniquenessFailures = gateSummary?.uniqueness_failures || [];
  const seoCompletion = selected?.run?.seo_completion;
  const seoFindings = seoCompletion?.findings || [];
  const recommendedLinks = seoCompletion?.recommended_links || [];
  const pendingCount = counts.pending_review || 0;
  const shadowCount = useMemo(() => items.filter((item) => item.run?.shadow_mode).length, [items]);
  const reviewActions = selected?.review_actions || {};
  const ideaPosts = ideaData?.posts || [];
  const ideaCounts = ideaData?.counts || {};
  const busy = loading || linkLoading || ideaLoading;

  const refreshAll = () => { load(); loadLinks(); loadIdeas(); };
  const changeView = (next) => { setView(next); setMobileDetailOpen(false); };
  const openContent = (id) => { setSelectedId(id); setMobileDetailOpen(true); };
  const openLink = (id) => { setSelectedLinkId(id); setMobileDetailOpen(true); };

  return (
    <div className={cn("min-h-full", embedded ? "" : "bg-[#FAF7EF] p-4 sm:p-6")}>
      {/* TruGreen-style forest-green hero with the Waves app in an iPhone */}
      <div className="relative overflow-hidden rounded-2xl bg-[#143D2A] text-white lg:min-h-[250px]">
        <div className="pointer-events-none absolute -right-10 -top-24 h-64 w-64 rounded-full bg-[#43B02A]/25 blur-3xl" />
        <div className="relative flex items-stretch justify-between gap-4">
          <div className="min-w-0 flex-1 px-4 py-4 sm:px-6 sm:py-6">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-11 font-medium uppercase tracking-label text-white/80">
                <Bot size={13} strokeWidth={2} className="text-[#7BD66A]" /> Autonomous content
              </span>
              <button
                type="button"
                onClick={refreshAll}
                disabled={busy}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-12 font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50 u-focus-ring"
              >
                <RefreshCw size={14} strokeWidth={2} className={busy ? "animate-spin" : ""} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
            </div>
            <h1 className="mt-3 text-22 font-medium leading-tight tracking-tight sm:text-28">Content Review</h1>
            <p className="mt-1.5 max-w-md text-13 text-white/65 sm:text-14">
              The engine drafts the posts — you approve what goes live. Every named-competitor comparison lands here first.
            </p>
            <div className="mt-4 flex gap-1.5 overflow-x-auto">
              <PillTab active={view === "content"} onClick={() => changeView("content")}>Content</PillTab>
              <PillTab active={view === "links"} onClick={() => changeView("links")}>Links</PillTab>
              <PillTab active={view === "ideas"} onClick={() => changeView("ideas")}>Ideas</PillTab>
            </div>
          </div>
          {/* iPhone mockup — desktop only (decorative; hidden on phones where it'd waste the screen) */}
          <div className="relative hidden w-[230px] shrink-0 lg:block">
            <div className="absolute right-5 top-8 w-[198px]">
              <PhoneFrame src="/waves-app-home.png" />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-[#FEECEB] px-3 py-2.5 text-13 text-[#B42318]">
          <AlertTriangle size={16} strokeWidth={2} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Content Queue ── */}
      {view === "content" && (
        <div className="pt-4">
          <KpiRow>
            <Kpi label="Pending review" value={pendingCount} emphasize={pendingCount > 0} />
            <Kpi label="Shadow rows" value={shadowCount} />
            <Kpi label="Done" value={counts.done || 0} />
            <Kpi label="Skipped" value={counts.skipped || 0} />
          </KpiRow>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start">
            {/* List */}
            <div className={cn(mobileDetailOpen ? "hidden" : "block", "lg:block")}>
              <ListHeader icon={Search} title="Queue" count={items.length} />
              {loading ? (
                <Empty>Loading…</Empty>
              ) : items.length === 0 ? (
                <Empty>No pending review rows.</Empty>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {items.map((item) => {
                    const gt = gateTag(item.run?.gate_summary);
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
                          {named && <Tag tone="forest" className="shrink-0">Named competitor</Tag>}
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <Tag>{item.action_type}</Tag>
                          <Tag tone={gt.tone}>{gt.label}</Tag>
                          <span className="text-12 tabular-nums text-zinc-500">Score {item.final_score ?? item.score ?? "—"}</span>
                          <span className="ml-auto text-12 text-zinc-400">{formatDate(item.updated_at || item.completed_at)}</span>
                        </div>
                      </RowCard>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Detail */}
            <div className={cn(mobileDetailOpen ? "block" : "hidden", "lg:block lg:sticky lg:top-4")}>
              <Panel>
                <PanelHeader icon={FileText} title="Review detail" onBack={() => setMobileDetailOpen(false)} />
                {!selected ? (
                  <Empty>Select a row to review it.</Empty>
                ) : (
                  <CardBody className={cn("flex flex-col gap-4", detailLoading && "opacity-60")}>
                    <div>
                      <div className="text-16 font-medium leading-snug text-zinc-900">
                        {selected.draft?.title || selected.target_keyword || "Untitled review"}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Tag>{selected.status}</Tag>
                        <Tag>{selected.action_type}</Tag>
                        {selected.run?.shadow_mode && <Tag>shadow</Tag>}
                        {isNamedCompetitor(selected) && <Tag tone="forest">Named competitor</Tag>}
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <Field label="Target" value={selected.target_url || "—"} />
                      <Field label="Keyword" value={selected.target_keyword || "—"} />
                      <Field label="Reason" value={selected.skip_reason || "—"} />
                      <Field label="Run" value={selected.run?.outcome || "—"} />
                    </div>

                    {selected.status === "pending_review" && (
                      <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4">
                        <Textarea
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                          placeholder="Reviewer note (optional)"
                          rows={3}
                        />
                        <div className="flex flex-wrap gap-2">
                          <ActionBtn variant="secondary" disabled={!reviewActions.can_requeue || !!actionPending} onClick={() => submitDecision("requeue")}>
                            <RotateCcw size={15} strokeWidth={2} />
                            {actionPending === "requeue" ? "Working…" : "Requeue"}
                          </ActionBtn>
                          {reviewActions.can_approve_trust_build && (
                            <ActionBtn disabled={!!actionPending} onClick={() => submitDecision("approve_trust_build")}>
                              <CheckCircle2 size={15} strokeWidth={2} />
                              {actionPending === "approve_trust_build" ? "Working…" : "Approve"}
                            </ActionBtn>
                          )}
                          {reviewActions.can_approve_named_competitor && (
                            <ActionBtn disabled={!!actionPending} onClick={() => submitDecision("approve_named_competitor")}>
                              <CheckCircle2 size={15} strokeWidth={2} />
                              {actionPending === "approve_named_competitor" ? "Working…" : "Approve & publish"}
                            </ActionBtn>
                          )}
                          <ActionBtn variant="danger" disabled={!reviewActions.can_dismiss || !!actionPending} onClick={() => submitDecision("dismiss")}>
                            <XCircle size={15} strokeWidth={2} />
                            {actionPending === "dismiss" ? "Working…" : "Dismiss"}
                          </ActionBtn>
                        </div>
                      </div>
                    )}

                    <Section
                      icon={hardFailures.length === 0 && uniquenessFailures.length === 0 && seoCompletion?.passed !== false ? CheckCircle2 : AlertTriangle}
                      ok={hardFailures.length === 0 && uniquenessFailures.length === 0 && seoCompletion?.passed !== false}
                      title="Gate summary"
                    >
                      <div className="grid gap-1 text-13 text-zinc-600">
                        <div>Score: <span className="tabular-nums text-zinc-900">{gateSummary?.quality_score ?? "—"} / {gateSummary?.quality_min_score ?? "—"}</span></div>
                        <div>Hard: {hardFailures.length ? hardFailures.join(", ") : "none"}</div>
                        <div>Soft: {softFailures.length ? softFailures.join(", ") : "none"}</div>
                        <div>Uniqueness: {uniquenessFailures.length ? uniquenessFailures.join(", ") : (gateSummary?.uniqueness_ok === false ? "failed" : "none")}</div>
                        <div>SEO completion: {seoCompletion?.available ? `P0 ${seoCompletion.p0} / P1 ${seoCompletion.p1} / P2 ${seoCompletion.p2}` : "not run"}</div>
                      </div>
                    </Section>

                    {seoCompletion?.available && (
                      <Section icon={seoCompletion.p0 === 0 ? CheckCircle2 : AlertTriangle} ok={seoCompletion.p0 === 0} title="SEO completion">
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
                              <div key={`${finding.severity}-${finding.code}`} className={cn("text-13 leading-snug", finding.severity === "P0" ? "text-[#B42318]" : "text-zinc-600")}>
                                <span className="font-medium">{finding.severity} {finding.code}</span>: {finding.message}
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
                    )}

                    {selected.draft?.meta_description && (
                      <Section title="Meta">
                        <div className="text-14 leading-snug text-zinc-600">{selected.draft.meta_description}</div>
                      </Section>
                    )}

                    {selected.draft?.body_preview && (
                      <Section title="Draft preview">
                        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#FAF7EF] p-3 text-14 leading-relaxed text-zinc-800">
                          {selected.draft.body || selected.draft.body_preview}
                        </div>
                      </Section>
                    )}
                  </CardBody>
                )}
              </Panel>
            </div>
          </div>
        </div>
      )}

      {/* ── Internal Links ── */}
      {view === "links" && (
        <div className="pt-4">
          <KpiRow>
            <Kpi label="Candidates" value={linkCounts.patch_candidate || 0} emphasize={(linkCounts.patch_candidate || 0) > 0} />
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
                          <div className="mt-0.5 truncate text-12 text-zinc-500">{[item.anchor_type, scorePercent(item.topical_relevance_score)].filter(Boolean).join(" · ")}</div>
                        </div>
                        <Tag tone={linkTagTone(item.status)} className="shrink-0">{item.status}</Tag>
                      </div>
                      <div className="mt-2 grid gap-0.5 text-12 text-zinc-500">
                        <div className="truncate"><span className="text-zinc-400">→</span> {item.target_url || "—"}</div>
                        <div className="flex items-center gap-2">
                          <span className="truncate">{item.source_url || item.source_file || "—"}</span>
                          <span className="ml-auto shrink-0 text-zinc-400">{formatDate(item.updated_at || item.planned_at)}</span>
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
                  <CardBody className={cn("flex flex-col gap-4", linkDetailLoading && "opacity-60")}>
                    <div>
                      <div className="text-16 font-medium leading-snug text-zinc-900">{selectedLink.anchor_text || "Untitled link"}</div>
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
                      <Field label="Reason" value={selectedLink.failure_reason || selectedLink.skip_reason || selectedLink.dismissed_reason || "—"} />
                      <Field label="Verified" value={formatDate(selectedLink.verified_at)} />
                    </div>

                    {selectedLink.astro_pr_url && <ExternalAnchor href={selectedLink.astro_pr_url} label="Open Astro PR" />}

                    <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4">
                      <Textarea
                        value={linkReviewNote}
                        onChange={(e) => setLinkReviewNote(e.target.value)}
                        placeholder="Reviewer note (optional)"
                        rows={3}
                      />
                      <div className="flex flex-wrap gap-2">
                        <ActionBtn variant="secondary" disabled={!selectedLink.review_actions?.can_requeue || !!linkActionPending} onClick={() => submitLinkDecision("requeue")}>
                          <RotateCcw size={15} strokeWidth={2} />
                          {linkActionPending === "requeue" ? "Working…" : "Requeue"}
                        </ActionBtn>
                        <ActionBtn disabled={!selectedLink.review_actions?.can_verify_now || !!linkActionPending} onClick={() => submitLinkDecision("verify_now")}>
                          <CheckCircle2 size={15} strokeWidth={2} />
                          {linkActionPending === "verify_now" ? "Working…" : "Verify"}
                        </ActionBtn>
                        <ActionBtn variant="danger" disabled={!selectedLink.review_actions?.can_dismiss || !!linkActionPending} onClick={() => submitLinkDecision("dismiss")}>
                          <XCircle size={15} strokeWidth={2} />
                          {linkActionPending === "dismiss" ? "Working…" : "Dismiss"}
                        </ActionBtn>
                      </div>
                    </div>

                    <LinkContext title="Before" value={selectedLink.link_context_before || selectedLink.context_snippet} />
                    <LinkContext title="After" value={selectedLink.link_context_after} />

                    <Section title="Validation">
                      <div className="grid gap-1 text-13 text-zinc-600">
                        <div>Target: HTTP {selectedLink.target_http_status ?? "—"} · indexable {yesNo(selectedLink.target_indexable)} · canonical {yesNo(selectedLink.target_canonical_matches)}</div>
                        <div>Source: HTTP {selectedLink.source_http_status ?? "—"} · indexable {yesNo(selectedLink.source_indexable)} · canonical {yesNo(selectedLink.source_canonical_matches)}</div>
                        <div>Links: source {selectedLink.source_existing_internal_links_count ?? "—"} · target inlinks {selectedLink.target_existing_inlinks_count ?? "—"}</div>
                      </div>
                    </Section>

                    {selectedLink.reviewer_notes && (
                      <Section title="Reviewer notes">
                        <div className="whitespace-pre-wrap text-13 leading-relaxed text-zinc-600">{selectedLink.reviewer_notes}</div>
                      </Section>
                    )}
                  </CardBody>
                )}
              </Panel>
            </div>
          </div>
        </div>
      )}

      {/* ── Blog Ideas ── */}
      {view === "ideas" && (
        <div className="pt-4">
          <KpiRow cols={3}>
            <Kpi label="Ideas" value={ideaCounts.idea || 0} emphasize={(ideaCounts.idea || 0) > 0} />
            <Kpi label="Drafts (ready)" value={ideaCounts.draft || 0} emphasize={(ideaCounts.draft || 0) > 0} />
            <Kpi label="Published" value={ideaCounts.published || 0} />
          </KpiRow>

          <ListHeader icon={Lightbulb} title="Blog ideas & drafts" count={ideaPosts.length} />
          {ideaLoading ? (
            <Empty>Loading…</Empty>
          ) : ideaPosts.length === 0 ? (
            <Empty>No blog ideas or drafts in the backlog.</Empty>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {ideaPosts.map((p) => (
                <div key={p.id} className="flex flex-col gap-2.5 rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-14 font-medium leading-snug text-zinc-900">{p.title || "Untitled"}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-12 text-zinc-500">
                        {p.tag && <Tag>{p.tag}</Tag>}
                        {p.city && <span>{p.city}</span>}
                        {p.keyword && <span className="truncate">kw: {p.keyword}</span>}
                      </div>
                    </div>
                    <Tag tone={p.status === "draft" ? "forest" : "neutral"} className="shrink-0">{p.status}</Tag>
                  </div>
                  <div className="flex justify-end">
                    {p.status === "idea" && (
                      <ActionBtn size="sm" disabled={!!ideaActionPending} onClick={() => runIdeaAction(p.id, "generate")}>
                        <Sparkles size={14} strokeWidth={2} />
                        {ideaActionPending === `generate:${p.id}` ? "Working…" : "Generate"}
                      </ActionBtn>
                    )}
                    {p.status === "draft" && (
                      <ActionBtn size="sm" disabled={!!ideaActionPending} onClick={() => runIdeaAction(p.id, "publish")}>
                        <UploadCloud size={14} strokeWidth={2} />
                        {ideaActionPending === `publish:${p.id}` ? "Working…" : "Publish PR"}
                      </ActionBtn>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-12 leading-relaxed text-zinc-500">
            Generate writes a full draft (content + meta) via the blog writer; Publish PR opens a review-only Astro PR (Codex + content guardrails run before merge). Ideas come from the blog idea generator, independent of GSC demand.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Presentational helpers (TruGreen-inspired: forest header, kelly-green accents) ──

function PhoneFrame({ src }) {
  // The App Store capture already includes the app's own top bar, so no hardware
  // notch is drawn over it — just a rounded bezel + screen for a clean mockup.
  return (
    <div className="relative rounded-[2rem] border-[5px] border-zinc-900 bg-zinc-900 shadow-2xl ring-1 ring-white/10">
      <img src={src} alt="Waves customer app" className="block w-full rounded-[1.6rem]" loading="lazy" />
    </div>
  );
}

function PillTab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-9 shrink-0 rounded-full px-4 text-13 font-medium transition-colors u-focus-ring",
        active ? "bg-[#43B02A] text-white" : "bg-white/10 text-white/80 hover:bg-white/20",
      )}
    >
      {children}
    </button>
  );
}

function KpiRow({ children, cols = 4 }) {
  return (
    <div className={cn("mb-4 grid grid-cols-2 gap-2.5 sm:gap-3", cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4")}>
      {children}
    </div>
  );
}

function Kpi({ label, value, emphasize }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4">
      <div className="text-11 uppercase tracking-label text-zinc-400 sm:text-12">{label}</div>
      <div className={cn("mt-1 text-22 leading-none tabular-nums sm:text-28", emphasize ? "font-medium text-[#43B02A]" : "text-zinc-900")}>{value}</div>
    </div>
  );
}

function ListHeader({ icon: Icon, title, count }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <Icon size={15} strokeWidth={2} className="text-[#2E7D20]" />
      <span className="text-12 uppercase tracking-label text-zinc-500">{title}</span>
      {typeof count === "number" && (
        <span className="rounded-full bg-zinc-100 px-2 text-11 tabular-nums text-zinc-500">{count}</span>
      )}
    </div>
  );
}

function RowCard({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-2xl border p-3 text-left transition-colors sm:p-4 u-focus-ring",
        active ? "border-[#43B02A] bg-[#F1F9EE]" : "border-zinc-200 bg-white hover:border-[#43B02A] hover:bg-[#F8FCF6]",
      )}
    >
      {children}
    </button>
  );
}

function Panel({ children }) {
  return <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">{children}</div>;
}

function PanelHeader({ icon: Icon, title, onBack }) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex h-7 items-center gap-1 rounded-full px-1.5 text-12 text-zinc-600 hover:bg-zinc-100 lg:hidden u-focus-ring"
      >
        <ArrowLeft size={15} strokeWidth={2} /> Back
      </button>
      <Icon size={15} strokeWidth={2} className="text-[#2E7D20]" />
      <span className="text-12 uppercase tracking-label text-zinc-500">{title}</span>
    </div>
  );
}

function Empty({ children }) {
  return <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-14 text-zinc-400">{children}</div>;
}

function Tag({ tone = "neutral", className, children }) {
  const cls = {
    neutral: "bg-zinc-100 text-zinc-600",
    green: "bg-[#EAF5E4] text-[#2E7D20]",
    forest: "bg-[#143D2A] text-white",
    alert: "bg-[#FEECEB] text-[#B42318]",
  }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-11 font-medium", cls, className)}>
      {children}
    </span>
  );
}

function ActionBtn({ variant = "green", size = "md", disabled, onClick, children }) {
  const tone = {
    green: "bg-[#43B02A] text-white hover:bg-[#3A9A24] border-transparent",
    secondary: "bg-white text-zinc-800 border-zinc-300 hover:bg-zinc-50",
    danger: "bg-white text-[#B42318] border-[#F1C7C2] hover:bg-[#FEF3F2]",
  }[variant];
  const sizing = size === "sm" ? "h-9 px-3.5 text-12" : "h-11 px-4 text-13 sm:h-10";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 u-focus-ring",
        sizing,
        tone,
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, value }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2 text-14">
      <span className="text-zinc-400">{label}</span>
      <span className="break-words text-zinc-900">{value}</span>
    </div>
  );
}

function Section({ icon: Icon, ok, title, children }) {
  return (
    <div className="border-t border-zinc-200 pt-4">
      <div className="mb-2 flex items-center gap-2">
        {Icon && <Icon size={15} strokeWidth={2} className={ok ? "text-[#2E7D20]" : "text-[#B42318]"} />}
        <span className="text-12 uppercase tracking-label text-zinc-500">{title}</span>
      </div>
      {children}
    </div>
  );
}

function ExternalAnchor({ href, label }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex w-fit items-center gap-1.5 text-13 font-medium text-[#2E7D20] hover:underline"
    >
      <ExternalLink size={14} strokeWidth={2} />
      {label}
    </a>
  );
}

function LinkContext({ title, value }) {
  if (!value) return null;
  return (
    <Section title={title}>
      <div className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#FAF7EF] p-3 text-13 leading-relaxed text-zinc-600">
        {value}
      </div>
    </Section>
  );
}

function scorePercent(value) {
  if (value == null) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${Math.round(n * 100)}% relevance`;
}

function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "—";
}
