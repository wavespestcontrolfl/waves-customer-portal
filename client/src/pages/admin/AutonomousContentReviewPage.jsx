import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "../../components/ui";
import { Bot, AlertTriangle } from "lucide-react";
import { PillTab, PhoneFrame } from "./autonomous-content/shared";
import useVisiblePageRefresh from "../../hooks/useVisiblePageRefresh";
import ContentTab from "./autonomous-content/ActivityTab";
import LinksTab from "./autonomous-content/LinksTab";
import ImpactTab from "./autonomous-content/ImpactTab";

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
  const [contentError, setContentError] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkDecisionError, setLinkDecisionError] = useState("");
  const [impactError, setImpactError] = useState("");
  const error = {
    links: [linkDecisionError, linkError].filter(Boolean).join(" · "),
    impact: impactError,
    content: contentError,
    review: [decisionError, contentError].filter(Boolean).join(" · "),
  }[view];
  const [reviewNote, setReviewNote] = useState("");
  const [linkReviewNote, setLinkReviewNote] = useState("");
  const [actionPending, setActionPending] = useState("");
  const [linkActionPending, setLinkActionPending] = useState("");
  const [impactData, setImpactData] = useState(null);
  const [impactLoading, setImpactLoading] = useState(true);
  // On phones the list and the detail can't share the screen — tapping a row
  // opens the detail; "Back" returns to the list. Desktop shows both columns.
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("all");
  const [detailVersion, setDetailVersion] = useState(0);
  const [linkDetailVersion, setLinkDetailVersion] = useState(0);
  const listRequest = useRef(0);
  const linksRequest = useRef(0);
  const linkDetailRequest = useRef(0);
  const impactRequest = useRef(0);
  const listInFlight = useRef(null);
  const currentLoad = useRef(null);
  const detailInFlight = useRef(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedLinkIdRef = useRef(selectedLinkId);
  selectedLinkIdRef.current = selectedLinkId;
  const linkReviewNoteRef = useRef(linkReviewNote);
  linkReviewNoteRef.current = linkReviewNote;
  const actionType = view === "review" ? "other" : "new_supporting_blog";

  const updateLinkReviewNote = useCallback((value) => {
    linkReviewNoteRef.current = value;
    setLinkReviewNote(value);
  }, []);

  const load = useCallback(
    async (background = false) => {
      const request = ++listRequest.current;
      listInFlight.current = request;
      if (!background) setLoading(true);
      setContentError("");
      try {
        const next = await adminFetch(
          `/admin/content/autonomous/review?status=${status}&limit=50&offset=${offset}&actionType=${actionType}`,
        );
        if (request !== listRequest.current) return;
        setData(next);
        if (!detailInFlight.current) setDetailVersion((version) => version + 1);
        const retained = next.items?.some((item) => item.id === selectedIdRef.current);
        if (background && !retained) {
          setSelectedId(null);
          setDetail(null);
          setMobileDetailOpen(false);
        } else {
          setSelectedId((current) => (retained ? current : next.items?.[0]?.id || null));
        }
      } catch (err) {
        if (request !== listRequest.current) return;
        setContentError(err.message);
        if (!background) {
          setData(null);
          setSelectedId(null);
          setDetail(null);
        }
      } finally {
        if (listInFlight.current === request) listInFlight.current = null;
        if (request === listRequest.current) setLoading(false);
      }
    },
    [offset, status, actionType],
  );
  currentLoad.current = load;

  const loadLinks = useCallback(async (background = false) => {
    const request = ++linksRequest.current;
    if (!background) setLinkLoading(true);
    setLinkError("");
    try {
      const next = await adminFetch("/admin/content/internal-links?status=all&limit=100");
      if (request !== linksRequest.current) return;
      // Check at response time so a poll that started before typing cannot
      // replace the selected row and clear its unsaved reviewer note.
      if (linkReviewNoteRef.current !== "") return;
      setLinkData(next);
      if (next.items?.some((item) => item.id === selectedLinkIdRef.current)) {
        setLinkDetailVersion((version) => version + 1);
      }
      setSelectedLinkId((current) =>
        next.items?.some((item) => item.id === current) ? current : next.items?.[0]?.id || null,
      );
    } catch (err) {
      if (request !== linksRequest.current) return;
      setLinkError(err.message);
    } finally {
      if (request === linksRequest.current) setLinkLoading(false);
    }
  }, []);

  const loadImpact = useCallback(async (background = false) => {
    const request = ++impactRequest.current;
    if (!background) setImpactLoading(true);
    setImpactError("");
    try {
      const next = await adminFetch("/admin/content/autonomous/impact?limit=100");
      if (request !== impactRequest.current) return;
      setImpactData(next);
    } catch (err) {
      if (request !== impactRequest.current) return;
      setImpactError(err.message);
    } finally {
      if (request === impactRequest.current) setImpactLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLinks();
    loadImpact();
  }, []);

  useEffect(() => {
    void load();
    return () => {
      listRequest.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setReviewNote("");
  }, [selectedId]);
  useEffect(() => {
    updateLinkReviewNote("");
  }, [selectedLinkId, updateLinkReviewNote]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return undefined;
    }
    // Stale-response guard: clicking row A then B can resolve A's fetch last,
    // leaving A's draft rendered while B is highlighted (decisions were
    // already safe server-side via the run-id 409; this fixes the display).
    let stale = false;
    const request = { id: selectedId };
    detailInFlight.current = request;
    setDetail((current) => (current?.id === selectedId ? current : null));
    setDetailLoading(true);
    adminFetch(`/admin/content/autonomous/review/${selectedId}`)
      .then((next) => {
        if (stale) return;
        setDetail(next.item);
      })
      .catch((err) => {
        if (!stale) setContentError(err.message);
      })
      .finally(() => {
        if (detailInFlight.current === request) detailInFlight.current = null;
        if (!stale) setDetailLoading(false);
      });
    return () => {
      stale = true;
      if (detailInFlight.current === request) detailInFlight.current = null;
    };
  }, [selectedId, detailVersion]);

  useEffect(() => {
    const request = ++linkDetailRequest.current;
    if (!selectedLinkId) {
      setLinkDetail(null);
      setLinkDetailLoading(false);
      return undefined;
    }
    setLinkDetail((current) => (current?.id === selectedLinkId ? current : null));
    setLinkDetailLoading(true);
    adminFetch(`/admin/content/internal-links/${selectedLinkId}`)
      .then((next) => {
        if (request !== linkDetailRequest.current || selectedLinkIdRef.current !== selectedLinkId) return;
        setLinkDetail(next.item);
      })
      .catch((err) => {
        if (request === linkDetailRequest.current && selectedLinkIdRef.current === selectedLinkId) {
          setLinkError(err.message);
        }
      })
      .finally(() => {
        if (request === linkDetailRequest.current && selectedLinkIdRef.current === selectedLinkId) {
          setLinkDetailLoading(false);
        }
      });
    return () => {
      if (linkDetailRequest.current === request) linkDetailRequest.current += 1;
    };
  }, [selectedLinkId, linkDetailVersion]);

  const submitDecision = async (decision) => {
    if (view !== "review" || selected?.action_type === "new_supporting_blog" || !selectedId || actionPending || loading)
      return;
    listRequest.current += 1;
    setActionPending(decision);
    setDecisionError("");
    try {
      const next = await adminFetch(`/admin/content/autonomous/review/${selectedId}/decision`, {
        method: "POST",
        // Bind the decision to the run currently displayed — the server rejects
        // it if a requeue/re-run replaced it since this view loaded.
        body: { decision, note: reviewNote, run_id: selected?.run?.id || null },
      });
      if (currentLoad.current !== load || selectedIdRef.current !== selectedId) return;
      setDetail(next.item);
      setReviewNote("");
      await load();
    } catch (err) {
      setDecisionError(err.message);
    } finally {
      setActionPending("");
    }
  };

  const submitLinkDecision = async (decision) => {
    if (!selectedLinkId || linkActionPending) return;
    const actionLinkId = selectedLinkId;
    linksRequest.current += 1;
    linkDetailRequest.current += 1;
    setLinkLoading(false);
    setLinkDetailLoading(false);
    setLinkActionPending(decision);
    setLinkDecisionError("");
    try {
      const next = await adminFetch(`/admin/content/internal-links/${actionLinkId}/decision`, {
        method: "POST",
        body: { decision, note: linkReviewNote },
      });
      if (selectedLinkIdRef.current === actionLinkId) {
        setLinkDetail(next.item);
        updateLinkReviewNote("");
      }
      await loadLinks();
    } catch (err) {
      setLinkDecisionError(err.message);
    } finally {
      setLinkActionPending("");
    }
  };

  const items = data?.items || [];
  const linkItems = linkData?.items || [];
  const selected = detail || items.find((item) => item.id === selectedId);
  const selectedLink = (linkDetail?.id === selectedLinkId ? linkDetail : null)
    || linkItems.find((item) => item.id === selectedLinkId);

  const busy = loading || linkLoading || impactLoading;

  useVisiblePageRefresh(
    () => {
      if (busy || actionPending || linkActionPending) return undefined;
      return Promise.all([load(true), loadLinks(true), loadImpact(true)]);
    },
    { intervalMs: 120_000 },
  );
  const changeView = (next) => {
    if (next === view) return;
    setView(next);
    setMobileDetailOpen(false);
    setOffset(0);
    setStatus(next === "review" ? "pending_review" : "all");
    setDetail(null);
    setReviewNote("");
  };
  const openContent = (id) => {
    setSelectedId(id);
    setMobileDetailOpen(true);
  };
  const openLink = (id) => {
    setSelectedLinkId(id);
    setMobileDetailOpen(true);
  };
  const retryCurrent = () => {
    if (view === "links") return loadLinks();
    if (view === "impact") return loadImpact();
    return load();
  };

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
            </div>
            <h1 className="mt-3 text-22 font-medium leading-tight tracking-tight sm:text-28">
              Autonomous blog activity
            </h1>
            <p className="mt-1.5 max-w-md text-13 text-white/65 sm:text-14">
              Blog posts are drafted, checked, repaired, and published automatically. Failed checks are retried or
              skipped with a recorded reason. No approval is needed.
            </p>
            <div className="mt-4 flex gap-1.5 overflow-x-auto">
              <PillTab active={view === "content"} onClick={() => changeView("content")}>
                Content
              </PillTab>
              <PillTab active={view === "review"} onClick={() => changeView("review")}>
                Review
              </PillTab>
              <PillTab active={view === "links"} onClick={() => changeView("links")}>
                Links
              </PillTab>
              <PillTab active={view === "impact"} onClick={() => changeView("impact")}>
                Impact
              </PillTab>
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
        <div className="mt-4 flex items-center gap-2 rounded-md bg-[#FEECEB] px-3 py-2.5 text-13 text-[#B42318]">
          <AlertTriangle size={16} strokeWidth={2} className="shrink-0" />
          <span>{error}</span>
          <button
            type="button"
            onClick={retryCurrent}
            disabled={busy}
            className="ml-auto min-h-9 rounded-md border border-[#B42318] bg-white px-3 text-14 font-medium u-focus-ring disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Content Queue ── */}
      {(view === "content" || view === "review") && (
        <ContentTab
          data={data}
          items={items}
          mobileDetailOpen={mobileDetailOpen}
          status={status}
          setStatus={setStatus}
          setOffset={setOffset}
          loading={loading}
          selectedId={selectedId}
          openContent={openContent}
          offset={offset}
          setMobileDetailOpen={setMobileDetailOpen}
          selected={selected}
          detailLoading={detailLoading}
          view={view}
          reviewNote={reviewNote}
          setReviewNote={setReviewNote}
          actionPending={actionPending}
          submitDecision={submitDecision}
        />
      )}

      {/* ── Internal Links ── */}
      {view === "links" && (
        <LinksTab
          linkData={linkData}
          mobileDetailOpen={mobileDetailOpen}
          linkItems={linkItems}
          linkLoading={linkLoading}
          selectedLinkId={selectedLinkId}
          openLink={openLink}
          setMobileDetailOpen={setMobileDetailOpen}
          selectedLink={selectedLink}
          linkDetailLoading={linkDetailLoading}
          linkReviewNote={linkReviewNote}
          setLinkReviewNote={updateLinkReviewNote}
          linkActionPending={linkActionPending}
          submitLinkDecision={submitLinkDecision}
        />
      )}

      {/* ── Ranking Impact ── */}
      {view === "impact" && <ImpactTab impactData={impactData} impactLoading={impactLoading} />}
    </div>
  );
}
