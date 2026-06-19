import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { BarChart3, Beaker, Calculator, ClipboardCheck, Plus, Wrench } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import EquipmentMaintenancePage from "./EquipmentMaintenancePage";
import EquipmentCalibrationPanel from "./EquipmentCalibrationPanel";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS folds cleanly while keeping semantic green/amber/red distinct.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  purple: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const sCard = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};
const sBtn = (bg, color) => ({
  padding: "8px 16px",
  background: bg,
  color,
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});
const sBadge = (bg, color) => ({
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 4,
  background: bg,
  color,
  fontWeight: 600,
});
const sInput = {
  width: "100%",
  padding: "8px 12px",
  background: D.input,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.text,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};
const fmt = (n) =>
  n != null
    ? "$" +
      Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "—";

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
  const byServiceRows = summary.byServiceType
    ? Object.entries(summary.byServiceType).map(([serviceType, stats]) => ({
        serviceType,
        stats,
      }))
    : (summary.by_service_type || []).map((row) => ({
        serviceType: row.service_type || "Unspecified",
        stats: {
          count: toNumber(row.total_jobs) || 0,
          avgRevenue:
            toNumber(row.total_jobs) > 0
              ? (toNumber(row.total_revenue) || 0) / toNumber(row.total_jobs)
              : 0,
          avgCost:
            toNumber(row.total_jobs) > 0
              ? (toNumber(row.total_costs) || 0) / toNumber(row.total_jobs)
              : 0,
          avgMargin: toNumber(row.avg_margin) || 0,
        },
      }));

  return {
    avgMargin: toNumber(summary.avgMargin ?? overall.avg_margin),
    avgRevenue:
      toNumber(summary.avgRevenue) ??
      (totalJobs > 0 && totalRevenue != null ? totalRevenue / totalJobs : null),
    avgCost:
      toNumber(summary.avgCost) ??
      (totalJobs > 0 && totalCost != null ? totalCost / totalJobs : null),
    totalJobs,
    byServiceType: Object.fromEntries(
      byServiceRows.map(({ serviceType, stats }) => [serviceType, stats]),
    ),
  };
}

const STATUS_COLORS = {
  active: D.green,
  maintenance: D.amber,
  retired: D.muted,
  sold: D.muted,
  lost: D.red,
  in_service: D.green,
  pending: D.purple,
};
const CAT_ICONS = {
  sprayer: "",
  pump: "",
  reel: "",
  spreader: "",
  dethatcher: "",
  backpack: "",
  vehicle: "",
  other: "",
};

const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
const EQUIPMENT_SECTIONS = [
  { key: "assets", label: "Assets", Icon: Wrench },
  { key: "maintenance", label: "Maintenance", Icon: Wrench },
  { key: "analytics", label: "Analytics", Icon: BarChart3 },
  { key: "tank-mixes", label: "Tank Mixes", Icon: Beaker },
  { key: "job-costs", label: "Job Costing", Icon: Calculator },
  { key: "calibrations", label: "Calibrations", Icon: ClipboardCheck },
];
const EQUIPMENT_TAB_ALIASES = {
  equipment: "assets",
  fleet: "maintenance",
  vehicles: "maintenance",
  mileage: "maintenance",
};
const EQUIPMENT_TAB_KEYS = new Set(EQUIPMENT_SECTIONS.map((s) => s.key));
const EQUIPMENT_LEAF_BY_KEY = Object.fromEntries(
  EQUIPMENT_SECTIONS.map((s) => [s.key, s]),
);

// The flat tab bar is grouped into ~4 parent sections, each revealing its leaf
// tabs in a sub-row. `tab` still holds the LEAF key, so every
// {tab === "..."} render block below is unchanged.
const EQUIPMENT_TAB_GROUPS = [
  { key: "assets", label: "Assets", Icon: Wrench, tabs: ["assets"] },
  {
    key: "maintenance",
    label: "Maintenance",
    Icon: Wrench,
    tabs: ["maintenance", "calibrations"],
  },
  { key: "tank-mixes", label: "Tank Mixes", Icon: Beaker, tabs: ["tank-mixes"] },
  {
    key: "costs",
    label: "Costs",
    Icon: Calculator,
    tabs: ["job-costs", "analytics"],
  },
];

