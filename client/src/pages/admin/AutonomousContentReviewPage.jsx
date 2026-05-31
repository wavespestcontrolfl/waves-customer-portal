import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
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
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  heading: "#09090B",
  text: "#27272A",
  muted: "#71717A",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  accent: "#18181B",
};
const MONO = "'JetBrains Mono', monospace";

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

function Chip({ children, tone = "neutral" }) {
  const colors = {
    green: { bg: "#DCFCE7", fg: D.green },
    amber: { bg: "#FEF3C7", fg: D.amber },
    red: { bg: "#FEE2E2", fg: D.red },
    neutral: { bg: D.bg, fg: D.text },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "0 8px",
        borderRadius: 6,
        background: colors.bg,
        color: colors.fg,
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Kpi({ label, value, tone }) {
  const color = tone === "red" ? D.red : tone === "amber" ? D.amber : tone === "green" ? D.green : D.heading;
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 24, color, fontWeight: 800, fontFamily: MONO, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function gateTone(summary) {
  if (!summary) return "neutral";
  if ((summary.hard_failures || []).length > 0 || summary.quality_ok === false || summary.uniqueness_ok === false || summary.seo_completion_ok === false) return "red";
  if ((summary.soft_failures || []).length > 0) return "amber";
  return "green";
}

export default function AutonomousContentReviewPage() {
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
        body: { decision, note: reviewNote },
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

  return (
    <div style={{ minHeight: "100%", background: D.bg, padding: 24 }}>
      <AdminCommandHeader
        title="Autonomous Content Review"
        icon={Bot}
        actions={[{ key: "refresh", label: "Refresh", icon: RefreshCw, onClick: () => { load(); loadLinks(); loadIdeas(); }, disabled: loading || linkLoading || ideaLoading, variant: "secondary" }]}
      />

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: D.red, background: "#FEE2E2", border: `1px solid ${D.red}33`, borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <AlertTriangle size={16} strokeWidth={2} />
          <span style={{ fontSize: 13, fontWeight: 650 }}>{error}</span>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <TabButton active={view === "content"} icon={Bot} label="Content Queue" onClick={() => setView("content")} />
        <TabButton active={view === "links"} icon={Link2} label="Internal Links" onClick={() => setView("links")} />
        <TabButton active={view === "ideas"} icon={Lightbulb} label="Blog Ideas" onClick={() => setView("ideas")} />
      </div>

      {view === "content" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
            <Kpi label="Pending Review" value={pendingCount} tone={pendingCount > 0 ? "amber" : "green"} />
            <Kpi label="Shadow Rows" value={shadowCount} />
            <Kpi label="Done" value={counts.done || 0} tone="green" />
            <Kpi label="Skipped" value={counts.skipped || 0} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: 16, alignItems: "start" }}>
        <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
            <Search size={16} strokeWidth={2} />
            <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>Queue</div>
          </div>
          {loading ? (
            <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>Loading...</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>No pending review rows.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
                <thead>
                  <tr>
                    {["Opportunity", "Action", "Score", "Gate", "Reason", "Updated"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: D.muted, fontSize: 12, fontWeight: 800, borderBottom: `1px solid ${D.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const active = item.id === selectedId;
                    const summary = item.run?.gate_summary;
                    return (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        style={{ cursor: "pointer", background: active ? "#F8FAFC" : D.card }}
                      >
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}>
                          <div style={{ color: D.heading, fontWeight: 750, fontSize: 13 }}>{item.target_keyword || item.query || item.target_url || "Untitled"}</div>
                          <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>{[item.city, item.service, item.bucket].filter(Boolean).join(" / ")}</div>
                        </td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}><Chip>{item.action_type}</Chip></td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, fontFamily: MONO, fontSize: 13 }}>{item.final_score ?? item.score ?? "—"}</td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}` }}>
                          <Chip tone={gateTone(summary)}>{summary?.quality_ok === true && summary?.uniqueness_ok !== false ? "Passed" : "Review"}</Chip>
                        </td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, color: D.text, fontSize: 12 }}>{item.skip_reason || "—"}</td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, color: D.muted, fontSize: 12 }}>{formatDate(item.updated_at || item.completed_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
            <FileText size={16} strokeWidth={2} />
            <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>Review Detail</div>
          </div>
          {!selected ? (
            <div style={{ padding: 24, color: D.muted, textAlign: "center" }}>Select a row.</div>
          ) : (
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, opacity: detailLoading ? 0.65 : 1 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 850, color: D.heading, lineHeight: 1.25 }}>{selected.draft?.title || selected.target_keyword || "Untitled review"}</div>
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <Chip>{selected.status}</Chip>
                  <Chip>{selected.action_type}</Chip>
                  {selected.run?.shadow_mode && <Chip tone="amber">shadow</Chip>}
                </div>
              </div>

              <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
                <Row label="Target" value={selected.target_url || "—"} />
                <Row label="Keyword" value={selected.target_keyword || "—"} />
                <Row label="Reason" value={selected.skip_reason || "—"} />
                <Row label="Run" value={selected.run?.outcome || "—"} />
              </div>

              {selected.status === "pending_review" && (
                <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12, display: "grid", gap: 10 }}>
                  <textarea
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    placeholder="Reviewer note"
                    rows={3}
                    style={{
                      width: "100%",
                      resize: "vertical",
                      border: `1px solid ${D.border}`,
                      borderRadius: 8,
                      padding: 10,
                      fontSize: 13,
                      color: D.text,
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <ActionButton
                      icon={RotateCcw}
                      label="Requeue"
                      disabled={!reviewActions.can_requeue || !!actionPending}
                      pending={actionPending === "requeue"}
                      onClick={() => submitDecision("requeue")}
                    />
                    {reviewActions.can_approve_trust_build && (
                      <ActionButton
                        icon={CheckCircle2}
                        label="Approve"
                        tone="green"
                        disabled={!!actionPending}
                        pending={actionPending === "approve_trust_build"}
                        onClick={() => submitDecision("approve_trust_build")}
                      />
                    )}
                    <ActionButton
                      icon={XCircle}
                      label="Dismiss"
                      tone="red"
                      disabled={!reviewActions.can_dismiss || !!actionPending}
                      pending={actionPending === "dismiss"}
                      onClick={() => submitDecision("dismiss")}
                    />
                  </div>
                </div>
              )}

              <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 800, color: D.heading, marginBottom: 8 }}>
                  {hardFailures.length === 0 && uniquenessFailures.length === 0 && seoCompletion?.passed !== false ? <CheckCircle2 size={16} color={D.green} /> : <AlertTriangle size={16} color={D.red} />}
                  Gate Summary
                </div>
                <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6 }}>
                  Score: {gateSummary?.quality_score ?? "—"} / {gateSummary?.quality_min_score ?? "—"}
                  <br />
                  Hard: {hardFailures.length ? hardFailures.join(", ") : "none"}
                  <br />
                  Soft: {softFailures.length ? softFailures.join(", ") : "none"}
                  <br />
                  Uniqueness: {uniquenessFailures.length ? uniquenessFailures.join(", ") : (gateSummary?.uniqueness_ok === false ? "failed" : "none")}
                  <br />
                  SEO completion: {seoCompletion?.available ? `P0 ${seoCompletion.p0} / P1 ${seoCompletion.p1} / P2 ${seoCompletion.p2}` : "not run"}
                </div>
              </div>

              {seoCompletion?.available && (
                <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 800, color: D.heading, marginBottom: 8 }}>
                    {seoCompletion.p0 === 0 ? <CheckCircle2 size={16} color={D.green} /> : <AlertTriangle size={16} color={D.red} />}
                    SEO Completion
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                    <Chip tone={seoCompletion.p0 > 0 ? "red" : "green"}>P0 {seoCompletion.p0}</Chip>
                    <Chip tone={seoCompletion.p1 > 0 ? "amber" : "green"}>P1 {seoCompletion.p1}</Chip>
                    <Chip tone={seoCompletion.p2 > 0 ? "amber" : "green"}>P2 {seoCompletion.p2}</Chip>
                    <Chip>{seoCompletion.faq_count || 0} FAQs</Chip>
                    <Chip>{recommendedLinks.length} links</Chip>
                  </div>
                  {seoFindings.length > 0 && (
                    <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                      {seoFindings.slice(0, 6).map((finding) => (
                        <div key={`${finding.severity}-${finding.code}`} style={{ fontSize: 12, lineHeight: 1.45, color: finding.severity === "P0" ? D.red : D.text }}>
                          <strong>{finding.severity} {finding.code}</strong>: {finding.message}
                        </div>
                      ))}
                    </div>
                  )}
                  {recommendedLinks.length > 0 && (
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontSize: 12, color: D.muted, fontWeight: 800 }}>Recommended links</div>
                      {recommendedLinks.slice(0, 6).map((link) => (
                        <div key={`${link.reason}-${link.url}`} style={{ fontSize: 12, color: D.text, lineHeight: 1.45 }}>
                          <strong>{link.url}</strong>
                          <br />
                          Anchor: {link.anchorText || "—"} · Reason: {link.reason || "—"}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {selected.draft?.meta_description && (
                <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800, marginBottom: 4 }}>Meta</div>
                  <div style={{ fontSize: 13, color: D.text, lineHeight: 1.45 }}>{selected.draft.meta_description}</div>
                </div>
              )}

              {selected.draft?.body_preview && (
                <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                  <div style={{ fontSize: 12, color: D.muted, fontWeight: 800, marginBottom: 4 }}>Draft Preview</div>
                  <div style={{ fontSize: 13, color: D.text, lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto" }}>
                    {selected.draft.body || selected.draft.body_preview}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
        </>
      )}

      {view === "links" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
            <Kpi label="Candidates" value={linkCounts.patch_candidate || 0} tone={(linkCounts.patch_candidate || 0) > 0 ? "amber" : "green"} />
            <Kpi label="PR Open" value={linkCounts.pr_open || 0} tone={(linkCounts.pr_open || 0) > 0 ? "amber" : "green"} />
            <Kpi label="Merged/Deployed" value={(linkCounts.merged || 0) + (linkCounts.deployed || 0)} tone={(linkCounts.merged || 0) + (linkCounts.deployed || 0) > 0 ? "amber" : "green"} />
            <Kpi label="Verified" value={linkCounts.verified || 0} tone="green" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(min(700px, 100%), 1.4fr) minmax(min(420px, 100%), 0.9fr)", gap: 16, alignItems: "start" }}>
            <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
                <Link2 size={16} strokeWidth={2} />
                <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>Internal-Link Tasks</div>
              </div>
              {linkLoading ? (
                <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>Loading...</div>
              ) : linkItems.length === 0 ? (
                <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>No internal-link tasks.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
                    <thead>
                      <tr>
                        {["Status", "Anchor", "Source", "Target", "PR", "Updated"].map((h) => (
                          <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: D.muted, fontSize: 12, fontWeight: 800, borderBottom: `1px solid ${D.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {linkItems.map((item) => {
                        const active = item.id === selectedLinkId;
                        return (
                          <tr
                            key={item.id}
                            onClick={() => setSelectedLinkId(item.id)}
                            style={{ cursor: "pointer", background: active ? "#F8FAFC" : D.card }}
                          >
                            <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}>
                              <Chip tone={linkStatusTone(item.status)}>{item.status}</Chip>
                            </td>
                            <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}>
                              <div style={{ color: D.heading, fontWeight: 800, fontSize: 13 }}>{item.anchor_text || "—"}</div>
                              <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>{[item.anchor_type, scorePercent(item.topical_relevance_score)].filter(Boolean).join(" / ")}</div>
                            </td>
                            <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, color: D.text, fontSize: 12, verticalAlign: "top" }}>{item.source_url || item.source_file || "—"}</td>
                            <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, color: D.text, fontSize: 12, verticalAlign: "top" }}>{item.target_url || "—"}</td>
                            <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}>
                              {item.astro_pr_url ? <ExternalAnchor href={item.astro_pr_url} label="PR" /> : <span style={{ color: D.muted }}>—</span>}
                            </td>
                            <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, color: D.muted, fontSize: 12, verticalAlign: "top" }}>{formatDate(item.updated_at || item.planned_at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <aside style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
                <GitPullRequest size={16} strokeWidth={2} />
                <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>Link Detail</div>
              </div>
              {!selectedLink ? (
                <div style={{ padding: 24, color: D.muted, textAlign: "center" }}>Select a task.</div>
              ) : (
                <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, opacity: linkDetailLoading ? 0.65 : 1 }}>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 850, color: D.heading, lineHeight: 1.25 }}>{selectedLink.anchor_text || "Untitled link"}</div>
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      <Chip tone={linkStatusTone(selectedLink.status)}>{selectedLink.status}</Chip>
                      {selectedLink.anchor_type && <Chip>{selectedLink.anchor_type}</Chip>}
                      {selectedLink.topic_cluster && <Chip>{selectedLink.topic_cluster}</Chip>}
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
                    <Row label="Source" value={selectedLink.source_url || selectedLink.source_file || "—"} />
                    <Row label="Target" value={selectedLink.target_url || "—"} />
                    <Row label="Source file" value={selectedLink.source_file || "—"} />
                    <Row label="Target file" value={selectedLink.target_file || "—"} />
                    <Row label="Reason" value={selectedLink.failure_reason || selectedLink.skip_reason || selectedLink.dismissed_reason || "—"} />
                    <Row label="Verified" value={formatDate(selectedLink.verified_at)} />
                  </div>

                  {selectedLink.astro_pr_url && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <ExternalAnchor href={selectedLink.astro_pr_url} label="Open Astro PR" />
                    </div>
                  )}

                  <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12, display: "grid", gap: 10 }}>
                    <textarea
                      value={linkReviewNote}
                      onChange={(e) => setLinkReviewNote(e.target.value)}
                      placeholder="Reviewer note"
                      rows={3}
                      style={{
                        width: "100%",
                        resize: "vertical",
                        border: `1px solid ${D.border}`,
                        borderRadius: 8,
                        padding: 10,
                        fontSize: 13,
                        color: D.text,
                        boxSizing: "border-box",
                      }}
                    />
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <ActionButton
                        icon={RotateCcw}
                        label="Requeue"
                        disabled={!selectedLink.review_actions?.can_requeue || !!linkActionPending}
                        pending={linkActionPending === "requeue"}
                        onClick={() => submitLinkDecision("requeue")}
                      />
                      <ActionButton
                        icon={CheckCircle2}
                        label="Verify"
                        tone="green"
                        disabled={!selectedLink.review_actions?.can_verify_now || !!linkActionPending}
                        pending={linkActionPending === "verify_now"}
                        onClick={() => submitLinkDecision("verify_now")}
                      />
                      <ActionButton
                        icon={XCircle}
                        label="Dismiss"
                        tone="red"
                        disabled={!selectedLink.review_actions?.can_dismiss || !!linkActionPending}
                        pending={linkActionPending === "dismiss"}
                        onClick={() => submitLinkDecision("dismiss")}
                      />
                    </div>
                  </div>

                  <LinkContext title="Before" value={selectedLink.link_context_before || selectedLink.context_snippet} />
                  <LinkContext title="After" value={selectedLink.link_context_after} />

                  <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12, display: "grid", gap: 8, fontSize: 12, color: D.text }}>
                    <div style={{ color: D.muted, fontWeight: 800 }}>Validation</div>
                    <div>Target: HTTP {selectedLink.target_http_status ?? "—"} · indexable {yesNo(selectedLink.target_indexable)} · canonical {yesNo(selectedLink.target_canonical_matches)}</div>
                    <div>Source: HTTP {selectedLink.source_http_status ?? "—"} · indexable {yesNo(selectedLink.source_indexable)} · canonical {yesNo(selectedLink.source_canonical_matches)}</div>
                    <div>Links: source {selectedLink.source_existing_internal_links_count ?? "—"} · target inlinks {selectedLink.target_existing_inlinks_count ?? "—"}</div>
                  </div>

                  {selectedLink.reviewer_notes && (
                    <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
                      <div style={{ fontSize: 12, color: D.muted, fontWeight: 800, marginBottom: 4 }}>Reviewer Notes</div>
                      <div style={{ fontSize: 12, color: D.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{selectedLink.reviewer_notes}</div>
                    </div>
                  )}
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      {view === "ideas" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
            <Kpi label="Ideas" value={ideaCounts.idea || 0} tone={(ideaCounts.idea || 0) > 0 ? "amber" : "green"} />
            <Kpi label="Drafts (ready to publish)" value={ideaCounts.draft || 0} tone={(ideaCounts.draft || 0) > 0 ? "amber" : undefined} />
            <Kpi label="Published" value={ideaCounts.published || 0} tone="green" />
          </div>

          <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
              <Lightbulb size={16} strokeWidth={2} />
              <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>Blog Ideas &amp; Drafts</div>
            </div>
            {ideaLoading ? (
              <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>Loading...</div>
            ) : ideaPosts.length === 0 ? (
              <div style={{ padding: 32, color: D.muted, textAlign: "center" }}>No blog ideas or drafts in the backlog.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
                  <thead>
                    <tr>
                      {["Title", "Topic", "City", "Status", ""].map((h) => (
                        <th key={h || "actions"} style={{ textAlign: h ? "left" : "right", padding: "10px 12px", color: D.muted, fontSize: 12, fontWeight: 800, borderBottom: `1px solid ${D.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ideaPosts.map((p) => (
                      <tr key={p.id} style={{ background: D.card }}>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top", maxWidth: 440 }}>
                          <div style={{ color: D.heading, fontWeight: 750, fontSize: 13, lineHeight: 1.3 }}>{p.title || "Untitled"}</div>
                          {p.keyword && <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>kw: {p.keyword}</div>}
                        </td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}>{p.tag ? <Chip>{p.tag}</Chip> : "—"}</td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top", fontSize: 12, color: D.text }}>{p.city || "—"}</td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}><Chip tone={p.status === "draft" ? "amber" : undefined}>{p.status}</Chip></td>
                        <td style={{ padding: "12px", borderBottom: `1px solid ${D.border}`, verticalAlign: "top" }}>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            {p.status === "idea" && (
                              <ActionButton
                                icon={Sparkles}
                                label="Generate"
                                tone="green"
                                disabled={!!ideaActionPending}
                                pending={ideaActionPending === `generate:${p.id}`}
                                onClick={() => runIdeaAction(p.id, "generate")}
                              />
                            )}
                            {p.status === "draft" && (
                              <ActionButton
                                icon={UploadCloud}
                                label="Publish PR"
                                tone="green"
                                disabled={!!ideaActionPending}
                                pending={ideaActionPending === `publish:${p.id}`}
                                onClick={() => runIdeaAction(p.id, "publish")}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <div style={{ marginTop: 12, fontSize: 12, color: D.muted, lineHeight: 1.5 }}>
            Generate writes a full draft (content + meta) via the blog writer; Publish PR opens a review-only Astro PR (Codex + content guardrails run before merge). Ideas come from the blog idea generator, independent of GSC demand.
          </div>
        </>
      )}
    </div>
  );
}

function TabButton({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        minHeight: 38,
        border: `1px solid ${active ? D.accent : D.border}`,
        borderRadius: 8,
        background: active ? D.accent : D.card,
        color: active ? "#FFFFFF" : D.text,
        padding: "0 12px",
        fontSize: 13,
        fontWeight: 800,
        cursor: "pointer",
      }}
    >
      <Icon size={15} strokeWidth={2} />
      {label}
    </button>
  );
}

function ActionButton({ icon: Icon, label, tone = "neutral", disabled, pending, onClick }) {
  const color = tone === "green" ? D.green : tone === "red" ? D.red : D.text;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 36,
        border: `1px solid ${D.border}`,
        borderRadius: 8,
        background: disabled ? "#FAFAFA" : D.card,
        color: disabled ? D.muted : color,
        padding: "0 10px",
        fontSize: 13,
        fontWeight: 750,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <Icon size={15} strokeWidth={2} />
      {pending ? "Working..." : label}
    </button>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "92px minmax(0, 1fr)", gap: 8 }}>
      <div style={{ color: D.muted, fontWeight: 750 }}>{label}</div>
      <div style={{ color: D.text, wordBreak: "break-word" }}>{value}</div>
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
      style={{ display: "inline-flex", alignItems: "center", gap: 5, color: D.accent, fontSize: 12, fontWeight: 800, textDecoration: "none" }}
    >
      <ExternalLink size={13} strokeWidth={2} />
      {label}
    </a>
  );
}

function LinkContext({ title, value }) {
  if (!value) return null;
  return (
    <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 800, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto", border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, background: "#FAFAFA" }}>
        {value}
      </div>
    </div>
  );
}

function linkStatusTone(status) {
  if (status === "verified" || status === "applied") return "green";
  if (status === "failed" || status === "dismissed") return "red";
  if (["patch_candidate", "pr_open", "merged", "deployed"].includes(status)) return "amber";
  return "neutral";
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
