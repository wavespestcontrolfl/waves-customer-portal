import { Button, Field, Select, Badge, Card, ActionFeedback, Table, THead, TBody, TR, TH, TD, Input, Checkbox } from "../../components/ui";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import useIsMobile from "../../hooks/useIsMobile";
import { BarChart3, Truck, Wrench, Droplets, Cog, RotateCw, Syringe, Leaf, ShieldCheck } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { etDateString, formatETDate, formatETDateOnly } from "../../lib/timezone";
const API = import.meta.env.VITE_API_URL || "/api";
// Alert severity → shared Badge tone. Critical and high are genuine alerts
// (alert tone); medium stays prominent (strong); low is informational (neutral).
const SEVERITY_TONES = {
  critical: "alert",
  high: "alert",
  medium: "strong",
  low: "neutral"
};

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
  return <Icon size={size} role="img" aria-label={category || "equipment"} className="inline-block shrink-0 align-middle" />;
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
function hasFleetData(overview, equipment, alerts) {
  return overview != null || equipment.length > 0 || alerts.length > 0;
}
function FleetLoadError({
  loaded,
  error,
  onRetry
}) {
  return <ActionFeedback error onRetry={onRetry} className="mb-4">
      {loaded ? "Could not refresh fleet: " : "Could not load fleet: "}
      {error}
      {loaded && ". Showing previously loaded data."}
    </ActionFeedback>;
}
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
  const fleetLoaded = hasFleetData(overview, equipment, alerts);
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
      {tab === "fleet" && fleetError && <FleetLoadError loaded={fleetLoaded} error={fleetError} onRetry={loadFleet} />}
      {analyticsError && tab === "analytics" && <ActionFeedback error onRetry={loadAnalytics} className="mb-4">
          Could not load analytics: {analyticsError}
        </ActionFeedback>}
      {tab === "fleet" && (!fleetError || fleetLoaded) && <FleetTab {...{
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
              <Badge tone={SEVERITY_TONES[a.severity] || "neutral"}>{a.severity}</Badge>{" "}
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
        <Select aria-label="Category" value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{
          width: "auto",
          minWidth: 140
        }}>
            {" "}
            <option value="">All Categories</option>
            {categories.map(c => <option key={c} value={c}>
                {c}
              </option>)}
          </Select>{" "}
        <Select aria-label="Status" value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{
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
          </Select>{" "}
        <Select aria-label="Sort by" value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
          width: "auto",
          minWidth: 130
        }}>
            {" "}
            <option value="name">Sort: Name</option>{" "}
            <option value="condition">Sort: Condition</option>{" "}
            <option value="cost">Sort: Cost</option>{" "}
          </Select>{" "}
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
  const [openForm, setOpenForm] = useState(null);
  const recordForm = openForm === "record";
  const mileageForm = openForm === "mileage";
  const toggleForm = name => setOpenForm(current => current === name ? null : name);
  useEffect(() => {
    if (isExpanded && !detail) {
      Promise.all([af(`/admin/equipment-maintenance/${eq.id}`), eq.category === "vehicle" ? af(`/admin/equipment-maintenance/${eq.id}/mileage?limit=30`) : Promise.resolve(null)]).then(([d, m]) => {
        setDetail(d);
        setMileage(m);
      }).catch(console.error);
    }
  }, [isExpanded, eq.id, eq.category, detail]);
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
    }} variant="secondary" className="!h-auto w-full text-left whitespace-normal" aria-expanded={isExpanded} aria-controls={`equipment-detail-${eq.id}`} disabled={formBusy}>
        <span className="sr-only">{isExpanded ? "Collapse" : "Expand"} </span>
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
            <Badge tone={eq.status === "lost" ? "alert" : "neutral"}>{eq.status}</Badge>{" "}
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
                {nm.next_due_at && <span>({formatETDateOnly(nm.next_due_at)})</span>}
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
            <InfoRow label="Purchase Date" value={detail.equipment.purchase_date ? formatETDateOnly(detail.equipment.purchase_date) : null} />{" "}
            <InfoRow label="Purchase Price" value={detail.equipment.purchase_price ? fmt(detail.equipment.purchase_price) : null} />{" "}
            <InfoRow label="Warranty" value={detail.equipment.warranty_expiration ? `Expires ${formatETDateOnly(detail.equipment.warranty_expiration)}` : null} />{" "}
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
                        <TD className="whitespace-nowrap" style={{
                    color: s.is_overdue ? "#C8312F" : "#27272A"
                  }}>
                          {s.is_overdue && "OVERDUE "}
                          {s.next_due_at ? formatETDateOnly(s.next_due_at) : ""}
                          {s.next_due_miles ? ` / ${fmtN(s.next_due_miles)} mi` : ""}
                          {s.next_due_hours ? ` / ${s.next_due_hours} hrs` : ""}
                        </TD>
                        <TD>
                          <Badge tone={SEVERITY_TONES[s.priority] || "neutral"}>{s.priority}</Badge>
                        </TD>
                        <TD className="whitespace-nowrap" style={{
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
            <Button onClick={() => toggleForm("record")} type="button" variant="primary" className="min-w-11" disabled={formBusy}>
              {recordForm ? "Cancel" : "Record Maintenance"}
            </Button>
            {eq.category === "vehicle" && <Button onClick={() => toggleForm("mileage")} type="button" variant="secondary" className="min-w-11" disabled={formBusy}>
                {mileageForm ? "Cancel" : "Log Mileage"}
              </Button>}
          </div>
          {/* Record Maintenance Form */}
          {recordForm && <MaintenanceForm equipmentId={eq.id} schedules={detail.schedules || []} onDone={() => {
        setOpenForm(null);
        setDetail(null);
        loadFleet();
        showToast("Maintenance recorded");
      }} onPendingChange={setFormBusy} />}

          {/* Log Mileage Form */}
          {mileageForm && <MileageForm vehicleId={eq.id} currentMiles={eq.current_miles} onDone={() => {
        setOpenForm(null);
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
                        <TD className="whitespace-nowrap" style={{
                  color: "#27272A"
                }}>
                          {formatETDate(r.performed_at)}
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
                        <TD className="whitespace-nowrap" style={{
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
                <Table className="min-w-[768px]" overflow="visible">
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
                        <TD className="whitespace-nowrap" style={{
                  color: "#27272A"
                }}>
                          {formatETDateOnly(l.log_date)}
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
                        <TD className="whitespace-nowrap" style={{
                  color: "#27272A",
                  textAlign: "right"
                }}>
                          {l.fuel_cost ? fmt(l.fuel_cost) : "--"}
                        </TD>
                        <TD className="whitespace-nowrap" style={{
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
export function MaintenanceForm({
  equipmentId,
  schedules,
  onDone,
  onPendingChange
}) {
  const actionRef = useRef(false);
  const [actionError, setActionError] = useState("");
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
  useEffect(() => {
    onPendingChange?.(saving);
    return () => onPendingChange?.(false);
  }, [saving, onPendingChange]);
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
    if (actionRef.current) return;
    actionRef.current = true;
    setActionError("");
    try {
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
        setActionError(`Save failed: ${e.message || "Request failed"}`);
      }
      setSaving(false);
    } finally {
      actionRef.current = false;
    }
  };
  return <Card style={{
    marginBottom: 16
  }} className="p-4 mb-3">
      {actionError && <ActionFeedback error className="mb-4">
          {actionError}
        </ActionFeedback>}{" "}
      <h2 style={{
      fontSize: 18,
      fontWeight: 500,
      color: "#09090B",
      marginBottom: 12
    }}>
        Record Maintenance
      </h2>{" "}
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
      gap: 10
    }}>
        {" "}
        <div>
          {" "}
          <Field label="Schedule (optional)" className="min-w-0">
            <Select value={form.scheduleId} onChange={e => selectSchedule(e.target.value)} disabled={saving}>
              {" "}
              <option value="">-- Select schedule --</option>
              {schedules.map(s => <option key={s.id} value={s.id}>
                  {s.task_name}
                  {s.is_overdue ? " (OVERDUE)" : ""}
                </option>)}
            </Select>
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Type" className="min-w-0">
            <Select value={form.maintenanceType} onChange={e => set("maintenanceType", e.target.value)} disabled={saving}>
              {["scheduled", "reactive", "inspection", "repair", "upgrade", "recall"].map(t => <option key={t} value={t}>
                  {t}
                </option>)}
            </Select>
          </Field>{" "}
        </div>{" "}
        <div style={{
        gridColumn: isMobile ? undefined : "1 / -1"
      }}>
          {" "}
          <Field label="Task Name *" className="min-w-0">
            <Input value={form.taskName} onChange={e => set("taskName", e.target.value)} placeholder="e.g. Oil Change" disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Performed By" className="min-w-0">
            <Input value={form.performedBy} onChange={e => set("performedBy", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Vendor" className="min-w-0">
            <Input value={form.vendorName} onChange={e => set("vendorName", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Miles at Service" className="min-w-0">
            <Input type="number" value={form.milesAtService} onChange={e => set("milesAtService", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Hours at Service" className="min-w-0">
            <Input type="number" step="0.1" value={form.hoursAtService} onChange={e => set("hoursAtService", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Condition Before (1-10)" className="min-w-0">
            <Input type="number" min="1" max="10" value={form.conditionBefore} onChange={e => set("conditionBefore", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Condition After (1-10)" className="min-w-0">
            <Input type="number" min="1" max="10" value={form.conditionAfter} onChange={e => set("conditionAfter", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Parts Cost" className="min-w-0">
            <Input type="number" step="0.01" value={form.partsCost} onChange={e => set("partsCost", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Labor Cost" className="min-w-0">
            <Input type="number" step="0.01" value={form.laborCost} onChange={e => set("laborCost", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Vendor Cost" className="min-w-0">
            <Input type="number" step="0.01" value={form.vendorCost} onChange={e => set("vendorCost", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Downtime Hours" className="min-w-0">
            <Input type="number" step="0.5" value={form.downtimeHours} onChange={e => set("downtimeHours", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div style={{
        display: "flex",
        gap: 16,
        alignItems: "center",
        gridColumn: isMobile ? undefined : "1 / -1"
      }}>
          {" "}
          <label style={{
          fontSize: 14,
          color: "#71717A",
          display: "flex",
          alignItems: "center",
          gap: 4
        }} className="ui-choice-label">
            {" "}
            <Checkbox type="checkbox" checked={form.followUpNeeded} onChange={e => set("followUpNeeded", e.target.checked)} disabled={saving} />
            Follow-up needed
          </label>{" "}
          <label style={{
          fontSize: 14,
          color: "#71717A",
          display: "flex",
          alignItems: "center",
          gap: 4
        }} className="ui-choice-label">
            {" "}
            <Checkbox type="checkbox" checked={form.warrantyClaim} onChange={e => set("warrantyClaim", e.target.checked)} disabled={saving} />
            Warranty claim
          </label>{" "}
        </div>
        {form.followUpNeeded && <>
            {" "}
            <div>
              {" "}
              <Field label="Follow-up Date" className="min-w-0">
                <Input type="date" value={form.followUpDate} onChange={e => set("followUpDate", e.target.value)} disabled={saving} />
              </Field>{" "}
            </div>{" "}
            <div>
              {" "}
              <Field label="Follow-up Notes" className="min-w-0">
                <Input value={form.followUpNotes} onChange={e => set("followUpNotes", e.target.value)} disabled={saving} />
              </Field>{" "}
            </div>{" "}
          </>}
      </div>{" "}
      <div style={{
      marginTop: 12,
      display: "flex",
      gap: 8
    }}>
        {" "}
        <Button onClick={submit} disabled={saving || !form.taskName} type="button" variant="primary" loading={saving} className="min-w-11">
          {"Save Record"}
        </Button>{" "}
      </div>{" "}
    </Card>;
}

// ═══════════════════════════════════════════════════════════════════
// LOG MILEAGE FORM
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// LOG MILEAGE FORM
// ═══════════════════════════════════════════════════════════════════
export function MileageForm({
  vehicleId,
  currentMiles,
  onDone,
  onPendingChange
}) {
  const actionRef = useRef(false);
  const [actionError, setActionError] = useState("");
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
  useEffect(() => {
    onPendingChange?.(saving);
    return () => onPendingChange?.(false);
  }, [saving, onPendingChange]);
  const set = (k, v) => setForm(p => ({
    ...p,
    [k]: v
  }));
  const totalMiles = (parseInt(form.odometerEnd) || 0) - (parseInt(form.odometerStart) || 0);
  const irsDeduction = totalMiles > 0 ? ((totalMiles - parseFloat(form.personalMiles || 0)) * 0.7).toFixed(2) : "0.00";
  const submit = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionError("");
    try {
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
        setActionError(`Save failed: ${e.message || "Request failed"}`);
      }
      setSaving(false);
    } finally {
      actionRef.current = false;
    }
  };
  return <Card style={{
    marginBottom: 16
  }} className="p-4 mb-3">
      {actionError && <ActionFeedback error className="mb-4">
          {actionError}
        </ActionFeedback>}{" "}
      <h2 style={{
      fontSize: 18,
      fontWeight: 500,
      color: "#09090B",
      marginBottom: 12
    }}>
        Log Mileage
      </h2>{" "}
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr",
      gap: 10
    }}>
        {" "}
        <div>
          {" "}
          <Field label="Date" className="min-w-0">
            <Input type="date" value={form.logDate} onChange={e => set("logDate", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Odometer Start" className="min-w-0">
            <Input type="number" value={form.odometerStart} onChange={e => set("odometerStart", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Odometer End" className="min-w-0">
            <Input type="number" value={form.odometerEnd} onChange={e => set("odometerEnd", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Personal Miles" className="min-w-0">
            <Input type="number" step="0.1" value={form.personalMiles} onChange={e => set("personalMiles", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Fuel Gallons" className="min-w-0">
            <Input type="number" step="0.01" value={form.fuelGallons} onChange={e => set("fuelGallons", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Fuel Cost ($)" className="min-w-0">
            <Input type="number" step="0.01" value={form.fuelCost} onChange={e => set("fuelCost", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Jobs Serviced" className="min-w-0">
            <Input type="number" value={form.jobsServiced} onChange={e => set("jobsServiced", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Logged By" className="min-w-0">
            <Input value={form.loggedBy} onChange={e => set("loggedBy", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
        <div>
          {" "}
          <Field label="Notes" className="min-w-0">
            <Input value={form.notes} onChange={e => set("notes", e.target.value)} disabled={saving} />
          </Field>{" "}
        </div>{" "}
      </div>
      {totalMiles > 0 && <div style={{
      marginTop: 10,
      fontSize: 14,
      color: "#71717A"
    }}>
          Total: {totalMiles} miles | Business:{" "}
          {totalMiles - parseFloat(form.personalMiles || 0)} miles | IRS
          Deduction:{" "}
          <span style={{
        color: "#18181B",
        fontWeight: 500
      }}>
            ${irsDeduction}
          </span>{" "}
        </div>}
      <div style={{
      marginTop: 12
    }}>
        {" "}
        <Button onClick={submit} disabled={saving || totalMiles <= 0} type="button" variant="primary" loading={saving} className="min-w-11">
          {"Save Mileage"}
        </Button>{" "}
      </div>{" "}
    </Card>;
}

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ═══════════════════════════════════════════════════════════════════
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
      <Card style={{
      marginBottom: 16
    }} className="p-4 mb-3">
        {" "}
        <div style={{
        fontSize: 16,
        fontWeight: 500,
        color: "#09090B",
        marginBottom: 12
      }}>
          Cost of Ownership
        </div>{" "}
        <div style={{
        overflowX: "auto"
      }}>
          <Table className="min-w-[840px]">
            <THead>
              <TR style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                <TH style={{
                textAlign: "left",
                color: "#71717A"
              }}>
                  Equipment
                </TH>
                <TH style={{
                textAlign: "left",
                color: "#71717A"
              }}>
                  Category
                </TH>
                <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                  Age (mo)
                </TH>
                <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                  Purchase
                </TH>
                <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                  Maintenance
                </TH>
                <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                  Monthly
                </TH>
                <TH style={{
                textAlign: "center",
                color: "#71717A"
              }}>
                  Condition
                </TH>
              </TR>
            </THead>
            <TBody>
              {costs.map(c => <TR key={c.equipment_id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                  <TD style={{
                color: "#27272A"
              }}>
                    <EquipmentCategoryIcon category={c.category} />{" "}
                    {c.equipment_name}
                    {c.asset_tag && <span style={{
                  color: "#71717A",
                  fontSize: 14,
                  marginLeft: 6
                }}>
                        {c.asset_tag}
                      </span>}
                  </TD>
                  <TD style={{
                color: "#71717A"
              }}>
                    {c.category}
                  </TD>
                  <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                    {c.age_months}
                  </TD>
                  <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                    {fmt(c.purchase_price)}
                  </TD>
                  <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                    {fmt(c.total_maintenance)}
                  </TD>
                  <TD style={{
                color: "#52525B",
                textAlign: "right"
              }}>
                    {fmt(c.monthly_cost)}
                  </TD>
                  <TD>
                    <ConditionBar rating={c.condition_rating} />
                  </TD>
                </TR>)}
            </TBody>
            {costs.length > 0 && <tfoot>
                <TR style={{
              borderTop: `2px solid ${"#E4E4E7"}`
            }}>
                  <TD style={{
                color: "#09090B"
              }} colSpan={3}>
                    Totals
                  </TD>
                  <TD style={{
                color: "#09090B",
                textAlign: "right"
              }}>
                    {fmt(costs.reduce((s, c) => s + c.purchase_price, 0))}
                  </TD>
                  <TD style={{
                color: "#09090B",
                textAlign: "right"
              }}>
                    {fmt(costs.reduce((s, c) => s + c.total_maintenance, 0))}
                  </TD>
                  <TD style={{
                color: "#52525B",
                textAlign: "right"
              }}>
                    {fmt(costs.reduce((s, c) => s + c.monthly_cost, 0))}
                  </TD>
                  <TD />
                </TR>
              </tfoot>}
          </Table>
        </div>{" "}
      </Card>
      {/* Monthly Cost Trend - SVG Bar Chart */}
      {monthlyCosts.length > 0 && <Card style={{
      marginBottom: 16
    }} className="p-4 mb-3">
          {" "}
          <div style={{
        fontSize: 16,
        fontWeight: 500,
        color: "#09090B",
        marginBottom: 12
      }}>
            Maintenance Cost Trend (Last 6 Months)
          </div>{" "}
          <CostBarChart data={monthlyCosts} />{" "}
        </Card>}

      {/* Reliability Ranking */}
      {reliability.length > 0 && <Card style={{
      marginBottom: 16
    }} className="p-4 mb-3">
          {" "}
          <div style={{
        fontSize: 16,
        fontWeight: 500,
        color: "#09090B",
        marginBottom: 12
      }}>
            Reliability Ranking (Downtime Hours)
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
                    Equipment
                  </TH>
                  <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                    Incidents
                  </TH>
                  <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                    Downtime (hrs)
                  </TH>
                  <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                    Jobs Affected
                  </TH>
                  <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                    Revenue Impact
                  </TH>
                </TR>
              </THead>
              <TBody>
                {reliability.map(r => <TR key={r.id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                    <TD style={{
                color: "#27272A"
              }}>
                      <EquipmentCategoryIcon category={r.category} /> {r.name}{" "}
                      <span style={{
                  color: "#71717A",
                  fontSize: 14
                }}>
                        {r.asset_tag}
                      </span>
                    </TD>
                    <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                      {r.incident_count}
                    </TD>
                    <TD style={{
                color: "#C8312F",
                textAlign: "right"
              }}>
                      {parseFloat(r.total_downtime_hours).toFixed(1)}
                    </TD>
                    <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                      {r.total_jobs_affected}
                    </TD>
                    <TD style={{
                color: "#52525B",
                textAlign: "right"
              }}>
                      {fmt(r.total_revenue_impact)}
                    </TD>
                  </TR>)}
              </TBody>
            </Table>{" "}
          </div>{" "}
        </Card>}

      {/* Fleet Mileage Summary */}
      {mileageSummary && mileageSummary.vehicles && mileageSummary.vehicles.length > 0 && <Card style={{
      marginBottom: 16
    }} className="p-4 mb-3">
            {" "}
            <div style={{
        fontSize: 16,
        fontWeight: 500,
        color: "#09090B",
        marginBottom: 12
      }}>
              Fleet Mileage Summary ({mileageSummary.year})
            </div>{" "}
            <div style={{
        overflowX: "auto"
      }}>
              {" "}
              <Table className="min-w-[768px]">
                <THead>
                  <TR style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                    <TH style={{
                textAlign: "left",
                color: "#71717A"
              }}>
                      Vehicle
                    </TH>
                    <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                      Total Miles
                    </TH>
                    <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                      Business Miles
                    </TH>
                    <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                      Fuel Cost
                    </TH>
                    <TH style={{
                textAlign: "right",
                color: "#71717A"
              }}>
                      IRS Deduction
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
                  {mileageSummary.vehicles.map(v => <TR key={v.id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`
            }}>
                      <TD style={{
                color: "#27272A"
              }}>
                        {v.name}{" "}
                        <span style={{
                  color: "#71717A",
                  fontSize: 14
                }}>
                          {v.asset_tag}
                        </span>
                      </TD>
                      <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                        {fmtN(Math.round(parseFloat(v.total_miles)))}
                      </TD>
                      <TD style={{
                color: "#18181B",
                textAlign: "right"
              }}>
                        {fmtN(Math.round(parseFloat(v.business_miles)))}
                      </TD>
                      <TD style={{
                color: "#52525B",
                textAlign: "right"
              }}>
                        {fmt(v.total_fuel_cost)}
                      </TD>
                      <TD style={{
                color: "#18181B",
                textAlign: "right"
              }}>
                        {fmt(v.total_irs_deduction)}
                      </TD>
                      <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                        {v.total_jobs}
                      </TD>
                    </TR>)}
                </TBody>
                {mileageSummary.fleet_totals && <tfoot>
                    <TR style={{
              borderTop: `2px solid ${"#E4E4E7"}`
            }}>
                      <TD style={{
                color: "#09090B"
              }}>
                        Fleet Totals
                      </TD>
                      <TD style={{
                color: "#09090B",
                textAlign: "right"
              }}>
                        {fmtN(Math.round(mileageSummary.fleet_totals.total_miles))}
                      </TD>
                      <TD style={{
                color: "#18181B",
                textAlign: "right"
              }}>
                        {fmtN(Math.round(mileageSummary.fleet_totals.business_miles))}
                      </TD>
                      <TD style={{
                color: "#52525B",
                textAlign: "right"
              }}>
                        {fmt(mileageSummary.fleet_totals.total_fuel_cost)}
                      </TD>
                      <TD style={{
                color: "#18181B",
                textAlign: "right"
              }}>
                        {fmt(mileageSummary.fleet_totals.total_irs_deduction)}
                      </TD>
                      <TD style={{
                color: "#09090B",
                textAlign: "right"
              }}>
                        {mileageSummary.fleet_totals.total_jobs}
                      </TD>
                    </TR>
                  </tfoot>}
              </Table>{" "}
            </div>{" "}
          </Card>}

      {/* Upcoming Maintenance (Next 30 Days) */}
      {dueSchedules.length > 0 && <Card className="p-4 mb-3">
          {" "}
          <div style={{
        fontSize: 16,
        fontWeight: 500,
        color: "#09090B",
        marginBottom: 12
      }}>
            Upcoming Maintenance (Next 30 Days)
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
                    Equipment
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
                    Due
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
                {dueSchedules.map(s => <TR key={s.id} style={{
              borderBottom: `1px solid ${"#E4E4E7"}`,
              background: s.is_overdue ? "rgba(239,68,68,0.08)" : "transparent"
            }}>
                    <TD style={{
                color: "#27272A"
              }}>
                      <EquipmentCategoryIcon category={s.category} />{" "}
                      {s.equipment_name}
                      {s.asset_tag && <span style={{
                  color: "#71717A",
                  fontSize: 14,
                  marginLeft: 4
                }}>
                          {s.asset_tag}
                        </span>}
                    </TD>
                    <TD style={{
                color: "#27272A"
              }}>
                      {s.task_name}
                    </TD>
                    <TD style={{
                color: s.is_overdue ? "#C8312F" : "#27272A"
              }}>
                      {s.is_overdue && <Badge tone="neutral">OVERDUE</Badge>}
                      {s.next_due_at ? formatETDateOnly(s.next_due_at) : "--"}
                    </TD>
                    <TD>
                      {" "}
                      <Badge tone={SEVERITY_TONES[s.priority] || "neutral"}>{s.priority}</Badge>{" "}
                    </TD>
                    <TD style={{
                color: "#27272A",
                textAlign: "right"
              }}>
                      {s.estimated_cost ? fmt(s.estimated_cost) : "--"}
                    </TD>
                  </TR>)}
              </TBody>
            </Table>{" "}
          </div>{" "}
        </Card>}
    </>;
}

// ═══════════════════════════════════════════════════════════════════
// SVG BAR CHART
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// SVG BAR CHART
// ═══════════════════════════════════════════════════════════════════
function CostBarChart({
  data
}) {
  if (!data || data.length === 0) return null;
  const maxCost = Math.max(...data.map(d => d.cost), 1);
  const labelWidth = Math.max(80, fmt(maxCost).length * 8 + 16);
  const w = Math.max(600, labelWidth * (data.length + 1));
  const h = 200;
  const xStep = (w - labelWidth) / data.length;
  const barW = Math.min(60, xStep - 16);
  return <div role="region" aria-label="Monthly maintenance costs chart" tabIndex={0} className="overflow-x-auto u-focus-ring">
      <ul className="sr-only">
        {data.map(d => <li key={d.month}>{d.month}: {fmt(d.cost)}</li>)}
      </ul>
      <svg viewBox={`0 0 ${w} ${h + 30}`} aria-hidden="true" style={{
      display: "block",
      width: w,
      maxWidth: "none",
      height: h + 30
    }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(pct => {
        const y = h - pct * (h - 20);
        return <g key={pct}>
              {" "}
              <line x1={labelWidth} y1={y} x2={w} y2={y} stroke={"#E4E4E7"} strokeWidth={0.5} />{" "}
              <text x={labelWidth - 12} y={y + 4} fill={"#71717A"} fontSize={14} textAnchor="end">
                {fmt(maxCost * pct)}
              </text>{" "}
            </g>;
      })}
        {/* Bars */}
        {data.map((d, i) => {
        const barH = d.cost / maxCost * (h - 20);
        const x = labelWidth + i * xStep + (xStep - barW) / 2;
        const y = h - barH;
        return <g key={d.month}>
              {" "}
              <rect x={x} y={y} width={barW} height={barH} rx={4} fill={"#18181B"} opacity={0.8} />{" "}
              <text x={x + barW / 2} y={h + 22} fill={"#71717A"} fontSize={14} textAnchor="middle">
                {d.month.slice(5)}
              </text>{" "}
              <text x={x + barW / 2} y={y - 4} fill={"#27272A"} fontSize={14} textAnchor="middle">
                {fmt(d.cost)}
              </text>{" "}
            </g>;
      })}
      </svg>
    </div>;
}
