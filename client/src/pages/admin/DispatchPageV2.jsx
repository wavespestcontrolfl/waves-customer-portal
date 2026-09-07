import { usePublishIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';
// client/src/pages/admin/DispatchPageV2.jsx
//
// Mobile-first orchestrator for /admin/dispatch under the dispatch-v2
// feature flag. Renders the day/week board, sidebars (TechMatchPanelV2 /
// CSRPanelV2 / RevenuePanelV2 / InsightsPanelV2), and on mobile manages
// the action-sheet stack (MobileAppointmentDetailSheet,
// MobileCheckoutSheet, MobilePaymentSheet, MobileServicePickerSheet, and
// the four payment tender sheets). Reuses CompletionPanel /
// RescheduleModal / EditServiceModal / ProtocolPanel from SchedulePage so
// the V1 modal logic is shared rather than re-implemented.
//
// Endpoints:
//   GET  /admin/dispatch/services?date=…
//   PATCH /admin/services/:id              (status, notes, tech assignment)
//   POST /admin/services/:id/complete      (final products + observations)
//   POST /admin/services/:id/reschedule
//   POST /admin/services/:id/payment       (cash/check/card/manual-card)
//   POST /admin/services/:id/refund
//   GET  /admin/techs/availability
//
// Mobile-shell-v2 rule (CLAUDE.md): under 768px the page renders inside
// MobileAdminShell with a bottom tab bar and StickyActionBar.
//
// Audit focus:
// - Action-sheet stack management — opening one sheet from inside another
//   (e.g. checkout → payment → cash tender) needs careful focus / scroll
//   restoration so the user doesn't lose context on dismiss.
// - Day-grid drag-drop (TimeGridDay / TimeGridDays) — race conditions
//   between optimistic local move and the PATCH /admin/services/:id call.
// - Sidebar lazy loading — Suspense boundaries around TechMatchPanelV2 etc.
//   should fail gracefully when the API for a panel times out.
// - Mobile vs desktop divergence — confirm the same appointment renders
//   the same details / action set on both, no orphaned mobile-only state
//   that desktop users can't reach.
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import {
  CompletionPanel,
  RescheduleModal,
  EditServiceModal,
  ProtocolPanel,
  completionResumeOwed,
} from "./SchedulePage";
import ProtocolReferenceTabV2 from "./ProtocolReferenceTabV2";
import {
  ViewModeSelectorV2,
  MonthViewV2,
} from "../../components/schedule/CalendarViewsV2";
import TimeGridDay from "../../components/schedule/TimeGridDay";
import TimeGridDays from "../../components/schedule/TimeGridDays";
import MobileWeekGrid from "../../components/schedule/MobileWeekGrid";
import MobileDayStrip from "../../components/schedule/MobileDayStrip";
import MobileDispatchList from "../../components/schedule/MobileDispatchList";
import useDispatchReadiness from "../../components/schedule/useDispatchReadiness";
import ScheduleClientSearch from "../../components/schedule/ScheduleClientSearch";
import MobileAppointmentDetailSheet from "../../components/schedule/MobileAppointmentDetailSheet";
import MobileCheckoutSheet from "../../components/schedule/MobileCheckoutSheet";
import MobilePaymentSheet from "../../components/schedule/MobilePaymentSheet";
import MobileServiceEditModal from "../../components/schedule/MobileServiceEditModal";
import TreatmentPlanPanel from "../../components/schedule/TreatmentPlanPanel";
import MarkPrepaidModal from "../../components/schedule/MarkPrepaidModal";
import RecurringAlertsBannerV2 from "../../components/schedule/RecurringAlertsBannerV2";
import CreateAppointmentModal from "../../components/schedule/CreateAppointmentModal";
import ScheduleListView from "../../components/schedule/ScheduleListView";
import ScheduleCustomerSidebar from "../../components/schedule/ScheduleCustomerSidebar";
import Customer360ProfileV2 from "../../components/admin/Customer360ProfileV2";
import CreateProjectModal, { wdoFeeSeedFromVisit } from "../../components/tech/CreateProjectModal";
import { ProjectDetail } from "./ProjectsPage";
import { getAdminUser } from "../../lib/adminAuth";
import HorizontalScroll from "../../components/HorizontalScroll";
import useIsMobile from "../../hooks/useIsMobile";
import { Button, cn } from "../../components/ui";
import {
  etDateString,
  etStartOfWeek,
  formatETDate,
  isETToday as isETTodayStr,
} from "../../lib/timezone";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";
import {
  mergePostPaymentService,
  shouldReopenCompletionAfterPayment,
  TERMINAL_VISIT_STATUSES,
} from "../../lib/dispatchCompletionRouting";
import { requestDispatchSync } from "../../lib/dispatchSync";

const TechMatchPanel = lazy(
  () => import("../../components/dispatch/TechMatchPanelV2"),
);
const CSRPanel = lazy(() => import("../../components/dispatch/CSRPanelV2"));
const RevenuePanel = lazy(
  () => import("../../components/dispatch/RevenuePanelV2"),
);
const InsightsPanel = lazy(
  () => import("../../components/dispatch/InsightsPanelV2"),
);

const ACTIVE_MOBILE_COMPLETION_STATUSES = new Set(["en_route", "on_site"]);
const PRE_SERVICE_STATUSES = new Set(["pending", "confirmed", "rescheduled"]);

// A completed visit may reopen CompletionPanel ONLY when it still owes the
// completion itself: (a) the invoice-mint resume marker (503
// backfill_invoice_mint_failed), or (b) a status-only completion — the
// day payload says has_service_record === false (strict: a legacy payload
// without the flag stays closed). The server's /complete accepts
// completed→completed (evaluateTerminalTransition same-status) and mints
// the service record + invoice from the tech's completion data; Billing
// Recovery deep-links these rows here via ?completeService=.
export function completedVisitOwesCompletion(service) {
  if (String(service?.status || "").toLowerCase() !== "completed") return false;
  // The durable resume marker wins: it is only ever set by CompletionPanel's
  // own committed submit, so a committed side-effect chain owes its replay
  // regardless of how the project heuristics classify the row (a cut-over
  // typed visit with a leftover linked project and a failed profile lookup
  // would otherwise lose its resume — Codex #3799 r5).
  if (completionResumeMarked(service)) return true;
  // A completed project-backed visit is closed by definition — handleComplete
  // refuses it (projectCompletionIsClosed) and CompletionPanel never owns
  // it, so a status-only reopen would be a dead end (Codex #3799 r1).
  if (projectCompletionIsClosed(service)) return false;
  return service?.has_service_record === false;
}

// The "Closeout owed" cue on the dispatch surfaces (mobile list, day grid,
// 5-day / week grid) keys on the resume marker ONLY: a completed visit whose
// committed closeout still owes a side effect on THIS device after a 503 —
// the #3783 scenario. Status-only completions (has_service_record === false,
// the Billing Recovery backlog) keep their existing tap-to-open path but are
// deliberately not badged here; that population needs its own lane.
export function completionResumeMarked(service) {
  if (String(service?.status || "").toLowerCase() !== "completed") return false;
  return completionResumeOwed(service?.id);
}


function shouldOpenMobileCompletion(service) {
  const status = String(service?.status || "").toLowerCase();
  return (
    ACTIVE_MOBILE_COMPLETION_STATUSES.has(status) ||
    PRE_SERVICE_STATUSES.has(status) ||
    completedVisitOwesCompletion(service)
  );
}

function isProjectBackedCompletion(service) {
  // projectBacked covers BOTH special projects (WDO/pre-treat) and the
  // still-project_required one-time types — those must keep routing to the
  // Projects flow or the server 409s them out of /complete. Typed
  // service_report profiles serialize projectBacked:false, so cut-over
  // jobs fall through to CompletionPanel.
  const profile = service?.completionProfile;
  // An explicit profile is authoritative (house review on #2717): cut-over
  // visits keep their legacy project linked via scheduled_service_id, but
  // the server's /complete gate reads the PROFILE, not the link — treating
  // the leftover link as project-backed dead-ended the post-payment punches
  // (and the row button) on visits the server would happily complete. The
  // link heuristic only backstops rows whose payload carries no profile
  // (e.g. week-list rows).
  if (profile && typeof profile.projectBacked === "boolean") {
    return !!(profile.projectBacked || profile.requiresProject);
  }
  return !!(profile?.projectBacked || profile?.requiresProject || service?.linkedProject?.id);
}


function projectCompletionIsClosed(service) {
  return isProjectBackedCompletion(service)
    && (service?.linkedProject?.status === "closed" || service?.status === "completed");
}

// Visit statuses the dispatch status route treats as terminal — the
// appointment detail sheet hides Cancel/No-show for these, and the
// continue-snapshot sync below refuses to downgrade past them.
const API_BASE = import.meta.env.VITE_API_URL || "/api";


const formatDateISO = (d) => etDateString(d);

function dateAtNoonUTC(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function addDaysISO(dateStr, days) {
  const d = dateAtNoonUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonthsISO(dateStr, months) {
  const d = dateAtNoonUTC(dateStr);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function formatDateDisplay(dateStr) {
  return formatETDate(dateAtNoonUTC(dateStr), {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const isToday = (dateStr) => isETTodayStr(dateStr);

// "08:00", "09:30" → 90. Returns undefined for missing/malformed input so the
// modal can fall back to the chosen service's default duration.
function slotDurationMinutes(start, end) {
  if (!start || !end) return undefined;
  const sm = start.match(/^(\d{1,2}):(\d{2})/);
  const em = end.match(/^(\d{1,2}):(\d{2})/);
  if (!sm || !em) return undefined;
  const minutes =
    Number(em[1]) * 60 + Number(em[2]) - (Number(sm[1]) * 60 + Number(sm[2]));
  return minutes > 0 ? minutes : undefined;
}


const SCHEDULE_TABS = [
  { id: "board", label: "Schedule" },
  { id: "protocols", label: "Protocols" },
  { id: "match", label: "Tech Match", desktopOnly: true },
  { id: "csr", label: "CSR Booking", desktopOnly: true },
  { id: "revenue", label: "Job Scores", desktopOnly: true },
  { id: "insights", label: "Insights", desktopOnly: true },
];

function MobileScheduleSheet({ children, serviceCount, completedCount }) {
  const [snap, setSnap] = useState("half");
  const sheetRef = useRef(null);
  const dragRef = useRef(null);

  const viewportHeight = () => {
    if (typeof window === "undefined") return 800;
    return window.visualViewport?.height || window.innerHeight;
  };

  const getHeight = (s) => {
    const vh = viewportHeight();
    if (s === "peek") return 120;
    if (s === "half") return Math.round(vh * 0.5);
    return Math.round(vh * 0.9);
  };

  useEffect(() => {
    if (!sheetRef.current) return undefined;
    const apply = () => {
      if (!sheetRef.current) return;
      sheetRef.current.style.transition =
        "height 300ms cubic-bezier(0.34, 1.56, 0.64, 1)";
      sheetRef.current.style.height = `${getHeight(snap)}px`;
    };
    apply();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      window.removeEventListener("resize", apply);
    };
  }, [snap]);

  const onTouchStart = (e) => {
    dragRef.current = {
      y: e.touches[0].clientY,
      h: sheetRef.current ? sheetRef.current.offsetHeight : getHeight(snap),
    };
  };

  const onTouchMove = (e) => {
    if (!dragRef.current || !sheetRef.current) return;
    const dy = dragRef.current.y - e.touches[0].clientY;
    const vh = viewportHeight();
    const newH = Math.max(120, Math.min(vh * 0.9, dragRef.current.h + dy));
    sheetRef.current.style.transition = "none";
    sheetRef.current.style.height = `${newH}px`;
  };

  const onTouchEnd = () => {
    if (!dragRef.current || !sheetRef.current) return;
    const currentH = sheetRef.current.offsetHeight;
    const vh = viewportHeight();
    const targets = [
      ["peek", 120],
      ["half", Math.round(vh * 0.5)],
      ["full", Math.round(vh * 0.9)],
    ];
    targets.sort(
      (a, b) => Math.abs(currentH - a[1]) - Math.abs(currentH - b[1]),
    );
    setSnap(targets[0][0]);
    dragRef.current = null;
  };

  return (
    <div
      ref={sheetRef}
      className="fixed left-0 right-0 z-40 bg-white border-t border-hairline border-zinc-200 rounded-t-md shadow-lg flex flex-col md:hidden"
      style={{
        bottom:
          "calc(56px + env(safe-area-inset-bottom, 0px) + var(--keyboard-inset, 0px))",
        height: `${getHeight(snap)}px`,
      }}
    >
      {" "}
      <div
        className="flex-shrink-0 select-none"
        style={{ touchAction: "none" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {" "}
        <div className="pt-2 pb-1">
          {" "}
          <div className="w-9 h-[5px] bg-zinc-400 rounded-full mx-auto" />{" "}
        </div>{" "}
        <div className="px-4 pt-1 pb-3 flex items-center justify-between border-b border-hairline border-zinc-100">
          {" "}
          <div className="flex items-baseline gap-1.5">
            {" "}
            <span className="u-nums text-16 font-medium text-ink-primary">
              {serviceCount}
            </span>{" "}
            <span className="text-13 text-ink-secondary">
              job{serviceCount === 1 ? "" : "s"} today
            </span>
            {completedCount > 0 && (
              <>
                {" "}
                <span className="text-zinc-300 mx-1">·</span>{" "}
                <span className="u-nums text-13 text-ink-secondary">
                  {completedCount} done
                </span>{" "}
              </>
            )}
          </div>{" "}
          <button
            onClick={() => setSnap(snap === "peek" ? "full" : "peek")}
            className="text-12 u-label text-ink-secondary min-h-11 px-3 u-focus-ring"
          >
            {snap === "peek" ? "Expand" : "Collapse"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
      <div
        className="flex-1 overflow-y-auto"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {children}
      </div>{" "}
    </div>
  );
}

export default function DispatchPageV2({
  activeTab: controlledActiveTab,
  setOpenCreateHandler,
} = {}) {
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  // Controlled mode: when AdminDispatchPage drives the active sub-tab via
  // the top-level pill, the internal tab strip + mobile pills + More sheet
  // are hidden and `setActiveTab` becomes a no-op.
  const isControlled = controlledActiveTab !== undefined;
  const [internalActiveTab, setInternalActiveTab] = useState("board");
  const activeTab = isControlled ? controlledActiveTab : internalActiveTab;
  const setActiveTab = isControlled ? () => {} : setInternalActiveTab;

  // On mobile, desktopOnly tabs (Tech Match / CSR / Job Scores / Insights) are
  // hidden from both the top row and the More sheet. If a returning user's
  // persisted activeTab is one of those, snap back to 'board' so they don't
  // land on a panel they can't navigate away from. Skip in controlled mode —
  // the parent owns the active tab.
  useEffect(() => {
    if (isControlled || !isMobile) return;
    const current = SCHEDULE_TABS.find((t) => t.id === activeTab);
    if (current?.desktopOnly) setInternalActiveTab("board");
  }, [isControlled, isMobile, activeTab]);
  // Default desktop to Week (multi-day grid); phones still open on Day,
  // which is what techs and Virginia want when triaging in the field.
  const [viewMode, setViewMode] = useState(() => {
    // In controlled mode with a non-board sub-tab (Protocols / Tech Match
    // / CSR / Job Scores / Insights), the panel only renders when
    // viewMode === 'day'. Initialize to 'day' so deep-linking to those
    // tabs (e.g. /admin/dispatch?tab=protocols) doesn't render the week
    // calendar instead of the requested panel.
    if (isControlled && controlledActiveTab !== "board") return "day";
    // A ?date= deep link (e.g. the dashboard's Stale Visits card) targets one
    // specific day — open Day view on it instead of the default week grid.
    if (/^\d{4}-\d{2}-\d{2}$/.test(searchParams.get("date") || "")) return "day";
    if (typeof window === "undefined") return "week";
    return window.matchMedia("(max-width: 767px)").matches ? "day" : "week";
  });

  // Same idea for *runtime* tab swaps from AdminDispatchPage's pill: if
  // the parent flips activeTab to a non-board sub-tab while we're sitting
  // on Week / 5-Day / Month, snap back to Day so the panel renders.
  useEffect(() => {
    if (!isControlled) return;
    if (controlledActiveTab !== "board" && viewMode !== "day") {
      setViewMode("day");
    }
  }, [isControlled, controlledActiveTab, viewMode]);
  // Initial-load only (like ?customer=): a valid ?date= deep link opens the
  // schedule on that day; navigating afterward doesn't rewrite the URL.
  const [date, setDate] = useState(() => {
    const linkedDate = searchParams.get("date");
    return /^\d{4}-\d{2}-\d{2}$/.test(linkedDate || "")
      ? linkedDate
      : formatDateISO(new Date());
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [completingService, setCompletingService] = useState(null);
  const [projectService, setProjectService] = useState(null);
  // In-place project editor (owner ask 2026-07-13): a project-backed visit's
  // report opens right here in the schedule — the same interaction as the
  // pest CompletionPanel — instead of bouncing to the Jobs page.
  const [continueProjectId, setContinueProjectId] = useState(null);
  // The visit behind the open report — powers the appointment-details
  // handoff (cancel/no-show/reschedule/rain-out/price) from the report
  // surfaces, mirroring the pest CompletionPanel's Details pill. Set and
  // cleared together with continueProjectId.
  const [continueProjectService, setContinueProjectService] = useState(null);
  // Keep that snapshot pinned to the LIVE schedule row (Codex P1): closing
  // the report inside ProjectDetail also completes the visit and refreshes
  // the schedule via onChanged — a stale pre-close snapshot handed to the
  // detail sheet would offer Cancel/No-show against a completed compliance
  // visit. Re-pointing on every refresh keeps the sheet's status gating
  // truthful; a row that left the day view clears the handoff. Reads
  // data?.services (the state), not the post-early-return derived const —
  // this hook must run unconditionally. Settles in one pass: once the
  // snapshot IS the live row the effect stops writing.
  useEffect(() => {
    if (!continueProjectService) return;
    const fresh = (data?.services || []).find(
      (s) => String(s.id) === String(continueProjectService.id),
    );
    // A miss is NOT a clear (Codex r2): mobile Week mode rows come from the
    // /week payload and legitimately aren't in the selected day's response —
    // clearing on miss killed the Details pill for every week row. Week-row
    // staleness after an in-editor close is covered by the close signal
    // (onChanged {visitCompleted}) and the sheet's own terminal gating.
    if (fresh && fresh !== continueProjectService) {
      // Never downgrade a terminal snapshot with an older row (Codex r3 P1):
      // the close signal marks the snapshot completed while fetchSchedule is
      // still in flight, so this effect re-runs against the PRE-close day
      // payload first — accepting that stale active-looking row would
      // resurrect the Details pill and hand a live-looking visit to the
      // action sheet.
      if (
        TERMINAL_VISIT_STATUSES.has(String(continueProjectService.status))
        && !TERMINAL_VISIT_STATUSES.has(String(fresh.status))
      ) {
        return;
      }
      // Keep the created-project seed through the same window (Codex r6
      // P2): onCreated stamps linkedProject onto the snapshot before
      // fetchSchedule resolves — a stale day row without it would strip
      // the link and reopen the duplicate-create path from Details →
      // Complete project.
      if (
        continueProjectService.linkedProject?.id
        && !fresh.linkedProject?.id
      ) {
        return;
      }
      setContinueProjectService(fresh);
    }
  }, [data, continueProjectService]);
  // Bumped after payment detours (Details → checkout) so the mounted
  // ProjectDetail reloads its closeoutPreview (preserveEdits) — otherwise
  // the footer keeps the stale billing block and Close project stays
  // disabled (Codex r10 P2).
  const [projectReloadKey, setProjectReloadKey] = useState(0);
  // Mirrors ProjectDetail's dirty state (via onDirtyChange) so the overlay
  // backdrop can confirm before discarding unsaved report edits
  // (Codex r14 P2). Re-synced on every editor mount; stale values after
  // unmount are unreachable (the backdrop only exists while mounted).
  const [projectEditorDirty, setProjectEditorDirty] = useState(false);
  // ProjectDetail needs the types registry for form labels/fields; fetched
  // once on first open, then cached for the session.
  const [projectTypesRegistry, setProjectTypesRegistry] = useState(null);
  useEffect(() => {
    if (!continueProjectId || projectTypesRegistry) return;
    // This page's adminFetch (utils/admin-fetch) returns the PARSED body,
    // not a Response — calling .json() on it threw and permanently cached
    // an empty registry, which blanked every findings field in the
    // in-place editor (Codex round-2 P2).
    adminFetch("/admin/projects/types")
      .then((d) => {
        // Only cache a real registry (Codex r15 P2): caching {} on a
        // transient failure or empty payload satisfied the loaded-guard
        // above and permanently blanked every findings field in the
        // in-place editor. Left null, the next editor open retries.
        const types = d?.types;
        if (types && Object.keys(types).length) {
          setProjectTypesRegistry(types);
        }
      })
      .catch(() => {});
  }, [continueProjectId, projectTypesRegistry]);
  const [rescheduleService, setRescheduleService] = useState(null);
  const [editingService, setEditingService] = useState(null);
  const [detailService, setDetailService] = useState(null);
  const [checkoutService, setCheckoutService] = useState(null);
  const [paymentData, setPaymentData] = useState(null);
  // Staged handoffs are PER SERVICE (Map serviceId → handoff): a singleton
  // let an earlier visit's slower response overwrite the handoff already
  // staged for the open panel, whose close then found nothing to drain and
  // a payment-due invoice went uncollected (codex P1 #3187 r20).
  const pendingPaymentAfterCompletionRef = useRef(new Map());
  // Mirrors WHICH visit's completion panel is mounted, for callbacks that
  // resolve AFTER the operator backed out (the onClose payment-ref drain
  // only runs at close — a later response must deliver its own handoff,
  // codex P1 #3187 r11). Tracking the service id, not a boolean: visit A's
  // late response while visit B's panel is open must deliver A immediately,
  // or B's own completion would overwrite A's entry in the singleton
  // pending ref and A's payment modal would never show (codex P1 r13).
  const completionPanelOpenServiceRef = useRef(null);
  useEffect(() => {
    completionPanelOpenServiceRef.current = completingService?.id || null;
  }, [completingService]);
  // A late handoff arriving while the tech is ACTIVELY collecting another
  // visit must queue, not replace: MobilePaymentSheet has no visit-specific
  // key, so swapping paymentData under an open tender would silently switch
  // the invoice being collected (codex P1 #3187 r15). Every sheet dismissal
  // pops the queue.
  const paymentSheetActiveRef = useRef(false);
  useEffect(() => {
    paymentSheetActiveRef.current = !!paymentData;
  }, [paymentData]);
  const latePaymentHandoffQueueRef = useRef([]);
  const releasePaymentSheet = useCallback(() => {
    const next = latePaymentHandoffQueueRef.current.shift() || null;
    // Synchronous ref update: a delivery landing before the paymentData
    // effect re-runs must already see the sheet as occupied/free.
    paymentSheetActiveRef.current = !!next;
    setPaymentData(next);
  }, []);
  // EVERY payment-handoff delivery routes through here — the late-response
  // path AND the panel-close drain (codex P1 #3187 r15 + r16): an active
  // sheet queues the handoff (MobilePaymentSheet has no visit key; a
  // paymentData swap under an open tender silently switches the invoice
  // being collected), a free sheet opens it.
  const deliverPaymentHandoff = useCallback((handoff) => {
    if (!handoff) return;
    if (paymentSheetActiveRef.current) {
      latePaymentHandoffQueueRef.current.push(handoff);
    } else {
      paymentSheetActiveRef.current = true;
      setPaymentData(handoff);
    }
  }, []);
  // Close-and-drain for the completion panel — EVERY dismissal path (Back/
  // Close AND the mobile Details swap) must clear the ownership ref
  // synchronously and drain this visit's staged handoff, or a response
  // landing in the effect-lag window stages an entry no drain ever reads
  // (codex P1 #3187 r18 + r21).
  const closeCompletionPanel = useCallback(() => {
    completionPanelOpenServiceRef.current = null;
    const closingServiceId = completingService?.id || null;
    setCompletingService(null);
    const staged = closingServiceId
      ? pendingPaymentAfterCompletionRef.current.get(closingServiceId)
      : null;
    if (staged) {
      pendingPaymentAfterCompletionRef.current.delete(closingServiceId);
      deliverPaymentHandoff(staged);
    }
  }, [completingService, deliverPaymentHandoff]);
  const [editingLineService, setEditingLineService] = useState(null);
  const [prepaidService, setPrepaidService] = useState(null);
  // When MarkPrepaidModal is opened from inside EditServiceModal we want to
  // return to the edit view (with fresh prepaid state) instead of punching
  // straight to CompletionPanel like the completion-flow entry does.
  const [prepaidEntryContext, setPrepaidEntryContext] = useState(null);
  const [protocolService, setProtocolService] = useState(null);
  const [treatmentPlanService, setTreatmentPlanService] = useState(null);
  const [auditContext, setAuditContext] = useState(null);
  const [selectedScheduleService, setSelectedScheduleService] = useState(null);
  const ibSelectedService = detailService || selectedScheduleService || editingService || rescheduleService || completingService || continueProjectService;
  usePublishIntelligenceBarPageData({
    viewed_date: date,
    appointment_id: ibSelectedService?.id,
    customer_id: ibSelectedService?.customer_id ?? ibSelectedService?.customerId,
  });
  const [showNewAppt, setShowNewAppt] = useState(false);
  const [newApptDefaults, setNewApptDefaults] = useState(null);
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0);
  // The visit the Edit / prepay modal last saved (fresh object per save):
  // the list view re-verifies that row on the refresh it triggers, unlike
  // the generic key bumps for creates, completions and payments.
  const [lastSavedVisit, setLastSavedVisit] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  // Aggregated stats from TimeGridDays for the currently-visible range
  // (Day / 5-Day / Week). null until the grid mounts and emits the first
  // batch — at which point we use these for the centered stats row so the
  // numbers reflect the visible date range, not just `?date=…`.
  const [gridStats, setGridStats] = useState(null);
  const handleGridStatsChange = useCallback((stats) => {
    setGridStats(stats);
  }, []);

  const openCustomerSidebar = useCallback((svc) => {
    const customerId = svc?.customerId || svc?.customer_id;
    if (!customerId) return;
    setSelectedScheduleService({ ...svc, customerId });
  }, []);

  // Client search → jump the schedule to the chosen appointment's day so the
  // operator sees it in context (Day view shows it in the list/grid below).
  const handleClientSearchSelect = useCallback(
    (svc) => {
      if (!svc?.scheduledDate) return;
      setDate(svc.scheduledDate);
      setViewMode("day");
      setActiveTab("board");
    },
    [setActiveTab],
  );

  // Reset gridStats whenever the visible range changes (different date or
  // a different viewMode). Otherwise the centered stats row keeps showing
  // the prior range's totals until the new TimeGridDays fetch lands —
  // e.g. switching Week → Day still showed the 7-day count for a beat.
  // The cleared state falls back to the single-day `services` numbers
  // (already date-correct via fetchSchedule) until the grid emits fresh
  // stats.
  useEffect(() => {
    setGridStats(null);
  }, [date, viewMode]);

  // Expose "open create modal" to AdminDispatchPage so the lifted "+ Add
  // Appointment" pill in its header can trigger this page's modal.
  useEffect(() => {
    if (typeof setOpenCreateHandler !== "function") return;
    setOpenCreateHandler(() => {
      setNewApptDefaults(null);
      setShowNewAppt(true);
    });
    return () => setOpenCreateHandler(null);
  }, [setOpenCreateHandler]);

  const fetchSchedule = useCallback(async (
    d,
    { silent = false, updateState = true } = {},
  ) => {
    // silent: refresh data without tripping the page-level loading/error
    // gates — both render ABOVE the overlays, so a loud refresh (or a
    // transient refresh failure) unmounts the in-place project editor and
    // its unsaved edits in board/week modes (Codex r8 P2). Loud stays the
    // default for initial loads, date changes, and explicit retries.
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [scheduleData, catalogData] = await Promise.all([
        adminFetch(`/admin/schedule?date=${d}`),
        adminFetch("/admin/dispatch/products/catalog"),
      ]);
      if (updateState) {
        setData(scheduleData);
        setProducts(catalogData.products || []);
      }
      if (!silent) setLoading(false);
      return scheduleData;
    } catch (e) {
      if (!silent) {
        setError(e);
        setLoading(false);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    fetchSchedule(date);
  }, [date, fetchSchedule]);

  // Auto-Dispatch audit links open the existing appointment detail sheet.
  // Inspecting a move must never enter the completion or new-booking flows.
  useEffect(() => {
    const id = searchParams.get("appointment");
    if (!id || loading || !data) return;
    const next = new URLSearchParams(searchParams);
    next.delete("appointment");
    setSearchParams(next, { replace: true });
    const visit = (data.services || []).find((service) => String(service.id) === id);
    if (visit) setDetailService(visit);
    else setError(new Error("That appointment is no longer on this date. Find its current placement on the schedule."));
  }, [searchParams, setSearchParams, loading, data]);

  // C4 (universal one-time services, ratified Q9): /tech deep-links typed
  // jobs here as ?completeService=<scheduledServiceId> instead of alert-
  // bouncing. The param is consumed once (deleted immediately, same shape
  // as ?customer below); the open itself happens after handleComplete is
  // defined, keyed off this ref.
  const pendingCompleteIdRef = useRef(null);
  useEffect(() => {
    const id = searchParams.get("completeService");
    if (!id) return;
    pendingCompleteIdRef.current = id;
    const next = new URLSearchParams(searchParams);
    next.delete("completeService");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const customerId = searchParams.get("customer");
    if (!customerId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await adminFetch(`/admin/customers/${customerId}`);
        if (cancelled) return;
        const c = res.customer || {};
        const address = c.address || {};
        setNewApptDefaults({
          customer: {
            id: c.id,
            firstName: c.firstName || "",
            lastName: c.lastName || "",
            phone: c.phone || "",
            address: address.line1 || "",
            city: address.city || "",
            zip: address.zip || "",
            tier: c.tier || null,
          },
        });
        setShowNewAppt(true);
      } catch (err) {
        console.error("Failed to preload schedule customer:", err);
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(searchParams);
          next.delete("customer");
          setSearchParams(next, { replace: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, setSearchParams]);

  // Mobile only exposes Day + Week. Snap back if user loaded with 5day/month.
  useEffect(() => {
    if (isMobile && (viewMode === "5day" || viewMode === "month")) {
      setViewMode("week");
    }
  }, [isMobile, viewMode]);

  const syncDispatchAI = async () => {
    setSyncing(true);
    setSyncMsg("");
    try {
      const d = await requestDispatchSync({
        apiBase: API_BASE,
        date,
        token: localStorage.getItem("waves_admin_token"),
      });
      setSyncMsg(
        d.message || `Synced ${d.bridge?.synced || 0} jobs from schedule`,
      );
      setTimeout(() => setSyncMsg(""), 5000);
    } catch (error) {
      setSyncMsg(error?.message || "Sync failed");
    }
    setSyncing(false);
  };

  const handleStatusChange = useCallback((serviceId, newStatus) => {
    setData((prev) => {
      if (!prev) return prev;
      const nowIso = new Date().toISOString();
      const updatedServices = prev.services.map((s) =>
        s.id === serviceId
          ? {
              ...s,
              status: newStatus,
              statusLog: [
                ...(s.statusLog || []),
                { status: newStatus, at: nowIso },
              ],
            }
          : s,
      );
      const updatedTechSummary = prev.techSummary.map((tech) => ({
        ...tech,
        services: tech.services.map((s) =>
          s.id === serviceId
            ? {
                ...s,
                status: newStatus,
                statusLog: [
                  ...(s.statusLog || []),
                  { status: newStatus, at: nowIso },
                ],
              }
            : s,
        ),
        completedServices: tech.services.filter((s) =>
          s.id === serviceId
            ? newStatus === "completed"
            : s.status === "completed",
        ).length,
      }));
      return {
        ...prev,
        services: updatedServices,
        techSummary: updatedTechSummary,
      };
    });
  }, []);

  const handleComplete = useCallback((service) => {
    // A durable resume marker means CompletionPanel already committed this
    // closeout and owes a replay — it bypasses the project-backed guard (a
    // cut-over typed visit can still carry a leftover linked project, and
    // the guard would otherwise strand the committed side effects).
    if (completionResumeMarked(service)) {
      setCompletingService(service);
      return;
    }
    if (isProjectBackedCompletion(service)) {
      if (projectCompletionIsClosed(service)) return;
      if (service?.linkedProject?.id) {
        // Open the existing report in place — no Jobs-page bounce.
        setContinueProjectId(service.linkedProject.id);
        setContinueProjectService(service);
        return;
      }
      setProjectService(service);
      return;
    }
    setCompletingService(service);
  }, []);

  // Second half of the ?completeService deep-link: once the day's schedule
  // is loaded, open the completion for the pending id through
  // handleComplete (so project-backed routing still applies). An id not on
  // the loaded date alerts once instead of silently hanging.
  useEffect(() => {
    const id = pendingCompleteIdRef.current;
    if (!id || !data) return;
    pendingCompleteIdRef.current = null;
    const svc = (data.services || []).find((s) => String(s.id) === String(id));
    if (!svc) {
      alert("That appointment isn't on this dispatch date — find it on the schedule to complete it.");
    } else if (
      ["completed", "cancelled", "skipped", "no_show"].includes(String(svc.status || "")) &&
      !completedVisitOwesCompletion(svc)
    ) {
      // Defense in depth for the /tech deep-link (Codex P1): a stale or
      // re-tapped URL must never reopen completion on a terminal visit —
      // the endpoint would accept a duplicate submission. A completed visit
      // owing its invoice-mint resume is the one exception: the server's
      // idempotency machinery replays it instead of double-submitting.
      alert(`That visit is already ${svc.status} — nothing to complete.`);
    } else {
      handleComplete(svc);
    }
  }, [data, handleComplete]);

  const handleEnRoute = useCallback(
    async (service) => {
      try {
        await adminFetch(`/admin/schedule/${service.id}/status`, {
          method: "PUT",
          body: JSON.stringify({ status: "en_route" }),
        });
        handleStatusChange(service.id, "en_route");
        return true;
      } catch (e) {
        alert("En route failed: " + e.message);
        return false;
      }
    },
    [handleStatusChange],
  );

  // Post-response completion bookkeeping, shared by the POST path
  // (handleCompleteSubmit) and the panel's status-poll resolution
  // (onCompletionResult, codex P1 #3187 r11) — both must flip the status,
  // invalidate the mobile week cache, and stage the payment handoff.
  const applyCompletionResult = useCallback(
    (serviceId, r, body) => {
      handleStatusChange(serviceId, "completed");
      // The mobile week list serves rows from its own cached /week payload —
      // completion was the one terminal transition that never invalidated
      // it, leaving the completed stop tappable for a duplicate /complete
      // submission (house review; same pattern as cancel/no-show/rain-out).
      setScheduleRefreshKey((k) => k + 1);
      const invoiceWasAlreadyBundled =
        ["service_complete_with_invoice", "service_report_v1_with_invoice"].includes(r?.completionSmsType) &&
        r?.completionSmsStatus === "sent";
      const invoiceWasAlreadyPaid = r?.invoiceStatus === "paid";
      const invoiceWasAlreadySent =
        !!body?.invoiceAlreadySent ||
        !!completingService?.completionInvoiceAlreadySent;
      if (
        isMobile &&
        r?.invoiceId &&
        r?.invoiceToken &&
        Number(r?.invoiceTotal || 0) > 0 &&
        r?.invoicePaymentActionRequired !== false &&
        !invoiceWasAlreadyBundled &&
        !invoiceWasAlreadyPaid &&
        !invoiceWasAlreadySent
      ) {
        const completedService =
          (data?.services || []).find((s) => s.id === serviceId) ||
          completingService;
        const handoff = {
          service: completedService,
          invoiceId: r.invoiceId,
          invoiceToken: r.invoiceToken,
          amount: Number(r.invoiceTotal),
        };
        if (completionPanelOpenServiceRef.current === serviceId) {
          // Own panel still open: stage under THIS service's key — its
          // onClose drains exactly this entry, and no other visit's
          // response can overwrite it (codex P1 #3187 r20).
          pendingPaymentAfterCompletionRef.current.set(serviceId, handoff);
        } else {
          // Panel closed or the operator moved on: deliver now through the
          // synchronized helper (queues behind an active sheet — codex P1
          // r11 + r13 + r15).
          deliverPaymentHandoff(handoff);
        }
      }
      return r;
    },
    [completingService, handleStatusChange, isMobile, data, deliverPaymentHandoff],
  );

  const handleCompleteSubmit = useCallback(
    async (serviceId, body) => {
      const r = await adminFetch(`/admin/dispatch/${serviceId}/complete`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return applyCompletionResult(serviceId, r, body);
    },
    [applyCompletionResult],
  );

  const handleSidebarCancel = useCallback(
    (service) => {
      setSelectedScheduleService(null);
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          services: prev.services.filter((s) => s.id !== service.id),
          techSummary: prev.techSummary.map((tech) => ({
            ...tech,
            services: tech.services.filter((s) => s.id !== service.id),
            totalServices: tech.services.filter((s) => s.id !== service.id)
              .length,
          })),
        };
      });
      setScheduleRefreshKey((k) => k + 1);
      fetchSchedule(date);
    },
    [date, fetchSchedule],
  );

  function shiftDate(dir) {
    if (viewMode === "day") setDate(addDaysISO(date, dir));
    else if (viewMode === "week" || viewMode === "5day") setDate(addDaysISO(date, dir * 7));
    else setDate(addMonthsISO(date, dir));
  }

  const isReferencePanel = activeTab !== "board" && viewMode === "day";
  const readiness = useDispatchReadiness({
    services: data?.services,
    date,
    active: activeTab === "board" && viewMode === "day" && data?.date === date && !loading && !error,
  });
  const dayServices = useMemo(() => (data?.services || []).map(service => ({
    ...service, readiness: readiness?.[service.id],
  })), [data?.services, readiness]);
  if (loading && !isReferencePanel)
    return (
      <div className="py-16 text-center text-13 text-ink-secondary">
        Loading schedule…
      </div>
    );
  if (error && !isReferencePanel) {
    if (isRateLimitError(error)) {
      return (
        <div className="py-16 text-center text-13 text-alert-fg">
          Too many requests. Wait a few seconds and{" "}
          <button onClick={() => fetchSchedule(date)} className="underline">
            retry
          </button>
          .
        </div>
      );
    }
    return (
      <div className="py-16 text-center text-13 text-alert-fg">
        Failed to load schedule: {error?.message || String(error)}
      </div>
    );
  }
  if (!data && !isReferencePanel) return null;

  const safeData = data || {};
  const services = dayServices;
  const techSummary = safeData.techSummary || [];
  const technicians = safeData.technicians || [];
  const zoneColors = safeData.zoneColors || {};
  const zoneLabels = safeData.zoneLabels || {};

  // Stats source by viewMode:
  //   - Day:           single-day `services` from /admin/schedule?date=X.
  //                    TimeGridDay (tech swimlanes) doesn't emit gridStats.
  //   - 5-Day / Week:  gridStats from TimeGridDays' /admin/schedule/week
  //                    aggregation. We never fall back to single-day data
  //                    here — that would show one day's numbers labeled
  //                    as "the week's totals". If the grid is still
  //                    loading or the fetch failed, the stats row hides
  //                    via `statsAvailable` instead.
  //   - Month:         row hidden entirely.
  const isDayView = viewMode === "day";
  const isMultiDayView = viewMode === "5day" || viewMode === "week";
  // Identity-check incoming gridStats against the currently-visible range
  // before trusting them. The reset-on-change useEffect runs after render,
  // so a Week→Week date hop (or Week→5-Day mode swap) would briefly render
  // the old range's totals labeled as the new range's. Comparing
  // gridStats.startDate / dayCount to what TimeGridDays *would* compute
  // for the current date+viewMode rejects the stale frame synchronously.
  const expectedDayCount =
    viewMode === "week" ? 7 : viewMode === "5day" ? 5 : 1;
  // Plain const — etStartOfWeek is cheap, and a hook here would sit
  // below the loading/error early-returns above, breaking hook order.
  const expectedStart = isMultiDayView ? etStartOfWeek(date) : null;
  const useGridStats =
    isMultiDayView &&
    !!gridStats &&
    gridStats.startDate === expectedStart &&
    gridStats.dayCount === expectedDayCount;
  const statsAvailable = isDayView || useGridStats;

  const totalCount = useGridStats ? gridStats.totalCount : services.length;
  const completedCount = useGridStats
    ? gridStats.completedCount
    : services.filter((s) => s.status === "completed").length;
  const skippedCount = useGridStats
    ? gridStats.skippedCount
    : services.filter((s) => s.status === "skipped").length;
  const remainingCount = useGridStats
    ? gridStats.remainingCount
    : totalCount - completedCount - skippedCount;

  // Totals reflect the actual planned figures on the visible services —
  // no per-service averages or fallbacks. A service without a price /
  // duration contributes 0 so 2 priced appts at $617 read as $617, not
  // $617 plus a placeholder for every unpriced row.
  const estTotalMin = useGridStats
    ? gridStats.totalMin || 0
    : services.reduce(
        (sum, s) =>
          sum +
          (typeof s.estimatedDuration === "number" ? s.estimatedDuration : 0),
        0,
      );
  const estTotalHrs = Math.floor(estTotalMin / 60);
  const estTotalMinRemainder = estTotalMin % 60;
  const estRemainingMin = useGridStats
    ? gridStats.remainingMin || 0
    : services.reduce((sum, s) => {
        if (s.status === "completed" || s.status === "skipped") return sum;
        return (
          sum +
          (typeof s.estimatedDuration === "number" ? s.estimatedDuration : 0)
        );
      }, 0);
  // ETA is "now + remaining time" — only meaningful when looking at a
  // single day; on multi-day views it's suppressed since the implied
  // finish time spans days. Hide it when no remaining time is known so
  // we don't render "ETA now".
  const estFinishTime =
    isDayView && estRemainingMin > 0
      ? (() => {
          const finish = new Date(Date.now() + estRemainingMin * 60000);
          return finish.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
        })()
      : null;
  const estRevenue = useGridStats
    ? gridStats.revenue
    : services.reduce(
        (sum, s) =>
          sum + (typeof s.estimatedPrice === "number" ? s.estimatedPrice : 0),
        0,
      );

  const weatherData = safeData.weather || {};
  const rainProbability =
    weatherData.rainProbability ?? weatherData.rain_probability ?? null;
  const windSpeed = weatherData.windSpeed ?? weatherData.wind_speed ?? null;
  const weatherTemp = weatherData.temp ?? weatherData.temperature ?? null;
  // Per-zone NWS rain chances for the zones on today's board (day payload
  // zoneRain: { zoneSlug: 0-100|null }). Exception-based: only zones at
  // ≥40% surface as chips on the weather bar — amber <50, alert-red ≥50
  // (same thresholds as the rain-alert / spray-hold lines below).
  const zoneRainAlerts = Object.entries(safeData.zoneRain || {})
    .filter(([, chance]) => chance != null && chance >= 40)
    .sort(([, a], [, b]) => b - a);
  const sprayHold =
    (rainProbability != null && rainProbability > 50) ||
    (windSpeed != null && windSpeed > 15);

  const sprayStatus = sprayHold ? "HOLD"
    : rainProbability == null || windSpeed == null ? "UNKNOWN" : "GO";

  const dateHeader =
    viewMode === "day"
      ? formatDateDisplay(date)
      : isMultiDayView
        ? (() => {
            // Match the grid’s Monday→Friday or Monday→Sunday span,
            // including when the selected date is not a Monday.
            const monday = etStartOfWeek(date);
            const lastDay = addDaysISO(monday, expectedDayCount - 1);
            return `${formatETDate(dateAtNoonUTC(monday), { month: "short", day: "numeric" })} – ${formatETDate(dateAtNoonUTC(lastDay), { month: "short", day: "numeric", year: "numeric" })}`;
          })()
        : formatETDate(dateAtNoonUTC(date), { month: "long", year: "numeric" });

  return (
    <div className="min-h-full bg-surface-page font-sans text-zinc-900">
      {/* "↻ Sync AI Data" — right-aligned, only visible on non-board sub-tabs.
          The Schedule h1 + "+ Add Appointment" pill that used to share this
          row are now lifted into AdminDispatchPage so they sit above the
          centered top-level tab pill. */}
      {activeTab !== "board" && viewMode === "day" && (
        <div className="hidden md:flex justify-end mb-4">
          {" "}
          <Button
            variant="secondary"
            onClick={syncDispatchAI}
            disabled={syncing}
          >
            {syncing ? "Syncing…" : "↻ Sync AI Data"}
          </Button>{" "}
        </div>
      )}

      {/* Mobile: Schedule + More pills. Hidden in controlled mode (top-level
          pill in AdminDispatchPage replaces them). */}
      {!isControlled && viewMode === "day" && (
        <div className="md:hidden mb-4 flex items-center gap-2">
          {" "}
          <button
            onClick={() => setActiveTab("board")}
            className={cn(
              "flex-1 inline-flex items-center justify-center u-label px-3 h-11 rounded-sm border-hairline u-focus-ring transition-colors",
              activeTab === "board"
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-ink-secondary border-zinc-300",
            )}
          >
            Schedule
          </button>{" "}
          <button
            onClick={() => setShowMoreSheet(true)}
            className={cn(
              "flex-1 inline-flex items-center justify-center u-label px-3 h-11 rounded-sm border-hairline u-focus-ring transition-colors",
              activeTab !== "board"
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-ink-secondary border-zinc-300",
            )}
          >
            {activeTab === "board"
              ? "More"
              : SCHEDULE_TABS.find((t) => t.id === activeTab)?.label || "More"}
          </button>{" "}
        </div>
      )}

      {/* Centered stats badges — schedule grid sub-tab on Day / 5-Day /
          Week (Month uses MonthViewV2 which has its own summary), desktop
          only. Day uses the single-day services fetch; multi-day views
          use TimeGridDays' aggregated stats. The row hides on multi-day
          while the week fetch is still loading or failed (statsAvailable
          guards), instead of falling back to single-day numbers that
          would mislabel the visible range. */}
      {statsAvailable && activeTab === "board" && (
        <div className="hidden md:flex justify-center mb-4">
          {" "}
          <div className="flex gap-3 items-center text-12 text-ink-secondary bg-white px-3 py-2 rounded-sm border-hairline border-zinc-200 flex-wrap">
            {" "}
            <span>
              <span className="u-nums font-medium text-zinc-900">
                {totalCount}
              </span>
              services
            </span>{" "}
            <span>
              <span className="u-nums font-medium text-zinc-900">
                {completedCount}
              </span>
              done
            </span>{" "}
            <span>
              <span
                className={cn(
                  "u-nums font-medium",
                  remainingCount > 0 ? "text-zinc-900" : "text-ink-secondary",
                )}
              >
                {remainingCount}
              </span>
              left
            </span>{" "}
            <span className="pl-3 border-l-hairline border-zinc-200">
              ~{estTotalHrs}h
              {estTotalMinRemainder > 0 ? ` ${estTotalMinRemainder}m` : ""}{" "}
              total
            </span>
            {estFinishTime && (
              <span>
                ETA{" "}
                <span className="u-nums font-medium text-zinc-900">
                  {estFinishTime}
                </span>
              </span>
            )}
            <span className="pl-3 border-l-hairline border-zinc-200">
              {" "}
              <span className="u-nums font-medium text-zinc-900">
                ${estRevenue.toLocaleString()}
              </span>
              revenue
            </span>{" "}
          </div>{" "}
        </div>
      )}

      {/* Centered date nav — every tab. */}
      <div className="flex justify-center items-center gap-1.5 mb-4 flex-wrap">
        {" "}
        <button
          type="button"
          onClick={() => shiftDate(-1)}
          className="w-11 h-11 md:w-8 md:h-8 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 text-14 md:text-12 u-focus-ring hover:bg-zinc-50 inline-flex items-center justify-center flex-shrink-0"
          title="Previous"
        >
          Prev
        </button>{" "}
        <span className="u-nums text-14 md:text-13 font-medium text-zinc-900 text-center px-2 md:min-w-[220px]">
          {dateHeader}
        </span>{" "}
        <button
          type="button"
          onClick={() => shiftDate(1)}
          className="w-11 h-11 md:w-8 md:h-8 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 text-14 md:text-12 u-focus-ring hover:bg-zinc-50 inline-flex items-center justify-center flex-shrink-0"
          title="Next"
        >
          Next
        </button>
        {!isToday(date) && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDate(formatDateISO(new Date()))}
          >
            Today
          </Button>
        )}
      </div>
      {/* Client search — find a customer's upcoming appointments from any
          view and jump to that day. Board tab only. */}
      {activeTab === "board" && (
        <div className="max-w-md mx-auto mb-4">
          {" "}
          <ScheduleClientSearch onSelect={handleClientSearchSelect} />{" "}
        </div>
      )}
      {/* Centered view-mode selector — schedule grid sub-tab + desktop only. */}
      {!isMobile && activeTab === "board" && (
        <div className="flex justify-center mb-4">
          {" "}
          <ViewModeSelectorV2
            viewMode={viewMode}
            onViewModeChange={(m) => {
              setViewMode(m);
              if (m === "day") setActiveTab("board");
            }}
          />{" "}
        </div>
      )}

      {syncMsg && (
        <div className="text-11 text-ink-secondary mb-2">{syncMsg}</div>
      )}

      {/* Mobile day strip — scrollable window of days with a live month
          label; scrolling browses, tapping selects. Mounted only on mobile
          so it measures and centers itself on a real layout (a CSS-hidden
          mount would never re-center after a resize). */}
      {isMobile && viewMode === "day" && (
        <MobileDayStrip date={date} onSelect={setDate} />
      )}

      {/* Mobile-only ViewMode selector — Day + Week only on phones. */}
      <div className="md:hidden mb-3 grid grid-cols-2 gap-1.5">
        {[
          { id: "day", label: "Day" },
          { id: "week", label: "Week" },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setViewMode(m.id);
              if (m.id === "day") setActiveTab("board");
            }}
            className={cn(
              "inline-flex items-center justify-center u-label px-2 h-11 rounded-sm border-hairline u-focus-ring transition-colors",
              viewMode === m.id
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-ink-secondary border-zinc-300",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      {showNewAppt && (
        <CreateAppointmentModal
          defaultDate={newApptDefaults?.date || date}
          defaultWindowStart={newApptDefaults?.windowStart}
          defaultDurationMinutes={newApptDefaults?.durationMinutes}
          defaultTechId={newApptDefaults?.techId}
          defaultCustomer={newApptDefaults?.customer || null}
          onClose={() => {
            setShowNewAppt(false);
            setNewApptDefaults(null);
          }}
          onCreated={(appt) => {
            setShowNewAppt(false);
            setNewApptDefaults(null);
            // Always refresh the DISPLAYED day. Fetching the created
            // appointment's own date (default updateState) replaced the
            // board with another day's stops while the header still showed
            // `date`; a non-silent fetch of that other day would also trip
            // the page-level loading/error gates for data we discard.
            // Off-screen days are covered by the week-grid key bump below.
            fetchSchedule(date);
            // TimeGridDays (week / 5-day) owns its own week-fetch — bump the
            // key so it refetches and the just-created appointment shows up.
            setScheduleRefreshKey((k) => k + 1);
          }}
        />
      )}

      {/* Week / 5-Day = multi-day time grid (drag to reschedule). Month = summary grid. */}
      {viewMode === "week" && isMobile && (
        <MobileDispatchList
          mode="week"
          date={date}
          refreshKey={scheduleRefreshKey}
          technicians={technicians}
          owesCompletion={completionResumeMarked}
          onRefresh={() => setScheduleRefreshKey((key) => key + 1)}
          onEdit={(svc) => {
            if (shouldOpenMobileCompletion(svc)) {
              handleComplete(svc);
            } else {
              setDetailService(svc);
            }
          }}
          onEnRoute={handleEnRoute}
          onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
        />
      )}
      {viewMode === "week" && !isMobile && (
        <TimeGridDays
          date={date}
          dayCount={7}
          selectedDate={date}
          hideUnassignedRail={false}
          refreshKey={scheduleRefreshKey}
          owesCompletion={completionResumeMarked}
          onEdit={(svc) => {
            // A row wearing the "Closeout owed" chip resumes through the
            // completion panel, same as the day grid and the mobile list.
            if (completionResumeMarked(svc)) {
              handleComplete(svc);
            } else {
              setEditingService(svc);
            }
          }}
          onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
          onViewCustomer={openCustomerSidebar}
          onChange={() => fetchSchedule(date)}
          onStatsChange={handleGridStatsChange}
          onCreateSlot={({ date: slotDate, windowStart, windowEnd }) => {
            setNewApptDefaults({
              date: slotDate,
              windowStart,
              durationMinutes: slotDurationMinutes(windowStart, windowEnd),
            });
            setShowNewAppt(true);
          }}
        />
      )}
      {viewMode === "5day" && (
        <TimeGridDays
          date={date}
          dayCount={5}
          selectedDate={date}
          hideUnassignedRail={isMobile}
          refreshKey={scheduleRefreshKey}
          owesCompletion={completionResumeMarked}
          onEdit={(svc) => {
            // A row wearing the "Closeout owed" chip resumes through the
            // completion panel, same as the day grid and the mobile list.
            if (completionResumeMarked(svc)) {
              handleComplete(svc);
            } else {
              setEditingService(svc);
            }
          }}
          onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
          onViewCustomer={openCustomerSidebar}
          onChange={() => fetchSchedule(date)}
          onStatsChange={handleGridStatsChange}
          onCreateSlot={({ date: slotDate, windowStart, windowEnd }) => {
            setNewApptDefaults({
              date: slotDate,
              windowStart,
              durationMinutes: slotDurationMinutes(windowStart, windowEnd),
            });
            setShowNewAppt(true);
          }}
        />
      )}
      {viewMode === "month" && (
        <MonthViewV2
          date={date}
          onDateClick={(d) => {
            setDate(d);
            setViewMode("day");
          }}
          onViewCustomer={openCustomerSidebar}
          refreshKey={scheduleRefreshKey}
        />
      )}
      {viewMode === "list" && (
        <ScheduleListView
          technicians={data?.technicians || []}
          onEdit={(svc) => {
            if (isMobile) {
              setDetailService(svc);
            } else {
              setEditingService(svc);
            }
          }}
          onRefresh={() => fetchSchedule(date)}
          refreshKey={scheduleRefreshKey}
          lastSave={lastSavedVisit}
        />
      )}

      {/* Tabs bar — day view only, and only when this page owns its own
          activeTab state. In controlled mode AdminDispatchPage's top-level
          pill is the single source of truth so we don't render a duplicate
          strip here. */}
      {!isControlled && viewMode === "day" && (
        <>
          {/* Desktop: tab strip — same separate-pill style as ViewModeSelectorV2
              (Day / 5-Day / Week / Month) so the two rows of selectors read
              consistently. */}
          <div className="hidden md:block mb-5">
            {" "}
            <HorizontalScroll
              gap={6}
              edgeBleed={4}
              style={{ paddingBottom: 0 }}
            >
              {SCHEDULE_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={cn(
                    "h-8 px-3 text-11 uppercase font-medium tracking-label rounded-sm border-hairline whitespace-nowrap flex-shrink-0 u-focus-ring transition-colors",
                    activeTab === t.id
                      ? "bg-zinc-900 text-white border-zinc-900"
                      : "bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </HorizontalScroll>{" "}
          </div>{" "}
        </>
      )}

      {/* Mobile "More" bottom sheet */}
      {showMoreSheet && createPortal(
        <div
          className="fixed inset-0 z-[120] md:hidden"
          role="dialog"
          aria-modal="true"
        >
          {" "}
          <div
            className="absolute inset-0 bg-zinc-900/30"
            onClick={() => setShowMoreSheet(false)}
          />{" "}
          <div
            className="absolute inset-x-0 bottom-0 bg-white rounded-t-md border-t border-hairline border-zinc-200"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            {" "}
            <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-hairline border-zinc-200">
              {" "}
              <span className="u-label text-ink-secondary">
                Switch tool
              </span>{" "}
              <button
                onClick={() => setShowMoreSheet(false)}
                className="inline-flex items-center justify-center h-11 w-11 -mr-3 text-ink-secondary u-focus-ring"
              >
                ×
              </button>{" "}
            </div>{" "}
            <div className="py-2">
              {SCHEDULE_TABS.filter((t) => !t.desktopOnly).map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setActiveTab(t.id);
                    setShowMoreSheet(false);
                  }}
                  className={cn(
                    "w-full flex items-center justify-between px-4 h-12 text-14 text-left u-focus-ring transition-colors",
                    activeTab === t.id
                      ? "bg-zinc-50 text-zinc-900 font-medium"
                      : "bg-white text-ink-primary hover:bg-zinc-50",
                  )}
                >
                  {" "}
                  <span>{t.label}</span>
                  {activeTab === t.id && (
                    <span className="text-11 u-label text-ink-tertiary">
                      Active
                    </span>
                  )}
                </button>
              ))}
            </div>{" "}
          </div>{" "}
        </div>,
        document.body,
      )}

      {viewMode === "day" && <RecurringAlertsBannerV2 />}

      {/* Non-board tabs — V2 monochrome panels (Match/CSR/Revenue/Insights/Protocols). */}
      {viewMode === "day" && activeTab === "protocols" && (
        <ProtocolReferenceTabV2 />
      )}
      {viewMode === "day" && activeTab === "match" && (
        <Suspense
          fallback={
            <div className="py-10 text-center text-13 text-ink-secondary">
              Loading…
            </div>
          }
        >
          <TechMatchPanel />
        </Suspense>
      )}
      {viewMode === "day" && activeTab === "csr" && (
        <Suspense
          fallback={
            <div className="py-10 text-center text-13 text-ink-secondary">
              Loading…
            </div>
          }
        >
          <CSRPanel />
        </Suspense>
      )}
      {viewMode === "day" && activeTab === "revenue" && (
        <Suspense
          fallback={
            <div className="py-10 text-center text-13 text-ink-secondary">
              Loading…
            </div>
          }
        >
          <RevenuePanel date={date} />
        </Suspense>
      )}
      {viewMode === "day" && activeTab === "insights" && (
        <Suspense
          fallback={
            <div className="py-10 text-center text-13 text-ink-secondary">
              Loading…
            </div>
          }
        >
          <InsightsPanel />
        </Suspense>
      )}

      {/* Board tab content */}
      {viewMode === "day" && activeTab === "board" && (
        <>
          {/* Weather bar — full-bleed, single row */}
          {(() => {
            const rp = rainProbability ?? 0;
            const weatherIcon = rp > 40 ? "" : rp > 15 ? "" : "";
            return (
              <div className="-mx-4 md:-mx-6 mb-3 md:mb-4 bg-white border-y border-hairline border-zinc-200 px-4 md:px-6 py-2 flex items-center justify-center gap-2 text-12 text-zinc-700 overflow-x-auto whitespace-nowrap">
                {" "}
                <span className="text-16" aria-hidden="true">
                  {weatherIcon}
                </span>{" "}
                <span className="u-nums font-medium text-zinc-900">
                  {weatherTemp == null ? "Weather unavailable" : `${weatherTemp}°F`}
                </span>
                {windSpeed != null && (
                  <>
                    {" "}
                    <span className="text-zinc-300" aria-hidden="true">
                      ·
                    </span>{" "}
                    <span className="u-nums">{windSpeed} mph</span>{" "}
                  </>
                )}
                {rainProbability != null && (
                  <>
                    {" "}
                    <span className="text-zinc-300" aria-hidden="true">
                      ·
                    </span>{" "}
                    <span className="u-nums">{rainProbability}% rain</span>{" "}
                  </>
                )}
                <span className="text-zinc-300" aria-hidden="true">
                  ·
                </span>{" "}
                <span
                  className={cn(
                    "font-medium uppercase tracking-label",
                    sprayHold ? "text-alert-fg" : "text-zinc-900",
                  )}
                >
                  SPRAY: {sprayStatus}
                </span>
                {/* Per-zone rain chips — only zones at ≥40% render. */}
                {zoneRainAlerts.map(([zone, chance]) => (
                  <span key={zone} className="inline-flex items-center gap-2">
                    {" "}
                    <span className="text-zinc-300" aria-hidden="true">
                      ·
                    </span>{" "}
                    <span
                      className={cn(
                        "u-nums font-medium",
                        chance >= 50 ? "text-alert-fg" : "text-amber-700",
                      )}
                      title={`${zoneLabels?.[zone] || zone}: ${chance}% chance of rain`}
                    >
                      {zoneLabels?.[zone] || zone} {chance}%
                    </span>
                  </span>
                ))}{" "}
              </div>
            );
          })()}
          {/* Day view keeps the per-technician swimlane layout (TimeGridDay)
              so dispatchers can drag jobs between tech lanes and create a
              slot pre-bound to a specific tech — the core same-day
              reassignment workflow. The 5-Day / Week / Month views use the
              date-column TimeGridDays since tech-by-tech granularity isn't
              meaningful across multiple days. Visual styling on TimeGridDay
              already mirrors TimeGridDays. */}
          <div className="hidden md:block">
            {" "}
            <TimeGridDay
              date={date}
              services={services}
              technicians={technicians}
              canGroup={safeData.visitGroups === true}
              owesCompletion={completionResumeMarked}
              onEdit={(svc) => {
                // A block wearing the "Closeout owed" chip must open the
                // completion panel (resume), not the appointment editor —
                // same routing the mobile list uses.
                if (completionResumeMarked(svc)) {
                  handleComplete(svc);
                } else {
                  setEditingService(svc);
                }
              }}
              onProtocol={(svc) => setProtocolService(svc)}
              onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
              onViewCustomer={openCustomerSidebar}
              onViewAudit={(svc) =>
                setAuditContext({
                  customerId: svc.customerId || svc.customer_id,
                  scheduledServiceId: svc.id,
                })
              }
              onChange={() => fetchSchedule(date)}
              onDateChange={setDate}
              onCreateSlot={({ date: slotDate, windowStart, techId }) => {
                setNewApptDefaults({ date: slotDate, windowStart, techId });
                setShowNewAppt(true);
              }}
            />{" "}
          </div>
          {/* Mobile: inline scrollable day list (replaces the multi-day calendar) */}
          <div className="md:hidden">
            {" "}
            <MobileDispatchList
              mode="day"
              date={date}
              services={services}
              rainChance={typeof safeData.rainChance === "number" ? safeData.rainChance : null}
              technicians={technicians}
              owesCompletion={completionResumeMarked}
              onRefresh={() => fetchSchedule(date)}
              onEdit={(svc) => {
                if (shouldOpenMobileCompletion(svc)) {
                  handleComplete(svc);
                } else {
                  setDetailService(svc);
                }
              }}
              onEnRoute={handleEnRoute}
              onProtocol={(svc) => setProtocolService(svc)}
              onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
              onViewAudit={(svc) =>
                setAuditContext({
                  customerId: svc.customerId || svc.customer_id,
                  scheduledServiceId: svc.id,
                })
              }
            />{" "}
          </div>{" "}
        </>
      )}

      {/* Modals — V1 components, unchanged */}
      {completingService && (
        <CompletionPanel
          service={completingService}
          products={products}
          onClose={closeCompletionPanel}
          onSubmit={handleCompleteSubmit}
          onCompletedElsewhere={(serviceId) => {
            // Cross-key completion: the visit finished under another
            // idempotency key, so handleCompleteSubmit never resolved —
            // run its non-payment bookkeeping (the invoice payload only
            // travels on the same-key response, so no payment handoff).
            handleStatusChange(serviceId, "completed");
            setScheduleRefreshKey((k) => k + 1);
          }}
          onCompletionResult={(serviceId, r) =>
            // Status-poll resolution: the stored same-key response is the
            // completion result — run the FULL bookkeeping, payment
            // handoff included (codex P1 #3187 r11).
            applyCompletionResult(serviceId, r, null)
          }
          onScheduleFollowup={async (suggestion) => {
            // Books the suggested follow-up as a PENDING appointment (the
            // normal pending → confirmed dispatch flow is the confirmation
            // step). Idempotent server-side per source visit.
            const serviceId = completingService?.id;
            if (!serviceId || !suggestion?.suggestedDate) return;
            try {
              // adminFetch returns the parsed JSON body (not a Response).
              const d = await adminFetch(`/admin/dispatch/${serviceId}/schedule-followup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: suggestion.suggestedDate }),
              });
              alert(d.alreadyScheduled
                ? `Follow-up already on the books for ${d.appointment.scheduledDate}.`
                : `Follow-up booked (pending) for ${d.appointment.scheduledDate}.`);
              setScheduleRefreshKey((k) => k + 1);
            } catch (e) {
              alert(`Could not book the follow-up: ${e.message || 'unknown error'}`);
            }
          }}
          onViewDetails={
            isMobile
              ? (svc) => {
                  // Same close-and-drain as Back/Close (codex P1 r21).
                  closeCompletionPanel();
                  setDetailService(svc);
                }
              : undefined
          }
        />
      )}
      {projectService && (
        <CreateProjectModal
          theme="light"
          presentation="sheet"
          defaultCustomerId={projectService.customerId}
          defaultCustomerLabel={projectService.customerName}
          defaultScheduledServiceId={projectService.id}
          defaultProjectDate={
            String(projectService.scheduledDate || date || "").split("T")[0]
          }
          defaultInspectionFee={
            /* The WDO line's own net price (never the pre-discount base,
               never a multi-service group total) — see wdoFeeSeedFromVisit. */
            wdoFeeSeedFromVisit(projectService)
          }
          defaultProjectType={projectService.completionProfile?.projectType || ""}
          allowedProjectTypes={
            projectService.completionProfile?.projectType
              ? [projectService.completionProfile.projectType]
              : null
          }
          allowInvoiceCompletion={getAdminUser()?.role === "admin"}
          onViewDetails={
            isMobile
              ? () => {
                  // Pest-completion parity: swap the report sheet for the
                  // appointment detail sheet (cancel / no-show / reschedule /
                  // rain-out / price edit).
                  const svc = projectService;
                  setProjectService(null);
                  setDetailService(svc);
                }
              : undefined
          }
          onClose={() => setProjectService(null)}
          onCreated={(p, outcome = {}) => {
            const svc = projectService;
            setProjectService(null);
            // Silent: this chains straight into the continue editor below,
            // and the loud loading/error gates render ABOVE the overlays —
            // a loud refresh withheld the just-created report's editor in
            // board/week modes, and a failed one stranded the tech on the
            // no-retry error screen with the local draft already deleted
            // (house review). The conditional-silence idiom can't cover
            // this call: continueProjectId isn't seated yet.
            fetchSchedule(date, { silent: true });
            // The mobile week list serves rows from its own cached /week
            // payload — without a refetch that row still shows no
            // linkedProject, and tapping it again would open a second
            // create sheet (and a second POST) for the same visit
            // (Codex r3 P2).
            setScheduleRefreshKey((k) => k + 1);
            // A completed WDO already sent its invoice, armed the customer-side
            // report hold, and closed the linked visit inside the same sheet.
            // Do not detour into the legacy Project editor afterward.
            if (p?.id && !outcome.completed) {
              setContinueProjectId(p.id);
              // Seed the snapshot with the created project (Codex r5 P2):
              // week rows (and day rows before the refetch lands) carry no
              // linkedProject yet, so Details → Complete project would
              // treat the visit as unlinked and mint a duplicate report.
              setContinueProjectService(
                svc ? { ...svc, linkedProject: p } : svc,
              );
            }
          }}
        />
      )}
      {continueProjectId && createPortal(
        <div
          // Stays at z-[100]: this editor's Details action opens
          // MobileAppointmentDetailSheet (z-[100], base of the schedule sheet
          // ladder 100/105/110/115). It participates in that ladder — raising
          // it to the z-[120] modal contract would bury its own child sheets.
          className="fixed inset-0 z-[100] bg-black/40 overflow-y-auto"
          onClick={() => {
            // A stray scrim tap must not silently discard unsaved report
            // edits — the editor keeps them only in component state
            // (Codex r14 P2).
            if (
              projectEditorDirty
              && !confirm("Discard unsaved report edits?")
            ) {
              return;
            }
            setContinueProjectId(null);
            setContinueProjectService(null);
            fetchSchedule(date);
          }}
        >
          <div
            className="max-w-4xl mx-auto min-h-full sm:min-h-0 bg-white sm:bg-transparent my-0 sm:my-6 px-0 sm:px-4 box-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* cancelled/no_show retirements aren't "closed" to
                projectCompletionIsClosed (it only knows completed/closed) —
                gate the handoff on the terminal visit set too, or the pill
                reopens appointment actions for a dead visit (Codex r7 P2). */}
            {isMobile && continueProjectService
              && !projectCompletionIsClosed(continueProjectService)
              && !TERMINAL_VISIT_STATUSES.has(
                String(continueProjectService.status),
              ) && (
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  className="h-9 rounded-full bg-white border border-hairline border-zinc-200 text-13 font-medium text-ink-primary px-4"
                  onClick={() => {
                    // Pest-completion parity: appointment actions (cancel /
                    // no-show / reschedule / rain-out / price edit) for the
                    // visit behind this report. Hidden once the visit/report
                    // is terminal (Codex P1) — the sheet also gates its own
                    // terminal actions as the last line of defense.
                    // The editor stays MOUNTED underneath (Codex r3 P2):
                    // clearing continueProjectId here unmounted ProjectDetail
                    // and silently discarded unsaved findings edits. The
                    // detail sheet portals to document.body at z-100, fully
                    // covering this z-50 overlay; closing it drops the
                    // operator back into the editor, edits intact.
                    setDetailService(continueProjectService);
                  }}
                >
                  Details
                </button>
              </div>
            )}
            <ProjectDetail
              projectId={continueProjectId}
              reloadKey={projectReloadKey}
              onDirtyChange={setProjectEditorDirty}
              typesRegistry={projectTypesRegistry}
              onClose={() => {
                // Same dirty guard as the backdrop (Codex r15 P2): the
                // header × inside ProjectDetail routes through this prop
                // and must not silently discard unsaved edits either.
                if (
                  projectEditorDirty
                  && !confirm("Discard unsaved report edits?")
                ) {
                  return;
                }
                setContinueProjectId(null);
                setContinueProjectService(null);
                fetchSchedule(date);
              }}
              onChanged={(info) => {
                // Silent: this fires while the editor is mounted — a loud
                // refresh would unmount it through the loading gate.
                fetchSchedule(date, { silent: true });
                // Close-from-editor also completes the visit. The day
                // refresh re-points day rows, but a Week-mode row never
                // appears in the day payload — mark the snapshot terminal
                // directly off the close signal so the Details pill hides
                // for those too (Codex P1/r2).
                if (info?.visitCompleted) {
                  setContinueProjectService(
                    (s) => (s ? { ...s, status: "completed" } : s),
                  );
                  // The week list's cached /week payload still holds the
                  // pre-close active row — tappable again once this overlay
                  // closes, reseeding a stale active snapshot (Codex r3 P1).
                  // Bump the shared key so it refetches, as rain-out does.
                  setScheduleRefreshKey((k) => k + 1);
                }
              }}
              canAdminActions={getAdminUser()?.role === "admin"}
            />
          </div>
        </div>,
        document.body,
      )}
      {rescheduleService && (
        <RescheduleModal
          service={rescheduleService}
          onClose={() => setRescheduleService(null)}
          onRescheduled={() => {
            setRescheduleService(null);
            fetchSchedule(date);
            // Week/5-Day and Month fetch their own payloads — bump the key
            // so a sidebar-launched reschedule can't leave them showing the
            // appointment at its old date.
            setScheduleRefreshKey((k) => k + 1);
          }}
        />
      )}
      {editingService && (
        <EditServiceModal
          service={editingService}
          technicians={technicians}
          onClose={() => setEditingService(null)}
          onSaved={async () => {
            const editedId = editingService?.id;
            // Captured pre-refetch: was the edited visit a DAY row? A
            // successful refresh miss then means it MOVED (retire the
            // snapshot); week-origin rows are never in the day payload,
            // so their miss means nothing (keep) — Codex r14 P2.
            const wasDayRow = (data?.services || []).some(
              (r) => String(r.id) === String(editedId),
            );
            setEditingService(null);
            setLastSavedVisit({ id: editedId });
            // Week rows cache their own /week payload — invalidate it so a
            // saved date/price/tech change can't be re-served pre-edit from
            // a week row into checkout/details (Codex r11 P1).
            setScheduleRefreshKey((k) => k + 1);
            // Silent only while the project editor is mounted underneath
            // (the Details → Edit path) — desktop grid edits keep the loud
            // gate so a failed refresh stays visible instead of silently
            // leaving the board stale (Codex r9 P2).
            const fresh = await fetchSchedule(date, {
              silent: !!continueProjectId,
            });
            // An edit can change the visit's price/service — refresh the
            // mounted editor's closeoutPreview too, or a billing-required
            // Close stays disabled after the tech lowers the visit to
            // $0/covered and the decision-time re-fetch never runs off the
            // disabled button (Codex r12 P2). Harmless when no editor is
            // mounted: the consumed-key ref ignores pre-mount bumps.
            setProjectReloadKey((k) => k + 1);
            // Mirror the rain-out re-seat/retire (Codex r9 P2): an edit can
            // change the visit's date/price/tech, and a day-miss would
            // otherwise leave the Details pill serving the pre-edit
            // appointment.
            setContinueProjectService((s) => {
              if (!s || String(s.id) !== String(editedId)) return s;
              // A failed refresh keeps the snapshot (house review). On a
              // successful refresh: a found row re-points; a miss retires
              // only DAY-origin visits (the edit moved them off this day)
              // and keeps week-origin ones, which are never in the day
              // payload to begin with (house review + Codex r14 P2).
              if (!fresh) return s;
              const row = (fresh.services || []).find(
                (r) => String(r.id) === String(s.id),
              );
              if (row) return row;
              return wasDayRow ? null : s;
            });
          }}
          onMarkPrepaid={(svc) => {
            setPrepaidEntryContext('edit');
            setPrepaidService(svc);
          }}
        />
      )}
      {protocolService && (
        <ProtocolPanel
          service={protocolService}
          onClose={() => setProtocolService(null)}
        />
      )}
      {detailService && (
        <MobileAppointmentDetailSheet
          service={detailService}
          onClose={() => setDetailService(null)}
          onEdit={(svc) => {
            setDetailService(null);
            setEditingService(svc);
          }}
          onTreatmentPlan={(svc) => {
            // Same trap as onReviewCheckout: TreatmentPlanPanel renders inline
            // (fixed z-1000) and would mount behind this body-level portaled
            // detail sheet. Close the detail sheet first. (Only this in-detail
            // entry point needs it — the list/grid onTreatmentPlan handlers
            // fire with no detail sheet open.)
            setDetailService(null);
            setTreatmentPlanService(svc);
          }}
          onReviewCheckout={(svc) => {
            // Close the detail sheet before opening checkout. The detail sheet
            // portals to document.body (z-100), while the checkout sheet renders
            // inline in this tree (z-105) where an ancestor stacking context
            // traps it beneath the body-level portal — so leaving the detail
            // sheet mounted opens checkout *behind* it and the CTA reads dead.
            // Every other detail transition (edit/complete/book-next) already
            // closes the detail sheet; this one was the lone omission.
            setDetailService(null);
            setCheckoutService(svc);
          }}
          onCompleteService={(svc) => {
            setDetailService(null);
            if (shouldReopenCompletionAfterPayment(svc)) {
              handleComplete(svc);
            }
          }}
          onBookNext={(svc) => {
            setDetailService(null);
            setNewApptDefaults({
              customer: {
                id: svc.customerId,
                firstName: (svc.customerName || "").split(" ")[0] || "",
                lastName: (svc.customerName || "")
                  .split(" ")
                  .slice(1)
                  .join(" "),
                phone: svc.customerPhone || "",
                address: svc.address || "",
                city: svc.city || "",
                tier: svc.waveguardTier || null,
              },
            });
            setShowNewAppt(true);
          }}
          onBillingChanged={() => {
            // The annual-prepay switch rewrote this visit's money state (lane,
            // attached invoice — possibly under a NEW invoice id after an
            // abort's restore). The open sheet still holds the pre-switch
            // snapshot, and checkout could reopen against the voided row
            // (Codex P1 r18) — close it and refetch; the operator reopens to
            // a fresh row. Same pairing the terminal actions below use.
            setDetailService(null);
            fetchSchedule(date, { silent: true });
            setScheduleRefreshKey((k) => k + 1);
          }}
          onCancelled={() => {
            // Silent only while the project editor is mounted underneath —
            // ordinary day-row sheets keep the loud gate so a failed
            // refresh can't quietly leave the pre-mutation row active
            // (Codex r11 P2).
            fetchSchedule(date, { silent: !!continueProjectId });
            // Week rows come from MobileDispatchList's cached /week payload —
            // without a bump the terminalized visit stays tappable as an
            // active project-backed row and can mint a project against a
            // cancelled visit (Codex r4 P2). Same pattern as onRescheduled.
            setScheduleRefreshKey((k) => k + 1);
            // A week-origin continue snapshot never re-points off the day
            // payload, so retire it directly — otherwise the editor's
            // Details pill reopens the sheet with stale active status
            // (Codex r5 P2). Same move as the project-close path.
            setContinueProjectService((s) =>
              s && detailService && String(s.id) === String(detailService.id)
                ? { ...s, status: "cancelled" }
                : s,
            );
          }}
          onRescheduled={async () => {
            // The mobile week list owns its own cached weekData; bump the
            // shared refresh key so it refetches and drops the moved stop.
            setScheduleRefreshKey((k) => k + 1);
            // Same conditional silence as onCancelled (Codex r11 P2).
            const fresh = await fetchSchedule(date, {
              silent: !!continueProjectId,
            });
            // Re-seat (or retire) the continue snapshot off the refreshed
            // day payload (Codex r7 P2): a rain-out/reschedule moves the
            // visit, and a day-miss would otherwise keep serving the old
            // date/status through the Details pill.
            setContinueProjectService((s) => {
              if (
                !s
                || !detailService
                || String(s.id) !== String(detailService.id)
              ) {
                return s;
              }
              // A failed refresh is not a move — keep the snapshot (house
              // review). The retire below is only for a visit that a
              // successful refetch shows really left the selected day.
              if (!fresh) return s;
              const row = (fresh.services || []).find(
                (r) => String(r.id) === String(s.id),
              );
              return row || null;
            });
          }}
        />
      )}
      {checkoutService && (
        <MobileCheckoutSheet
          service={checkoutService}
          desktopVisible
          onClose={() => setCheckoutService(null)}
          onChargeSuccess={({
            service: svc,
            invoiceId,
            invoiceToken,
            amount,
          }) => {
            if (Number(amount || 0) <= 0) {
              setCheckoutService(null);
              setDetailService(null);
              // Route through handleComplete, not straight to the generic
              // CompletionPanel: project-backed visits (WDO/cert) must land
              // in their project lanes — /complete rejects them (Codex r7
              // P1). Pest visits take the same setCompletingService path
              // as before.
              handleComplete({
                ...svc,
                checkoutInvoiceId: invoiceId,
                checkoutInvoiceToken: invoiceToken,
              });
              setProjectReloadKey((k) => k + 1);
              fetchSchedule(date, { silent: true });
              return;
            }
            // Through the synchronized delivery helper (codex P1 #3187
            // r19): a direct setPaymentData leaves paymentSheetActiveRef
            // false until the passive effect runs, and a late completion
            // handoff landing in that window would overwrite this checkout
            // sheet instead of queueing behind it.
            deliverPaymentHandoff({ service: svc, invoiceId, invoiceToken, amount });
          }}
          onEditServiceLine={(svc) => setEditingLineService(svc)}
        />
      )}
      {editingLineService && (
        <MobileServiceEditModal
          desktopVisible
          service={editingLineService}
          technicians={technicians}
          onClose={() => setEditingLineService(null)}
          onSaved={async () => {
            const svcId = editingLineService.id;
            setEditingLineService(null);
            const fresh = await fetchSchedule(date, { silent: true });
            // Invalidate the cached week rows too (Codex r10 P1): a
            // week-origin visit never lands in the day payload, and
            // reopening checkout from a stale week row would hand the
            // pre-edit totals right back.
            setScheduleRefreshKey((k) => k + 1);
            // Re-seat the checkout sheet on the updated service record so
            // the new totals render immediately without the tech having
            // to close + reopen the sheet.
            const updated = fresh?.services?.find((s) => s.id === svcId);
            if (updated) {
              setCheckoutService(updated);
              return;
            }
            // The line edit saved, but the refresh failed or the visit
            // isn't in the selected day's payload — never re-present
            // checkout on pre-edit totals (Codex r9 P1). Close it;
            // reopening re-derives fresh state.
            setCheckoutService(null);
            alert(
              "Line saved, but the schedule refresh didn't return this visit — reopen checkout to continue with updated totals.",
            );
          }}
        />
      )}
      {paymentData && (
        <MobilePaymentSheet
          // Invoice-keyed remount: advancing the queue must never reuse the
          // previous invoice's local tender state (a launched Tap to Pay
          // left `charging` stuck for the next customer — codex P2 #3187
          // r18).
          key={paymentData.invoiceId}
          service={paymentData.service}
          invoiceId={paymentData.invoiceId}
          invoiceToken={paymentData.invoiceToken}
          amount={paymentData.amount}
          desktopVisible
          onClose={releasePaymentSheet}
          onInvoiceSent={async () => {
            // Invoice SMS+email was just sent — the bill is now in the
            // customer's hands. Mirror the cash/check tender flow and
            // punch straight to the completion sheet so the tech can
            // wrap the visit without a second step.
            const svc = {
              ...paymentData.service,
              completionInvoiceAlreadySent: true,
            };
            // Unlike the card/cash/check tenders, MobilePaymentSheet does
            // NOT chain onClose after onInvoiceSent — this path releases
            // itself or the sheet stays mounted and the queue stalls
            // (codex P1 #3187 r18).
            releasePaymentSheet();
            setCheckoutService(null);
            setDetailService(null);
            const serviceDate = String(svc.scheduledDate || date).split("T")[0];
            const fresh = await fetchSchedule(serviceDate, {
              silent: true,
              updateState: serviceDate === String(date).split("T")[0],
            });
            const updated = fresh?.services?.find((s) => s.id === svc.id);
            // Same project-backed routing as the primary Complete action
            // (Codex r7 P1).
            const completionService = mergePostPaymentService(updated, svc);
            if (shouldReopenCompletionAfterPayment(completionService)) {
              handleComplete(completionService);
            }
            setScheduleRefreshKey((k) => k + 1);
            setProjectReloadKey((k) => k + 1);
          }}
          onChargeSuccess={async () => {
            // Card paths reopen completion like the invoice/cash/check
            // paths do — otherwise a billing-409 detour that pays by card
            // drops the tech back to the schedule with the visit still
            // incomplete and the typed draft stranded.
            const svc = {
              ...paymentData.service,
              checkoutInvoiceId: paymentData.invoiceId,
              checkoutInvoiceStatus: "paid",
            };
            // No release here: MobilePaymentSheet always invokes onClose right
            // after this callback, and releasing twice would shift TWO queue
            // entries and lose one (codex P1 #3187 r17) — onClose is the
            // sheet's single release point.
            setCheckoutService(null);
            setDetailService(null);
            const serviceDate = String(svc.scheduledDate || date).split("T")[0];
            const fresh = await fetchSchedule(serviceDate, {
              silent: true,
              updateState: serviceDate === String(date).split("T")[0],
            });
            const updated = fresh?.services?.find((s) => s.id === svc.id);
            // Same project-backed routing as the primary Complete action
            // (Codex r7 P1).
            const completionService = mergePostPaymentService(updated, svc);
            if (shouldReopenCompletionAfterPayment(completionService)) {
              handleComplete(completionService);
            }
            setScheduleRefreshKey((k) => k + 1);
            setProjectReloadKey((k) => k + 1);
          }}
          onPrepaidRecorded={async ({ invoice } = {}) => {
            // Cash / Check tender marked the pre-minted invoice paid server-side;
            // punch straight to completion with fresh enough payment state for
            // the completion SMS to use the paid branch.
            const svc = {
              ...paymentData.service,
              checkoutInvoiceId: invoice?.id || paymentData.invoiceId,
              checkoutInvoiceStatus: invoice?.status || "paid",
            };
            // No release here: MobilePaymentSheet always invokes onClose right
            // after this callback, and releasing twice would shift TWO queue
            // entries and lose one (codex P1 #3187 r17) — onClose is the
            // sheet's single release point.
            setCheckoutService(null);
            setDetailService(null);
            const serviceDate = String(svc.scheduledDate || date).split("T")[0];
            const fresh = await fetchSchedule(serviceDate, {
              silent: true,
              updateState: serviceDate === String(date).split("T")[0],
            });
            const updated = fresh?.services?.find((s) => s.id === svc.id);
            // Same project-backed routing as the primary Complete action
            // (Codex r7 P1).
            const completionService = mergePostPaymentService(updated, svc);
            if (shouldReopenCompletionAfterPayment(completionService)) {
              handleComplete(completionService);
            }
            setScheduleRefreshKey((k) => k + 1);
            setProjectReloadKey((k) => k + 1);
          }}
        />
      )}
      {prepaidService && (
        <MarkPrepaidModal
          service={prepaidService}
          onClose={() => {
            setPrepaidService(null);
            setPrepaidEntryContext(null);
          }}
          onSaved={async () => {
            const svc = prepaidService;
            const entry = prepaidEntryContext;
            setPrepaidService(null);
            setPrepaidEntryContext(null);
            setLastSavedVisit({ id: svc?.id });
            // Week rows cache their own /week payload — without a bump a
            // week-origin visit keeps showing unpaid and can reopen
            // checkout/prepay off stale totals (Codex r12 P2).
            setScheduleRefreshKey((k) => k + 1);
            const fresh = await fetchSchedule(date, { silent: true });
            if (entry === 'edit') {
              // Re-seat the editing service with the post-save row so the
              // EditServiceModal banner reflects the new prepaid state
              // without forcing the operator to close + reopen.
              const updated = fresh?.services?.find((s) => s.id === svc.id);
              if (updated) {
                setEditingService(updated);
              } else {
                // Refresh failed or the visit isn't in the day payload —
                // never leave the edit modal claiming the visit is still
                // unpaid; the stale banner invited a second collection
                // (house review; mirrors the r9 line-edit alert).
                setEditingService(null);
                alert(
                  "Prepayment recorded, but the schedule refresh didn't return this visit — reopen it to see the updated state.",
                );
              }
              // Prepaid resolves project closeout billing — refresh the
              // mounted editor's closeoutPreview too, or Close project
              // stays disabled until reopen (Codex r11 P2).
              setProjectReloadKey((k) => k + 1);
            } else {
              // Same project-backed routing as the primary Complete action
              // (Codex r7 P1).
              handleComplete(svc);
              setProjectReloadKey((k) => k + 1);
            }
          }}
        />
      )}
      {treatmentPlanService && (
        <TreatmentPlanPanel
          service={treatmentPlanService}
          onClose={() => setTreatmentPlanService(null)}
        />
      )}
      {auditContext?.customerId && (
        <Customer360ProfileV2
          customerId={auditContext.customerId}
          initialTab="services"
          initialScheduledServiceId={auditContext.scheduledServiceId}
          onClose={() => setAuditContext(null)}
        />
      )}
      {selectedScheduleService && (
        <ScheduleCustomerSidebar
          service={selectedScheduleService}
          onClose={() => setSelectedScheduleService(null)}
          onEdit={(svc) => {
            setSelectedScheduleService(null);
            setEditingService(svc);
          }}
          onReschedule={(svc) => {
            setSelectedScheduleService(null);
            setRescheduleService(svc);
          }}
          onSavedNote={(svc, notes) => {
            setSelectedScheduleService((prev) =>
              prev && prev.id === svc.id ? { ...prev, notes } : prev,
            );
            fetchSchedule(date);
          }}
          onCancel={handleSidebarCancel}
          onBookNext={(svc) => {
            setSelectedScheduleService(null);
            setNewApptDefaults({
              customer: {
                id: svc.customerId,
                firstName: (svc.customerName || "").split(" ")[0] || "",
                lastName: (svc.customerName || "")
                  .split(" ")
                  .slice(1)
                  .join(" "),
                phone: svc.customerPhone || "",
                address: svc.address || "",
                city: svc.city || "",
                tier: svc.waveguardTier || svc.tier || null,
              },
            });
            setShowNewAppt(true);
          }}
        />
      )}
    </div>
  );
}
