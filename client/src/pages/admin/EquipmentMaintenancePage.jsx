import { Button, Field, Select, Badge, Card, ActionFeedback, Table, THead, TBody, TR, TH, TD } from "../../components/ui";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import useIsMobile from "../../hooks/useIsMobile";
import { BarChart3, Truck, Wrench, Droplets, Cog, RotateCw, Syringe, Leaf, ShieldCheck } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { etDateString } from "../../lib/timezone";
const API = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS / SEV_COLORS fold cleanly — in_service & low both → zinc-900,
// stay distinct from green/amber/red/muted in their respective scopes.
// SEV_COLORS.high keeps explicit '#f97316' for warning-orange between amber and red.

// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS / SEV_COLORS fold cleanly — in_service & low both → zinc-900,
// stay distinct from green/amber/red/muted in their respective scopes.
// SEV_COLORS.high keeps explicit '#f97316' for warning-orange between amber and red.

function af(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json"
    },
    ...opts
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}
const sCard = {
  background: "#FFFFFF",
  border: `1px solid ${"#E4E4E7"}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)"
};
const sBtn = (bg, c) => ({
  padding: "8px 16px",
  background: bg,
  color: c,
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer"
});
const sBadge = (bg, c) => ({
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 4,
  background: bg,
  color: c,
  fontWeight: 500,
  display: "inline-block"
});
const sInput = {
  width: "100%",
  padding: "8px 12px",
  background: "#FFFFFF",
  border: `1px solid ${"#E4E4E7"}`,
  borderRadius: 8,
  color: "#27272A",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box"
};
const fmt = n => n != null ? "$" + Number(n).toLocaleString(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}) : "--";
const fmtN = n => n != null ? Number(n).toLocaleString() : "--";
const CAT_ICONS = {
  vehicle: Truck,
  sprayer: Droplets,
  pump: Cog,
  reel: RotateCw,
  injection: Syringe,
  dethatcher: Leaf,
  topdresser: Leaf,
  mower: Leaf,
  trailer: Truck,
  tool: Wrench,
  safety: ShieldCheck,
  other: Wrench
};
function EquipmentCategoryIcon({
  category,
  size = 16
}) {
  const Icon = CAT_ICONS[category] || Wrench;
  return <Icon size={size} aria-hidden="true" className="inline-block shrink-0 align-middle" />;
}
const FLEET_SECTIONS = [{
  key: "fleet",
  label: "Fleet Overview",
  Icon: Truck
}, {
  key: "analytics",
  label: "Analytics",
  Icon: BarChart3
}];
function ConditionBar({
  rating
}) {
  const r = rating || 5;
  const color = r >= 8 ? "#18181B" : r >= 5 ? "#52525B" : "#C8312F";
  return <div style={{
    display: "flex",
    alignItems: "center",
    gap: 6
  }}>
      {" "}
      <div style={{
      flex: 1,
      height: 6,
      background: "#FFFFFF",
      borderRadius: 3,
      overflow: "hidden",
      minWidth: 60
    }}>
        {" "}
        <div style={{
        width: `${r * 10}%`,
        height: "100%",
        background: color,
        borderRadius: 3
      }} />{" "}
      </div>{" "}
      <span style={{
      fontSize: 14,
      color,
      fontWeight: 500,
      minWidth: 20
    }}>
        {r}/10
      </span>{" "}
    </div>;
}
function StatCard({
  label,
  value,
  color,
  sub
}) {
  return <Card style={{
    flex: "1 1 160px",
    minWidth: 140,
    textAlign: "center",
    padding: 16
  }} className="p-4 mb-3">
      {" "}
      <div style={{
      fontSize: 14,
      color: "#71717A",
      marginBottom: 4
    }}>
        {label}
      </div>{" "}
      <div style={{
      fontSize: 22,
      fontWeight: 500,
      color: color || "#09090B"
    }}>
        {value}
      </div>
      {sub && <div style={{
      fontSize: 14,
      color: "#71717A",
      marginTop: 2
    }}>
          {sub}
        </div>}
    </Card>;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════
export default function EquipmentMaintenancePage({
  embedded = false,
  initialTab = "fleet"
}) {
  const actionRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [tab, setTab] = useState(initialTab);
  const [toast, setToast] = useState("");
  const showToast = m => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };

  // Fleet state
  const [equipment, setEquipment] = useState([]);
  const [overview, setOverview] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterCat, setFilterCat] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [sortBy, setSortBy] = useState("name");
  const [expandedId, setExpandedId] = useState(null);

  // Analytics state
  const [costs, setCosts] = useState([]);
  const [reliability, setReliability] = useState([]);
  const [mileageSummary, setMileageSummary] = useState(null);
  const [dueSchedules, setDueSchedules] = useState([]);
  const [monthlyCosts, setMonthlyCosts] = useState([]);
  const [fleetError, setFleetError] = useState("");
  const [analyticsError, setAnalyticsError] = useState("");
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const loadFleet = useCallback(async () => {
    setFleetError("");
    setLoading(true);
    try {
      const [eqRes, ovRes, alRes] = await Promise.all([af("/admin/equipment-maintenance"), af("/admin/equipment-maintenance/analytics/overview"), af("/admin/equipment-maintenance/alerts?status=new")]);
      setEquipment(eqRes.equipment || []);
      setOverview(ovRes);
      setAlerts(alRes.alerts || []);
    } catch (e) {
      setFleetError(e.message);
    }
    setLoading(false);
  }, []);
  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setAnalyticsError("");
    try {
      const [cRes, rRes, mRes, dRes, recRes] = await Promise.all([af("/admin/equipment-maintenance/analytics/costs"), af("/admin/equipment-maintenance/analytics/reliability"), af("/admin/equipment-maintenance/mileage/summary"), af("/admin/equipment-maintenance/schedules/due"), af("/admin/equipment-maintenance/records/recent?limit=100")]);
      setCosts(cRes.costs || []);
      setReliability(rRes.reliability || []);
      setMileageSummary(mRes);
      setDueSchedules(dRes.schedules || []);

      // Build monthly cost trend from recent records
      const byMonth = {};
      (recRes.records || []).forEach(r => {
        const m = (r.performed_at || "").slice(0, 7);
        if (m) byMonth[m] = (byMonth[m] || 0) + parseFloat(r.total_cost || 0);
      });
      const months = Object.keys(byMonth).sort().slice(-6);
      setMonthlyCosts(months.map(m => ({
        month: m,
        cost: byMonth[m]
      })));
    } catch (e) {
      setAnalyticsError(e.message);
    }
    setAnalyticsLoading(false);
  }, []);
  useEffect(() => {
    loadFleet();
  }, [loadFleet]);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  useEffect(() => {
    if (tab === "analytics") loadAnalytics();
  }, [tab, loadAnalytics]);
  const filtered = useMemo(() => {
    let list = [...equipment];
    if (filterCat) list = list.filter(e => e.category === filterCat);
    if (filterStatus) list = list.filter(e => e.status === filterStatus);
    list.sort((a, b) => {
      if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
      if (sortBy === "condition") return (a.condition_rating || 0) - (b.condition_rating || 0);
      if (sortBy === "cost") return (b.avg_maintenance_cost || 0) - (a.avg_maintenance_cost || 0);
      return 0;
    });
    return list;
  }, [equipment, filterCat, filterStatus, sortBy]);
  const categories = useMemo(() => [...new Set(equipment.map(e => e.category).filter(Boolean))].sort(), [equipment]);
  const dismissAlert = async id => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionError("");
    setPendingAction(id);
    try {
      try {
        await af(`/admin/equipment-maintenance/alerts/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            status: "resolved",
            resolved_by: "admin"
          })
        });
        setAlerts(prev => prev.filter(a => a.id !== id));
        showToast("Alert resolved");
      } catch (e) {
        setActionError(`Error resolving alert: ${e.message}`);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };

  // ─── RENDER ─────────────────────────────────────────────────────
  return <div style={embedded ? undefined : {
    maxWidth: 1300,
    margin: "0 auto"
  }}>
      {actionError && <ActionFeedback error className="mb-4">
          {actionError}
        </ActionFeedback>}{" "}
      {!embedded && <AdminCommandHeader title="Fleet" icon={Truck} sections={FLEET_SECTIONS} activeKey={tab} onSectionChange={setTab} ariaLabel="Fleet section" navGridClassName="grid-cols-2" variant="workspace" />}
      {toast && <Card role="status" className="fixed z-[300] right-4 bottom-[calc(80px+env(safe-area-inset-bottom))] sm:bottom-5 max-w-[calc(100vw-32px)] px-4 py-3">
          {toast}
        </Card>}
      {tab === "fleet" && fleetError && <ActionFeedback error onRetry={loadFleet} className="mb-4">
          Could not load fleet: {fleetError}
        </ActionFeedback>}
      {analyticsError && tab === "analytics" && <ActionFeedback error onRetry={loadAnalytics} className="mb-4">
          Could not load analytics: {analyticsError}
        </ActionFeedback>}
      {tab === "fleet" && !fleetError && <FleetTab {...{
      loading,
      overview,
      alerts,
      dismissAlert,
      resolvingAlert: pendingAction,
      filtered,
      categories,
      filterCat,
      setFilterCat,
      filterStatus,
      setFilterStatus,
      sortBy,
      setSortBy,
      expandedId,
      setExpandedId,
      showToast,
      loadFleet
    }} />}
      {tab === "analytics" && analyticsLoading && <div className="min-h-60 py-6 text-zinc-500">
          Loading equipment analytics…
        </div>}
      {tab === "analytics" && !analyticsLoading && !analyticsError && <AnalyticsTab {...{
      costs,
      reliability,
      mileageSummary,
      dueSchedules,
      monthlyCosts,
      overview
    }} />}
    </div>;
}

