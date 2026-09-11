import { Button, Field, Input, Select, Textarea, Badge, Card, UiSurface, ActionFeedback, Tabs, TabList, Tab, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Table, THead, TBody, TR, TH, TD } from "../../components/ui";
import { useState, useEffect, useCallback, useRef } from "react";
import useIsMobile from "../../hooks/useIsMobile";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { BarChart3, Beaker, Calculator, ClipboardCheck, Plus, Wrench } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import EquipmentMaintenancePage from "./EquipmentMaintenancePage";
import EquipmentCalibrationPanel from "./EquipmentCalibrationPanel";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS folds cleanly while keeping semantic green/amber/red distinct.

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json"
    },
    ...options
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}
const fmt = n => n != null ? "$" + Number(n).toLocaleString(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}) : "—";
function toNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function normalizeJobCostSummary(summary) {
  if (!summary) return null;
  const overall = summary.overall || {};
  const totalJobs = toNumber(summary.totalJobs ?? overall.total_jobs) || 0;
  const totalRevenue = toNumber(overall.total_revenue);
  const totalCost = toNumber(overall.total_costs);
  const byServiceRows = summary.byServiceType ? Object.entries(summary.byServiceType).map(([serviceType, stats]) => ({
    serviceType,
    stats
  })) : (summary.by_service_type || []).map(row => ({
    serviceType: row.service_type || "Unspecified",
    stats: {
      count: toNumber(row.total_jobs) || 0,
      avgRevenue: toNumber(row.total_jobs) > 0 ? (toNumber(row.total_revenue) || 0) / toNumber(row.total_jobs) : 0,
      avgCost: toNumber(row.total_jobs) > 0 ? (toNumber(row.total_costs) || 0) / toNumber(row.total_jobs) : 0,
      avgMargin: toNumber(row.avg_margin) || 0
    }
  }));
  return {
    avgMargin: toNumber(summary.avgMargin ?? overall.avg_margin),
    avgRevenue: toNumber(summary.avgRevenue) ?? (totalJobs > 0 && totalRevenue != null ? totalRevenue / totalJobs : null),
    avgCost: toNumber(summary.avgCost) ?? (totalJobs > 0 && totalCost != null ? totalCost / totalJobs : null),
    totalJobs,
    byServiceType: Object.fromEntries(byServiceRows.map(({
      serviceType,
      stats
    }) => [serviceType, stats]))
  };
}
const STATUS_COLORS = {
  active: "#18181B",
  maintenance: "#52525B",
  retired: "#71717A",
  sold: "#71717A",
  lost: "#C8312F",
  in_service: "#18181B",
  pending: "#18181B"
};
const CAT_ICONS = {
  sprayer: "",
  pump: "",
  reel: "",
  spreader: "",
  dethatcher: "",
  backpack: "",
  vehicle: "",
  other: ""
};
const EQUIPMENT_SECTIONS = [{
  key: "assets",
  label: "Assets",
  Icon: Wrench
}, {
  key: "maintenance",
  label: "Maintenance",
  Icon: Wrench
}, {
  key: "analytics",
  label: "Analytics",
  Icon: BarChart3
}, {
  key: "tank-mixes",
  label: "Tank Mixes",
  Icon: Beaker
}, {
  key: "job-costs",
  label: "Job Costing",
  Icon: Calculator
}, {
  key: "calibrations",
  label: "Calibrations",
  Icon: ClipboardCheck
}];
const EQUIPMENT_TAB_ALIASES = {
  equipment: "assets",
  fleet: "maintenance",
  vehicles: "maintenance",
  mileage: "maintenance"
};
const EQUIPMENT_TAB_KEYS = new Set(EQUIPMENT_SECTIONS.map(s => s.key));
const EQUIPMENT_LEAF_BY_KEY = Object.fromEntries(EQUIPMENT_SECTIONS.map(s => [s.key, s]));