function normalizeEquipmentTab(value) {
  const key = EQUIPMENT_TAB_ALIASES[value] || value;
  return EQUIPMENT_TAB_KEYS.has(key) ? key : "assets";
}

export default function EquipmentPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() =>
    normalizeEquipmentTab(searchParams.get("tab")),
  );
  const [toast, setToast] = useState("");
  const [editing, setEditing] = useState(null);
  const showToast = (m) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };
  const activeGroup =
    EQUIPMENT_TAB_GROUPS.find((g) => g.tabs.includes(tab)) ||
    EQUIPMENT_TAB_GROUPS[0];
  const selectLeaf = (nextTab) => {
    const normalized = normalizeEquipmentTab(nextTab);
    const params = new URLSearchParams(searchParams);
    if (normalized === "assets") params.delete("tab");
    else params.set("tab", normalized);
    setTab(normalized);
    setSearchParams(params, { replace: true });
  };
  const handleSectionChange = (key) => {
    const g = EQUIPMENT_TAB_GROUPS.find((x) => x.key === key);
    if (g) selectLeaf(g.tabs[0]);
  };

  useEffect(() => {
    const nextTab = normalizeEquipmentTab(searchParams.get("tab"));
    setTab((current) => (current === nextTab ? current : nextTab));
  }, [searchParams]);

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      {" "}
      <style>{`
        @media (max-width: 640px) {
          .equipment-tab-bar { justify-content: flex-start !important; }
        }
      `}</style>{" "}
      <AdminCommandHeader
        title="Equipment"
        icon={Wrench}
        sections={EQUIPMENT_TAB_GROUPS.map((g) => ({
          key: g.key,
          label: g.label,
          Icon: g.Icon,
        }))}
        activeKey={activeGroup.key}
        onSectionChange={handleSectionChange}
        ariaLabel="Equipment section"
        navGridClassName="grid-cols-2 lg:grid-cols-4"
        action={
          tab === "assets"
            ? {
                label: "Add Equipment",
                icon: Plus,
                onClick: () => setEditing({ ...EMPTY_EQUIP }),
              }
            : null
        }
      />
      {activeGroup.tabs.length > 1 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 16,
          }}
        >
          {activeGroup.tabs.map((key) => {
            const leaf = EQUIPMENT_LEAF_BY_KEY[key];
            const active = tab === key;
            const LeafIcon = leaf.Icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => selectLeaf(key)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 36,
                  padding: "0 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  cursor: "pointer",
                  border: `1px solid ${active ? "#18181B" : "#E4E4E7"}`,
                  background: active ? "#18181B" : "#FFFFFF",
                  color: active ? "#fff" : "#27272A",
                }}
              >
                <LeafIcon size={14} strokeWidth={1.9} />
                {leaf.label}
              </button>
            );
          })}
        </div>
      )}
      {tab === "assets" && (
        <EquipmentTab
          showToast={showToast}
          editing={editing}
          setEditing={setEditing}
        />
      )}
      {tab === "maintenance" && (
        <EquipmentMaintenancePage
          key="maintenance"
          embedded
          initialTab="fleet"
        />
      )}
      {tab === "analytics" && (
        <EquipmentMaintenancePage
          key="analytics"
          embedded
          initialTab="analytics"
        />
      )}
      {tab === "tank-mixes" && <TankMixTab showToast={showToast} />}
      {tab === "job-costs" && <JobCostTab />}
      {tab === "calibrations" && <EquipmentCalibrationPanel />}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          background: D.card,
          border: `1px solid ${D.green}`,
          borderRadius: 8,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,.4)",
          zIndex: 300,
          fontSize: 12,
          transform: toast ? "translateY(0)" : "translateY(80px)",
          opacity: toast ? 1 : 0,
          transition: "all .3s",
          pointerEvents: "none",
        }}
      >
        {" "}
        <span style={{ color: D.green }}></span>
        <span style={{ color: D.text }}>{toast}</span>{" "}
      </div>{" "}
    </div>
  );
}