// ═══════════════════════════════════════════════════════════════════
// FLEET OVERVIEW TAB
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// FLEET OVERVIEW TAB
// ═══════════════════════════════════════════════════════════════════
function FleetTab({
  loading,
  overview,
  alerts,
  dismissAlert,
  resolvingAlert,
  filtered,
  categories,
  filterCat,
  setFilterCat,
  filterStatus,
  setFilterStatus,
  sortBy,
  setSortBy,
  expandedId,
  setExpandedId,
  showToast,
  loadFleet
}) {
  const isMobile = useIsMobile(768);
  if (loading) return <div style={{
    color: "#71717A",
    textAlign: "center",
    padding: 40
  }}>
        Loading fleet data...
      </div>;
  return <>
      {/* Alert Banner */}
      {alerts.length > 0 && <Card style={{
      borderColor: "#E4E4E7",
      padding: 16,
      marginBottom: 16
    }} className="p-4 mb-3">
          {" "}
          <div style={{
        fontSize: 14,
        fontWeight: 500,
        color: "#C8312F",
        marginBottom: 8
      }}>
            {alerts.length} Active Alert{alerts.length > 1 ? "s" : ""}
          </div>
          {alerts.slice(0, 5).map(a => <div key={a.id} style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
        borderBottom: `1px solid ${"#E4E4E7"}`
      }}>
              {" "}
              <Badge tone="neutral">{a.severity}</Badge>{" "}
              <span style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          color: "#27272A"
        }}>
                {a.title}
              </span>{" "}
              <Button onClick={() => dismissAlert(a.id)} disabled={!!resolvingAlert} loading={resolvingAlert === a.id} type="button" variant="secondary" className="min-w-11">
                Dismiss
              </Button>{" "}
            </div>)}
          {alerts.length > 5 && <div style={{
        fontSize: 14,
        color: "#71717A",
        marginTop: 6
      }}>
              + {alerts.length - 5} more
            </div>}
        </Card>}

      {/* Stats */}
      {overview && <div style={{
      display: "flex",
      flexWrap: "wrap",
      gap: 10,
      marginBottom: 16
    }}>
          {" "}
          <StatCard label="Total Assets" value={overview.total_assets} />{" "}
          <StatCard label="Overdue Maintenance" value={overview.overdue_maintenance} color={overview.overdue_maintenance > 0 ? "#C8312F" : "#18181B"} />{" "}
          <StatCard label="YTD Maintenance" value={fmt(overview.ytd_maintenance_spend)} />{" "}
          <StatCard label="YTD Mileage" value={fmtN(Math.round(overview.ytd_total_miles))} sub="miles" />{" "}
          <StatCard label="YTD Fuel" value={fmt(overview.ytd_fuel_cost)} />{" "}
          <StatCard label="YTD IRS Deduction" value={fmt(overview.ytd_irs_deduction)} color={"#18181B"} />{" "}
        </div>}

      {/* Filters */}
      <div style={{
      display: "flex",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 16
    }}>
        {" "}
        <Field label="Category">
          <Select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{
          width: "auto",
          minWidth: 140
        }}>
            {" "}
            <option value="">All Categories</option>
            {categories.map(c => <option key={c} value={c}>
                {c}
              </option>)}
          </Select>
        </Field>{" "}
        <Field label="Status">
          <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{
          width: "auto",
          minWidth: 130
        }}>
            {" "}
            <option value="">All Statuses</option>{" "}
            <option value="active">Active</option>{" "}
            <option value="maintenance">Maintenance</option>{" "}
            <option value="retired">Retired</option>{" "}
            <option value="sold">Sold</option>{" "}
            <option value="lost">Lost</option>{" "}
          </Select>
        </Field>{" "}
        <Field label="Sort by">
          <Select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
          width: "auto",
          minWidth: 130
        }}>
            {" "}
            <option value="name">Sort: Name</option>{" "}
            <option value="condition">Sort: Condition</option>{" "}
            <option value="cost">Sort: Cost</option>{" "}
          </Select>
        </Field>{" "}
      </div>
      {/* Equipment Grid */}
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(340, 1fr))",
      gap: 12
    }}>
        {filtered.map(eq => <EquipmentCard key={eq.id} eq={eq} isExpanded={expandedId === eq.id} onToggle={() => setExpandedId(expandedId === eq.id ? null : eq.id)} showToast={showToast} loadFleet={loadFleet} />)}
      </div>
      {filtered.length === 0 && <div style={{
      color: "#71717A",
      textAlign: "center",
      padding: 40
    }}>
          No equipment found
        </div>}
    </>;
}