// The flat tab bar is grouped into ~4 parent sections, each revealing its leaf
// tabs in a sub-row. `tab` still holds the LEAF key, so every
// {tab === "..."} render block below is unchanged.
const EQUIPMENT_TAB_GROUPS = [{
  key: "assets",
  label: "Assets",
  Icon: Wrench,
  tabs: ["assets"]
}, {
  key: "maintenance",
  label: "Maintenance",
  Icon: Wrench,
  tabs: ["maintenance", "calibrations"]
}, {
  key: "tank-mixes",
  label: "Tank Mixes",
  Icon: Beaker,
  tabs: ["tank-mixes"]
}, {
  key: "costs",
  label: "Costs",
  Icon: Calculator,
  tabs: ["job-costs", "analytics"]
}];
function normalizeEquipmentTab(value) {
  const key = EQUIPMENT_TAB_ALIASES[value] || value;
  return EQUIPMENT_TAB_KEYS.has(key) ? key : "assets";
}

// Job Costing + Analytics carry financial data (labor cost, margins) —
// owner-only under the 2026-08-25 role lockdown. Techs keep assets,
// maintenance, calibrations, and tank mixes.
const OWNER_ONLY_EQUIPMENT_TABS = new Set(["job-costs", "analytics"]);
export default function EquipmentPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Server-verified role from the shell's Outlet context (never localStorage).
  const outletContext = useOutletContext();
  const isAdminRole = outletContext?.user?.role === "admin";
  const normalizeForRole = value => {
    const normalized = normalizeEquipmentTab(value);
    return !isAdminRole && OWNER_ONLY_EQUIPMENT_TABS.has(normalized) ? "assets" : normalized;
  };
  const visibleGroups = EQUIPMENT_TAB_GROUPS.filter(g => isAdminRole || !g.tabs.every(t => OWNER_ONLY_EQUIPMENT_TABS.has(t)));
  const [tab, setTab] = useState(() => normalizeForRole(searchParams.get("tab")));
  const [toast, setToast] = useState("");
  const [editing, setEditing] = useState(null);
  const showToast = m => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };
  const activeGroup = visibleGroups.find(g => g.tabs.includes(tab)) || visibleGroups[0];
  const selectLeaf = nextTab => {
    const normalized = normalizeForRole(nextTab);
    const params = new URLSearchParams(searchParams);
    if (normalized === "assets") params.delete("tab");else params.set("tab", normalized);
    setTab(normalized);
    setSearchParams(params, {
      replace: true
    });
  };
  const handleSectionChange = key => {
    const g = visibleGroups.find(x => x.key === key);
    if (g) selectLeaf(g.tabs[0]);
  };
  useEffect(() => {
    const nextTab = normalizeForRole(searchParams.get("tab"));
    setTab(current => current === nextTab ? current : nextTab);
    // eslint reads only errors here; normalizeForRole is stable per role.
  }, [searchParams, isAdminRole]);

  // Report the leaf that actually RENDERS: /admin/equipment falls back to
  // 'assets' and legacy links (?tab=fleet) normalize to 'maintenance' —
  // the raw ?tab= beacon can't see either (Codex #2961 r19).
  useRenderedTabBeacon("/admin/equipment", tab, [searchParams]);
  return <UiSurface density="comfortable" className="ui-workspace text-ui-body text-zinc-900">
      {" "}
      <AdminCommandHeader title="Equipment" icon={Wrench} sections={visibleGroups.map(g => ({
      key: g.key,
      label: g.label,
      Icon: g.Icon
    }))} activeKey={activeGroup.key} onSectionChange={handleSectionChange} ariaLabel="Equipment section" navGridClassName="grid-cols-2 lg:grid-cols-4" action={tab === "assets" ? {
      label: "Add Equipment",
      icon: Plus,
      onClick: event => {
        event.currentTarget.focus({
          preventScroll: true
        });
        setEditing({
          ...EMPTY_EQUIP
        });
      }
    } : null} variant="workspace" />
      {activeGroup.tabs.length > 1 && <Tabs value={tab} onValueChange={selectLeaf} className="mb-4" variant="section">
          <TabList aria-label={`${activeGroup.label} views`} scrollable>
            {activeGroup.tabs.map(key => {
          const leaf = EQUIPMENT_LEAF_BY_KEY[key];
          const LeafIcon = leaf.Icon;
          return <Tab key={key} value={key} className="inline-flex items-center gap-2">
                  <LeafIcon size={14} strokeWidth={1.9} aria-hidden />
                  {leaf.label}
                </Tab>;
        })}
          </TabList>
        </Tabs>}
      {tab === "assets" && <EquipmentTab showToast={showToast} editing={editing} setEditing={setEditing} />}
      {tab === "maintenance" && <EquipmentMaintenancePage key="maintenance" embedded initialTab="fleet" />}
      {tab === "analytics" && isAdminRole && <EquipmentMaintenancePage key="analytics" embedded initialTab="analytics" />}
      {tab === "tank-mixes" && <TankMixTab showToast={showToast} />}
      {tab === "job-costs" && isAdminRole && <JobCostTab />}
      {tab === "calibrations" && <EquipmentCalibrationPanel />}
      {toast && <Card role="status" className="fixed z-[300] right-4 bottom-[calc(80px+env(safe-area-inset-bottom))] sm:bottom-5 max-w-[calc(100vw-32px)] px-4 py-3">
          {toast}
        </Card>}
    </UiSurface>;
}

