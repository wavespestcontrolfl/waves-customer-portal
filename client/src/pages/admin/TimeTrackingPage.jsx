import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import StaffDocumentLibrary from "../../components/staffDocuments/Library";
import useStaffDocumentsAvailable from "../../hooks/useStaffDocumentsAvailable";
import PayrollSettings from "../../components/payroll/PayrollSettings";
import ProtocolAudit from "../../components/techRewards/ProtocolAudit";
import Scoreboard, { ScoreboardPreview } from "../../components/techRewards/Scoreboard";
import useTechScoreboardAvailability from "../../hooks/useTechScoreboardAvailability";
import usePayrollAvailable from "../../hooks/usePayrollAvailable";
import TechPayStubs from "../../components/payroll/TechPayStubs";
import useTechPayStubs from "../../hooks/useTechPayStubs";
import {
  BarChart3,
  CheckCircle2,
  Clock,
  Receipt,
  FileText,
  LayoutDashboard,
  List,
  Users,
  Wallet,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import "./TimeTrackingPage.css";
import { D, isErrorToastText, readStaffProfile } from "./staff/staffShared";
import { DashboardTab } from "./staff/DashboardTab";
import { TimesheetTab } from "./staff/TimesheetTab";
import { EntriesTab } from "./staff/EntriesTab";
import { AnalyticsTab } from "./staff/AnalyticsTab";
import { TeamTab, TechVoicePinField } from "./staff/TeamTab";
import { DocumentsTab } from "./staff/DocumentsTab";
import { ApprovalsTab } from "./staff/ApprovalsTab";

export {
  DashboardTab,
  TimesheetTab,
  EntriesTab,
  AnalyticsTab,
  TeamTab,
  DocumentsTab,
  ApprovalsTab,
  TechVoicePinField,
};

const STAFF_SECTIONS = [
  { key: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { key: "timesheet", label: "Timesheet", Icon: Clock },
  { key: "approvals", label: "Approvals", Icon: CheckCircle2 },
  { key: "entries", label: "Entries", Icon: List },
  { key: "analytics", label: "Analytics", Icon: BarChart3 },
  { key: "team", label: "Roster", Icon: Users },
  { key: "documents", label: "Documents", Icon: FileText },
  { key: "protocol-audit", label: "Protocol audit", Icon: CheckCircle2 },
  { key: "payroll", label: "Payroll", Icon: Wallet },
  { key: "pay-stubs", label: "Pay stubs", Icon: Receipt },
  { key: "scoreboard", label: "Scoreboard", Icon: BarChart3 },
  { key: "scoreboard-preview", label: "Scoreboard preview", Icon: BarChart3 },
];

// Grouped by operational responsibility so Staff never nests "Team > Staff > Team > Team"
// and Pay / Rewards tabs live together instead of being split across Time and Team.
// Every existing ?tab= leaf key stays identical for deep links and bookmarks.
const TIMETRACKING_TAB_GROUPS = [
  { key: "dashboard", label: "Dashboard", Icon: LayoutDashboard, tabs: ["dashboard"] },
  {
    key: "time",
    label: "Time",
    Icon: Clock,
    tabs: ["timesheet", "entries", "approvals", "analytics"],
  },
  {
    key: "roster",
    label: "Roster & Docs",
    Icon: Users,
    tabs: ["team", "documents"],
  },
  {
    key: "pay-rewards",
    label: "Pay & Rewards",
    Icon: Wallet,
    tabs: ["payroll", "pay-stubs", "protocol-audit", "scoreboard", "scoreboard-preview"],
  },
];

const STAFF_LEAF_BY_KEY = Object.fromEntries(
  STAFF_SECTIONS.map((s) => [s.key, s]),
);

// Office-only leaves read routes a technician login cannot reach
// (docs/technician-reachable-routes.md), so a technician never sees them: its
// Staff page is Dashboard, its own pay stubs, its scoreboard and the roster.
const OFFICE_ONLY_STAFF_TABS = new Set([
  "timesheet",
  "entries",
  "approvals",
  "analytics",
  "documents",
  "protocol-audit",
  "scoreboard-preview",
]);

// Resolve the LEAF the page will actually render for a ?tab= deep link.
export function resolveStaffTab(rawTab, role, payrollAvailable = false, payStubsStatus = "off", scoreboardStatus = "off") {
  if (role !== "admin" && OFFICE_ONLY_STAFF_TABS.has(rawTab)) return "dashboard";
  const gatedStatus = new Map([["pay-stubs", payStubsStatus], ["scoreboard", scoreboardStatus]]).get(rawTab);
  if (gatedStatus !== undefined) {
    if (gatedStatus === "ready") return rawTab;
    if (gatedStatus === "loading") return null;
    return role === "admin" ? "timesheet" : "dashboard";
  }
  if (rawTab === "payroll") {
    if (role !== "admin" || payrollAvailable === false) return "team";
    return payrollAvailable === true ? "payroll" : null;
  }
  return rawTab;
}

function openStaffLeaves(group, leafOpen, role) {
  return group.tabs.filter((key) => (leafOpen[key] ?? true) && (role === "admin" || !OFFICE_ONLY_STAFF_TABS.has(key)));
}

const AVAILABILITY_WORDS = {
  payroll: "Checking payroll availability…",
  "pay-stubs": "Checking pay stub availability…",
  scoreboard: "Checking scoreboard availability…",
};

const LEGACY_TABS = new Set(["dashboard", "timesheet", "approvals", "entries", "analytics", "team"]);

function DocumentsTabView({ available, legacyDocsOpened, onOpenLegacyDocs, showToast }) {
  if (available === null) {
    return <p role="status" style={{ color: D.muted }}>Checking document library…</p>;
  }
  if (!available) {
    return (
      <div className="staff-legacy">
        <DocumentsTab showToast={showToast} />
      </div>
    );
  }
  return (
    <>
      <StaffDocumentLibrary manage />
      <details
        style={{ marginTop: 24 }}
        onToggle={(e) => { if (e.currentTarget.open) onOpenLegacyDocs(); }}
      >
        <summary style={{ fontSize: 16, fontWeight: 700, padding: "16px 0", cursor: "pointer" }}>
          Uploaded files and historical attachments
        </summary>
        {legacyDocsOpened && (
          <div className="staff-legacy">
            <DocumentsTab showToast={showToast} />
          </div>
        )}
      </details>
    </>
  );
}

function LegacyTabContent({ tab, showToast, staffProfile, payrollGateOpen, weekStartParam, setTab }) {
  return (
    <div className="staff-legacy">
      {tab === "dashboard" && <DashboardTab showToast={showToast} />}
      {tab === "timesheet" && <TimesheetTab showToast={showToast} onOpenApprovals={(w) => setTab("approvals", w)} />}
      {tab === "approvals" && <ApprovalsTab showToast={showToast} weekStartParam={weekStartParam} />}
      {tab === "entries" && <EntriesTab showToast={showToast} onOpenApprovals={(w) => setTab("approvals", w)} />}
      {tab === "analytics" && <AnalyticsTab />}
      {tab === "team" && (
        <TeamTab
          showToast={showToast}
          staffProfile={staffProfile}
          payrollAvailable={payrollGateOpen}
          onOpenPayroll={() => setTab("payroll")}
        />
      )}
    </div>
  );
}

function StaffToast({ toast }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        background: D.card,
        border: `1px solid ${toast?.isError ? D.red : D.green}`,
        borderRadius: 8,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: "0 8px 32px rgba(0,0,0,.4)",
        zIndex: 300,
        fontSize: 14,
        transform: toast ? "translateY(0)" : "translateY(80px)",
        opacity: toast ? 1 : 0,
        transition: "all .3s",
        pointerEvents: "none",
      }}
    >
      <span style={{ color: toast?.isError ? D.red : D.green, fontWeight: 600 }}>
        {toast?.isError ? "Error" : "OK"}
      </span>
      <span style={{ color: D.text }}>{toast?.message || ""}</span>
    </div>
  );
}