// ═══════════════════════════════════════════════════════════════════
// EQUIPMENT CARD + EXPANDED DETAIL
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// EQUIPMENT CARD + EXPANDED DETAIL
// ═══════════════════════════════════════════════════════════════════
function EquipmentCard({
  eq,
  isExpanded,
  onToggle,
  showToast,
  loadFleet
}) {
  const [formBusy, setFormBusy] = useState(false);
  const isMobile = useIsMobile(768);
  const [detail, setDetail] = useState(null);
  const [mileage, setMileage] = useState(null);
  const [recordForm, setRecordForm] = useState(false);
  const [mileageForm, setMileageForm] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!isExpanded || detail) {
      setDetailLoading(false);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    Promise.all([af(`/admin/equipment-maintenance/${eq.id}`), eq.category === "vehicle" ? af(`/admin/equipment-maintenance/${eq.id}/mileage?limit=30`) : Promise.resolve(null)]).then(([d, m]) => {
      if (active) {
        setDetail(d);
        setMileage(m);
      }
    }).catch(error => {
      if (active) setDetailError(error.message);
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => {
      active = false;
    };
  }, [isExpanded, eq.id, eq.category, detail, attempt]);
  const nm = eq.next_maintenance;
  const overdue = nm && nm.is_overdue;
  return <Card style={{
    cursor: "pointer",
    transition: "border-color 0.2s",
    borderColor: overdue ? "#C8312F" : isExpanded ? "#18181B" : "#E4E4E7",
    gridColumn: isExpanded ? "1 / -1" : undefined
  }} className="min-w-0 p-4 mb-3">
      {/* Card Header */}
      <Button onClick={onToggle} style={{
      display: "flex",
      gap: 12,
      alignItems: "flex-start"
    }} variant="secondary" className="!h-auto w-full text-left whitespace-normal" aria-expanded={isExpanded} aria-controls={`equipment-detail-${eq.id}`} aria-label={`Open ${eq.name}`} disabled={formBusy}>
        {" "}
        <div style={{
        fontSize: 28,
        lineHeight: 1
      }}>
          <EquipmentCategoryIcon category={eq.category} size={24} />
        </div>{" "}
        <div style={{
        flex: 1,
        minWidth: 0
      }}>
          {" "}
          <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap"
        }}>
            {" "}
            <span style={{
            fontSize: 15,
            fontWeight: 500,
            color: "#09090B"
          }}>
              {eq.name}
            </span>{" "}
            <Badge tone="neutral">{eq.status}</Badge>{" "}
          </div>{" "}
          <div style={{
          fontSize: 14,
          color: "#71717A",
          marginTop: 2
        }}>
            {eq.asset_tag && <span style={{
            marginRight: 12
          }}>
                {eq.asset_tag}
              </span>}
            {eq.make && <span style={{
            marginRight: 12
          }}>
                {eq.make} {eq.model}
              </span>}
            {eq.year && <span>({eq.year})</span>}
          </div>{" "}
          <div style={{
          display: "flex",
          gap: 12,
          marginTop: 8,
          alignItems: "center",
          flexWrap: "wrap"
        }}>
            {" "}
            <div style={{
            flex: "1 1 100px",
            minWidth: 80
          }}>
              {" "}
              <ConditionBar rating={eq.condition_rating} />{" "}
            </div>
            {nm && <div style={{
            fontSize: 14,
            color: overdue ? "#C8312F" : "#71717A"
          }}>
                {overdue ? "OVERDUE: " : "Next: "}
                {nm.task_name}
                {nm.next_due_at && <span>({new Date(nm.next_due_at).toLocaleDateString()})</span>}
              </div>}
          </div>{" "}
          <div style={{
          display: "flex",
          gap: 12,
          marginTop: 4,
          fontSize: 14,
          color: "#71717A"
        }}>
            {eq.assigned_tech_name !== "Unassigned" && <span>Assigned: {eq.assigned_tech_name}</span>}
            {eq.current_miles > 0 && <span>{fmtN(eq.current_miles)} mi</span>}
            {parseFloat(eq.current_hours) > 0 && <span>{fmtN(eq.current_hours)} hrs</span>}
          </div>{" "}
        </div>{" "}
      </Button>
      {isExpanded && detailLoading && <div className="min-h-24 py-4 text-zinc-500" id={`equipment-detail-${eq.id}`}>
          Loading equipment details…
        </div>}
      {isExpanded && detailError && <ActionFeedback error onRetry={() => setAttempt(v => v + 1)} className="mt-4">
          Could not load equipment details: {detailError}
        </ActionFeedback>}
      {/* Expanded Detail */}
      {isExpanded && detail && <div style={{
      marginTop: 16,
      borderTop: `1px solid ${"#E4E4E7"}`,
      paddingTop: 16
    }} id={`equipment-detail-${eq.id}`}>
          {/* Equipment Info Grid */}
          <div style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
        gap: 12,
        marginBottom: 16
      }}>
            {" "}
            <InfoRow label="Serial" value={detail.equipment.serial_number} />{" "}
            <InfoRow label="VIN" value={detail.equipment.vin} />{" "}
            <InfoRow label="Purchase Date" value={detail.equipment.purchase_date ? new Date(detail.equipment.purchase_date).toLocaleDateString() : null} />{" "}
            <InfoRow label="Purchase Price" value={detail.equipment.purchase_price ? fmt(detail.equipment.purchase_price) : null} />{" "}
            <InfoRow label="Warranty" value={detail.equipment.warranty_expiration ? `Expires ${new Date(detail.equipment.warranty_expiration).toLocaleDateString()}` : null} />{" "}
            <InfoRow label="Engine" value={detail.equipment.engine_type} />{" "}
            <InfoRow label="Location" value={detail.equipment.location} />{" "}
            <InfoRow label="Depreciation" value={detail.equipment.depreciation_method} />{" "}
          </div>
          {/* Maintenance Schedules */}
          <div style={{
        marginBottom: 16
      }}>
            {" "}
            <div style={{
          fontSize: 14,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 8
        }}>
              Maintenance Schedules
            </div>{" "}
            <div style={{
          overflowX: "auto"
        }}>
              {" "}
              <Table className="min-w-[640px]">
                <THead>
                  <TR style={{
                borderBottom: `1px solid ${"#E4E4E7"}`
              }}>
                    <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                      Task
                    </TH>
                    <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                      Interval
                    </TH>
                    <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                      Next Due
                    </TH>
                    <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                      Priority
                    </TH>
                    <TH style={{
                  textAlign: "right",
                  color: "#71717A"
                }}>
                      Est Cost
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {(detail.schedules || []).map(s => {
                const intervals = [];
                if (s.interval_miles) intervals.push(`${fmtN(s.interval_miles)} mi`);
                if (s.interval_hours) intervals.push(`${s.interval_hours} hrs`);
                if (s.interval_days) intervals.push(`${s.interval_days} days`);
                if (s.interval_months) intervals.push(`${s.interval_months} mo`);
                return <TR key={s.id} style={{
                  borderBottom: `1px solid ${"#E4E4E7"}`,
                  background: s.is_overdue ? "rgba(239,68,68,0.1)" : "transparent"
                }}>
                        <TD style={{
                    color: "#27272A"
                  }}>
                          {s.task_name}
                        </TD>
                        <TD style={{
                    color: "#71717A"
                  }}>
                          {intervals.join(" / ") || "--"}
                        </TD>
                        <TD style={{
                    color: s.is_overdue ? "#C8312F" : "#27272A"
                  }}>
                          {s.is_overdue && "OVERDUE "}
                          {s.next_due_at ? new Date(s.next_due_at).toLocaleDateString() : ""}
                          {s.next_due_miles ? ` / ${fmtN(s.next_due_miles)} mi` : ""}
                          {s.next_due_hours ? ` / ${s.next_due_hours} hrs` : ""}
                        </TD>
                        <TD>
                          <Badge tone="neutral">{s.priority}</Badge>
                        </TD>
                        <TD style={{
                    color: "#27272A",
                    textAlign: "right"
                  }}>
                          {s.estimated_cost ? fmt(s.estimated_cost) : "--"}
                        </TD>
                      </TR>;
              })}
                </TBody>
              </Table>{" "}
            </div>{" "}
          </div>
          {/* Action Buttons */}
          <div style={{
        display: "flex",
        gap: 8,
        marginBottom: 16,
        flexWrap: "wrap"
      }}>
            {" "}
            <Button onClick={() => setRecordForm(!recordForm)} type="button" variant="primary" className="min-w-11" disabled={formBusy}>
              {recordForm ? "Cancel" : "Record Maintenance"}
            </Button>
            {eq.category === "vehicle" && <Button onClick={() => setMileageForm(!mileageForm)} type="button" variant="secondary" className="min-w-11" disabled={formBusy}>
                {mileageForm ? "Cancel" : "Log Mileage"}
              </Button>}
          </div>
          {/* Record Maintenance Form */}
          {recordForm && <MaintenanceForm equipmentId={eq.id} schedules={detail.schedules || []} onDone={() => {
        setRecordForm(false);
        setDetail(null);
        loadFleet();
        showToast("Maintenance recorded");
      }} onPendingChange={setFormBusy} />}

          {/* Log Mileage Form */}
          {mileageForm && <MileageForm vehicleId={eq.id} currentMiles={eq.current_miles} onDone={() => {
        setMileageForm(false);
        setMileage(null);
        setDetail(null);
        loadFleet();
        showToast("Mileage logged");
      }} onPendingChange={setFormBusy} />}

          {/* Recent Maintenance History */}
          {(detail.recentRecords || []).length > 0 && <div style={{
        marginBottom: 16
      }}>
              {" "}
              <div style={{
          fontSize: 14,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 8
        }}>
                Maintenance History
              </div>{" "}
              <div style={{
          overflowX: "auto"
        }}>
                {" "}
                <Table className="min-w-[640px]">
                  <THead>
                    <TR style={{
                borderBottom: `1px solid ${"#E4E4E7"}`
              }}>
                      <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                        Date
                      </TH>
                      <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                        Task
                      </TH>
                      <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                        Type
                      </TH>
                      <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                        By
                      </TH>
                      <TH style={{
                  textAlign: "right",
                  color: "#71717A"
                }}>
                        Cost
                      </TH>
                    </TR>
                  </THead>
                  <TBody>
                    {detail.recentRecords.slice(0, 10).map(r => <TR key={r.id} style={{
                borderBottom: `1px solid ${"#E4E4E7"}`
              }}>
                        <TD style={{
                  color: "#27272A"
                }}>
                          {new Date(r.performed_at).toLocaleDateString()}
                        </TD>
                        <TD style={{
                  color: "#27272A"
                }}>
                          {r.task_name}
                        </TD>
                        <TD>
                          <Badge tone="neutral">{r.maintenance_type}</Badge>
                        </TD>
                        <TD style={{
                  color: "#71717A"
                }}>
                          {r.performed_by || r.vendor_name || "--"}
                        </TD>
                        <TD style={{
                  color: "#27272A",
                  textAlign: "right"
                }}>
                          {fmt(r.total_cost)}
                        </TD>
                      </TR>)}
                  </TBody>
                </Table>{" "}
              </div>{" "}
            </div>}

          {/* Cost of Ownership */}
          {detail.costOfOwnership && <Card className="p-4 mb-3">
              {" "}
              <div style={{
          fontSize: 14,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 12
        }}>
                Cost of Ownership
              </div>{" "}
              <div style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)",
          gap: 12,
          fontSize: 14
        }}>
                {" "}
                <div>
                  <div style={{
              color: "#71717A"
            }}>
                    Purchase
                  </div>
                  <div style={{
              color: "#09090B",
              fontWeight: 500
            }}>
                    {fmt(detail.costOfOwnership.purchase_price)}
                  </div>
                </div>{" "}
                <div>
                  <div style={{
              color: "#71717A"
            }}>
                    Total Maintenance
                  </div>
                  <div style={{
              color: "#09090B",
              fontWeight: 500
            }}>
                    {fmt(detail.costOfOwnership.total_maintenance)}
                  </div>
                </div>{" "}
                <div>
                  <div style={{
              color: "#71717A"
            }}>
                    Total Fuel
                  </div>
                  <div style={{
              color: "#09090B",
              fontWeight: 500
            }}>
                    {fmt(detail.costOfOwnership.total_fuel)}
                  </div>
                </div>{" "}
                <div>
                  <div style={{
              color: "#71717A"
            }}>
                    Total Cost
                  </div>
                  <div style={{
              color: "#52525B",
              fontWeight: 500
            }}>
                    {fmt(detail.costOfOwnership.total_cost)}
                  </div>
                </div>{" "}
                <div>
                  <div style={{
              color: "#71717A"
            }}>
                    Monthly Cost
                  </div>
                  <div style={{
              color: "#09090B",
              fontWeight: 500
            }}>
                    {fmt(detail.costOfOwnership.monthly_cost)}
                  </div>
                </div>{" "}
                <div>
                  <div style={{
              color: "#71717A"
            }}>
                    Age
                  </div>
                  <div style={{
              color: "#09090B",
              fontWeight: 500
            }}>
                    {detail.costOfOwnership.age_months} months
                  </div>
                </div>
                {detail.costOfOwnership.cost_per_mile && <div>
                    <div style={{
              color: "#71717A"
            }}>
                      Cost/Mile
                    </div>
                    <div style={{
              color: "#09090B",
              fontWeight: 500
            }}>
                      {fmt(detail.costOfOwnership.cost_per_mile)}
                    </div>
                  </div>}
                {detail.costOfOwnership.total_irs_deduction > 0 && <div>
                    <div style={{
              color: "#71717A"
            }}>
                      IRS Deduction
                    </div>
                    <div style={{
              color: "#18181B",
              fontWeight: 500
            }}>
                      {fmt(detail.costOfOwnership.total_irs_deduction)}
                    </div>
                  </div>}
              </div>{" "}
            </Card>}

          {/* Vehicle Mileage Section */}
          {mileage && mileage.logs && mileage.logs.length > 0 && <div style={{
        marginTop: 12
      }}>
              {" "}
              <div style={{
          fontSize: 14,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 8
        }}>
                Mileage Log (Last 30 Days)
              </div>{" "}
              <div style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 12
        }}>
                {" "}
                <Card style={{
            padding: 12,
            textAlign: "center"
          }} className="p-4 mb-3">
                  {" "}
                  <div style={{
              fontSize: 14,
              color: "#71717A"
            }}>
                    Total Miles
                  </div>{" "}
                  <div style={{
              fontSize: 16,
              fontWeight: 500,
              color: "#09090B"
            }}>
                    {fmtN(Math.round(mileage.summary.total_miles))}
                  </div>{" "}
                </Card>{" "}
                <Card style={{
            padding: 12,
            textAlign: "center"
          }} className="p-4 mb-3">
                  {" "}
                  <div style={{
              fontSize: 14,
              color: "#71717A"
            }}>
                    Business Miles
                  </div>{" "}
                  <div style={{
              fontSize: 16,
              fontWeight: 500,
              color: "#18181B"
            }}>
                    {fmtN(Math.round(mileage.summary.business_miles))}
                  </div>{" "}
                </Card>{" "}
                <Card style={{
            padding: 12,
            textAlign: "center"
          }} className="p-4 mb-3">
                  {" "}
                  <div style={{
              fontSize: 14,
              color: "#71717A"
            }}>
                    Fuel Cost
                  </div>{" "}
                  <div style={{
              fontSize: 16,
              fontWeight: 500,
              color: "#52525B"
            }}>
                    {fmt(mileage.summary.total_fuel_cost)}
                  </div>{" "}
                </Card>{" "}
                <Card style={{
            padding: 12,
            textAlign: "center"
          }} className="p-4 mb-3">
                  {" "}
                  <div style={{
              fontSize: 14,
              color: "#71717A"
            }}>
                    IRS Deduction
                  </div>{" "}
                  <div style={{
              fontSize: 16,
              fontWeight: 500,
              color: "#18181B"
            }}>
                    {fmt(mileage.summary.total_irs_deduction)}
                  </div>{" "}
                </Card>{" "}
              </div>
              {mileage.summary.avg_mpg && <div style={{
          fontSize: 14,
          color: "#71717A",
          marginBottom: 8
        }}>
                  Avg MPG: {mileage.summary.avg_mpg}
                </div>}
              <div style={{
          overflowX: "auto",
          maxHeight: 300,
          overflowY: "auto"
        }}>
                {" "}
                <Table className="min-w-[768px]">
                  <THead>
                    <TR style={{
                borderBottom: `1px solid ${"#E4E4E7"}`,
                position: "sticky",
                top: 0,
                background: "#FFFFFF"
              }}>
                      <TH style={{
                  textAlign: "left",
                  color: "#71717A"
                }}>
                        Date
                      </TH>
                      <TH style={{
                  textAlign: "right",
                  color: "#71717A"
                }}>
                        Miles
                      </TH>
                      <TH style={{
                  textAlign: "right",
                  color: "#71717A"
                }}>
                        Biz %
                      </TH>
                      <TH style={{
                  textAlign: "right",
                  color: "#71717A"
                }}>
                        Fuel
                      </TH>
                      <TH style={{
                  textAlign: "right",
                  color: "#71717A"
                }}>
                        IRS Ded.
                      </TH>
                      <TH style={{
                  textAlign: "right",
                  color: "#71717A"
                }}>
                        Jobs
                      </TH>
                    </TR>
                  </THead>
                  <TBody>
                    {mileage.logs.slice(0, 30).map(l => <TR key={l.id} style={{
                borderBottom: `1px solid ${"#E4E4E7"}`
              }}>
                        <TD style={{
                  color: "#27272A"
                }}>
                          {new Date(l.log_date).toLocaleDateString()}
                        </TD>
                        <TD style={{
                  color: "#27272A",
                  textAlign: "right"
                }}>
                          {l.total_miles}
                        </TD>
                        <TD style={{
                  color: "#71717A",
                  textAlign: "right"
                }}>
                          {l.business_pct}%
                        </TD>
                        <TD style={{
                  color: "#27272A",
                  textAlign: "right"
                }}>
                          {l.fuel_cost ? fmt(l.fuel_cost) : "--"}
                        </TD>
                        <TD style={{
                  color: "#18181B",
                  textAlign: "right"
                }}>
                          {fmt(l.irs_deduction_amount)}
                        </TD>
                        <TD style={{
                  color: "#71717A",
                  textAlign: "right"
                }}>
                          {l.jobs_serviced || "--"}
                        </TD>
                      </TR>)}
                  </TBody>
                </Table>{" "}
              </div>{" "}
            </div>}
        </div>}
    </Card>;
}
function InfoRow({
  label,
  value
}) {
  if (!value) return null;
  return <div style={{
    fontSize: 14
  }}>
      {" "}
      <span style={{
      color: "#71717A"
    }}>
        {label}:{" "}
      </span>{" "}
      <span style={{
      color: "#27272A"
    }}>
        {value}
      </span>{" "}
    </div>;
}