// ── Equipment Tab ──

// ── Equipment Tab ──
const CATEGORIES = ["sprayer", "pump", "reel", "spreader", "dethatcher", "backpack", "vehicle", "other"];
const STATUSES = ["active", "maintenance", "retired", "sold", "lost"];
const EMPTY_EQUIP = {
  name: "",
  category: "other",
  make: "",
  model: "",
  serial_number: "",
  purchase_date: "",
  purchase_price: "",
  current_hours: "",
  next_service_hours: "",
  next_service_type: "",
  assigned_to: "",
  status: "active",
  book_value: "",
  notes: ""
};
function EquipmentTab({
  showToast,
  editing,
  setEditing
}) {
  const actionRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const isMobile = useIsMobile(640);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const loadSeq = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError("");
    try {
      const d = await adminFetch("/admin/equipment/equipment");
      if (seq === loadSeq.current) setItems(d.equipment || []);
    } catch (error) {
      if (seq === loadSeq.current) setLoadError(error.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    reload();
    return () => {
      loadSeq.current += 1;
    };
  }, [reload]);
  useEffect(() => setActionError(""), [editing?.id, !!editing]);
  const save = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionError("");
    try {
      if (!editing.name?.trim()) return setActionError("Name is required");
      setSaving(true);
      try {
        const payload = {
          ...editing
        };
        ["purchase_price", "current_hours", "next_service_hours", "book_value"].forEach(k => {
          payload[k] = payload[k] === "" || payload[k] == null ? null : Number(payload[k]);
        });
        if (!payload.purchase_date) payload.purchase_date = null;
        if (editing.id) {
          await adminFetch(`/admin/equipment/equipment/${editing.id}`, {
            method: "PUT",
            body: JSON.stringify(payload)
          });
          showToast("Equipment updated");
        } else {
          await adminFetch("/admin/equipment/equipment", {
            method: "POST",
            body: JSON.stringify(payload)
          });
          showToast("Equipment added");
        }
        setEditing(null);
        await reload();
      } catch (e) {
        setActionError(`Failed: ${e.message}`);
      } finally {
        setSaving(false);
      }
    } finally {
      actionRef.current = false;
    }
  };
  if (loading && !items.length) return <div style={{
    color: "#71717A",
    padding: 40,
    textAlign: "center"
  }}>
        Loading equipment...
      </div>;
  return <>
      {loadError && <ActionFeedback error onRetry={reload} className="mb-4">
          Could not load equipment: {loadError}
          {items.length > 0 && " Showing previously loaded equipment."}
        </ActionFeedback>}
      {!loading && !loadError && items.length === 0 && <Card className="p-6 text-zinc-500">
          No equipment recorded. Use Add Equipment to record an asset.
        </Card>}{" "}
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(300px, 1fr))",
      gap: 12
    }}>
        {items.map(e => {
        const hoursLeft = e.next_service_hours ? e.next_service_hours - (e.current_hours || 0) : null;
        const needsService = hoursLeft !== null && hoursLeft <= 10;
        return <Card key={e.id} style={{
          marginBottom: 0,
          borderLeft: `3px solid ${STATUS_COLORS[e.status] || "#71717A"}`
        }} className="min-w-0 [overflow-wrap:anywhere] p-4 mb-3">
              {" "}
              <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 8,
            gap: 8
          }}>
                {" "}
                <div style={{
              minWidth: 0,
              flex: 1
            }}>
                  {" "}
                  <div style={{
                fontSize: 14,
                fontWeight: 500,
                color: "#09090B"
              }}>
                    {CAT_ICONS[e.category] || ""} {e.name}
                  </div>{" "}
                  <div style={{
                fontSize: 14,
                color: "#71717A"
              }}>
                    {[e.make, e.model].filter(Boolean).join(" ")}
                  </div>{" "}
                </div>{" "}
                <div style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              flexShrink: 0
            }}>
                  {" "}
                  <Badge tone={STATUS_COLORS[e.status] === "#C8312F" ? "alert" : "neutral"}>
                    {e.status}
                  </Badge>{" "}
                  <Button onClick={event => {
                event.currentTarget.focus({
                  preventScroll: true
                });
                setEditing({
                  ...e,
                  purchase_date: e.purchase_date ? String(e.purchase_date).split("T")[0] : "",
                  purchase_price: e.purchase_price ?? "",
                  current_hours: e.current_hours ?? "",
                  next_service_hours: e.next_service_hours ?? "",
                  book_value: e.book_value ?? ""
                });
              }} type="button" variant="secondary" className="min-w-11" disabled={saving}>
                    Edit
                  </Button>{" "}
                </div>{" "}
              </div>{" "}
              <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            fontSize: 14
          }}>
                {e.current_hours > 0 && <div>
                    <span style={{
                color: "#71717A"
              }}>
                      Hours:
                    </span>{" "}
                    <span style={{
                color: "#09090B"
              }}>
                      {e.current_hours}
                    </span>
                  </div>}
                {e.purchase_price > 0 && <div>
                    <span style={{
                color: "#71717A"
              }}>
                      Cost:
                    </span>{" "}
                    <span style={{
                color: "#18181B"
              }}>
                      {fmt(e.purchase_price)}
                    </span>
                  </div>}
                {e.book_value > 0 && <div>
                    <span style={{
                color: "#71717A"
              }}>
                      Book:
                    </span>{" "}
                    <span>{fmt(e.book_value)}</span>
                  </div>}
                {e.last_service_date && <div>
                    <span style={{
                color: "#71717A"
              }}>
                      Last Svc:
                    </span>{" "}
                    <span>
                      {new Date(e.last_service_date).toLocaleDateString()}
                    </span>
                  </div>}
              </div>
              {e.specs && <div style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            marginTop: 8
          }}>
                  {Object.entries(typeof e.specs === "string" ? JSON.parse(e.specs) : e.specs).map(([k, v]) => <Badge key={k} tone="neutral">
                      {k.replace(/_/g, " ")}: {v}
                    </Badge>)}
                </div>}
              {needsService && <div style={{
            marginTop: 8,
            fontSize: 14,
            color: "#52525B",
            fontWeight: 500
          }}>
                  Service due in {Math.round(hoursLeft)} hours —{" "}
                  {e.next_service_type}
                </div>}
            </Card>;
      })}
      </div>
      {editing && <EquipmentEditModal equipment={editing} onChange={setEditing} onClose={() => setEditing(null)} onSave={save} saving={saving} error={actionError} />}
    </>;
}
function EquipmentEditModal({
  equipment: e,
  onChange,
  onClose,
  onSave,
  saving,
  error
}) {
  const field = (key, label, type = "text", opts = null) => <Field label={label} className="min-w-0">
      {opts ? <Select value={e[key] ?? ""} onChange={ev => onChange({
      ...e,
      [key]: ev.target.value
    })} disabled={saving}>
          {opts.map(o => <option key={o} value={o}>
              {o}
            </option>)}
        </Select> : type === "textarea" ? <Textarea value={e[key] ?? ""} onChange={ev => onChange({
      ...e,
      [key]: ev.target.value
    })} rows={3} disabled={saving} /> : <Input type={type} value={e[key] ?? ""} onChange={ev => onChange({
      ...e,
      [key]: ev.target.value
    })} disabled={saving} />}
    </Field>;
  return <Dialog open onClose={() => {
    if (!saving) onClose();
  }} size="lg">
      <DialogHeader>
        <DialogTitle>{e.id ? "Edit Equipment" : "Add Equipment"}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {error && <ActionFeedback error className="mb-4">
            {error}
          </ActionFeedback>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field("name", "Name *")}
          {field("category", "Category", "text", CATEGORIES)}
          {field("make", "Make")}
          {field("model", "Model")}
          {field("serial_number", "Serial #")}
          {field("status", "Status", "text", STATUSES)}
          {field("purchase_date", "Purchase Date", "date")}
          {field("purchase_price", "Purchase Price ($)", "number")}
          {field("current_hours", "Current Hours", "number")}
          {field("book_value", "Book Value ($)", "number")}
          {field("next_service_hours", "Next Service @ Hours", "number")}
          {field("next_service_type", "Next Service Type")}
          {field("assigned_to", "Assigned To")}
        </div>
        <div className="mt-3">{field("notes", "Notes", "textarea")}</div>
      </DialogBody>
      <DialogFooter className="grid grid-cols-2">
        <Button variant="secondary" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button loading={saving} disabled={saving} onClick={onSave}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>;
}