export default function TimeTrackingPage() {
  const outletContext = useOutletContext();
  const staffProfile = useMemo(
    () => outletContext?.user || readStaffProfile(),
    [outletContext?.user],
  );
  const staffRole = staffProfile?.role || null;
  const controlledDocumentsAvailable = useStaffDocumentsAvailable();
  const payrollAvailable = usePayrollAvailable(staffRole === "admin");
  const payStubs = useTechPayStubs();
  const scoreboard = useTechScoreboardAvailability();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = STAFF_LEAF_BY_KEY[searchParams.get("tab")] ? searchParams.get("tab") : "dashboard";
  const payrollGateOpen = payrollAvailable === true && staffRole === "admin";
  const tab = resolveStaffTab(rawTab, staffRole, payrollAvailable, payStubs.status, scoreboard.status);
  const leafOpen = {
    payroll: payrollGateOpen,
    "pay-stubs": payStubs.status === "ready",
    scoreboard: scoreboard.status === "ready",
  };
  const visibleLeaves = (group) => openStaffLeaves(group, leafOpen, staffRole);
  const setTab = (value, weekStart = null) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", value);
    if (weekStart) next.set("weekStart", weekStart);
    else if (value !== "approvals") next.delete("weekStart");
    if (value !== "documents") { next.delete("document"); next.delete("version"); }
    setSearchParams(next);
  };
  const activeGroup =
    TIMETRACKING_TAB_GROUPS.find((g) => g.tabs.includes(tab ?? rawTab)) ||
    TIMETRACKING_TAB_GROUPS[0];
  useRenderedTabBeacon("/admin/timetracking", tab, [searchParams]);
  const [toast, setToast] = useState(null);
  const [legacyDocsOpened, setLegacyDocsOpened] = useState(false);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((m, opts = {}) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const message = String(m || "");
    const isError = typeof opts.error === "boolean" ? opts.error : isErrorToastText(message);
    setToast(message ? { message, isError } : null);
    if (message) {
      toastTimerRef.current = setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, isError ? 5000 : 3500);
    }
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const groupSections = TIMETRACKING_TAB_GROUPS
    .filter((g) => visibleLeaves(g).length > 0)
    .map((g) => ({ key: g.key, label: g.label, Icon: g.Icon }));
  const secondaryLeaves = visibleLeaves(activeGroup);

  return (
    <div className="staff-foundation mx-auto max-w-[1500px]">
      <AdminCommandHeader
        title="Staff"
        icon={Users}
        sections={groupSections}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = TIMETRACKING_TAB_GROUPS.find((x) => x.key === key);
          if (g && visibleLeaves(g).length) setTab(visibleLeaves(g)[0]);
        }}
        ariaLabel="Staff section"
        navGridClassName="grid-cols-2 md:grid-cols-4 xl:grid-cols-4"
        secondarySections={secondaryLeaves.length > 1 ? secondaryLeaves.map((key) => STAFF_LEAF_BY_KEY[key]) : []}
        secondaryActiveKey={tab}
        onSecondaryChange={setTab}
        secondaryAriaLabel="Staff sub-section"
      />
      {LEGACY_TABS.has(tab) && (
        <LegacyTabContent
          tab={tab}
          showToast={showToast}
          staffProfile={staffProfile}
          payrollGateOpen={payrollGateOpen}
          weekStartParam={searchParams.get("weekStart")}
          setTab={setTab}
        />
      )}
      {tab === "documents" && (
        <DocumentsTabView
          available={controlledDocumentsAvailable}
          legacyDocsOpened={legacyDocsOpened}
          onOpenLegacyDocs={() => setLegacyDocsOpened(true)}
          showToast={showToast}
        />
      )}
      {tab === "protocol-audit" && <ProtocolAudit />}
      {tab === "scoreboard-preview" && <ScoreboardPreview />}
      {tab === "payroll" && <PayrollSettings />}
      {tab === "pay-stubs" && <TechPayStubs stubs={payStubs} />}
      {tab === "scoreboard" && <Scoreboard />}
      {tab === null && <p role="status" style={{ color: "#71717A" }}>{AVAILABILITY_WORDS[rawTab] || "Checking availability…"}</p>}
      <StaffToast toast={toast} />
    </div>
  );
}