// ═══════════════════════════════════════════════════════════════════
// RECORD MAINTENANCE FORM
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// RECORD MAINTENANCE FORM
// ═══════════════════════════════════════════════════════════════════
function MaintenanceForm({
  equipmentId,
  schedules,
  onDone
}) {
  const isMobile = useIsMobile(768);
  const [form, setForm] = useState({
    scheduleId: "",
    maintenanceType: "scheduled",
    taskName: "",
    description: "",
    performedBy: "",
    vendorName: "",
    milesAtService: "",
    hoursAtService: "",
    conditionBefore: "",
    conditionAfter: "",
    partsCost: "0",
    laborCost: "0",
    vendorCost: "0",
    downtimeHours: "0",
    followUpNeeded: false,
    followUpNotes: "",
    followUpDate: "",
    warrantyClaim: false
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({
    ...p,
    [k]: v
  }));
  const selectSchedule = id => {
    const s = schedules.find(x => x.id === id);
    if (s) set("taskName", s.task_name);
    set("scheduleId", id);
  };
  const submit = async () => {
    if (!form.taskName) return;
    setSaving(true);
    try {
      await af(`/admin/equipment-maintenance/${equipmentId}/records`, {
        method: "POST",
        body: JSON.stringify({
          scheduleId: form.scheduleId || null,
          maintenanceType: form.maintenanceType,
          taskName: form.taskName,
          description: form.description || null,
          performedBy: form.performedBy || null,
          vendorName: form.vendorName || null,
          milesAtService: form.milesAtService ? parseInt(form.milesAtService) : null,
          hoursAtService: form.hoursAtService ? parseFloat(form.hoursAtService) : null,
          conditionBefore: form.conditionBefore ? parseInt(form.conditionBefore) : null,
          conditionAfter: form.conditionAfter ? parseInt(form.conditionAfter) : null,
          partsCost: parseFloat(form.partsCost) || 0,
          laborCost: parseFloat(form.laborCost) || 0,
          vendorCost: parseFloat(form.vendorCost) || 0,
          downtimeHours: parseFloat(form.downtimeHours) || 0,
          followUpNeeded: form.followUpNeeded,
          followUpNotes: form.followUpNotes || null,
          followUpDate: form.followUpDate || null,
          warrantyClaim: form.warrantyClaim
        })
      });
      onDone();
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  };
  return <div style={{
    ...sCard,
    background: "#FAFAFA",
    marginBottom: 16
  }}>
      {" "}
      <div style={{
      fontSize: 14,
      fontWeight: 700,
      color: "#09090B",
      marginBottom: 12
    }}>
        Record Maintenance
      </div>{" "}
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
      gap: 10
    }}>
        {" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Schedule (optional)
          </label>{" "}
          <select value={form.scheduleId} onChange={e => selectSchedule(e.target.value)} style={sInput}>
            {" "}
            <option value="">-- Select schedule --</option>
            {schedules.map(s => <option key={s.id} value={s.id}>
                {s.task_name}
                {s.is_overdue ? " (OVERDUE)" : ""}
              </option>)}
          </select>{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>Type</label>{" "}
          <select value={form.maintenanceType} onChange={e => set("maintenanceType", e.target.value)} style={sInput}>
            {["scheduled", "reactive", "inspection", "repair", "upgrade", "recall"].map(t => <option key={t} value={t}>
                {t}
              </option>)}
          </select>{" "}
        </div>{" "}
        <div style={{
        gridColumn: isMobile ? undefined : "1 / -1"
      }}>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Task Name *
          </label>{" "}
          <input value={form.taskName} onChange={e => set("taskName", e.target.value)} style={sInput} placeholder="e.g. Oil Change" />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Performed By
          </label>{" "}
          <input value={form.performedBy} onChange={e => set("performedBy", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>Vendor</label>{" "}
          <input value={form.vendorName} onChange={e => set("vendorName", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Miles at Service
          </label>{" "}
          <input type="number" value={form.milesAtService} onChange={e => set("milesAtService", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Hours at Service
          </label>{" "}
          <input type="number" step="0.1" value={form.hoursAtService} onChange={e => set("hoursAtService", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Condition Before (1-10)
          </label>{" "}
          <input type="number" min="1" max="10" value={form.conditionBefore} onChange={e => set("conditionBefore", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Condition After (1-10)
          </label>{" "}
          <input type="number" min="1" max="10" value={form.conditionAfter} onChange={e => set("conditionAfter", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Parts Cost
          </label>{" "}
          <input type="number" step="0.01" value={form.partsCost} onChange={e => set("partsCost", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Labor Cost
          </label>{" "}
          <input type="number" step="0.01" value={form.laborCost} onChange={e => set("laborCost", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Vendor Cost
          </label>{" "}
          <input type="number" step="0.01" value={form.vendorCost} onChange={e => set("vendorCost", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Downtime Hours
          </label>{" "}
          <input type="number" step="0.5" value={form.downtimeHours} onChange={e => set("downtimeHours", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div style={{
        display: "flex",
        gap: 16,
        alignItems: "center",
        gridColumn: isMobile ? undefined : "1 / -1"
      }}>
          {" "}
          <label style={{
          fontSize: 12,
          color: "#71717A",
          display: "flex",
          alignItems: "center",
          gap: 4
        }}>
            {" "}
            <input type="checkbox" checked={form.followUpNeeded} onChange={e => set("followUpNeeded", e.target.checked)} />
            Follow-up needed
          </label>{" "}
          <label style={{
          fontSize: 12,
          color: "#71717A",
          display: "flex",
          alignItems: "center",
          gap: 4
        }}>
            {" "}
            <input type="checkbox" checked={form.warrantyClaim} onChange={e => set("warrantyClaim", e.target.checked)} />
            Warranty claim
          </label>{" "}
        </div>
        {form.followUpNeeded && <>
            {" "}
            <div>
              {" "}
              <label style={{
            fontSize: 11,
            color: "#71717A"
          }}>
                Follow-up Date
              </label>{" "}
              <input type="date" value={form.followUpDate} onChange={e => set("followUpDate", e.target.value)} style={sInput} />{" "}
            </div>{" "}
            <div>
              {" "}
              <label style={{
            fontSize: 11,
            color: "#71717A"
          }}>
                Follow-up Notes
              </label>{" "}
              <input value={form.followUpNotes} onChange={e => set("followUpNotes", e.target.value)} style={sInput} />{" "}
            </div>{" "}
          </>}
      </div>{" "}
      <div style={{
      marginTop: 12,
      display: "flex",
      gap: 8
    }}>
        {" "}
        <button onClick={submit} disabled={saving || !form.taskName} style={{
        ...sBtn("#15803D", "#FFFFFF"),
        opacity: saving || !form.taskName ? 0.5 : 1
      }}>
          {saving ? "Saving..." : "Save Record"}
        </button>{" "}
      </div>{" "}
    </div>;
}

// ═══════════════════════════════════════════════════════════════════
// LOG MILEAGE FORM
// ═══════════════════════════════════════════════════════════════════
function MileageForm({
  vehicleId,
  currentMiles,
  onDone
}) {
  const isMobile = useIsMobile(768);
  const today = etDateString();
  const [form, setForm] = useState({
    logDate: today,
    odometerStart: currentMiles || "",
    odometerEnd: "",
    businessMiles: "",
    personalMiles: "0",
    fuelGallons: "",
    fuelCost: "",
    jobsServiced: "",
    loggedBy: "",
    notes: ""
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({
    ...p,
    [k]: v
  }));
  const totalMiles = (parseInt(form.odometerEnd) || 0) - (parseInt(form.odometerStart) || 0);
  const irsDeduction = totalMiles > 0 ? ((totalMiles - parseFloat(form.personalMiles || 0)) * 0.7).toFixed(2) : "0.00";
  const submit = async () => {
    if (!form.odometerStart || !form.odometerEnd) return;
    setSaving(true);
    try {
      await af(`/admin/equipment-maintenance/${vehicleId}/mileage`, {
        method: "POST",
        body: JSON.stringify({
          logDate: form.logDate,
          odometerStart: parseInt(form.odometerStart),
          odometerEnd: parseInt(form.odometerEnd),
          personalMiles: parseFloat(form.personalMiles) || 0,
          fuelGallons: form.fuelGallons ? parseFloat(form.fuelGallons) : null,
          fuelCost: form.fuelCost ? parseFloat(form.fuelCost) : null,
          jobsServiced: form.jobsServiced ? parseInt(form.jobsServiced) : null,
          loggedBy: form.loggedBy || null,
          notes: form.notes || null,
          source: "manual"
        })
      });
      onDone();
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  };
  return <div style={{
    ...sCard,
    background: "#FAFAFA",
    marginBottom: 16
  }}>
      {" "}
      <div style={{
      fontSize: 14,
      fontWeight: 700,
      color: "#09090B",
      marginBottom: 12
    }}>
        Log Mileage
      </div>{" "}
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr",
      gap: 10
    }}>
        {" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>Date</label>{" "}
          <input type="date" value={form.logDate} onChange={e => set("logDate", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Odometer Start
          </label>{" "}
          <input type="number" value={form.odometerStart} onChange={e => set("odometerStart", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Odometer End
          </label>{" "}
          <input type="number" value={form.odometerEnd} onChange={e => set("odometerEnd", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Personal Miles
          </label>{" "}
          <input type="number" step="0.1" value={form.personalMiles} onChange={e => set("personalMiles", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Fuel Gallons
          </label>{" "}
          <input type="number" step="0.01" value={form.fuelGallons} onChange={e => set("fuelGallons", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Fuel Cost ($)
          </label>{" "}
          <input type="number" step="0.01" value={form.fuelCost} onChange={e => set("fuelCost", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>
            Jobs Serviced
          </label>{" "}
          <input type="number" value={form.jobsServiced} onChange={e => set("jobsServiced", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>Logged By</label>{" "}
          <input value={form.loggedBy} onChange={e => set("loggedBy", e.target.value)} style={sInput} />{" "}
        </div>{" "}
        <div>
          {" "}
          <label style={{
          fontSize: 11,
          color: "#71717A"
        }}>Notes</label>{" "}
          <input value={form.notes} onChange={e => set("notes", e.target.value)} style={sInput} />{" "}
        </div>{" "}
      </div>
      {totalMiles > 0 && <div style={{
      marginTop: 10,
      fontSize: 12,
      color: "#71717A"
    }}>
          Total: {totalMiles} miles | Business:{" "}
          {totalMiles - parseFloat(form.personalMiles || 0)} miles | IRS
          Deduction:{" "}
          <span style={{
        color: "#15803D",
        fontWeight: 700
      }}>
            ${irsDeduction}
          </span>{" "}
        </div>}
      <div style={{
      marginTop: 12
    }}>
        {" "}
        <button onClick={submit} disabled={saving || totalMiles <= 0} style={{
        ...sBtn("#18181B", "#FFFFFF"),
        opacity: saving || totalMiles <= 0 ? 0.5 : 1
      }}>
          {saving ? "Saving..." : "Save Mileage"}
        </button>{" "}
      </div>{" "}
    </div>;
}

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ═══════════════════════════════════════════════════════════════════
function AnalyticsTab({
  costs,
  reliability,
  mileageSummary,
  dueSchedules,
  monthlyCosts,
  overview
}) {
  return <>
      {/* Cost of Ownership Table */}
      <div style={{
      ...sCard,
      marginBottom: 16
    }}>
        {" "}
        <div style={{
        fontSize: 16,
        fontWeight: 700,
        color: "#09090B",
        marginBottom: 12
      }}>
          Cost of Ownership
        </div>{" "}
        <div style={{
        overflowX: "auto"
      }}>
          <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12
        }}>
            <thead>
              <tr style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                  Equipment
                </th>
                <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                  Category
                </th>
                <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                  Age (mo)
                </th>
                <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                  Purchase
                </th>
                <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                  Maintenance
                </th>
                <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                  Monthly
                </th>
                <th style={{
                textAlign: "center",
                padding: "8px",
                color: "#71717A"
              }}>
                  Condition
                </th>
              </tr>
            </thead>
            <tbody>
              {costs.map(c => <tr key={c.equipment_id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                  <td style={{
                padding: "8px",
                color: "#27272A"
              }}>
                    <EquipmentCategoryIcon category={c.category} /> {c.equipment_name}
                    {c.asset_tag && <span style={{
                  color: "#71717A",
                  fontSize: 10,
                  marginLeft: 6
                }}>
                        {c.asset_tag}
                      </span>}
                  </td>
                  <td style={{
                padding: "8px",
                color: "#71717A"
              }}>
                    {c.category}
                  </td>
                  <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                    {c.age_months}
                  </td>
                  <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                    {fmt(c.purchase_price)}
                  </td>
                  <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                    {fmt(c.total_maintenance)}
                  </td>
                  <td style={{
                padding: "8px",
                color: "#A16207",
                textAlign: "right",
                fontWeight: 500
              }}>
                    {fmt(c.monthly_cost)}
                  </td>
                  <td style={{
                padding: "8px"
              }}>
                    <ConditionBar rating={c.condition_rating} />
                  </td>
                </tr>)}
            </tbody>
            {costs.length > 0 && <tfoot>
                <tr style={{
              borderTop: `2px solid ${"#E4E4E7"}`
            }}>
                  <td style={{
                padding: "8px",
                color: "#09090B",
                fontWeight: 700
              }} colSpan={3}>
                    Totals
                  </td>
                  <td style={{
                padding: "8px",
                color: "#09090B",
                fontWeight: 700,
                textAlign: "right"
              }}>
                    {fmt(costs.reduce((s, c) => s + c.purchase_price, 0))}
                  </td>
                  <td style={{
                padding: "8px",
                color: "#09090B",
                fontWeight: 700,
                textAlign: "right"
              }}>
                    {fmt(costs.reduce((s, c) => s + c.total_maintenance, 0))}
                  </td>
                  <td style={{
                padding: "8px",
                color: "#A16207",
                fontWeight: 700,
                textAlign: "right"
              }}>
                    {fmt(costs.reduce((s, c) => s + c.monthly_cost, 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>}
          </table>
        </div>{" "}
      </div>
      {/* Monthly Cost Trend - SVG Bar Chart */}
      {monthlyCosts.length > 0 && <div style={{
      ...sCard,
      marginBottom: 16
    }}>
          {" "}
          <div style={{
        fontSize: 16,
        fontWeight: 700,
        color: "#09090B",
        marginBottom: 12
      }}>
            Maintenance Cost Trend (Last 6 Months)
          </div>{" "}
          <CostBarChart data={monthlyCosts} />{" "}
        </div>}

      {/* Reliability Ranking */}
      {reliability.length > 0 && <div style={{
      ...sCard,
      marginBottom: 16
    }}>
          {" "}
          <div style={{
        fontSize: 16,
        fontWeight: 700,
        color: "#09090B",
        marginBottom: 12
      }}>
            Reliability Ranking (Downtime Hours)
          </div>{" "}
          <div style={{
        overflowX: "auto"
      }}>
            {" "}
            <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12
        }}>
              {" "}
              <thead>
                {" "}
                <tr style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                  {" "}
                  <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                    Equipment
                  </th>{" "}
                  <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                    Incidents
                  </th>{" "}
                  <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                    Downtime (hrs)
                  </th>{" "}
                  <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                    Jobs Affected
                  </th>{" "}
                  <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                    Revenue Impact
                  </th>{" "}
                </tr>{" "}
              </thead>{" "}
              <tbody>
                {reliability.map(r => <tr key={r.id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                    {" "}
                    <td style={{
                padding: "8px",
                color: "#27272A"
              }}>
                      <EquipmentCategoryIcon category={r.category} /> {r.name}{" "}
                      <span style={{
                  color: "#71717A",
                  fontSize: 10
                }}>
                        {r.asset_tag}
                      </span>
                    </td>{" "}
                    <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                      {r.incident_count}
                    </td>{" "}
                    <td style={{
                padding: "8px",
                color: "#991B1B",
                textAlign: "right",
                fontWeight: 500
              }}>
                      {parseFloat(r.total_downtime_hours).toFixed(1)}
                    </td>{" "}
                    <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                      {r.total_jobs_affected}
                    </td>{" "}
                    <td style={{
                padding: "8px",
                color: "#A16207",
                textAlign: "right"
              }}>
                      {fmt(r.total_revenue_impact)}
                    </td>{" "}
                  </tr>)}
              </tbody>{" "}
            </table>{" "}
          </div>{" "}
        </div>}

      {/* Fleet Mileage Summary */}
      {mileageSummary && mileageSummary.vehicles && mileageSummary.vehicles.length > 0 && <div style={{
      ...sCard,
      marginBottom: 16
    }}>
            {" "}
            <div style={{
        fontSize: 16,
        fontWeight: 700,
        color: "#09090B",
        marginBottom: 12
      }}>
              Fleet Mileage Summary ({mileageSummary.year})
            </div>{" "}
            <div style={{
        overflowX: "auto"
      }}>
              {" "}
              <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12
        }}>
                {" "}
                <thead>
                  {" "}
                  <tr style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                    {" "}
                    <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                      Vehicle
                    </th>{" "}
                    <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                      Total Miles
                    </th>{" "}
                    <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                      Business Miles
                    </th>{" "}
                    <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                      Fuel Cost
                    </th>{" "}
                    <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                      IRS Deduction
                    </th>{" "}
                    <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                      Jobs
                    </th>{" "}
                  </tr>{" "}
                </thead>{" "}
                <tbody>
                  {mileageSummary.vehicles.map(v => <tr key={v.id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                      {" "}
                      <td style={{
                padding: "8px",
                color: "#27272A"
              }}>
                        {v.name}{" "}
                        <span style={{
                  color: "#71717A",
                  fontSize: 10
                }}>
                          {v.asset_tag}
                        </span>
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                        {fmtN(Math.round(parseFloat(v.total_miles)))}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#18181B",
                textAlign: "right"
              }}>
                        {fmtN(Math.round(parseFloat(v.business_miles)))}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#A16207",
                textAlign: "right"
              }}>
                        {fmt(v.total_fuel_cost)}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#15803D",
                textAlign: "right",
                fontWeight: 700
              }}>
                        {fmt(v.total_irs_deduction)}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                        {v.total_jobs}
                      </td>{" "}
                    </tr>)}
                </tbody>
                {mileageSummary.fleet_totals && <tfoot>
                    {" "}
                    <tr style={{
              borderTop: `2px solid ${"#E4E4E7"}`
            }}>
                      {" "}
                      <td style={{
                padding: "8px",
                color: "#09090B",
                fontWeight: 700
              }}>
                        Fleet Totals
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#09090B",
                fontWeight: 700,
                textAlign: "right"
              }}>
                        {fmtN(Math.round(mileageSummary.fleet_totals.total_miles))}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#18181B",
                fontWeight: 700,
                textAlign: "right"
              }}>
                        {fmtN(Math.round(mileageSummary.fleet_totals.business_miles))}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#A16207",
                fontWeight: 700,
                textAlign: "right"
              }}>
                        {fmt(mileageSummary.fleet_totals.total_fuel_cost)}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#15803D",
                fontWeight: 700,
                textAlign: "right"
              }}>
                        {fmt(mileageSummary.fleet_totals.total_irs_deduction)}
                      </td>{" "}
                      <td style={{
                padding: "8px",
                color: "#09090B",
                fontWeight: 700,
                textAlign: "right"
              }}>
                        {mileageSummary.fleet_totals.total_jobs}
                      </td>{" "}
                    </tr>{" "}
                  </tfoot>}
              </table>{" "}
            </div>{" "}
          </div>}

      {/* Upcoming Maintenance (Next 30 Days) */}
      {dueSchedules.length > 0 && <div style={{
      ...sCard
    }}>
          {" "}
          <div style={{
        fontSize: 16,
        fontWeight: 700,
        color: "#09090B",
        marginBottom: 12
      }}>
            Upcoming Maintenance (Next 30 Days)
          </div>{" "}
          <div style={{
        overflowX: "auto"
      }}>
            {" "}
            <table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12
        }}>
              {" "}
              <thead>
                {" "}
                <tr style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                  {" "}
                  <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                    Equipment
                  </th>{" "}
                  <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                    Task
                  </th>{" "}
                  <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                    Due
                  </th>{" "}
                  <th style={{
                textAlign: "left",
                padding: "8px",
                color: "#71717A"
              }}>
                    Priority
                  </th>{" "}
                  <th style={{
                textAlign: "right",
                padding: "8px",
                color: "#71717A"
              }}>
                    Est Cost
                  </th>{" "}
                </tr>{" "}
              </thead>{" "}
              <tbody>
                {dueSchedules.map(s => <tr key={s.id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`,
              background: s.is_overdue ? "rgba(239,68,68,0.08)" : "transparent"
            }}>
                    {" "}
                    <td style={{
                padding: "8px",
                color: "#27272A"
              }}>
                      <EquipmentCategoryIcon category={s.category} /> {s.equipment_name}
                      {s.asset_tag && <span style={{
                  color: "#71717A",
                  fontSize: 10,
                  marginLeft: 4
                }}>
                          {s.asset_tag}
                        </span>}
                    </td>{" "}
                    <td style={{
                padding: "8px",
                color: "#27272A"
              }}>
                      {s.task_name}
                    </td>{" "}
                    <td style={{
                padding: "8px",
                color: s.is_overdue ? "#991B1B" : "#27272A"
              }}>
                      {s.is_overdue && <span style={{
                  ...sBadge("#991B1B", "#FFFFFF"),
                  marginRight: 4
                }}>
                          OVERDUE
                        </span>}
                      {s.next_due_at ? new Date(s.next_due_at).toLocaleDateString() : "--"}
                    </td>{" "}
                    <td style={{
                padding: "8px"
              }}>
                      {" "}
                      <span style={sBadge(s.priority === "critical" ? "#991B1B" : s.priority === "high" ? "#f97316" : "#18181B", "#FFFFFF")}>
                        {s.priority}
                      </span>{" "}
                    </td>{" "}
                    <td style={{
                padding: "8px",
                color: "#27272A",
                textAlign: "right"
              }}>
                      {s.estimated_cost ? fmt(s.estimated_cost) : "--"}
                    </td>{" "}
                  </tr>)}
              </tbody>{" "}
            </table>{" "}
          </div>{" "}
        </div>}
    </>;
}

// ═══════════════════════════════════════════════════════════════════
// SVG BAR CHART
// ═══════════════════════════════════════════════════════════════════
function CostBarChart({
  data
}) {
  if (!data || data.length === 0) return null;
  const maxCost = Math.max(...data.map(d => d.cost), 1);
  const w = 600;
  const h = 200;
  const barW = Math.min(60, (w - 40) / data.length - 10);
  const xStep = (w - 40) / data.length;
  return <svg viewBox={`0 0 ${w} ${h + 30}`} style={{
    width: "100%",
    maxWidth: 600,
    height: "auto"
  }}>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(pct => {
      const y = h - pct * (h - 20);
      return <g key={pct}>
            {" "}
            <line x1={30} y1={y} x2={w} y2={y} stroke={"#E4E4E7"} strokeWidth={0.5} />{" "}
            <text x={28} y={y + 4} fill={"#71717A"} fontSize={9} textAnchor="end">
              {fmt(maxCost * pct)}
            </text>{" "}
          </g>;
    })}
      {/* Bars */}
      {data.map((d, i) => {
      const barH = d.cost / maxCost * (h - 20);
      const x = 40 + i * xStep + (xStep - barW) / 2;
      const y = h - barH;
      return <g key={d.month}>
            {" "}
            <rect x={x} y={y} width={barW} height={barH} rx={4} fill={"#18181B"} opacity={0.8} />{" "}
            <text x={x + barW / 2} y={h + 14} fill={"#71717A"} fontSize={10} textAnchor="middle">
              {d.month.slice(5)}
            </text>{" "}
            <text x={x + barW / 2} y={y - 4} fill={"#27272A"} fontSize={9} textAnchor="middle">
              {fmt(d.cost)}
            </text>{" "}
          </g>;
    })}
    </svg>;
}