// ── Tank Mix Tab ──
// ── Tank Mix Tab ──
function TankMixTab({
  showToast
}) {
  const actionRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const isMobile = useIsMobile(640);
  const [mixes, setMixes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const loadRequest = useRef(0);
  const mounted = useRef(false);
  const loadMixes = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError(false);
    try {
      const d = await adminFetch("/admin/equipment/tank-mixes");
      if (mounted.current && request === loadRequest.current) setMixes(d.tank_mixes || d.mixes || []);
    } catch {
      if (mounted.current && request === loadRequest.current) setLoadError(true);
    } finally {
      if (mounted.current && request === loadRequest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void loadMixes();
    return () => {
      mounted.current = false;
      loadRequest.current += 1;
    };
  }, [loadMixes]);
  const recalculate = async id => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionError("");
    setPendingAction(id);
    try {
      try {
        await adminFetch(`/admin/equipment/tank-mixes/${id}/recalculate`, {
          method: "POST"
        });
        if (!mounted.current) return;
        showToast("Costs recalculated from current inventory prices");
        await loadMixes();
      } catch (e) {
        if (mounted.current) setActionError(`Failed: ${e.message}`);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  if (loading && mixes.length === 0) return <div style={{
    color: "#71717A",
    padding: 40,
    textAlign: "center"
  }}>
        Loading tank mixes...
      </div>;
  return <div>
      {actionError && <ActionFeedback error className="mb-4">
          {actionError}
        </ActionFeedback>}
      {loadError && <Card role="alert" style={{
      color: "#C8312F",
      fontSize: 14
    }} className="p-4 mb-3">
          Could not load tank mixes.
          {mixes.length > 0 && " Showing previously loaded mixes; costs may be out of date."}
          <Button onClick={loadMixes} aria-label="Retry tank mixes" style={{
        marginLeft: 12
      }} type="button" variant="primary" className="min-w-11" disabled={!!pendingAction}>
            Retry
          </Button>
        </Card>}
      {loading && <div role="status" style={{
      color: "#71717A"
    }}>
          Refreshing tank mixes...
        </div>}
      {mixes.length === 0 ? !loadError && <Card style={{
      textAlign: "center",
      padding: 40,
      color: "#71717A"
    }} className="p-4 mb-3">
              No tank mixes configured yet. Add your standard mixes to track
              costs per application.
            </Card> : mixes.map(m => {
      const products = typeof m.products === "string" ? JSON.parse(m.products) : m.products || [];
      return <Card key={m.id} className="p-4 mb-3">
                {" "}
                <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12
        }}>
                  {" "}
                  <div>
                    {" "}
                    <div style={{
              fontSize: 15,
              fontWeight: 500,
              color: "#09090B"
            }}>
                      {m.name}
                    </div>{" "}
                    <div style={{
              fontSize: 14,
              color: "#71717A"
            }}>
                      {m.service_type} · {m.tank_size_gal}gal tank · covers{" "}
                      {(m.coverage_sqft || 0).toLocaleString()} sqft
                    </div>{" "}
                  </div>{" "}
                  <div style={{
            display: "flex",
            gap: 8,
            alignItems: "center"
          }}>
                    {" "}
                    <div style={{
              textAlign: "right"
            }}>
                      {" "}
                      <div style={{
                fontSize: 18,
                fontWeight: 500,
                color: m.cost_incomplete ? "#52525B" : "#18181B"
              }} className="u-nums">
                        {fmt(m.cost_per_tank)}/tank
                      </div>{" "}
                      <div style={{
                fontSize: 14,
                color: "#71717A"
              }} className="u-nums">
                        {fmt(m.cost_per_1000sf)}/1000sf
                      </div>{" "}
                      {m.cost_incomplete && <div style={{
                fontSize: 14,
                color: "#52525B"
              }}>
                          incomplete — unpriced component excluded
                        </div>}{" "}
                    </div>{" "}
                    <Button onClick={() => recalculate(m.id)} type="button" variant="secondary" className="min-w-11" disabled={!!pendingAction} loading={pendingAction === m.id}>
                      Recalc
                    </Button>{" "}
                  </div>{" "}
                </div>{" "}
                <div style={{
          overflowX: "auto",
          WebkitOverflowScrolling: "touch"
        }}>
                  {" "}
                  <Table style={{
            minWidth: isMobile ? 400 : undefined
          }}>
                    <THead>
                      <TR>
                        {["Product", "Rate/1000sf", "Oz/Tank", "Cost"].map(h => <TH key={h} style={{
                  color: "#71717A",
                  textAlign: "left"
                }}>
                              {h}
                            </TH>)}
                      </TR>
                    </THead>
                    <TBody>
                      {products.map((p, i) => <TR key={i}>
                          <TD style={{
                  color: "#09090B"
                }}>
                            {p.product_name}
                          </TD>
                          <TD nums>
                            {p.rate_per_1000sf} {p.rate_unit}
                          </TD>
                          <TD nums>{p.oz_per_tank}</TD>
                          <TD style={{
                  color: "#18181B"
                }} nums>
                            {fmt(p.cost)}
                          </TD>
                        </TR>)}
                    </TBody>
                  </Table>{" "}
                </div>{" "}
              </Card>;
    })}
    </div>;
}

// ── Job Cost Tab ──
// ── Job Cost Tab ──
function JobCostTab() {
  const isMobile = useIsMobile(640);
  const [summary, setSummary] = useState(null);
  const [costs, setCosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [listError, setListError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setReadError("");
    setListError("");
    Promise.allSettled([adminFetch("/admin/equipment/job-costs/summary"), adminFetch("/admin/equipment/job-costs?limit=30")]).then(([s, c]) => {
      if (!active) return;
      if (s.status === "fulfilled") {
        setSummary(normalizeJobCostSummary(s.value));
      } else {
        setReadError(s.reason?.message || "Request failed");
      }
      if (c.status === "fulfilled") {
        setCosts(c.value.job_costs || c.value.costs || []);
      } else {
        setListError(c.reason?.message || "Request failed");
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [attempt]);
  const retry = () => setAttempt(v => v + 1);
  if (readError && !summary) return <ActionFeedback error onRetry={retry}>
        Could not load job costs: {readError}
      </ActionFeedback>;
  if (loading) return <div style={{
    color: "#71717A",
    padding: 40,
    textAlign: "center"
  }}>
        Loading job costs...
      </div>;
  return <div>
      {readError && <ActionFeedback error onRetry={retry} className="mb-3">
          Could not refresh job cost summary: {readError}. Showing previously loaded figures.
        </ActionFeedback>}
      {summary && <div style={{
      display: "flex",
      gap: 10,
      marginBottom: 20,
      flexWrap: "wrap"
    }}>
          {[{
        label: "Avg Margin",
        value: summary.avgMargin != null ? `${summary.avgMargin.toFixed(1)}%` : "—",
        color: summary.avgMargin == null || summary.avgMargin >= 50 ? "#18181B" : "#52525B"
      }, {
        label: "Avg Revenue/Job",
        value: fmt(summary.avgRevenue),
        color: "#18181B"
      }, {
        label: "Avg Cost/Job",
        value: fmt(summary.avgCost),
        color: "#52525B"
      }, {
        label: "Total Jobs Costed",
        value: summary.totalJobs || 0,
        color: "#09090B"
      }].map(s => <Card key={s.label} style={{
        flex: isMobile ? "1 1 calc(50% - 6px)" : "1 1 140px",
        minWidth: isMobile ? 0 : 140,
        marginBottom: 0,
        textAlign: "center"
      }} className="p-4 mb-3">
              {" "}
              <div style={{
          fontSize: isMobile ? 18 : 22,
          fontWeight: 500,
          color: s.color
        }} className="u-nums">
                {s.value}
              </div>{" "}
              <div style={{
          fontSize: 14,
          color: "#71717A",
          marginTop: 2
        }}>
                {s.label}
              </div>{" "}
            </Card>)}
        </div>}

      {/* By service type */}
      {summary?.byServiceType && <Card className="p-4 mb-3">
          {" "}
          <div style={{
        fontSize: 15,
        fontWeight: 500,
        color: "#09090B",
        marginBottom: 12
      }}>
            Margins by Service Type
          </div>
          {Object.entries(summary.byServiceType).map(([svc, stats]) => <div key={svc} style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "8px 0",
        borderBottom: `1px solid ${"#E4E4E7"}22`,
        fontSize: 14
      }}>
              {" "}
              <span style={{
          color: "#09090B",
          fontWeight: 500
        }}>
                {svc}
              </span>{" "}
              <div style={{
          display: "flex",
          gap: 16
        }}>
                {" "}
                <span style={{
            color: "#71717A"
          }} className="u-nums">
                  {stats.count} jobs
                </span>{" "}
                <span style={{
            color: "#18181B"
          }} className="u-nums">
                  Rev: {fmt(stats.avgRevenue)}
                </span>{" "}
                <span style={{
            color: "#52525B"
          }} className="u-nums">
                  Cost: {fmt(stats.avgCost)}
                </span>{" "}
                <span style={{
            color: stats.avgMargin >= 50 ? "#18181B" : "#52525B",
            fontWeight: 500
          }} className="u-nums">
                  {stats.avgMargin?.toFixed(1)}%
                </span>{" "}
              </div>{" "}
            </div>)}
        </Card>}

      {listError && <ActionFeedback error onRetry={retry} className="mb-3">
          Could not load recent job costs: {listError}
        </ActionFeedback>}
      {!listError && costs.length === 0 && <Card style={{
      textAlign: "center",
      padding: 40,
      color: "#71717A"
    }} className="p-4 mb-3">
          No job costs recorded yet
        </Card>}
    </div>;
}

// ── Maintenance Tab ──
// ── Maintenance Tab ──
function MaintenanceTab({
  showToast
}) {
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/equipment/equipment").then(d => {
      const items = (d.equipment || []).filter(e => {
        const hoursLeft = e.next_service_hours ? e.next_service_hours - (e.current_hours || 0) : null;
        return hoursLeft !== null && hoursLeft <= 50;
      });
      setEquipment(items);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);
  if (loading) return <div style={{
    color: "#71717A",
    padding: 40,
    textAlign: "center"
  }}>
        Loading...
      </div>;
  return <div>
      {" "}
      <div style={{
      fontSize: 15,
      fontWeight: 500,
      color: "#09090B",
      marginBottom: 12
    }}>
        Upcoming Maintenance
      </div>
      {equipment.length === 0 ? <Card style={{
      textAlign: "center",
      padding: 40,
      color: "#71717A"
    }} className="p-4 mb-3">
          No equipment needs service soon
        </Card> : equipment.map(e => {
      const hoursLeft = e.next_service_hours - (e.current_hours || 0);
      return <Card key={e.id} style={{
        borderLeft: `3px solid ${hoursLeft <= 10 ? "#C8312F" : "#52525B"}`
      }} className="p-4 mb-3">
              {" "}
              <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}>
                {" "}
                <div>
                  {" "}
                  <div style={{
              fontSize: 14,
              fontWeight: 500,
              color: "#09090B"
            }}>
                    {e.name}
                  </div>{" "}
                  <div style={{
              fontSize: 14,
              color: "#71717A"
            }}>
                    {e.next_service_type} — in {Math.round(hoursLeft)} hours
                  </div>{" "}
                </div>{" "}
                <Button onClick={async () => {
            try {
              await adminFetch(`/admin/equipment/equipment/${e.id}/maintenance`, {
                method: "POST",
                body: JSON.stringify({
                  service_type: e.next_service_type,
                  hours_at_service: e.current_hours
                })
              });
              showToast("Maintenance logged");
            } catch (err) {
              showToast(`Failed: ${err.message}`);
            }
          }} type="button" variant="primary" className="min-w-11">
                  Mark Complete
                </Button>{" "}
              </div>{" "}
            </Card>;
    })}
    </div>;
}