// ── Equipment Tab ──
const CATEGORIES = [
  "sprayer",
  "pump",
  "reel",
  "spreader",
  "dethatcher",
  "backpack",
  "vehicle",
  "other",
];
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
  notes: "",
};

function EquipmentTab({ showToast, editing, setEditing }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = () =>
    adminFetch("/admin/equipment/equipment")
      .then((d) => setItems(d.equipment || []))
      .catch(() => {});

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!editing.name?.trim()) return showToast("Name is required");
    setSaving(true);
    try {
      const payload = { ...editing };
      [
        "purchase_price",
        "current_hours",
        "next_service_hours",
        "book_value",
      ].forEach((k) => {
        payload[k] =
          payload[k] === "" || payload[k] == null ? null : Number(payload[k]);
      });
      if (!payload.purchase_date) payload.purchase_date = null;
      if (editing.id) {
        await adminFetch(`/admin/equipment/equipment/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showToast("Equipment updated");
      } else {
        await adminFetch("/admin/equipment/equipment", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("Equipment added");
      }
      setEditing(null);
      await reload();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading equipment...
      </div>
    );

  return (
    <>
      {" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile
            ? "1fr"
            : "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 12,
        }}
      >
        {items.map((e) => {
          const hoursLeft = e.next_service_hours
            ? e.next_service_hours - (e.current_hours || 0)
            : null;
          const needsService = hoursLeft !== null && hoursLeft <= 10;
          return (
            <div
              key={e.id}
              style={{
                ...sCard,
                marginBottom: 0,
                borderLeft: `3px solid ${STATUS_COLORS[e.status] || D.muted}`,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: 8,
                  gap: 8,
                }}
              >
                {" "}
                <div style={{ minWidth: 0, flex: 1 }}>
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 600, color: D.heading }}
                  >
                    {CAT_ICONS[e.category] || ""} {e.name}
                  </div>{" "}
                  <div style={{ fontSize: 11, color: D.muted }}>
                    {[e.make, e.model].filter(Boolean).join(" ")}
                  </div>{" "}
                </div>{" "}
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    flexShrink: 0,
                  }}
                >
                  {" "}
                  <span
                    style={sBadge(
                      `${STATUS_COLORS[e.status]}22`,
                      STATUS_COLORS[e.status],
                    )}
                  >
                    {e.status}
                  </span>{" "}
                  <button
                    onClick={() =>
                      setEditing({
                        ...e,
                        purchase_date: e.purchase_date
                          ? String(e.purchase_date).split("T")[0]
                          : "",
                        purchase_price: e.purchase_price ?? "",
                        current_hours: e.current_hours ?? "",
                        next_service_hours: e.next_service_hours ?? "",
                        book_value: e.book_value ?? "",
                      })
                    }
                    style={{
                      padding: "4px 10px",
                      background: "transparent",
                      border: `1px solid ${D.border}`,
                      borderRadius: 6,
                      color: D.muted,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    Edit
                  </button>{" "}
                </div>{" "}
              </div>{" "}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 4,
                  fontSize: 11,
                }}
              >
                {e.current_hours > 0 && (
                  <div>
                    <span style={{ color: D.muted }}>Hours:</span>{" "}
                    <span style={{ color: D.heading, fontFamily: MONO }}>
                      {e.current_hours}
                    </span>
                  </div>
                )}
                {e.purchase_price > 0 && (
                  <div>
                    <span style={{ color: D.muted }}>Cost:</span>{" "}
                    <span style={{ color: D.green, fontFamily: MONO }}>
                      {fmt(e.purchase_price)}
                    </span>
                  </div>
                )}
                {e.book_value > 0 && (
                  <div>
                    <span style={{ color: D.muted }}>Book:</span>{" "}
                    <span style={{ fontFamily: MONO }}>
                      {fmt(e.book_value)}
                    </span>
                  </div>
                )}
                {e.last_service_date && (
                  <div>
                    <span style={{ color: D.muted }}>Last Svc:</span>{" "}
                    <span>
                      {new Date(e.last_service_date).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </div>
              {e.specs && (
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    flexWrap: "wrap",
                    marginTop: 8,
                  }}
                >
                  {Object.entries(
                    typeof e.specs === "string" ? JSON.parse(e.specs) : e.specs,
                  ).map(([k, v]) => (
                    <span key={k} style={sBadge(`${D.teal}22`, D.teal)}>
                      {k.replace(/_/g, " ")}: {v}
                    </span>
                  ))}
                </div>
              )}
              {needsService && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    color: D.amber,
                    fontWeight: 600,
                  }}
                >
                  Service due in {Math.round(hoursLeft)} hours —{" "}
                  {e.next_service_type}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {editing && (
        <EquipmentEditModal
          equipment={editing}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={save}
          saving={saving}
        />
      )}
    </>
  );
}

function EquipmentEditModal({
  equipment: e,
  onChange,
  onClose,
  onSave,
  saving,
}) {
  const field = (key, label, type = "text", opts = null) => (
    <label style={{ display: "block" }}>
      {" "}
      <div
        style={{
          fontSize: 11,
          color: D.muted,
          fontWeight: 600,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      {opts ? (
        <select
          value={e[key] ?? ""}
          onChange={(ev) => onChange({ ...e, [key]: ev.target.value })}
          style={sInput}
        >
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          value={e[key] ?? ""}
          onChange={(ev) => onChange({ ...e, [key]: ev.target.value })}
          rows={3}
          style={{ ...sInput, resize: "vertical", fontFamily: "inherit" }}
        />
      ) : (
        <input
          type={type}
          value={e[key] ?? ""}
          onChange={(ev) => onChange({ ...e, [key]: ev.target.value })}
          style={sInput}
        />
      )}
    </label>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 400,
      }}
    >
      {" "}
      <div
        onClick={(ev) => ev.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: 12,
          padding: 24,
          width: "100%",
          maxWidth: 640,
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
        }}
      >
        {" "}
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          {e.id ? "Edit Equipment" : "Add Equipment"}
        </div>{" "}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
            gap: 12,
          }}
        >
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
        </div>{" "}
        <div style={{ marginTop: 12 }}>
          {field("notes", "Notes", "textarea")}
        </div>{" "}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          {" "}
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              ...sBtn("transparent", D.muted),
              border: `1px solid ${D.border}`,
            }}
          >
            Cancel
          </button>{" "}
          <button
            onClick={onSave}
            disabled={saving}
            style={sBtn(D.teal, "#fff")}
          >
            {saving ? "Saving..." : "Save"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── Tank Mix Tab ──
function TankMixTab({ showToast }) {
  const [mixes, setMixes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch("/admin/equipment/tank-mixes")
      .then((d) => setMixes(d.tank_mixes || d.mixes || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const recalculate = async (id) => {
    try {
      await adminFetch(`/admin/equipment/tank-mixes/${id}/recalculate`, {
        method: "POST",
      });
      showToast("Costs recalculated from current inventory prices");
      const d = await adminFetch("/admin/equipment/tank-mixes");
      setMixes(d.tank_mixes || d.mixes || []);
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading tank mixes...
      </div>
    );

  return (
    <div>
      {mixes.length === 0 ? (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No tank mixes configured yet. Add your standard mixes to track costs
          per application.
        </div>
      ) : (
        mixes.map((m) => {
          const products =
            typeof m.products === "string"
              ? JSON.parse(m.products)
              : m.products || [];
          return (
            <div key={m.id} style={{ ...sCard }}>
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                }}
              >
                {" "}
                <div>
                  {" "}
                  <div
                    style={{ fontSize: 15, fontWeight: 600, color: D.heading }}
                  >
                    {m.name}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted }}>
                    {m.service_type} · {m.tank_size_gal}gal tank · covers{" "}
                    {(m.coverage_sqft || 0).toLocaleString()} sqft
                  </div>{" "}
                </div>{" "}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {" "}
                  <div style={{ textAlign: "right" }}>
                    {" "}
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 18,
                        fontWeight: 700,
                        color: D.green,
                      }}
                    >
                      {fmt(m.cost_per_tank)}/tank
                    </div>{" "}
                    <div
                      style={{ fontFamily: MONO, fontSize: 12, color: D.muted }}
                    >
                      {fmt(m.cost_per_1000sf)}/1000sf
                    </div>{" "}
                  </div>{" "}
                  <button
                    onClick={() => recalculate(m.id)}
                    style={{
                      ...sBtn("transparent", D.muted),
                      border: `1px solid ${D.border}`,
                      padding: "4px 8px",
                      fontSize: 10,
                    }}
                  >
                    Recalc
                  </button>{" "}
                </div>{" "}
              </div>{" "}
              <div
                style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}
              >
                {" "}
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    minWidth: isMobile ? 400 : undefined,
                  }}
                >
                  {" "}
                  <thead>
                    <tr>
                      {["Product", "Rate/1000sf", "Oz/Tank", "Cost"].map(
                        (h) => (
                          <th
                            key={h}
                            style={{
                              fontSize: 10,
                              color: D.muted,
                              textTransform: "uppercase",
                              letterSpacing: 1,
                              textAlign: "left",
                              padding: "4px 8px",
                              borderBottom: `1px solid ${D.border}22`,
                            }}
                          >
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>{" "}
                  <tbody>
                    {products.map((p, i) => (
                      <tr key={i}>
                        {" "}
                        <td
                          style={{
                            padding: "6px 8px",
                            fontSize: 12,
                            color: D.heading,
                          }}
                        >
                          {p.product_name}
                        </td>{" "}
                        <td
                          style={{
                            padding: "6px 8px",
                            fontSize: 12,
                            fontFamily: MONO,
                          }}
                        >
                          {p.rate_per_1000sf} {p.rate_unit}
                        </td>{" "}
                        <td
                          style={{
                            padding: "6px 8px",
                            fontSize: 12,
                            fontFamily: MONO,
                          }}
                        >
                          {p.oz_per_tank}
                        </td>{" "}
                        <td
                          style={{
                            padding: "6px 8px",
                            fontSize: 12,
                            fontFamily: MONO,
                            color: D.green,
                          }}
                        >
                          {fmt(p.cost)}
                        </td>{" "}
                      </tr>
                    ))}
                  </tbody>{" "}
                </table>{" "}
              </div>{" "}
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Job Cost Tab ──
function JobCostTab() {
  const [summary, setSummary] = useState(null);
  const [costs, setCosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminFetch("/admin/equipment/job-costs/summary").catch(() => null),
      adminFetch("/admin/equipment/job-costs?limit=30").catch(() => ({
        costs: [],
      })),
    ]).then(([s, c]) => {
      setSummary(normalizeJobCostSummary(s));
      setCosts(c.job_costs || c.costs || []);
      setLoading(false);
    });
  }, []);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading job costs...
      </div>
    );

  return (
    <div>
      {summary && (
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          {[
            {
              label: "Avg Margin",
              value: summary.avgMargin != null
                ? `${summary.avgMargin.toFixed(1)}%`
                : "—",
              color:
                summary.avgMargin == null || summary.avgMargin >= 50
                  ? D.green
                  : D.amber,
            },
            {
              label: "Avg Revenue/Job",
              value: fmt(summary.avgRevenue),
              color: D.green,
            },
            {
              label: "Avg Cost/Job",
              value: fmt(summary.avgCost),
              color: D.amber,
            },
            {
              label: "Total Jobs Costed",
              value: summary.totalJobs || 0,
              color: D.heading,
            },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                ...sCard,
                flex: isMobile ? "1 1 calc(50% - 6px)" : "1 1 140px",
                minWidth: isMobile ? 0 : 140,
                marginBottom: 0,
                textAlign: "center",
              }}
            >
              {" "}
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: isMobile ? 18 : 22,
                  fontWeight: 700,
                  color: s.color,
                }}
              >
                {s.value}
              </div>{" "}
              <div
                style={{
                  fontSize: 9,
                  color: D.muted,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginTop: 2,
                }}
              >
                {s.label}
              </div>{" "}
            </div>
          ))}
        </div>
      )}

      {/* By service type */}
      {summary?.byServiceType && (
        <div style={sCard}>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Margins by Service Type
          </div>
          {Object.entries(summary.byServiceType).map(([svc, stats]) => (
            <div
              key={svc}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: `1px solid ${D.border}22`,
                fontSize: 12,
              }}
            >
              {" "}
              <span style={{ color: D.heading, fontWeight: 500 }}>
                {svc}
              </span>{" "}
              <div style={{ display: "flex", gap: 16 }}>
                {" "}
                <span style={{ color: D.muted }}>{stats.count} jobs</span>{" "}
                <span style={{ color: D.green, fontFamily: MONO }}>
                  Rev: {fmt(stats.avgRevenue)}
                </span>{" "}
                <span style={{ color: D.amber, fontFamily: MONO }}>
                  Cost: {fmt(stats.avgCost)}
                </span>{" "}
                <span
                  style={{
                    color: stats.avgMargin >= 50 ? D.green : D.amber,
                    fontFamily: MONO,
                    fontWeight: 700,
                  }}
                >
                  {stats.avgMargin?.toFixed(1)}%
                </span>{" "}
              </div>{" "}
            </div>
          ))}
        </div>
      )}

      {costs.length === 0 && (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No job costs recorded yet
        </div>
      )}
    </div>
  );
}

// ── Maintenance Tab ──
function MaintenanceTab({ showToast }) {
  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch("/admin/equipment/equipment")
      .then((d) => {
        const items = (d.equipment || []).filter((e) => {
          const hoursLeft = e.next_service_hours
            ? e.next_service_hours - (e.current_hours || 0)
            : null;
          return hoursLeft !== null && hoursLeft <= 50;
        });
        setEquipment(items);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading...
      </div>
    );

  return (
    <div>
      {" "}
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Upcoming Maintenance
      </div>
      {equipment.length === 0 ? (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No equipment needs service soon
        </div>
      ) : (
        equipment.map((e) => {
          const hoursLeft = e.next_service_hours - (e.current_hours || 0);
          return (
            <div
              key={e.id}
              style={{
                ...sCard,
                borderLeft: `3px solid ${hoursLeft <= 10 ? D.red : D.amber}`,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                {" "}
                <div>
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 600, color: D.heading }}
                  >
                    {e.name}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted }}>
                    {e.next_service_type} — in {Math.round(hoursLeft)} hours
                  </div>{" "}
                </div>{" "}
                <button
                  onClick={async () => {
                    try {
                      await adminFetch(
                        `/admin/equipment/equipment/${e.id}/maintenance`,
                        {
                          method: "POST",
                          body: JSON.stringify({
                            service_type: e.next_service_type,
                            hours_at_service: e.current_hours,
                          }),
                        },
                      );
                      showToast("Maintenance logged");
                    } catch (err) {
                      showToast(`Failed: ${err.message}`);
                    }
                  }}
                  style={sBtn(D.green, D.white)}
                >
                  Mark Complete
                </button>{" "}
              </div>{" "}
            </div>
          );
        })
      )}
    </div>
  );
}
