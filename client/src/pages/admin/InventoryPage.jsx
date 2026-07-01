import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  ClipboardList,
  FileText,
  Package,
  Percent,
  Plus,
  ShoppingCart,
  ShieldCheck,
  Store,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
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

function safeExternalHref(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function formatMoney(value, decimals = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `$${numeric.toFixed(decimals)}`;
}

function formatUnitCost(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !unit) return "—";
  const decimals = numeric >= 10 ? 2 : 4;
  return `${formatMoney(numeric, decimals)}/${unit}`;
}

// Format a single $/unit value, widening decimals for sub-cent prices.
function formatPerUnit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const abs = Math.abs(numeric);
  let decimals = 2;
  if (abs < 0.1) decimals = 4;
  if (abs < 0.001) decimals = 6;
  return `$${numeric.toFixed(decimals)}`;
}

// Render a server-provided unitPrices array as "$/g · $/oz · $/lb".
function formatUnitPriceList(unitPrices) {
  if (!Array.isArray(unitPrices) || unitPrices.length === 0) return null;
  const parts = unitPrices
    .map((u) => {
      const formatted = formatPerUnit(u?.pricePerUnit);
      return formatted ? `${formatted}/${u.unit}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
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
  padding: "8px 12px",
  background: D.input,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.text,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};
const thS = {
  fontSize: 10,
  color: D.muted,
  textTransform: "uppercase",
  letterSpacing: 1,
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: `1px solid ${D.border}`,
};
const tdS = {
  padding: "10px",
  borderBottom: `1px solid ${D.border}22`,
  fontSize: 13,
  color: D.text,
};

// The flat 13-tab bar is organized into parent groups, each revealing its leaf
// tabs in a sub-row. `tab` state still holds the LEAF key, so every
// {tab === "..."} render block below is unchanged.
const TAB_GROUPS = [
  { key: "products", label: "Products", Icon: Package, tabs: ["products"] },
  {
    key: "vendors",
    label: "Vendors & Pricing",
    Icon: Store,
    tabs: ["price-sync", "approvals", "vendors", "scrape"],
  },
  {
    key: "planning",
    label: "Planning",
    Icon: ShoppingCart,
    tabs: ["forecast", "unit-review", "restock"],
  },
  {
    key: "content",
    label: "Content",
    Icon: ClipboardList,
    tabs: ["registry", "lawnFacts", "lawnContent"],
  },
  {
    key: "protocols",
    label: "Protocols",
    Icon: FileText,
    tabs: ["protocols", "margins"],
  },
];

const LEAF_META = {
  products: { label: "Products", Icon: Package },
  "price-sync": { label: "Price Sync", Icon: Store },
  approvals: { label: "Approvals", Icon: CheckCircle2 },
  vendors: { label: "Vendors", Icon: Store },
  scrape: { label: "Scrape Health", Icon: ShieldCheck },
  forecast: { label: "Forecast", Icon: ShoppingCart },
  "unit-review": { label: "Unit Review", Icon: ClipboardList },
  restock: { label: "Restock", Icon: ShoppingCart },
  registry: { label: "Registry", Icon: ClipboardList },
  lawnFacts: { label: "Lawn Facts", Icon: ShieldCheck },
  lawnContent: { label: "Lawn Content", Icon: FileText },
  protocols: { label: "Protocols", Icon: FileText },
  margins: { label: "Service Margins", Icon: Percent },
};

const ALL_LEAF_TABS = TAB_GROUPS.flatMap((g) => g.tabs);

export default function InventoryPage() {
  const [searchParams] = useSearchParams();
  const initialTab = ALL_LEAF_TABS.includes(searchParams.get("tab"))
    ? searchParams.get("tab")
    : "products";
  const [tab, setTab] = useState(initialTab);
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState("");
  const [productFilter, setProductFilter] = useState("all");
  const [showAddForm, setShowAddForm] = useState(false);

  const loadStats = () =>
    adminFetch("/admin/inventory/stats")
      .then(setStats)
      .catch(() => {});
  useEffect(() => {
    loadStats();
  }, []);
  const showToast = (m) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };

  const activeGroup =
    TAB_GROUPS.find((g) => g.tabs.includes(tab)) || TAB_GROUPS[0];
  const groupSections = TAB_GROUPS.map((g) => {
    let pending = 0;
    if (g.tabs.includes("approvals")) pending += stats?.approvals?.pending || 0;
    if (g.tabs.includes("restock")) pending += stats?.restockRequests?.open || 0;
    return {
      key: g.key,
      label: pending > 0 ? `${g.label} (${pending})` : g.label,
      Icon: g.Icon,
    };
  });
  const leafLabel = (key) => {
    if (key === "approvals" && stats?.approvals?.pending > 0)
      return `Approvals (${stats.approvals.pending})`;
    if (key === "restock" && stats?.restockRequests?.open > 0)
      return `Restock (${stats.restockRequests.open})`;
    return LEAF_META[key].label;
  };

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      {" "}
      <AdminCommandHeader
        title="Inventory"
        icon={Package}
        sections={groupSections}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = TAB_GROUPS.find((x) => x.key === key);
          if (g) setTab(g.tabs[0]);
        }}
        ariaLabel="Inventory section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
        action={
          tab === "products"
            ? {
                label: "Add Product",
                icon: Plus,
                onClick: () => setShowAddForm((s) => !s),
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
            const active = tab === key;
            const LeafIcon = LEAF_META[key].Icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
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
                {leafLabel(key)}
              </button>
            );
          })}
        </div>
      )}
      {stats && (
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
              label: "Products",
              value: stats.products?.total,
              color: D.heading,
              filter: "all",
            },
            {
              label: "Priced",
              value: stats.products?.priced,
              color: D.green,
              filter: "priced",
            },
            {
              label: "Needs Price",
              value: stats.products?.needsPrice,
              color: D.amber,
              filter: "needs_price",
            },
            {
              label: "Low Stock",
              value: stats.products?.lowStock,
              color: stats.products?.lowStock > 0 ? D.red : D.green,
              filter: "low_stock",
            },
            {
              label: "Vendors",
              value: stats.vendors?.total,
              color: D.teal,
              action: () => setTab("vendors"),
            },
            {
              label: "Pending Approvals",
              value: stats.approvals?.pending,
              color: stats.approvals?.pending > 0 ? D.amber : D.green,
              action: () => setTab("approvals"),
            },
            {
              label: "Restock",
              value: stats.restockRequests?.open,
              color: stats.restockRequests?.open > 0 ? D.amber : D.green,
              action: () => setTab("restock"),
            },
            {
              label: "Scrape Jobs",
              value: stats.scrapeJobs?.completed,
              color: D.purple,
              action: () => setTab("scrape"),
            },
          ].map((s) => (
            <div
              key={s.label}
              onClick={() => {
                if (s.action) s.action();
                else if (s.filter) {
                  setTab("products");
                  setProductFilter(s.filter);
                }
              }}
              style={{
                ...sCard,
                flex: "1 1 120px",
                minWidth: 120,
                marginBottom: 0,
                textAlign: "center",
                cursor: "pointer",
              }}
            >
              {" "}
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 22,
                  fontWeight: 700,
                  color: s.color,
                }}
              >
                {s.value ?? 0}
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
      {tab === "products" && (
        <ProductsTab
          showToast={showToast}
          filter={productFilter}
          onFilterChange={setProductFilter}
          showAddForm={showAddForm}
          setShowAddForm={setShowAddForm}
        />
      )}
      {tab === "lawnFacts" && <LawnFactsTab showToast={showToast} />}
      {tab === "lawnContent" && <LawnContentModulesTab showToast={showToast} />}
      {tab === "price-sync" && <PriceSyncTab showToast={showToast} />}
      {tab === "registry" && <RegistryTab showToast={showToast} />}
      {tab === "vendors" && <VendorsTab showToast={showToast} />}
      {tab === "approvals" && (
        <ApprovalsTab showToast={showToast} onUpdate={loadStats} />
      )}
      {tab === "protocols" && (
        <ProtocolsTab
          showToast={showToast}
          initialServiceLine={searchParams.get("serviceLine") || "all"}
          initialAction={
            searchParams.get("add")
              ? "add"
              : searchParams.get("highlight") || ""
          }
        />
      )}
      {tab === "forecast" && <WaveGuardForecastTab showToast={showToast} onUpdate={loadStats} />}
      {tab === "unit-review" && <UnitReviewTab showToast={showToast} />}
      {tab === "restock" && <RestockRequestsTab showToast={showToast} onUpdate={loadStats} />}
      {tab === "margins" && <MarginsTab showToast={showToast} />}
      {tab === "scrape" && <ScrapeTab showToast={showToast} />}
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

function LawnFactsTab({ showToast }) {
  const [facts, setFacts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/inventory/lawn-outline-facts")
      .then((data) => {
        setFacts(data.facts || []);
        setSummary(data.summary || null);
      })
      .catch((err) => showToast(`Load failed: ${err.message}`))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (row) => {
    const p = row.product || {};
    const suggestion = row.suggestedCopy || {};
    setEditing(row);
    setForm({
      productType: p.productType || row.readiness?.productType || suggestion.productType || "",
      customerVisibility: p.customerVisibility || "internal_only",
      contentStatus: p.contentStatus || "draft",
      epaRegNumber: p.epaRegNumber || "",
      publicSummary: p.publicSummary || "",
      portalSummary: p.portalSummary || "",
      customerSafetySummary: p.customerSafetySummary || "",
      customerPrecautionSummary: p.customerPrecautionSummary || "",
      petKidGuidanceText: p.petKidGuidanceText || "",
      reentrySummary: p.reentrySummary || p.reentryText || "",
      labelSourceUrl: p.labelSourceUrl || p.labelUrl || "",
      labelVerifiedAt: p.labelVerifiedAt ? String(p.labelVerifiedAt).slice(0, 10) : "",
      labelVersion: p.labelVersion || "",
    });
  };

  const applySuggestedCopy = () => {
    if (!editing?.suggestedCopy) return;
    const suggestion = editing.suggestedCopy;
    setForm((current) => ({
      ...current,
      productType: current.productType || suggestion.productType || "",
      publicSummary: current.publicSummary || suggestion.publicSummary || "",
      customerPrecautionSummary: current.customerPrecautionSummary || suggestion.customerPrecautionSummary || "",
      reentrySummary: current.reentrySummary || suggestion.reentrySummary || "",
    }));
  };

  const save = async (approve = false) => {
    if (!editing?.product?.id) return;
    try {
      await adminFetch(`/admin/inventory/lawn-outline-facts/${editing.product.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...form, approve }),
      });
      showToast(approve ? "Product fact approved for estimate packets" : "Product fact saved");
      setEditing(null);
      load();
    } catch (err) {
      showToast(err.message || "Save failed");
    }
  };

  const approveRow = async (row) => {
    if (!row?.product?.id) return;
    try {
      await adminFetch(`/admin/inventory/lawn-outline-facts/${row.product.id}`, {
        method: "PATCH",
        body: JSON.stringify({ approve: true }),
      });
      showToast("Product fact approved for estimate packets");
      load();
    } catch (err) {
      showToast(err.message || "Approve failed");
    }
  };

  const badge = (status) => {
    const colors = {
      approved: [D.green, "#DCFCE7"],
      ready_to_approve: [D.teal, "#E0F2FE"],
      needs_facts: [D.amber, "#FEF3C7"],
      missing_product: [D.red, "#FEE2E2"],
    };
    const [fg, bg] = colors[status] || [D.muted, "#F4F4F5"];
    return <span style={sBadge(bg, fg)}>{String(status || "unknown").replaceAll("_", " ")}</span>;
  };

  if (loading) return <div style={sCard}>Loading lawn product facts...</div>;
  const visibleFacts = statusFilter === "all"
    ? facts
    : facts.filter((row) => row.readiness?.status === statusFilter);
  const missingFieldEntries = Object.entries(summary?.missingFields || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div>
      <div style={{ ...sCard, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
        {[
          ["Protocol Products", summary?.total || 0],
          ["Approved", summary?.approved || 0],
          ["Ready", summary?.ready_to_approve || 0],
          ["Needs Facts", summary?.needs_facts || 0],
          ["Missing", summary?.missing_product || 0],
        ].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: D.heading }}>{value}</div>
            <div style={{ fontSize: 10, color: D.muted, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
          </div>
        ))}
      </div>

      {missingFieldEntries.length > 0 && (
        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginBottom: 10 }}>Most Common Readiness Gaps</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {missingFieldEntries.map(([field, count]) => (
              <span key={field} style={sBadge("#FEF3C7", D.amber)}>{field} · {count}</span>
            ))}
          </div>
        </div>
      )}

      <div style={sCard}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 6 }}>Lawn Estimate Product Facts</div>
            <div style={{ fontSize: 13, color: D.muted }}>
              Product cards in lawn service outlines only render from products approved here. Draft or incomplete products stay hidden.
            </div>
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...sInput, minWidth: 190 }}>
            <option value="all">All statuses</option>
            <option value="missing_product">Missing product</option>
            <option value="needs_facts">Needs facts</option>
            <option value="ready_to_approve">Ready to approve</option>
            <option value="approved">Approved</option>
          </select>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thS}>Protocol item</th>
                <th style={thS}>Used In</th>
                <th style={thS}>Catalog match</th>
                <th style={thS}>Status</th>
                <th style={thS}>Missing</th>
                <th style={thS}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleFacts.map((row) => (
                <tr key={row.key || row.needle}>
                  <td style={tdS}>
                    <div style={{ fontWeight: 700, color: D.heading }}>{row.needle}</div>
                    <div style={{ fontSize: 11, color: D.muted }}>{row.expectedCategory}</div>
                  </td>
                  <td style={tdS}>
                    <div style={{ fontSize: 12, color: D.heading }}>{(row.turfTracks || []).join(", ")}</div>
                    <div style={{ fontSize: 11, color: D.muted }}>{(row.months || []).join(", ")} · {row.referenceCount || 0} refs</div>
                  </td>
                  <td style={tdS}>
                    {row.product ? (
                      <>
                        <div style={{ fontWeight: 700, color: D.heading }}>{row.product.name}</div>
                        <div style={{ fontSize: 11, color: D.muted }}>
                          {row.product.productType || row.readiness?.productType || "type pending"} · {row.product.contentStatus} · {row.product.customerVisibility}
                        </div>
                      </>
                    ) : (
                      <span style={{ color: D.red }}>No product match</span>
                    )}
                  </td>
                  <td style={tdS}>{badge(row.readiness?.status)}</td>
                  <td style={tdS}>
                    {(row.readiness?.missing || []).length ? (
                      <ul style={{ margin: 0, paddingLeft: 18, maxWidth: 360 }}>
                        {row.readiness.missing.map((m) => <li key={m}>{m}</li>)}
                      </ul>
                    ) : (
                      <span style={{ color: D.green }}>Complete</span>
                    )}
                  </td>
                  <td style={tdS}>
                    {row.product && (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button type="button" style={sBtn(D.card, D.heading)} onClick={() => startEdit(row)}>Edit</button>
                        {row.readiness?.eligible && row.readiness?.status !== "approved" && (
                          <button type="button" style={sBtn(D.green, D.white)} onClick={() => approveRow(row)}>Approve</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleFacts.length === 0 && <div style={{ padding: 18, color: D.muted }}>No products match this status.</div>}
        </div>
      </div>

      {editing && (
        <div style={{ ...sCard, borderColor: D.heading }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>Edit Product Fact</div>
              <div style={{ fontSize: 13, color: D.muted }}>{editing.product?.name}</div>
            </div>
            <button type="button" style={sBtn(D.card, D.heading)} onClick={() => setEditing(null)}>Close</button>
          </div>
          {editing.suggestedCopy && (
            <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 12, marginBottom: 14, background: D.bg }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: D.heading }}>Starter copy</div>
              <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.6, marginTop: 4 }}>
                This is draft customer-safe language from the protocol item category. It does not approve EPA numbers, label claims, or product eligibility.
              </div>
              <button type="button" style={{ ...sBtn(D.card, D.heading), marginTop: 10 }} onClick={applySuggestedCopy}>Fill empty copy fields</button>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            {[
              ["productType", "Product type"],
              ["customerVisibility", "Visibility"],
              ["contentStatus", "Content status"],
              ["epaRegNumber", "EPA registration number"],
              ["labelSourceUrl", "Label source URL"],
              ["labelVerifiedAt", "Label verified date"],
              ["labelVersion", "Label version"],
            ].map(([key, label]) => (
              <label key={key} style={{ display: "block" }}>
                <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{label}</div>
                <input
                  type={key === "labelVerifiedAt" ? "date" : "text"}
                  value={form[key] || ""}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  style={{ ...sInput, width: "100%" }}
                />
              </label>
            ))}
          </div>
          {[
            ["publicSummary", "Public summary"],
            ["portalSummary", "Portal summary"],
            ["customerSafetySummary", "Customer safety summary"],
            ["customerPrecautionSummary", "Customer precaution summary"],
            ["petKidGuidanceText", "Pet/child guidance"],
            ["reentrySummary", "Re-entry summary"],
          ].map(([key, label]) => (
            <label key={key} style={{ display: "block", marginTop: 12 }}>
              <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{label}</div>
              <textarea
                value={form[key] || ""}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                style={{ ...sInput, width: "100%", minHeight: 72, resize: "vertical" }}
              />
            </label>
          ))}
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button type="button" style={sBtn(D.heading, D.white)} onClick={() => save(false)}>Save</button>
            <button type="button" style={sBtn(D.green, D.white)} onClick={() => save(true)}>Save + Approve</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LawnContentModulesTab({ showToast }) {
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState("all");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/service-outlines/content-modules")
      .then((data) => setModules(data.modules || []))
      .catch((err) => showToast(`Load failed: ${err.message}`))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const latest = [];
  const seen = new Set();
  for (const module of modules) {
    if (seen.has(module.key)) continue;
    seen.add(module.key);
    latest.push(module);
  }
  const keys = ["all", ...latest.map((module) => module.key)];
  const visible = selectedKey === "all" ? latest : latest.filter((module) => module.key === selectedKey);

  const startEdit = (module) => {
    setEditing(module);
    setForm({
      title: module.title || "",
      audience: module.audience || "estimate_packet",
      status: module.status || "draft",
      plainText: module.plain_text || "",
      sourceNotes: module.source_notes || "",
    });
  };

  const save = async (status = form.status) => {
    if (!editing?.id) return;
    try {
      await adminFetch(`/admin/service-outlines/content-modules/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...form, status }),
      });
      showToast(status === "approved" ? "Content module approved" : "Content module saved");
      setEditing(null);
      load();
    } catch (err) {
      showToast(err.message || "Save failed");
    }
  };

  if (loading) return <div style={sCard}>Loading lawn content modules...</div>;

  return (
    <div>
      <div style={sCard}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>Lawn Outline Content Library</div>
            <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
              These approved modules power the public page, estimate packet, and service-report language.
            </div>
          </div>
          <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} style={{ ...sInput, minWidth: 240 }}>
            {keys.map((key) => (
              <option key={key} value={key}>{key === "all" ? "All modules" : key}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={sCard}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thS}>Key</th>
                <th style={thS}>Title</th>
                <th style={thS}>Audience</th>
                <th style={thS}>Status</th>
                <th style={thS}>Copy</th>
                <th style={thS}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((module) => (
                <tr key={module.id}>
                  <td style={tdS}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{module.key}</div>
                    <div style={{ fontSize: 11, color: D.muted }}>v{module.version}</div>
                  </td>
                  <td style={tdS}>{module.title}</td>
                  <td style={tdS}>{module.audience}</td>
                  <td style={tdS}>
                    <span style={sBadge(module.status === "approved" ? "#DCFCE7" : "#FEF3C7", module.status === "approved" ? D.green : D.amber)}>
                      {module.status}
                    </span>
                  </td>
                  <td style={{ ...tdS, maxWidth: 460 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                      {module.plain_text}
                    </div>
                  </td>
                  <td style={tdS}>
                    <button type="button" style={sBtn(D.card, D.heading)} onClick={() => startEdit(module)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div style={{ ...sCard, borderColor: D.heading }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>Edit Content Module</div>
              <div style={{ fontSize: 13, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>{editing.key}</div>
            </div>
            <button type="button" style={sBtn(D.card, D.heading)} onClick={() => setEditing(null)}>Close</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <label>
              <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Title</div>
              <input value={form.title || ""} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} style={{ ...sInput, width: "100%" }} />
            </label>
            <label>
              <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Audience</div>
              <select value={form.audience || "estimate_packet"} onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))} style={{ ...sInput, width: "100%" }}>
                <option value="public">Public</option>
                <option value="estimate_packet">Estimate packet</option>
                <option value="service_report">Service report</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label>
              <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Status</div>
              <select value={form.status || "draft"} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} style={{ ...sInput, width: "100%" }}>
                <option value="draft">Draft</option>
                <option value="review">Review</option>
                <option value="approved">Approved</option>
                <option value="deprecated">Deprecated</option>
                <option value="retired">Retired</option>
              </select>
            </label>
          </div>
          <label style={{ display: "block", marginTop: 12 }}>
            <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Approved copy</div>
            <textarea
              value={form.plainText || ""}
              onChange={(e) => setForm((f) => ({ ...f, plainText: e.target.value }))}
              style={{ ...sInput, width: "100%", minHeight: 140, resize: "vertical" }}
            />
          </label>
          <label style={{ display: "block", marginTop: 12 }}>
            <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Source notes</div>
            <textarea
              value={form.sourceNotes || ""}
              onChange={(e) => setForm((f) => ({ ...f, sourceNotes: e.target.value }))}
              style={{ ...sInput, width: "100%", minHeight: 72, resize: "vertical" }}
            />
          </label>
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button type="button" style={sBtn(D.heading, D.white)} onClick={() => save()}>Save</button>
            <button type="button" style={sBtn(D.green, D.white)} onClick={() => save("approved")}>Save + Approve</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PRICE SYNC TAB — control layer shell, no connector execution
// ══════════════════════════════════════════════════════════════
function PriceSyncTab({ showToast }) {
  const [view, setView] = useState("vendors");
  const [vendors, setVendors] = useState([]);
  const [needsMapping, setNeedsMapping] = useState([]);
  const [reviewQueue, setReviewQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [csvPreview, setCsvPreview] = useState("");
  const [csvName, setCsvName] = useState("");
  const [mappingImportCsv, setMappingImportCsv] = useState("");
  const [importResult, setImportResult] = useState(null);
  const [loginDiscoveryLimit, setLoginDiscoveryLimit] = useState(50);
  const [loginDiscoveryQueueing, setLoginDiscoveryQueueing] = useState(false);
  const [loginDiscoveryResult, setLoginDiscoveryResult] = useState(null);
  const [autoMapId, setAutoMapId] = useState(null);
  const showToastRef = useRef(showToast);

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vendorData, mappingData, reviewData] = await Promise.all([
        adminFetch("/admin/inventory/price-sync/vendors"),
        adminFetch("/admin/inventory/price-sync/needs-mapping"),
        adminFetch("/admin/inventory/price-sync/review-queue"),
      ]);
      setVendors(vendorData.vendors || []);
      setNeedsMapping(mappingData.products || []);
      setReviewQueue(reviewData.approvals || []);
    } catch (e) {
      showToastRef.current?.(`Price Sync failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadCsv = async (type) => {
    try {
      const path =
        type === "manual_seed"
          ? "/admin/inventory/price-sync/manual-seed-template"
          : `/admin/inventory/price-sync/mappings/export?mode=${type}`;
      const data = await adminFetch(path);
      setCsvPreview(data.csv || "");
      setCsvName(data.filename || "price-sync.csv");
      showToast?.("CSV template loaded");
    } catch (e) {
      showToast?.(`CSV failed: ${e.message}`);
    }
  };

  const copyCsv = async () => {
    if (!csvPreview) return;
    await navigator.clipboard.writeText(csvPreview);
    showToast?.(`${csvName} copied`);
  };

  const importMappings = async () => {
    if (!mappingImportCsv.trim()) {
      showToast?.("Paste mapping CSV first");
      return;
    }
    try {
      const result = await adminFetch(
        "/admin/inventory/price-sync/mappings/import",
        {
          method: "POST",
          body: JSON.stringify({ csv: mappingImportCsv }),
        },
      );
      setImportResult(result);
      showToast?.(result.message || "Mapping import finished");
      await load();
    } catch (e) {
      showToast?.(`Import failed: ${e.message}`);
    }
  };

  const autoMapVendor = async (vendorId) => {
    setAutoMapId(vendorId);
    try {
      const result = await adminFetch("/admin/inventory/price-sync/auto-map", {
        method: "POST",
        body: JSON.stringify({ vendorId, limit: 8 }),
      });
      showToast?.(result.message || `Auto-mapped ${result.mapped || 0} products`);
      await load();
    } catch (e) {
      showToast?.(`Auto-map failed: ${e.message}`);
    } finally {
      setAutoMapId(null);
    }
  };

  const queueLoginDiscovery = async () => {
    setLoginDiscoveryQueueing(true);
    try {
      const result = await adminFetch("/admin/inventory/price-sync/hermes-login-discovery", {
        method: "POST",
        body: JSON.stringify({
          limit: loginDiscoveryLimit,
          includePublic: false,
        }),
      });
      setLoginDiscoveryResult(result);
      showToast?.(result.message || "Hermes login discovery queued");
      await load();
    } catch (e) {
      showToast?.(`Login discovery failed: ${e.message}`);
    } finally {
      setLoginDiscoveryQueueing(false);
    }
  };

  if (loading) {
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading price sync...
      </div>
    );
  }

  const totalConnections = vendors.reduce(
    (sum, vendor) => sum + (vendor.connections?.length || 0),
    0,
  );
  const verifiedMappings = vendors.reduce(
    (sum, vendor) => sum + (vendor.verifiedMappings || 0),
    0,
  );
  const currentPrices = vendors.reduce(
    (sum, vendor) => sum + (vendor.currentPrices || 0),
    0,
  );
  const loginDiscoveryVendors = vendors.filter(
    (vendor) => vendor.loginDiscoveryNeeded || vendor.loginDiscoveryStatus,
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {[
          { label: "Vendors", value: vendors.length },
          { label: "Connections", value: totalConnections },
          { label: "Needs Mapping", value: needsMapping.length },
          { label: "Verified Maps", value: verifiedMappings },
          { label: "Current Prices", value: currentPrices },
          { label: "Needs Login", value: loginDiscoveryVendors.length },
          { label: "Pending Review", value: reviewQueue.length },
        ].map((item) => (
          <div
            key={item.label}
            style={{
              ...sCard,
              flex: "1 1 130px",
              minWidth: 130,
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 22,
                fontWeight: 700,
                color: item.value ? D.heading : D.muted,
              }}
            >
              {item.value}
            </div>
            <div
              style={{
                fontSize: 9,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 1,
                marginTop: 2,
              }}
            >
              {item.label}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          { key: "vendors", label: "Vendor Sync Status" },
          { key: "mapping", label: "Needs Mapping" },
          { key: "login", label: "Login Discovery" },
          { key: "csv", label: "CSV Import / Export" },
          { key: "review", label: "Price Review Queue" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setView(tab.key)}
            style={{
              padding: "7px 14px",
              borderRadius: 20,
              border: "none",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              background: view === tab.key ? D.teal : D.card,
              color: view === tab.key ? D.white : D.muted,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {view === "vendors" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[
                  "Vendor",
                  "Connections",
                  "Mapped",
                  "Verified",
                  "Current",
                  "Best",
                  "Pending",
                  "Next Action",
                ].map((h) => (
                  <th key={h} style={thS}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vendors.map((vendor) => (
                <tr key={vendor.id}>
                  <td style={{ ...tdS, fontWeight: 700, color: D.heading }}>
                    {vendor.name}
                  </td>
                  <td style={tdS}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {(vendor.connections || []).map((connection) => (
                        <span
                          key={connection.id}
                          style={sBadge(
                            connection.credentialStatus === "missing"
                              ? `${D.amber}22`
                              : `${D.green}22`,
                            connection.credentialStatus === "missing"
                              ? D.amber
                              : D.green,
                          )}
                          title={`${connection.approvalStatus} / ${connection.credentialStatus}`}
                        >
                          {connection.type}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={tdS}>{vendor.mappedProducts}</td>
                  <td style={tdS}>{vendor.verifiedMappings}</td>
                  <td style={tdS}>{vendor.currentPrices}</td>
                  <td style={tdS}>{vendor.bestPrices}</td>
                  <td style={tdS}>{vendor.pendingApprovals}</td>
                  <td style={{ ...tdS, color: D.muted }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span>{vendor.nextAction}</span>
                      {(vendor.nextAction === "Needs mapping" || vendor.nextAction === "Verify mappings") && (
                        <button
                          onClick={() => autoMapVendor(vendor.id)}
                          disabled={autoMapId === vendor.id}
                          title="AI-propose vendor SKUs/URLs for this vendor's unmapped products (writes unverified — review before pricing)"
                          style={{
                            ...sBtn(D.teal, D.white),
                            padding: "4px 10px",
                            fontSize: 11,
                            opacity: autoMapId === vendor.id ? 0.6 : 1,
                            cursor: autoMapId === vendor.id ? "default" : "pointer",
                          }}
                        >
                          {autoMapId === vendor.id ? "Mapping…" : "Auto-map"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "mapping" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[
                  "Product",
                  "Category",
                  "SKU",
                  "Package",
                  "Status",
                  "Mapped",
                  "Verified",
                  "Package Maps",
                ].map((h) => (
                  <th key={h} style={thS}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {needsMapping.map((product) => (
                <tr key={product.id}>
                  <td style={{ ...tdS, fontWeight: 700, color: D.heading }}>
                    {product.name}
                  </td>
                  <td style={tdS}>{product.category || "—"}</td>
                  <td style={tdS}>{product.sku || "—"}</td>
                  <td style={tdS}>{product.containerSize || "—"}</td>
                  <td style={tdS}>
                    <span style={sBadge(`${D.amber}22`, D.amber)}>
                      {product.bestPriceStatus || "needs_mapping"}
                    </span>
                  </td>
                  <td style={tdS}>{product.mappedVendors}</td>
                  <td style={tdS}>{product.verifiedMappings}</td>
                  <td style={tdS}>{product.completePackageMaps}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {needsMapping.length === 0 && (
            <div style={{ ...sCard, color: D.muted, textAlign: "center" }}>
              All active products have verified mappings.
            </div>
          )}
        </div>
      )}

      {view === "login" && (
        <div style={sCard}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
            <div>
              <h3 style={{ margin: "0 0 4px", color: D.heading, fontSize: 18 }}>Hermes Vendor Login Discovery</h3>
              <div style={{ color: D.muted, fontSize: 13 }}>
                Queue active vendors missing login setup so Hermes can find portal, registration, and rep-contact paths.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label>
                <div style={{ fontSize: 10, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Vendor cap</div>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={loginDiscoveryLimit}
                  onChange={(e) => setLoginDiscoveryLimit(e.target.value)}
                  style={{ ...sInput, width: 110 }}
                />
              </label>
              <button
                type="button"
                onClick={queueLoginDiscovery}
                disabled={loginDiscoveryQueueing}
                style={sBtn(loginDiscoveryQueueing ? D.card : D.green, loginDiscoveryQueueing ? D.muted : D.white)}
              >
                {loginDiscoveryQueueing ? "Queueing..." : "Queue Hermes"}
              </button>
            </div>
          </div>

          {loginDiscoveryResult && (
            <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, marginBottom: 12, color: D.text, fontSize: 12, background: D.input }}>
              Queued {loginDiscoveryResult.queued || 0}; skipped open jobs {loginDiscoveryResult.duplicates || 0}; candidates {loginDiscoveryResult.candidateCount || 0}.
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Vendor", "Website", "Login URL", "Credentials", "Status", "Hermes"].map((h) => (
                    <th key={h} style={thS}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loginDiscoveryVendors.map((vendor) => {
                  const websiteHref = safeExternalHref(vendor.website);
                  const loginHref = safeExternalHref(vendor.loginUrl);
                  return (
                    <tr key={vendor.id}>
                      <td style={{ ...tdS, fontWeight: 700, color: D.heading }}>{vendor.name}</td>
                      <td style={tdS}>
                        {websiteHref ? (
                          <a href={websiteHref} target="_blank" rel="noopener noreferrer" style={{ color: D.teal }}>
                            {vendor.website}
                          </a>
                        ) : (vendor.website || "—")}
                      </td>
                      <td style={tdS}>
                        {loginHref ? (
                          <a href={loginHref} target="_blank" rel="noopener noreferrer" style={{ color: D.teal }}>
                            {vendor.loginUrl}
                          </a>
                        ) : (vendor.loginUrl || "—")}
                      </td>
                      <td style={tdS}>{vendor.hasCredentials ? "Saved login metadata" : "Missing"}</td>
                      <td style={tdS}>
                        <span style={sBadge(vendor.loginDiscoveryNeeded ? `${D.amber}22` : `${D.green}22`, vendor.loginDiscoveryNeeded ? D.amber : D.green)}>
                          {vendor.credentialStatus || "needs_login"}
                        </span>
                      </td>
                      <td style={tdS}>{vendor.loginDiscoveryStatus || "not queued"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {loginDiscoveryVendors.length === 0 && (
              <div style={{ color: D.muted, textAlign: "center", padding: 18 }}>
                No vendors currently need login discovery.
              </div>
            )}
          </div>
        </div>
      )}

      {view === "csv" && (
        <div style={sCard}>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 12,
            }}
          >
            <button onClick={() => loadCsv("needs_mapping")} style={sBtn(D.teal, D.white)}>
              Needs Mapping Export
            </button>
            <button onClick={() => loadCsv("existing")} style={sBtn(D.teal, D.white)}>
              Existing Mappings Export
            </button>
            <button onClick={() => loadCsv("manual_seed")} style={sBtn(D.teal, D.white)}>
              Manual Seed Template
            </button>
            <button
              onClick={copyCsv}
              disabled={!csvPreview}
              style={sBtn(csvPreview ? D.green : D.card, csvPreview ? D.white : D.muted)}
            >
              Copy CSV
            </button>
          </div>
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>
            Mapping import writes verified product mappings only. Manual seed
            price import remains disabled until the pricing approval worker is
            built.
          </div>
          <textarea
            readOnly
            value={csvPreview}
            placeholder="Choose an export/template..."
            style={{
              ...sInput,
              width: "100%",
              minHeight: 260,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
            }}
          />
          <div
            style={{
              marginTop: 16,
              borderTop: `1px solid ${D.border}`,
              paddingTop: 14,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              Mapping Import
            </div>
            <textarea
              value={mappingImportCsv}
              onChange={(e) => setMappingImportCsv(e.target.value)}
              placeholder="Paste mapping CSV here..."
              style={{
                ...sInput,
                width: "100%",
                minHeight: 180,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={importMappings} style={sBtn(D.green, D.white)}>
                Import Mappings
              </button>
              <button
                onClick={() => {
                  setMappingImportCsv("");
                  setImportResult(null);
                }}
                style={sBtn(D.card, D.muted)}
              >
                Clear
              </button>
            </div>
            {importResult && (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  border: `1px solid ${D.border}`,
                  borderRadius: 8,
                  fontSize: 12,
                  color: D.text,
                  background: D.input,
                }}
              >
                <div>
                  Imported {importResult.imported || 0} of{" "}
                  {importResult.rowsReceived || 0} rows.
                </div>
                {(importResult.rowErrors || []).slice(0, 8).map((err) => (
                  <div key={err.row} style={{ color: D.red, marginTop: 4 }}>
                    Row {err.row}: {(err.errors || []).join("; ")}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {view === "review" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[
                  "Product",
                  "Vendor",
                  "Old",
                  "New",
                  "Change",
                  "Source",
                  "Confidence",
                  "Reason",
                  "Captured",
                ].map((h) => (
                  <th key={h} style={thS}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reviewQueue.map((approval) => (
                <tr key={approval.id}>
                  <td style={{ ...tdS, fontWeight: 700, color: D.heading }}>
                    {approval.productName}
                  </td>
                  <td style={tdS}>{approval.vendorName}</td>
                  <td style={tdS}>{approval.oldPrice != null ? `$${approval.oldPrice.toFixed(2)}` : "—"}</td>
                  <td style={tdS}>{approval.newPrice != null ? `$${approval.newPrice.toFixed(2)}` : "—"}</td>
                  <td style={tdS}>{approval.changePercent != null ? `${approval.changePercent.toFixed(1)}%` : "—"}</td>
                  <td style={tdS}>{approval.sourceType || "—"}</td>
                  <td style={tdS}>{approval.confidence != null ? `${Math.round(approval.confidence * 100)}%` : "—"}</td>
                  <td style={{ ...tdS, color: D.muted }}>{approval.approvalReason || "—"}</td>
                  <td style={tdS}>{approval.capturedAt ? new Date(approval.capturedAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {reviewQueue.length === 0 && (
            <div style={{ ...sCard, color: D.muted, textAlign: "center" }}>
              No pending price approvals.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WaveGuardForecastTab({ showToast, onUpdate }) {
  const [days, setDays] = useState(14);
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creatingId, setCreatingId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch(`/admin/inventory/waveguard-forecast?days=${encodeURIComponent(days)}`);
      setForecast(data.forecast || null);
    } catch (err) {
      showToast(`Forecast failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [days, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  async function createRestock(product) {
    const qty = Number(product.recommendedOrderQuantity || product.shortfall || 0);
    if (!qty || qty <= 0) {
      showToast("No forecasted order quantity for this product");
      return;
    }
    setCreatingId(product.productId);
    try {
      const data = await adminFetch(`/admin/inventory/waveguard-forecast/${product.productId}/restock-request`, {
        method: "POST",
        body: JSON.stringify({
          requestedQuantity: qty,
          unit: product.inventoryUnit || product.demandUnit,
          targetStock: product.targetStock,
          neededBy: product.firstShortDate || forecast?.endDate || null,
          priority: product.priority || (product.status === "short" ? "urgent" : "high"),
          forecastDays: forecast?.days,
          committedDemand: product.committedDemand,
          projectedRemaining: product.projectedRemaining,
          firstShortDate: product.firstShortDate,
          reason: `${forecast?.days || days}-day WaveGuard forecast needs ${product.committedDemand} ${product.demandUnit || product.inventoryUnit || ""} of ${product.productName}.`,
        }),
      });
      showToast(data.existing ? "Open restock request already exists" : "Forecast restock request created");
      onUpdate && onUpdate();
      await load();
    } catch (err) {
      showToast(`Restock request failed: ${err.message}`);
    } finally {
      setCreatingId("");
    }
  }

  const products = forecast?.products || [];
  const counts = forecast?.statusCounts || {};
  const statusColor = (status) => {
    if (status === "short") return D.red;
    if (status === "warning" || status === "unit_mismatch") return D.amber;
    if (status === "not_tracked") return D.muted;
    return D.green;
  };
  const statusLabel = (status) => String(status || "ok").replace(/_/g, " ");

  return (
    <div style={sCard}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0, color: D.heading }}>WaveGuard Inventory Forecast</h3>
          <p style={{ margin: "4px 0 0", color: D.muted, fontSize: 13 }}>
            Upcoming lawn protocol demand compared against live product stock.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ ...sInput, width: 130 }}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
          </select>
          <button onClick={load} disabled={loading} style={sBtn(D.card, D.text)}>Refresh</button>
        </div>
      </div>

      {forecast && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          {[
            { label: "Appointments", value: forecast.serviceCount || 0, color: D.heading },
            { label: "Products", value: forecast.productCount || 0, color: D.heading },
            { label: "Short", value: counts.short || 0, color: counts.short ? D.red : D.green },
            { label: "Warnings", value: counts.warning || 0, color: counts.warning ? D.amber : D.green },
            { label: "Unit Review", value: counts.unit_mismatch || 0, color: counts.unit_mismatch ? D.amber : D.green },
          ].map((item) => (
            <div key={item.label} style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: "10px 12px", minWidth: 120 }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: item.color }}>{item.value}</div>
              <div style={{ color: D.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>{item.label}</div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ color: D.muted, fontSize: 13 }}>Building forecast...</div>
      ) : products.length === 0 ? (
        <div style={{ color: D.muted, fontSize: 13 }}>No forecasted WaveGuard product demand in this window.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Product", "Demand", "Stock", "Projected", "Status", "Upcoming", "Action"].map((h) => (
                  <th key={h} style={thS}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.productId}>
                  <td style={tdS}>
                    <strong>{product.productName}</strong>
                    <div style={{ color: D.muted, fontSize: 12 }}>{product.category || "Product"}</div>
                  </td>
                  <td style={tdS}>
                    <strong>{product.committedDemand} {product.demandUnit || product.inventoryUnit || ""}</strong>
                    <div style={{ color: product.conversionConfidence === "needs_review" ? D.amber : D.muted, fontSize: 12 }}>
                      {String(product.conversionConfidence || "exact_unit").replace(/_/g, " ")}
                    </div>
                    {product.unconvertedDemand > 0 && (
                      <div style={{ color: D.amber, fontSize: 12 }}>
                        {product.unconvertedDemand} unit review
                      </div>
                    )}
                  </td>
                  <td style={tdS}>
                    {product.onHand ?? "—"} {product.inventoryUnit || ""}
                    {product.lowStockThreshold != null && (
                      <div style={{ color: D.muted, fontSize: 12 }}>Low at {product.lowStockThreshold}</div>
                    )}
                  </td>
                  <td style={tdS}>
                    {product.projectedRemaining ?? "—"} {product.inventoryUnit || ""}
                    {product.shortfall > 0 && (
                      <div style={{ color: D.red, fontSize: 12 }}>Short {product.shortfall}</div>
                    )}
                  </td>
                  <td style={tdS}>
                    <span style={{
                      padding: "4px 8px",
                      borderRadius: 999,
                      border: `1px solid ${statusColor(product.status)}`,
                      color: statusColor(product.status),
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                    }}>
                      {statusLabel(product.status)}
                    </span>
                    {product.firstShortDate && (
                      <div style={{ color: D.red, fontSize: 12, marginTop: 4 }}>Blocks by {product.firstShortDate}</div>
                    )}
                  </td>
                  <td style={tdS}>
                    {(product.appointments || []).slice(0, 3).map((appt) => (
                      <div key={`${product.productId}-${appt.serviceId}`} style={{ marginBottom: 4 }}>
                        <strong>{appt.scheduledDate}</strong> · {appt.customerName}
                        <div style={{ color: D.muted, fontSize: 12 }}>
                          {appt.amount} {appt.unit}
                          {appt.inventoryAmount != null && appt.inventoryUnit && appt.inventoryUnit !== appt.unit
                            ? ` = ${appt.inventoryAmount} ${appt.inventoryUnit}`
                            : ""}
                          {" · "}{appt.protocolWindowTitle || appt.serviceType}
                        </div>
                      </div>
                    ))}
                    {(product.appointments || []).length > 3 && (
                      <div style={{ color: D.muted, fontSize: 12 }}>+{product.appointments.length - 3} more</div>
                    )}
                  </td>
                  <td style={tdS}>
                    {["short", "warning"].includes(product.status) ? (
                      <button
                        onClick={() => createRestock(product)}
                        disabled={creatingId === product.productId}
                        style={sBtn(D.green, D.white)}
                      >
                        Request {product.recommendedOrderQuantity} {product.inventoryUnit || product.demandUnit || ""}
                      </button>
                    ) : (
                      <span style={{ color: D.muted }}>No request</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(forecast?.errors || []).length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
          <div style={{ color: D.amber, fontWeight: 700, fontSize: 13 }}>Plan errors</div>
          {(forecast.errors || []).slice(0, 5).map((err) => (
            <div key={err.serviceId} style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>
              {err.scheduledDate} · {err.customerName}: {err.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UnitReviewTab({ showToast }) {
  const [data, setData] = useState({ products: [], forecastRows: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [drafts, setDrafts] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminFetch("/admin/inventory/unit-review?days=14");
      setData(result);
    } catch (err) {
      showToast(`Unit review failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  async function fixUnit(product, unit) {
    const inventoryUnit = unit || drafts[product.id]?.inventoryUnit || product.suggestedUnit;
    if (!inventoryUnit) {
      showToast("Choose a unit first");
      return;
    }
    setSavingId(product.id);
    try {
      await adminFetch(`/admin/inventory/unit-review/${product.id}/fix`, {
        method: "POST",
        body: JSON.stringify({
          inventoryUnit,
          convertExistingStock: drafts[product.id]?.convertExistingStock !== false,
        }),
      });
      showToast("Inventory unit updated");
      await load();
    } catch (err) {
      showToast(`Unit fix failed: ${err.message}`);
    } finally {
      setSavingId("");
    }
  }

  const products = data.products || [];
  const forecastRows = data.forecastRows || [];
  const unitChoices = ["fl_oz", "gal", "oz", "lb", "g", "kg", "ml", "l"];

  return (
    <div style={sCard}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0, color: D.heading }}>Inventory Unit Review</h3>
          <p style={{ margin: "4px 0 0", color: D.muted, fontSize: 13 }}>
            Clean up unsupported, missing, and ambiguous inventory units before they affect forecast or closeout math.
          </p>
        </div>
        <button onClick={load} disabled={loading} style={sBtn(D.card, D.text)}>Refresh</button>
      </div>

      {loading ? (
        <div style={{ color: D.muted, fontSize: 13 }}>Loading unit review...</div>
      ) : products.length === 0 && forecastRows.length === 0 ? (
        <div style={{ color: D.green, fontSize: 13 }}>No inventory unit issues found.</div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Product", "Current", "Issues", "Fix"].map((h) => (
                    <th key={h} style={thS}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => {
                  const draft = drafts[product.id] || {};
                  return (
                    <tr key={product.id}>
                      <td style={tdS}>
                        <strong>{product.name}</strong>
                        <div style={{ color: D.muted, fontSize: 12 }}>
                          {product.category || "Product"} · {product.formulation || "unspecified"}
                        </div>
                      </td>
                      <td style={tdS}>
                        {product.inventoryOnHand ?? "—"} {product.inventoryUnit || "no unit"}
                        {product.lowStockThreshold != null && (
                          <div style={{ color: D.muted, fontSize: 12 }}>Low at {product.lowStockThreshold}</div>
                        )}
                      </td>
                      <td style={tdS}>
                        {(product.reasons || []).map((reason) => (
                          <div key={reason.code} style={{ color: reason.severity === "block" ? D.red : D.amber, fontSize: 12, marginBottom: 3 }}>
                            {reason.message}
                          </div>
                        ))}
                      </td>
                      <td style={tdS}>
                        <div style={{ display: "grid", gap: 6, minWidth: 260 }}>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {unitChoices.map((unit) => (
                              <button
                                key={unit}
                                onClick={() => fixUnit(product, unit)}
                                disabled={savingId === product.id}
                                style={sBtn(product.suggestedUnit === unit ? D.green : D.card, product.suggestedUnit === unit ? D.white : D.text)}
                              >
                                {unit}
                              </button>
                            ))}
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <input
                              value={draft.inventoryUnit ?? ""}
                              onChange={(e) => setDrafts((prev) => ({ ...prev, [product.id]: { ...(prev[product.id] || {}), inventoryUnit: e.target.value } }))}
                              style={{ ...sInput, flex: 1 }}
                              placeholder="custom supported unit"
                            />
                            <button onClick={() => fixUnit(product)} disabled={savingId === product.id} style={sBtn(D.teal, D.white)}>Apply</button>
                          </div>
                          <label style={{ color: D.muted, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={draft.convertExistingStock !== false}
                              onChange={(e) => setDrafts((prev) => ({ ...prev, [product.id]: { ...(prev[product.id] || {}), convertExistingStock: e.target.checked } }))}
                            />
                            Convert existing stock and low-stock threshold
                          </label>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {forecastRows.length > 0 && (
            <div style={{ marginTop: 16, borderTop: `1px solid ${D.border}`, paddingTop: 12 }}>
              <h4 style={{ margin: "0 0 8px", color: D.heading }}>Forecast Unit Review</h4>
              {forecastRows.map((row) => (
                <div key={row.productId} style={{ color: D.muted, fontSize: 13, marginBottom: 8 }}>
                  <strong style={{ color: D.text }}>{row.productName}</strong>: {row.unconvertedDemand} {row.demandUnit || "unknown unit"} could not convert to {row.inventoryUnit || "inventory unit"} across {row.unitMismatchCount} appointment{row.unitMismatchCount === 1 ? "" : "s"}.
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PRODUCTS TAB — with inline editing
// ══════════════════════════════════════════════════════════════
function ProductsTab({
  showToast,
  filter = "all",
  onFilterChange,
  showAddForm,
  setShowAddForm,
}) {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [vendors, setVendors] = useState([]);
  const [newProduct, setNewProduct] = useState({
    name: "",
    category: "",
    activeIngredient: "",
    moaGroup: "",
    defaultUnit: "oz",
    inventoryOnHand: "",
    inventoryUnit: "",
    lowStockThreshold: "",
  });
  const [deleting, setDeleting] = useState(null);
  const [page, setPage] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const PER_PAGE = 50;

  const load = useCallback(async () => {
    const needsPricingParam =
      filter === "needs_price"
        ? "&needsPricing=true"
        : filter === "priced"
          ? "&needsPricing=false"
          : "";
    const stockParam = filter === "low_stock" ? "&stock=low" : "";
    const [pData, vData] = await Promise.all([
      adminFetch(
        `/admin/inventory?search=${encodeURIComponent(search)}&category=${encodeURIComponent(catFilter)}&limit=${PER_PAGE}&page=${page}${needsPricingParam}${stockParam}`,
      ),
      adminFetch("/admin/inventory/vendors"),
    ]);
    setProducts(pData.products || []);
    setCategories(pData.categories || []);
    setTotalProducts(pData.total || 0);
    setVendors(vData.vendors || []);
    setLoading(false);
  }, [search, catFilter, page, filter]);

  useEffect(() => {
    load();
  }, [load]);

  const savePrice = async (productId, vendorId, price, quantity) => {
    try {
      await adminFetch(`/admin/inventory/${productId}/pricing`, {
        method: "PUT",
        body: JSON.stringify({
          vendorId,
          price: parseFloat(price),
          quantity,
          sourceType: "manual",
          confidenceScore: 0.8,
        }),
      });
      showToast("Price saved");
      load();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };

  const startEdit = (p, e) => {
    e && e.stopPropagation();
    setEditing(p.id);
    setEditForm({
      name: p.name || "",
      category: p.category || "",
      activeIngredient: p.activeIngredient || "",
      moaGroup: p.moaGroup || "",
      containerSize: p.containerSize || "",
      formulation: p.formulation || "",
      sku: p.sku || "",
      inventoryOnHand: p.inventoryOnHand ?? "",
      inventoryUnit: p.inventoryUnit || "",
      lowStockThreshold: p.lowStockThreshold ?? "",
    });
  };

  const saveEdit = async (id) => {
    try {
      await adminFetch(`/admin/inventory/${id}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      showToast("Product updated");
      setEditing(null);
      load();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading products...
      </div>
    );

  return (
    <div>
      {" "}
      <div
        style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}
      >
        {[
          { key: "all", label: "All Products" },
          { key: "priced", label: "Priced" },
          { key: "needs_price", label: "Needs Price" },
          { key: "low_stock", label: "Low Stock" },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => {
              onFilterChange?.(f.key);
              setPage(1);
            }}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              border: "none",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              background: filter === f.key ? D.teal : D.card,
              color: filter === f.key ? D.white : D.muted,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>{" "}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {" "}
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search products..."
          style={{ ...sInput, flex: 1, minWidth: 200 }}
        />{" "}
        <select
          value={catFilter}
          onChange={(e) => {
            setCatFilter(e.target.value);
            setPage(1);
          }}
          style={{ ...sInput, cursor: "pointer", minWidth: 150 }}
        >
          {" "}
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.count})
            </option>
          ))}
        </select>{" "}
      </div>
      {showAddForm && (
        <div
          style={{
            background: D.card,
            borderRadius: 10,
            padding: 16,
            border: `1px solid ${D.green}44`,
            marginBottom: 16,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 10,
            }}
          >
            New Product
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8,
              marginBottom: 10,
            }}
          >
            {" "}
            <input
              value={newProduct.name}
              onChange={(e) =>
                setNewProduct((p) => ({ ...p, name: e.target.value }))
              }
              placeholder="Product name *"
              style={sInput}
            />{" "}
            <input
              value={newProduct.category}
              onChange={(e) =>
                setNewProduct((p) => ({ ...p, category: e.target.value }))
              }
              placeholder="Category"
              style={sInput}
            />{" "}
            <input
              value={newProduct.activeIngredient}
              onChange={(e) =>
                setNewProduct((p) => ({
                  ...p,
                  activeIngredient: e.target.value,
                }))
              }
              placeholder="Active ingredient"
              style={sInput}
            />{" "}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8,
            }}
          >
            {" "}
            <input
              value={newProduct.moaGroup}
              onChange={(e) =>
                setNewProduct((p) => ({ ...p, moaGroup: e.target.value }))
              }
              placeholder="MOA/FRAC group"
              style={sInput}
            />{" "}
            <select
              value={newProduct.defaultUnit}
              onChange={(e) =>
                setNewProduct((p) => ({ ...p, defaultUnit: e.target.value }))
              }
              style={sInput}
            >
              {" "}
              <option value="oz">oz</option>
              <option value="ml">ml</option>
              <option value="gal">gal</option>
              <option value="lb">lb</option>
              <option value="g">g</option>
              <option value="each">each</option>{" "}
            </select>{" "}
            <div style={{ display: "flex", gap: 6 }}>
              {" "}
              <input
                value={newProduct.inventoryOnHand}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    inventoryOnHand: e.target.value,
                  }))
                }
                type="number"
                step="0.0001"
                placeholder="Stock"
                style={{ ...sInput, width: "100%" }}
              />{" "}
              <input
                value={newProduct.inventoryUnit}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    inventoryUnit: e.target.value,
                  }))
                }
                placeholder="unit"
                style={{ ...sInput, width: 70 }}
              />{" "}
              <input
                value={newProduct.lowStockThreshold}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    lowStockThreshold: e.target.value,
                  }))
                }
                type="number"
                step="0.0001"
                placeholder="low"
                style={{ ...sInput, width: 70 }}
              />{" "}
            </div>{" "}
          </div>{" "}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {" "}
            <button
              onClick={async () => {
                if (!newProduct.name.trim()) {
                  showToast("Product name required");
                  return;
                }
                try {
                  await adminFetch("/admin/inventory", {
                    method: "POST",
                    body: JSON.stringify(newProduct),
                  });
                  showToast("Product added");
                  setNewProduct({
                    name: "",
                    category: "",
                    activeIngredient: "",
                    moaGroup: "",
                    defaultUnit: "oz",
                    inventoryOnHand: "",
                    inventoryUnit: "",
                    lowStockThreshold: "",
                  });
                  setShowAddForm(false);
                  load();
                } catch (e) {
                  showToast("Failed: " + e.message);
                }
              }}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 8,
                border: "none",
                background: D.green,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Save
            </button>{" "}
            <button
              onClick={() => setShowAddForm(false)}
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: "none",
                color: D.muted,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>{" "}
          </div>{" "}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        {" "}
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          {" "}
          <thead>
            <tr>
              {[
                "Product",
                "Category",
                "Active Ingredient",
                "MOA",
                "Size",
                "Stock",
                "Best Price",
                "Unit Cost",
                "Vendor",
                "Status",
                "",
              ].map((h) => (
                <th key={h} style={thS}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>{" "}
          <tbody>
            {products.map((p) => {
              const isEditing = editing === p.id;
              const isExpanded = expanded === p.id && !isEditing;
              return [
                <tr
                  key={p.id}
                  onClick={() =>
                    !isEditing && setExpanded(expanded === p.id ? null : p.id)
                  }
                  style={{
                    cursor: isEditing ? "default" : "pointer",
                    background: isEditing
                      ? `${D.teal}10`
                      : isExpanded
                        ? `${D.teal}08`
                        : "transparent",
                  }}
                >
                  {" "}
                  <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>
                    {isEditing ? (
                      <input
                        value={editForm.name}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, name: e.target.value }))
                        }
                        style={{ ...sInput, width: "100%", fontWeight: 600 }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      p.name
                    )}
                  </td>{" "}
                  <td style={tdS}>
                    {isEditing ? (
                      <input
                        value={editForm.category}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            category: e.target.value,
                          }))
                        }
                        style={{ ...sInput, width: 100 }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span style={sBadge(`${D.teal}22`, D.teal)}>
                        {p.category}
                      </span>
                    )}
                  </td>{" "}
                  <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>
                    {isEditing ? (
                      <input
                        value={editForm.activeIngredient}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            activeIngredient: e.target.value,
                          }))
                        }
                        style={{ ...sInput, width: "100%" }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      p.activeIngredient || "—"
                    )}
                  </td>{" "}
                  <td style={{ ...tdS, color: D.muted, fontSize: 11 }}>
                    {isEditing ? (
                      <input
                        value={editForm.moaGroup}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            moaGroup: e.target.value,
                          }))
                        }
                        style={{ ...sInput, width: 80 }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      p.moaGroup || "—"
                    )}
                  </td>{" "}
                  <td style={{ ...tdS, fontSize: 12 }}>
                    {isEditing ? (
                      <input
                        value={editForm.containerSize}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            containerSize: e.target.value,
                          }))
                        }
                        style={{ ...sInput, width: 80 }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      p.containerSize || "—"
                    )}
                  </td>{" "}
                  <td style={{ ...tdS, fontSize: 12 }}>
                    {isEditing ? (
                      <div
                        style={{ display: "flex", gap: 4 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {" "}
                        <input
                          value={editForm.inventoryOnHand}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              inventoryOnHand: e.target.value,
                            }))
                          }
                          type="number"
                          step="0.0001"
                          placeholder="Stock"
                          style={{ ...sInput, width: 76 }}
                        />{" "}
                        <input
                          value={editForm.inventoryUnit}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              inventoryUnit: e.target.value,
                            }))
                          }
                          placeholder="unit"
                          style={{ ...sInput, width: 56 }}
                        />{" "}
                        <input
                          value={editForm.lowStockThreshold}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              lowStockThreshold: e.target.value,
                            }))
                          }
                          type="number"
                          step="0.0001"
                          placeholder="low"
                          style={{ ...sInput, width: 66 }}
                        />{" "}
                      </div>
                    ) : (
                      <span
                        style={{
                          color: p.lowStock ? D.red : D.text,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {p.inventoryOnHand != null
                          ? `${p.inventoryOnHand} ${p.inventoryUnit || ""}`
                          : "—"}
                        {p.lowStock && (
                          <span
                            style={{
                              ...sBadge(`${D.red}22`, D.red),
                              marginLeft: 6,
                            }}
                          >
                            Low
                          </span>
                        )}
                      </span>
                    )}
                  </td>{" "}
                  <td
                    style={{
                      ...tdS,
                      fontFamily: "'JetBrains Mono', monospace",
                      color: p.bestPrice ? D.green : D.muted,
                  }}
                >
                    {formatMoney(p.bestPrice)}
                  </td>{" "}
                  <td
                    style={{
                      ...tdS,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: p.unitPrices?.length || p.costPerUnit ? D.text : D.muted,
                    }}
                  >
                    {formatUnitPriceList(p.unitPrices) ||
                      formatUnitCost(p.costPerUnit, p.costUnit)}
                  </td>{" "}
                  <td style={{ ...tdS, fontSize: 12 }}>
                    {p.bestVendor || "—"}
                  </td>{" "}
                  <td style={tdS}>
                    {p.needsPricing ? (
                      <span style={sBadge(`${D.amber}22`, D.amber)}>
                        Needs Price
                      </span>
                    ) : (
                      <span style={sBadge(`${D.green}22`, D.green)}>
                        Priced
                      </span>
                    )}
                  </td>{" "}
                  <td style={{ ...tdS, width: 90 }}>
                    {" "}
                    <div
                      style={{ display: "flex", gap: 4 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isEditing ? (
                        <>
                          {" "}
                          <button
                            onClick={() => saveEdit(p.id)}
                            style={{
                              fontSize: 10,
                              padding: "3px 8px",
                              borderRadius: 4,
                              border: "none",
                              background: D.green,
                              color: "#fff",
                              cursor: "pointer",
                              fontWeight: 600,
                            }}
                          >
                            Save
                          </button>{" "}
                          <button
                            onClick={() => setEditing(null)}
                            style={{
                              fontSize: 10,
                              padding: "3px 6px",
                              borderRadius: 4,
                              border: `1px solid ${D.border}`,
                              background: "none",
                              color: D.muted,
                              cursor: "pointer",
                            }}
                          >
                            ×
                          </button>{" "}
                        </>
                      ) : (
                        <>
                          {" "}
                          <button
                            onClick={(e) => startEdit(p, e)}
                            style={{
                              fontSize: 11,
                              padding: "2px 6px",
                              borderRadius: 4,
                              border: `1px solid ${D.border}`,
                              background: "none",
                              color: D.teal,
                              cursor: "pointer",
                            }}
                            title="Edit"
                          >
                            Edit
                          </button>
                          {deleting === p.id ? (
                            <>
                              {" "}
                              <button
                                onClick={async () => {
                                  try {
                                    await adminFetch(
                                      `/admin/inventory/${p.id}`,
                                      { method: "DELETE" },
                                    );
                                    showToast("Deleted");
                                    load();
                                  } catch {
                                    showToast("Delete failed");
                                  }
                                  setDeleting(null);
                                }}
                                style={{
                                  fontSize: 10,
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                  border: "none",
                                  background: D.red,
                                  color: "#fff",
                                  cursor: "pointer",
                                }}
                              >
                                Yes
                              </button>{" "}
                              <button
                                onClick={() => setDeleting(null)}
                                style={{
                                  fontSize: 10,
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                  border: `1px solid ${D.border}`,
                                  background: "none",
                                  color: D.muted,
                                  cursor: "pointer",
                                }}
                              >
                                No
                              </button>{" "}
                            </>
                          ) : (
                            <button
                              onClick={() => setDeleting(p.id)}
                              style={{
                                fontSize: 12,
                                background: "none",
                                border: "none",
                                color: D.muted,
                                cursor: "pointer",
                                padding: 4,
                              }}
                            >
                              ×
                            </button>
                          )}
                        </>
                      )}
                    </div>{" "}
                  </td>{" "}
                </tr>,
                isExpanded && (
                  <tr key={`${p.id}-exp`}>
                    <td
                      colSpan={10}
                      style={{
                        padding: "0 10px 16px",
                        background: `${D.teal}05`,
                      }}
                    >
                      {" "}
                      <ExpandedProduct
                        product={p}
                        vendors={vendors}
                        onSave={savePrice}
                        onInventoryChanged={load}
                        showToast={showToast}
                      />{" "}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>{" "}
        </table>{" "}
      </div>
      {products.length === 0 && (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No products found
        </div>
      )}
      {totalProducts > PER_PAGE && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 0",
          }}
        >
          {" "}
          <div style={{ fontSize: 12, color: D.muted }}>
            Showing {(page - 1) * PER_PAGE + 1}–
            {Math.min(page * PER_PAGE, totalProducts)} of {totalProducts}{" "}
            products
          </div>{" "}
          <div style={{ display: "flex", gap: 6 }}>
            {" "}
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              style={{
                ...sBtn(
                  page <= 1 ? D.card : D.teal,
                  page <= 1 ? D.muted : D.white,
                ),
                opacity: page <= 1 ? 0.5 : 1,
              }}
            >
              ← Prev
            </button>{" "}
            <span
              style={{
                fontSize: 13,
                color: D.text,
                padding: "8px 12px",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {page} / {Math.ceil(totalProducts / PER_PAGE)}
            </span>{" "}
            <button
              disabled={page >= Math.ceil(totalProducts / PER_PAGE)}
              onClick={() => setPage((p) => p + 1)}
              style={{
                ...sBtn(
                  page >= Math.ceil(totalProducts / PER_PAGE) ? D.card : D.teal,
                  page >= Math.ceil(totalProducts / PER_PAGE)
                    ? D.muted
                    : D.white,
                ),
                opacity: page >= Math.ceil(totalProducts / PER_PAGE) ? 0.5 : 1,
              }}
            >
              Next →
            </button>{" "}
          </div>{" "}
        </div>
      )}
    </div>
  );
}

function RestockRequestsTab({ showToast, onUpdate }) {
  const [requests, setRequests] = useState([]);
  const [status, setStatus] = useState("active");
  const [loading, setLoading] = useState(true);
  const [receivingId, setReceivingId] = useState("");
  const [receiveDrafts, setReceiveDrafts] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch(`/admin/inventory/restock-requests?status=${encodeURIComponent(status)}`);
      setRequests(data.requests || []);
    } catch (err) {
      showToast(`Failed to load restock requests: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [status, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(request, action) {
    setReceivingId(request.id);
    try {
      const draft = receiveDrafts[request.id] || {};
      const result = await adminFetch(`/admin/inventory/restock-requests/${request.id}/action`, {
        method: "POST",
        body: JSON.stringify({
          action,
          quantity: draft.quantity || request.requestedQuantity || null,
          unit: draft.unit || request.unit || request.inventoryUnit || null,
          note: draft.note || null,
        }),
      });
      if (action === "receive") {
        const recheck = result.readinessRecheck;
        if (recheck?.alertStatus === "resolved") {
          showToast(`Stock received. Readiness alert resolved (${recheck.resolvedAlerts || 0}).`);
        } else if (recheck?.blocked != null) {
          showToast(`Stock received. Readiness rechecked: ${recheck.blocked} blocked remain.`);
        } else {
          showToast("Stock received.");
        }
      } else {
        showToast(action === "mark_ordered" ? "Marked ordered" : "Request cancelled");
      }
      await load();
      onUpdate && onUpdate();
    } catch (err) {
      showToast(`Failed: ${err.message}`);
    } finally {
      setReceivingId("");
    }
  }

  return (
    <div style={sCard}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0, color: D.heading }}>Restock Requests</h3>
          <p style={{ margin: "4px 0 0", color: D.muted, fontSize: 13 }}>
            Product requests created from readiness and inventory exceptions.
          </p>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ ...sInput, width: 160 }}
        >
          <option value="active">Open + Ordered</option>
          <option value="open">Open</option>
          <option value="ordered">Ordered</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
      </div>
      {loading ? (
        <div style={{ color: D.muted, fontSize: 13 }}>Loading restock requests...</div>
      ) : requests.length === 0 ? (
        <div style={{ color: D.muted, fontSize: 13 }}>No restock requests in this view.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Product", "Need", "Source", "Status", "Receive"].map((h) => (
                  <th key={h} style={thS}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => {
                const draft = receiveDrafts[request.id] || {};
                return (
                  <tr key={request.id}>
                    <td style={tdS}>
                      <strong>{request.productName}</strong>
                      <div style={{ color: D.muted, fontSize: 12 }}>
                        {request.productCategory || "Product"} · live stock {request.liveStock ?? "—"} {request.inventoryUnit || request.unit || ""}
                      </div>
                    </td>
                    <td style={tdS}>
                      <strong>{request.requestedQuantity ?? "—"} {request.unit || ""}</strong>
                      <div style={{ color: D.muted, fontSize: 12 }}>
                        Needed {request.neededBy || "as soon as possible"} · {request.priority}
                      </div>
                      {request.vendor && <div style={{ color: D.muted, fontSize: 12 }}>Vendor: {request.vendor}</div>}
                    </td>
                    <td style={tdS}>
                      <div>{request.customerName || request.source}</div>
                      <div style={{ color: D.muted, fontSize: 12 }}>
                        {request.scheduledDate || request.createdAt?.slice?.(0, 10)} · {request.serviceType || "inventory"}
                      </div>
                      <div style={{ color: D.muted, fontSize: 12 }}>{request.reason}</div>
                    </td>
                    <td style={tdS}>
                      <span style={{
                        padding: "4px 8px",
                        borderRadius: 999,
                        border: `1px solid ${request.status === "received" ? D.green : request.status === "cancelled" ? D.red : D.amber}`,
                        color: request.status === "received" ? D.green : request.status === "cancelled" ? D.red : D.amber,
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: "uppercase",
                      }}>
                        {request.status}
                      </span>
                      {request.status === "open" && (
                        <button
                          onClick={() => runAction(request, "mark_ordered")}
                          disabled={receivingId === request.id}
                          style={{ ...sBtn(D.card, D.text), marginTop: 8, display: "block" }}
                        >
                          Mark Ordered
                        </button>
                      )}
                    </td>
                    <td style={tdS}>
                      {["open", "ordered"].includes(request.status) ? (
                        <div style={{ display: "grid", gap: 6, minWidth: 220 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: 6 }}>
                            <input
                              value={draft.quantity ?? request.requestedQuantity ?? ""}
                              onChange={(e) => setReceiveDrafts((prev) => ({ ...prev, [request.id]: { ...(prev[request.id] || {}), quantity: e.target.value } }))}
                              style={sInput}
                              placeholder="Qty"
                            />
                            <input
                              value={draft.unit ?? request.unit ?? request.inventoryUnit ?? ""}
                              onChange={(e) => setReceiveDrafts((prev) => ({ ...prev, [request.id]: { ...(prev[request.id] || {}), unit: e.target.value } }))}
                              style={sInput}
                              placeholder="Unit"
                            />
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              onClick={() => runAction(request, "receive")}
                              disabled={receivingId === request.id}
                              style={sBtn(D.green, D.white)}
                            >
                              Receive
                            </button>
                            <button
                              onClick={() => runAction(request, "cancel")}
                              disabled={receivingId === request.id}
                              style={sBtn(D.card, D.red)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: D.muted }}>Closed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExpandedProduct({
  product,
  vendors,
  onSave,
  onInventoryChanged,
  showToast,
}) {
  const [vendorId, setVendorId] = useState(vendors[0]?.id || "");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [movements, setMovements] = useState([]);
  const [movementLoading, setMovementLoading] = useState(true);
  const [adjustForm, setAdjustForm] = useState({
    movementType: "restock",
    quantity: "",
    unit: product.inventoryUnit || "oz",
    lotNumber: "",
    reason: "",
    note: "",
  });

  const loadMovements = useCallback(async () => {
    setMovementLoading(true);
    try {
      const data = await adminFetch(`/admin/inventory/${product.id}/movements`);
      setMovements(data.movements || []);
    } catch {
      setMovements([]);
    } finally {
      setMovementLoading(false);
    }
  }, [product.id]);

  useEffect(() => {
    loadMovements();
    setAdjustForm((f) => ({
      ...f,
      unit: product.inventoryUnit || f.unit || "oz",
    }));
  }, [loadMovements, product.inventoryUnit]);

  const submitAdjustment = async () => {
    if (!adjustForm.quantity || !adjustForm.unit) {
      showToast?.("Amount and unit required");
      return;
    }
    try {
      await adminFetch(`/admin/inventory/${product.id}/adjust`, {
        method: "POST",
        body: JSON.stringify({
          ...adjustForm,
          quantity: Number(adjustForm.quantity),
        }),
      });
      showToast?.("Inventory adjusted");
      setAdjustForm((f) => ({
        ...f,
        quantity: "",
        lotNumber: "",
        reason: "",
        note: "",
      }));
      await loadMovements();
      onInventoryChanged?.();
    } catch (e) {
      showToast?.(`Failed: ${e.message}`);
    }
  };

  const queueRefresh = async (vendorPricing) => {
    try {
      const data = await adminFetch(
        `/admin/inventory/${product.id}/pricing/refresh`,
        {
          method: "POST",
          body: JSON.stringify({ vendorId: vendorPricing.vendorId }),
        },
      );
      showToast?.(data.message || "Refresh queued");
    } catch (e) {
      showToast?.(`Refresh failed: ${e.message}`);
    }
  };

  return (
    <div style={{ padding: 12 }}>
      {" "}
      <div
        style={{
          display: "flex",
          gap: 16,
          marginBottom: 12,
          flexWrap: "wrap",
          fontSize: 12,
        }}
      >
        {product.formulation && (
          <span style={{ color: D.muted }}>
            Formulation:{" "}
            <span style={{ color: D.text }}>{product.formulation}</span>
          </span>
        )}
        {product.unitSizeOz && (
          <span style={{ color: D.muted }}>
            Size (oz):{" "}
            <span style={{ color: D.text }}>{product.unitSizeOz}</span>
          </span>
        )}
        {product.sku && (
          <span style={{ color: D.muted }}>
            SKU: <span style={{ color: D.text }}>{product.sku}</span>
          </span>
        )}
        <span style={{ color: D.muted }}>
          Stock:{" "}
          <span style={{ color: product.lowStock ? D.red : D.text }}>
            {product.inventoryOnHand != null
              ? `${product.inventoryOnHand} ${product.inventoryUnit || ""}`
              : "not set"}
          </span>
        </span>
        {product.lowStockThreshold != null && (
          <span style={{ color: D.muted }}>
            Low at:{" "}
            <span style={{ color: D.text }}>
              {product.lowStockThreshold} {product.inventoryUnit || ""}
            </span>
          </span>
        )}
      </div>
      {product.vendorPricing.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {" "}
          <div
            style={{
              fontSize: 11,
              color: D.muted,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            Vendor Prices
          </div>{" "}
          <div style={{ display: "grid", gap: 4 }}>
            {product.vendorPricing.map((vp, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "6px 10px",
                  background: D.input,
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                {" "}
                <span
                  style={{ color: D.heading, fontWeight: 600, minWidth: 140 }}
                >
                  {vp.vendorName}
                </span>{" "}
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: vp.isBest ? D.green : D.text,
                  }}
                >
                  ${vp.price.toFixed(2)}
                </span>
                {vp.quantity && (
                  <span style={{ color: D.muted }}>{vp.quantity}</span>
                )}
                {(() => {
                  const unitLabel =
                    formatUnitPriceList(vp.unitPrices) ||
                    (vp.normalizedUnitPrice != null && vp.normalizedUnit
                      ? formatUnitCost(vp.normalizedUnitPrice, vp.normalizedUnit)
                      : null);
                  return unitLabel ? (
                    <span
                      style={{
                        color: D.muted,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                      }}
                    >
                      {unitLabel}
                    </span>
                  ) : null;
                })()}
                {vp.sourceType && (
                  <span style={sBadge(`${D.teal}14`, D.muted)}>
                    {String(vp.sourceType).replace(/_/g, " ")}
                  </span>
                )}
                {vp.availability && (
                  <span style={{ color: D.muted, fontSize: 11 }}>
                    {vp.availability}
                  </span>
                )}
                {vp.branchLocation && (
                  <span style={{ color: D.muted, fontSize: 11 }}>
                    {vp.branchLocation}
                  </span>
                )}
                {vp.confidenceScore != null && (
                  <span style={{ color: D.muted, fontSize: 10 }}>
                    {Math.round(vp.confidenceScore * 100)}% conf
                  </span>
                )}
                {vp.isBest && (
                  <span style={sBadge(`${D.green}22`, D.green)}>Best</span>
                )}
                {vp.url && (
                  <a
                    href={vp.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: D.teal, fontSize: 11 }}
                  >
                    Open
                  </a>
                )}
                {vp.lastChecked && (
                  <span style={{ color: D.muted, fontSize: 10 }}>
                    {new Date(vp.lastChecked).toLocaleDateString()}
                  </span>
                )}
                <button
                  onClick={() => queueRefresh(vp)}
                  style={{
                    marginLeft: "auto",
                    fontSize: 10,
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: `1px solid ${D.border}`,
                    background: D.card,
                    color: D.teal,
                    cursor: "pointer",
                  }}
                >
                  Refresh
                </button>
              </div>
            ))}
          </div>{" "}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        {" "}
        <div>
          <label
            style={{
              fontSize: 10,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Vendor
          </label>{" "}
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            style={{ ...sInput, width: 160 }}
          >
            {vendors
              .filter((v) => v.active)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
          </select>
        </div>{" "}
        <div>
          <label
            style={{
              fontSize: 10,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Price
          </label>{" "}
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            type="number"
            step="0.01"
            placeholder="0.00"
            style={{ ...sInput, width: 100 }}
          />
        </div>{" "}
        <div>
          <label
            style={{
              fontSize: 10,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            Quantity
          </label>{" "}
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="e.g. 32 oz"
            style={{ ...sInput, width: 120 }}
          />
        </div>{" "}
        <button
          onClick={() => {
            if (price) {
              onSave(product.id, vendorId, price, qty);
              setPrice("");
              setQty("");
            }
          }}
          style={sBtn(D.teal, D.white)}
        >
          Add Price
        </button>{" "}
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 380px) 1fr",
          gap: 12,
          marginTop: 14,
        }}
      >
        {" "}
        <div
          style={{
            background: D.input,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            padding: 12,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 11,
              color: D.muted,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 8,
            }}
          >
            Manual Adjustment
          </div>{" "}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            {" "}
            <select
              value={adjustForm.movementType}
              onChange={(e) =>
                setAdjustForm((f) => ({ ...f, movementType: e.target.value }))
              }
              style={sInput}
            >
              {" "}
              <option value="restock">Restock</option>{" "}
              <option value="correction">Correction</option>{" "}
              <option value="damaged_lost">Damaged/Lost</option>{" "}
            </select>{" "}
            <div style={{ display: "flex", gap: 6 }}>
              {" "}
              <input
                value={adjustForm.quantity}
                onChange={(e) =>
                  setAdjustForm((f) => ({ ...f, quantity: e.target.value }))
                }
                type="number"
                step="0.0001"
                placeholder="Amount"
                style={{ ...sInput, width: "100%" }}
              />{" "}
              <input
                value={adjustForm.unit}
                onChange={(e) =>
                  setAdjustForm((f) => ({ ...f, unit: e.target.value }))
                }
                placeholder="unit"
                style={{ ...sInput, width: 70 }}
              />{" "}
            </div>{" "}
            <input
              value={adjustForm.lotNumber}
              onChange={(e) =>
                setAdjustForm((f) => ({ ...f, lotNumber: e.target.value }))
              }
              placeholder="Lot number"
              style={sInput}
            />{" "}
            <input
              value={adjustForm.reason}
              onChange={(e) =>
                setAdjustForm((f) => ({ ...f, reason: e.target.value }))
              }
              placeholder="Reason"
              style={sInput}
            />{" "}
            <input
              value={adjustForm.note}
              onChange={(e) =>
                setAdjustForm((f) => ({ ...f, note: e.target.value }))
              }
              placeholder="Note"
              style={{ ...sInput, gridColumn: "1 / -1" }}
            />{" "}
          </div>{" "}
          <button
            onClick={submitAdjustment}
            style={{ ...sBtn(D.green, D.white), marginTop: 8, width: "100%" }}
          >
            Apply Adjustment
          </button>{" "}
        </div>{" "}
        <div
          style={{
            background: D.input,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            padding: 12,
            minWidth: 0,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 11,
              color: D.muted,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 8,
            }}
          >
            Movement History
          </div>
          {movementLoading ? (
            <div style={{ color: D.muted, fontSize: 12 }}>
              Loading movements...
            </div>
          ) : movements.length === 0 ? (
            <div style={{ color: D.muted, fontSize: 12 }}>
              No inventory movements yet.
            </div>
          ) : (
            <div style={{ maxHeight: 220, overflow: "auto" }}>
              {" "}
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                {" "}
                <thead>
                  <tr>
                    {["Date", "Type", "Amount", "Stock", "Job/Reason"].map(
                      (h) => (
                        <th key={h} style={thS}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>{" "}
                <tbody>
                  {movements.map((m) => (
                    <tr key={m.id}>
                      {" "}
                      <td style={{ ...tdS, fontSize: 11, color: D.muted }}>
                        {m.createdAt
                          ? new Date(m.createdAt).toLocaleDateString()
                          : "—"}
                      </td>{" "}
                      <td style={tdS}>
                        <span
                          style={sBadge(
                            m.movementType === "usage"
                              ? `${D.teal}22`
                              : m.movementType === "damaged_lost"
                                ? `${D.red}22`
                                : `${D.green}22`,
                            m.movementType === "damaged_lost"
                              ? D.red
                              : m.movementType === "usage"
                                ? D.teal
                                : D.green,
                          )}
                        >
                          {m.movementType}
                        </span>
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {m.quantity ?? "—"} {m.unit || ""}
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 12,
                        }}
                      >
                        {m.stockBefore ?? "—"} → {m.stockAfter ?? "—"}
                      </td>{" "}
                      <td style={{ ...tdS, fontSize: 11, color: D.muted }}>
                        {m.customerName ||
                          m.metadata?.reason ||
                          m.metadata?.note ||
                          "—"}
                      </td>{" "}
                    </tr>
                  ))}
                </tbody>{" "}
              </table>{" "}
            </div>
          )}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// REGISTRY TAB — Customer-facing content & visibility
// ══════════════════════════════════════════════════════════════
const VISIBILITY_OPTIONS = [
  { value: "internal_only", label: "Internal Only", color: D.muted },
  { value: "portal_only", label: "Portal", color: D.teal },
  { value: "public", label: "Public", color: D.green },
];
const STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: D.muted },
  { value: "approved_for_portal", label: "Approved (Portal)", color: D.teal },
  { value: "approved_for_public", label: "Approved (Public)", color: D.green },
  { value: "retired", label: "Retired", color: D.red },
];

function RegistryTab({ showToast }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch("/admin/inventory?limit=500");
      setProducts(data.products || []);
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (p) => {
    setEditing(p.id);
    setForm({
      customerVisibility: p.customerVisibility || "internal_only",
      contentStatus: p.contentStatus || "draft",
      commonName: p.commonName || "",
      publicSummary: p.publicSummary || "",
      portalSummary: p.portalSummary || "",
      customerSafetySummary: p.customerSafetySummary || "",
      petKidGuidanceText: p.petKidGuidanceText || "",
      targetPests: (p.targetPests || []).join(", "),
      applicationZones: (p.applicationZones || []).join(", "),
    });
  };

  const save = async (id) => {
    try {
      const payload = {
        ...form,
        targetPests: form.targetPests
          ? form.targetPests.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        applicationZones: form.applicationZones
          ? form.applicationZones.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
      };
      await adminFetch(`/admin/inventory/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showToast("Registry updated");
      setEditing(null);
      load();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };

  const filtered = products.filter((p) => {
    if (filter === "all") return true;
    if (filter === "public") return p.customerVisibility === "public";
    if (filter === "portal") return p.customerVisibility === "portal_only";
    if (filter === "draft") return p.contentStatus === "draft";
    if (filter === "needs_content") return p.customerVisibility !== "internal_only" && !p.publicSummary;
    return true;
  });

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          { key: "all", label: "All Products" },
          { key: "public", label: "Public" },
          { key: "portal", label: "Portal" },
          { key: "draft", label: "Drafts" },
          { key: "needs_content", label: "Needs Content" },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              ...sBtn(filter === f.key ? D.teal : "transparent", filter === f.key ? "#fff" : D.muted),
              border: filter === f.key ? "none" : `1px solid ${D.border}`,
              fontSize: 11,
              padding: "4px 10px",
            }}
          >
            {f.label}
          </button>
        ))}
        <span style={{ color: D.muted, fontSize: 11, alignSelf: "center", marginLeft: 8 }}>
          {filtered.length} product{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {filtered.map((p) => {
          const isEditing = editing === p.id;
          const vis = VISIBILITY_OPTIONS.find((v) => v.value === (p.customerVisibility || "internal_only"));
          const stat = STATUS_OPTIONS.find((s) => s.value === (p.contentStatus || "draft"));

          return (
            <div key={p.id} style={{ ...sCard, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: isEditing ? 12 : 0 }}>
                <span style={{ color: D.text, fontWeight: 500, flex: 1 }}>{p.name}</span>
                <span style={{ fontSize: 11, color: D.muted }}>{p.category}</span>
                <span style={sBadge(`${vis.color}22`, vis.color)}>{vis.label}</span>
                <span style={sBadge(`${stat.color}22`, stat.color)}>{stat.label}</span>
                {!isEditing && (
                  <button onClick={() => startEdit(p)} style={{ ...sBtn(D.teal, "#fff"), fontSize: 11, padding: "3px 10px" }}>
                    Edit
                  </button>
                )}
              </div>

              {isEditing && (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <div>
                      <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Visibility</label>
                      <select value={form.customerVisibility} onChange={(e) => setForm((f) => ({ ...f, customerVisibility: e.target.value }))} style={sInput}>
                        {VISIBILITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Status</label>
                      <select value={form.contentStatus} onChange={(e) => setForm((f) => ({ ...f, contentStatus: e.target.value }))} style={sInput}>
                        {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Common Name</label>
                      <input value={form.commonName} onChange={(e) => setForm((f) => ({ ...f, commonName: e.target.value }))} placeholder="Plain-language name" style={sInput} />
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div>
                      <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Target Pests (comma-separated)</label>
                      <input value={form.targetPests} onChange={(e) => setForm((f) => ({ ...f, targetPests: e.target.value }))} placeholder="ants, roaches, spiders" style={sInput} />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Application Zones (comma-separated)</label>
                      <input value={form.applicationZones} onChange={(e) => setForm((f) => ({ ...f, applicationZones: e.target.value }))} placeholder="exterior perimeter, interior cracks" style={sInput} />
                    </div>
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Public Summary (why we use it — 1-2 sentences)</label>
                    <textarea value={form.publicSummary} onChange={(e) => setForm((f) => ({ ...f, publicSummary: e.target.value }))} rows={2} placeholder="Non-repellent transfer insecticide that eliminates entire colonies..." style={{ ...sInput, resize: "vertical" }} />
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Portal Summary (shown in service history)</label>
                    <textarea value={form.portalSummary} onChange={(e) => setForm((f) => ({ ...f, portalSummary: e.target.value }))} rows={2} placeholder="Applied to your exterior perimeter to create a transfer zone..." style={{ ...sInput, resize: "vertical" }} />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div>
                      <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Customer Safety Summary</label>
                      <textarea value={form.customerSafetySummary} onChange={(e) => setForm((f) => ({ ...f, customerSafetySummary: e.target.value }))} rows={2} placeholder="Applied according to label directions..." style={{ ...sInput, resize: "vertical" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: D.muted, display: "block", marginBottom: 2 }}>Pet/Kid Guidance</label>
                      <textarea value={form.petKidGuidanceText} onChange={(e) => setForm((f) => ({ ...f, petKidGuidanceText: e.target.value }))} rows={2} placeholder="Safe once dry, typically 15-30 minutes" style={{ ...sInput, resize: "vertical" }} />
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => setEditing(null)} style={{ ...sBtn("transparent", D.muted), border: `1px solid ${D.border}`, fontSize: 11, padding: "4px 12px" }}>
                      Cancel
                    </button>
                    <button onClick={() => save(p.id)} style={{ ...sBtn(D.green, "#fff"), fontSize: 11, padding: "4px 12px" }}>
                      Save Registry
                    </button>
                  </div>
                </div>
              )}

              {!isEditing && p.publicSummary && (
                <div style={{ marginTop: 6, fontSize: 12, color: D.muted, fontStyle: "italic" }}>
                  {p.publicSummary}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// VENDORS TAB
// ══════════════════════════════════════════════════════════════
function VendorsTab({ showToast }) {
  const [vendors, setVendors] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    const d = await adminFetch("/admin/inventory/vendors");
    setVendors(d.vendors || []);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const save = async (id, form) => {
    try {
      await adminFetch(`/admin/inventory/vendors/${id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      showToast("Vendor updated");
      setEditing(null);
      load();
    } catch (e) {
      showToast("Failed: " + e.message);
    }
  };
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading vendors...
      </div>
    );
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
      }}
    >
      {vendors.map((v) => (
        <div key={v.id} style={{ ...sCard, marginBottom: 0 }}>
          {" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: 8,
            }}
          >
            {" "}
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
                {v.name}
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>{v.type}</div>
            </div>{" "}
            <div style={{ display: "flex", gap: 4 }}>
              {v.scrapingEnabled && (
                <span style={sBadge(`${D.green}22`, D.green)}>Scrape</span>
              )}
              {v.hasCredentials && (
                <span style={sBadge(`${D.teal}22`, D.teal)}>Login</span>
              )}
              {!v.active && (
                <span style={sBadge(`${D.red}22`, D.red)}>Inactive</span>
              )}
            </div>{" "}
          </div>{" "}
          <div
            style={{
              display: "flex",
              gap: 12,
              fontSize: 12,
              color: D.muted,
              marginBottom: 8,
            }}
          >
            <span>{v.productCount} products</span>
            <span>{v.bestPriceCount} best prices</span>
          </div>
          {v.website && (
            <a
              href={v.website}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11,
                color: D.teal,
                display: "block",
                marginTop: 4,
              }}
            >
              {v.website}
            </a>
          )}
          {editing === v.id ? (
            <VendorEditForm
              vendor={v}
              onSave={save}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button
              onClick={() => setEditing(v.id)}
              style={{
                ...sBtn("transparent", D.muted),
                border: `1px solid ${D.border}`,
                marginTop: 8,
                width: "100%",
                fontSize: 11,
              }}
            >
              Edit Credentials
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function VendorEditForm({ vendor, onSave, onCancel }) {
  const [form, setForm] = useState({
    loginUsername: vendor.loginUsername || "",
    loginEmail: vendor.loginEmail || "",
    loginPassword: "",
    accountNumber: vendor.accountNumber || "",
    loginUrl: vendor.loginUrl || "",
  });
  return (
    <div
      style={{
        marginTop: 8,
        padding: 12,
        background: D.input,
        borderRadius: 8,
      }}
    >
      {[
        { key: "loginUsername", label: "Username" },
        { key: "loginEmail", label: "Email" },
        { key: "loginPassword", label: "Password", type: "password" },
        { key: "accountNumber", label: "Account #" },
        { key: "loginUrl", label: "Login URL" },
      ].map((f) => (
        <div key={f.key} style={{ marginBottom: 6 }}>
          <label
            style={{
              fontSize: 10,
              color: D.muted,
              display: "block",
              marginBottom: 2,
            }}
          >
            {f.label}
          </label>{" "}
          <input
            value={form[f.key]}
            onChange={(e) =>
              setForm((p) => ({ ...p, [f.key]: e.target.value }))
            }
            type={f.type || "text"}
            placeholder={f.label}
            style={{ ...sInput, width: "100%" }}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button
          onClick={() => onSave(vendor.id, form)}
          style={sBtn(D.teal, D.white)}
        >
          Save
        </button>
        <button
          onClick={onCancel}
          style={{
            ...sBtn("transparent", D.muted),
            border: `1px solid ${D.border}`,
          }}
        >
          Cancel
        </button>
      </div>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// APPROVALS TAB
// ══════════════════════════════════════════════════════════════
function ApprovalsTab({ showToast, onUpdate }) {
  const [approvals, setApprovals] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const load = () =>
    adminFetch("/admin/inventory/approvals?status=pending&limit=100")
      .then((d) => {
        setApprovals(d.approvals || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  const handleAction = async (id, action) => {
    try {
      await adminFetch(`/admin/inventory/approvals/${id}/${action}`, {
        method: "POST",
      });
      showToast(action === "approve" ? "Approved" : "Rejected");
      load();
      onUpdate();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };
  const handleBulk = async (action) => {
    try {
      await adminFetch("/admin/inventory/approvals/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], action }),
      });
      showToast(
        `${action === "approve" ? "Approved" : "Rejected"} ${selected.size} items`,
      );
      setSelected(new Set());
      load();
      onUpdate();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };
  const toggleSel = (id) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading approvals...
      </div>
    );
  return (
    <div>
      {selected.size > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginBottom: 12,
            padding: "10px 16px",
            background: D.card,
            border: `1px solid ${D.teal}`,
            borderRadius: 10,
          }}
        >
          {" "}
          <span style={{ fontSize: 13, fontWeight: 600, color: D.teal }}>
            {selected.size} selected
          </span>{" "}
          <button
            onClick={() => handleBulk("approve")}
            style={sBtn(D.green, D.white)}
          >
            Approve All
          </button>{" "}
          <button
            onClick={() => handleBulk("reject")}
            style={sBtn(D.red, D.white)}
          >
            Reject All
          </button>{" "}
          <button
            onClick={() => setSelected(new Set())}
            style={{
              ...sBtn("transparent", D.muted),
              border: `1px solid ${D.border}`,
            }}
          >
            Clear
          </button>{" "}
        </div>
      )}
      {approvals.length === 0 ? (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          <div style={{ fontSize: 24, marginBottom: 8 }}></div>No pending
          approvals
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {approvals.map((a) => {
            const pct =
              a.price_change_pct ||
              (a.old_price
                ? (((a.new_price - a.old_price) / a.old_price) * 100).toFixed(1)
                : null);
            const isUp = pct > 0;
            return (
              <div
                key={a.id}
                style={{
                  ...sCard,
                  marginBottom: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                {" "}
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggleSel(a.id)}
                  style={{ accentColor: D.teal, cursor: "pointer" }}
                />{" "}
                <div style={{ flex: 1 }}>
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 600, color: D.heading }}
                  >
                    {a.product_name}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted }}>
                    {a.vendor_name} · {a.category}
                  </div>
                  {a.notes && (
                    <div
                      style={{ fontSize: 11, color: D.purple, marginTop: 2 }}
                    >
                      {a.notes}
                    </div>
                  )}
                </div>{" "}
                <div style={{ textAlign: "center", minWidth: 80 }}>
                  {a.old_price && (
                    <div
                      style={{
                        fontSize: 12,
                        color: D.muted,
                        textDecoration: "line-through",
                      }}
                    >
                      ${parseFloat(a.old_price).toFixed(2)}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      fontFamily: "'JetBrains Mono', monospace",
                      color: D.heading,
                    }}
                  >
                    ${parseFloat(a.new_price).toFixed(2)}
                  </div>{" "}
                </div>
                {pct !== null && (
                  <span
                    style={sBadge(
                      isUp ? `${D.red}22` : `${D.green}22`,
                      isUp ? D.red : D.green,
                    )}
                  >
                    {isUp ? "+" : ""}
                    {pct}%
                  </span>
                )}
                <div style={{ display: "flex", gap: 4 }}>
                  {" "}
                  <button
                    onClick={() => handleAction(a.id, "approve")}
                    style={sBtn(D.green, D.white)}
                  >
                    Approve
                  </button>{" "}
                  <button
                    onClick={() => handleAction(a.id, "reject")}
                    style={sBtn(D.red, D.white)}
                  >
                    Reject
                  </button>{" "}
                </div>{" "}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PROTOCOLS TAB
// ══════════════════════════════════════════════════════════════
function costSourceLabel(product) {
  if (product.costSource === "cost_per_unit") return "Unit cost";
  if (product.costSource === "best_price_unit_size") return "Best price";
  return product.costWarning ? "Missing" : "Fallback";
}

const PROTOCOL_FILTERS = [
  { key: "all", label: "All" },
  { key: "pest", label: "Pest" },
  { key: "termite", label: "Termite" },
  { key: "lawn", label: "Lawn" },
  { key: "mosquito", label: "Mosquito" },
  { key: "rodent", label: "Rodent" },
  { key: "tree_shrub", label: "Tree & Shrub" },
];

function protocolLineForService(serviceType) {
  const value = String(serviceType || "").toLowerCase();
  if (
    value.includes("termite") ||
    value.includes("bora-care") ||
    value.includes("bora care") ||
    value.includes("termidor")
  )
    return "termite";
  if (value.includes("mosquito")) return "mosquito";
  if (value.includes("rodent")) return "rodent";
  if (value.includes("lawn")) return "lawn";
  if (value.includes("tree") || value.includes("shrub")) return "tree_shrub";
  return "pest";
}

const DEFAULT_PROTOCOL_SERVICE = {
  pest: "General Pest Perimeter",
  termite: "Termite Bait Station",
  lawn: "Lawn Care",
  mosquito: "Mosquito Treatment",
  rodent: "Rodent Control",
  tree_shrub: "Tree & Shrub",
};

function ProtocolsTab({
  showToast,
  initialServiceLine = "all",
  initialAction = "",
}) {
  const [services, setServices] = useState([]);
  const [products, setProducts] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const normalizedInitialLine = PROTOCOL_FILTERS.some(
    (f) => f.key === initialServiceLine,
  )
    ? initialServiceLine
    : "all";
  const [serviceFilter, setServiceFilter] = useState(normalizedInitialLine);
  const [costHighlightLine, setCostHighlightLine] = useState(
    initialAction === "costs" ? normalizedInitialLine : null,
  );
  const [editingRow, setEditingRow] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showAdd, setShowAdd] = useState(null);
  const [newRow, setNewRow] = useState({
    productId: "",
    usageAmount: "",
    usageUnit: "oz",
    usagePer1000sf: "",
    isPrimary: false,
    notes: "",
  });
  const [newServiceType, setNewServiceType] = useState("");
  const [showNewService, setShowNewService] = useState(false);
  const [appliedDeepLink, setAppliedDeepLink] = useState(false);

  const load = async () => {
    const [sData, pData, hData] = await Promise.all([
      adminFetch("/admin/inventory/service-usage"),
      adminFetch("/admin/inventory?limit=200"),
      adminFetch("/admin/inventory/protocol-health").catch(() => null),
    ]);
    setServices(sData.services || []);
    setProducts(pData.products || []);
    setHealth(hData);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (loading || appliedDeepLink || normalizedInitialLine === "all") return;
    setAppliedDeepLink(true);
    if (initialAction === "add") {
      const existingService = services.find(
        (svc) =>
          protocolLineForService(svc.serviceType) === normalizedInitialLine,
      )?.serviceType;
      setShowAdd(
        existingService ||
          DEFAULT_PROTOCOL_SERVICE[normalizedInitialLine] ||
          normalizedInitialLine,
      );
      showToast(
        `Add a COGS product for ${PROTOCOL_FILTERS.find((f) => f.key === normalizedInitialLine)?.label || normalizedInitialLine}`,
      );
    } else if (initialAction === "costs") {
      setCostHighlightLine(normalizedInitialLine);
      showToast(
        `Highlighted missing cost data for ${PROTOCOL_FILTERS.find((f) => f.key === normalizedInitialLine)?.label || normalizedInitialLine}`,
      );
    }
  }, [
    loading,
    appliedDeepLink,
    normalizedInitialLine,
    initialAction,
    services,
    showToast,
  ]);

  const startEdit = (row) => {
    setEditingRow(row.id);
    setEditForm({
      usageAmount: row.usageAmount || "",
      usageUnit: row.usageUnit || "oz",
      usagePer1000sf: row.usagePer1000sf || "",
      isPrimary: row.isPrimary,
      notes: row.notes || "",
    });
  };
  const saveEdit = async (id) => {
    try {
      await adminFetch(`/admin/inventory/service-usage/${id}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      showToast("Protocol updated");
      setEditingRow(null);
      load();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };
  const deleteRow = async (id) => {
    try {
      await adminFetch(`/admin/inventory/service-usage/${id}`, {
        method: "DELETE",
      });
      showToast("Removed");
      load();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };
  const addRow = async (serviceType) => {
    if (!newRow.productId) {
      showToast("Select a product");
      return;
    }
    try {
      await adminFetch("/admin/inventory/service-usage", {
        method: "POST",
        body: JSON.stringify({
          serviceType,
          productId: newRow.productId,
          usageAmount: parseFloat(newRow.usageAmount) || 0,
          usageUnit: newRow.usageUnit,
          usagePer1000sf: parseFloat(newRow.usagePer1000sf) || null,
          isPrimary: newRow.isPrimary,
          notes: newRow.notes,
        }),
      });
      showToast("Product added to protocol");
      setShowAdd(null);
      setNewRow({
        productId: "",
        usageAmount: "",
        usageUnit: "oz",
        usagePer1000sf: "",
        isPrimary: false,
        notes: "",
      });
      load();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading protocols...
      </div>
    );

  const unitOpts = [
    "oz",
    "ml",
    "gal",
    "lb",
    "g",
    "packets",
    "tube",
    "station",
    "blocks",
    "traps",
    "each",
  ];
  const visibleServices =
    serviceFilter === "all"
      ? services
      : services.filter(
          (svc) => protocolLineForService(svc.serviceType) === serviceFilter,
        );

  const lineLabel = (lineKey) =>
    PROTOCOL_FILTERS.find((f) => f.key === lineKey)?.label || lineKey;
  const firstServiceForLine = (lineKey) =>
    services.find((svc) => protocolLineForService(svc.serviceType) === lineKey)
      ?.serviceType;
  const filterToLine = (lineKey) => {
    setServiceFilter(lineKey);
    setCostHighlightLine(null);
    showToast(`Showing ${lineLabel(lineKey)} protocols`);
  };
  const openAddForLine = (lineKey) => {
    const serviceType =
      firstServiceForLine(lineKey) ||
      DEFAULT_PROTOCOL_SERVICE[lineKey] ||
      lineLabel(lineKey);
    setServiceFilter(lineKey);
    setCostHighlightLine(null);
    setShowAdd(serviceType);
    showToast(`Add a COGS product for ${lineLabel(lineKey)}`);
  };
  const highlightMissingCosts = (lineKey) => {
    setServiceFilter(lineKey);
    setShowAdd(null);
    setCostHighlightLine(lineKey);
    showToast(`Highlighted missing cost data for ${lineLabel(lineKey)}`);
  };

  return (
    <div>
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        {" "}
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
            Treatment Protocols by Service Line
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted }}>
            Define which products each service uses, at what rates — drives COGS
            calculations
          </div>
        </div>{" "}
        <button
          onClick={() => setShowNewService(!showNewService)}
          style={sBtn(D.green, D.white)}
        >
          + New Service Type
        </button>{" "}
      </div>
      {health?.lines?.length > 0 && (
        <div style={{ ...sCard, padding: 16 }}>
          {" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            {" "}
            <div>
              {" "}
              <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
                Protocol Health
              </div>{" "}
              <div style={{ fontSize: 11, color: D.muted }}>
                Template coverage, linked inventory COGS rows, and missing cost
                warnings
              </div>{" "}
            </div>{" "}
            <button
              onClick={load}
              style={{
                ...sBtn("transparent", D.muted),
                border: `1px solid ${D.border}`,
                fontSize: 11,
                padding: "6px 10px",
              }}
            >
              Refresh
            </button>{" "}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))",
              gap: 8,
            }}
          >
            {health.lines.map((line) => {
              const label = lineLabel(line.serviceLine);
              const color =
                line.status === "healthy"
                  ? D.green
                  : line.status === "warning"
                    ? D.amber
                    : D.red;
              const needsCogs = line.cogsRows === 0;
              const needsCosts = line.missingCostRows > 0;
              return (
                <div
                  key={line.serviceLine}
                  style={{
                    textAlign: "left",
                    background: D.input,
                    border: `1px solid ${color}55`,
                    borderRadius: 8,
                    padding: 10,
                  }}
                  title={(line.warnings || [])
                    .map((w) => `${w.serviceType}: ${w.warning}`)
                    .join("\n")}
                >
                  {" "}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    {" "}
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: D.heading,
                      }}
                    >
                      {label}
                    </div>{" "}
                    <span style={sBadge(`${color}22`, color)}>
                      {line.status}
                    </span>{" "}
                  </div>{" "}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, 1fr)",
                      gap: 6,
                      marginTop: 8,
                    }}
                  >
                    {" "}
                    <div>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 15,
                          color: D.heading,
                        }}
                      >
                        {line.templateCount}
                      </div>
                      <div
                        style={{
                          fontSize: 9,
                          color: D.muted,
                          textTransform: "uppercase",
                        }}
                      >
                        Templates
                      </div>
                    </div>{" "}
                    <div>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 15,
                          color: D.heading,
                        }}
                      >
                        {line.cogsRows}
                      </div>
                      <div
                        style={{
                          fontSize: 9,
                          color: D.muted,
                          textTransform: "uppercase",
                        }}
                      >
                        COGS
                      </div>
                    </div>{" "}
                    <div>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 15,
                          color,
                        }}
                      >
                        {line.missingCostRows}
                      </div>
                      <div
                        style={{
                          fontSize: 9,
                          color: D.muted,
                          textTransform: "uppercase",
                        }}
                      >
                        Missing
                      </div>
                    </div>{" "}
                  </div>{" "}
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      marginTop: 10,
                    }}
                  >
                    {" "}
                    <button
                      onClick={() => filterToLine(line.serviceLine)}
                      style={{
                        ...sBtn("transparent", D.teal),
                        border: `1px solid ${D.border}`,
                        fontSize: 10,
                        padding: "5px 8px",
                      }}
                    >
                      View
                    </button>
                    {needsCogs && (
                      <button
                        onClick={() => openAddForLine(line.serviceLine)}
                        style={{
                          ...sBtn(D.teal, D.white),
                          fontSize: 10,
                          padding: "5px 8px",
                        }}
                      >
                        + COGS
                      </button>
                    )}
                    {needsCosts && (
                      <button
                        onClick={() => highlightMissingCosts(line.serviceLine)}
                        style={{
                          ...sBtn(`${D.amber}22`, D.amber),
                          border: `1px solid ${D.amber}44`,
                          fontSize: 10,
                          padding: "5px 8px",
                        }}
                      >
                        Cost Data
                      </button>
                    )}
                    <button
                      onClick={() => {
                        window.location.href = "/admin/dispatch?tab=protocols";
                      }}
                      style={{
                        ...sBtn(
                          line.templateCount === 0
                            ? `${D.red}12`
                            : "transparent",
                          line.templateCount === 0 ? D.red : D.muted,
                        ),
                        border: `1px solid ${line.templateCount === 0 ? `${D.red}33` : D.border}`,
                        fontSize: 10,
                        padding: "5px 8px",
                      }}
                    >
                      Templates
                    </button>{" "}
                  </div>{" "}
                </div>
              );
            })}
          </div>{" "}
        </div>
      )}
      <div
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}
      >
        {PROTOCOL_FILTERS.map((filter) => {
          const active = serviceFilter === filter.key;
          return (
            <button
              key={filter.key}
              onClick={() => {
                setServiceFilter(filter.key);
                setCostHighlightLine(null);
              }}
              style={{
                ...sBtn(
                  active ? D.teal : "transparent",
                  active ? D.white : D.muted,
                ),
                border: `1px solid ${active ? D.teal : D.border}`,
                fontSize: 11,
                padding: "6px 10px",
              }}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
      {showNewService && (
        <div
          style={{
            ...sCard,
            display: "flex",
            gap: 8,
            alignItems: "center",
            border: `1px solid ${D.green}44`,
          }}
        >
          {" "}
          <input
            value={newServiceType}
            onChange={(e) => setNewServiceType(e.target.value)}
            placeholder="Service type (e.g. Mole Trapping)"
            style={{ ...sInput, flex: 1 }}
          />{" "}
          <button
            onClick={() => {
              if (newServiceType.trim()) {
                setShowAdd(newServiceType.trim());
                setShowNewService(false);
              }
            }}
            style={sBtn(D.green, D.white)}
          >
            Create
          </button>{" "}
          <button
            onClick={() => setShowNewService(false)}
            style={{
              ...sBtn("transparent", D.muted),
              border: `1px solid ${D.border}`,
            }}
          >
            Cancel
          </button>{" "}
        </div>
      )}
      {showAdd && !services.find((s) => s.serviceType === showAdd) && (
        <div style={{ ...sCard, border: `1px solid ${D.teal}44` }}>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            {showAdd}
          </div>{" "}
          <AddProtocolRow
            products={products}
            newRow={newRow}
            setNewRow={setNewRow}
            unitOpts={unitOpts}
            onAdd={() => addRow(showAdd)}
            onCancel={() => setShowAdd(null)}
          />{" "}
        </div>
      )}
      {services.length === 0 && !showAdd && (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No protocols defined yet.
        </div>
      )}
      {services.length > 0 && visibleServices.length === 0 && !showAdd && (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No protocols in this service category yet.
        </div>
      )}
      {visibleServices.map((svc) => {
        const serviceLine = protocolLineForService(svc.serviceType);
        const highlightService =
          costHighlightLine === serviceLine &&
          svc.products.some((p) => p.costWarning || !p.costPerApp);
        return (
          <div
            key={svc.serviceType}
            style={{
              ...sCard,
              border: highlightService ? `1px solid ${D.amber}` : sCard.border,
              boxShadow: highlightService
                ? `0 0 0 3px ${D.amber}18`
                : sCard.boxShadow,
            }}
          >
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
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
                {svc.serviceType}
              </div>{" "}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {" "}
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 16,
                    fontWeight: 700,
                    color: D.green,
                  }}
                >
                  ${svc.totalCost.toFixed(2)}/app
                </div>{" "}
                <button
                  onClick={() => {
                    setCostHighlightLine(null);
                    setShowAdd(
                      showAdd === svc.serviceType ? null : svc.serviceType,
                    );
                  }}
                  style={{
                    ...sBtn(D.teal, D.white),
                    fontSize: 11,
                    padding: "6px 12px",
                  }}
                >
                  + Product
                </button>{" "}
              </div>{" "}
            </div>{" "}
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              {" "}
              <thead>
                <tr>
                  {[
                    "Product",
                    "Usage",
                    "Per 1000sf",
                    "Best Price",
                    "Cost/App",
                    "Cost Source",
                    "Primary",
                    "Notes",
                    "",
                  ].map((h) => (
                    <th key={h} style={thS}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>{" "}
              <tbody>
                {svc.products.map((p) => {
                  const highlightProductCost =
                    costHighlightLine === serviceLine &&
                    (p.costWarning || !p.costPerApp);
                  return editingRow === p.id ? (
                    <tr key={p.id} style={{ background: `${D.teal}10` }}>
                      {" "}
                      <td style={{ ...tdS, fontWeight: 500 }}>
                        {p.productName}
                      </td>{" "}
                      <td style={tdS}>
                        <div style={{ display: "flex", gap: 4 }}>
                          <input
                            value={editForm.usageAmount}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                usageAmount: e.target.value,
                              }))
                            }
                            type="number"
                            step="0.01"
                            style={{ ...sInput, width: 60 }}
                          />
                          <select
                            value={editForm.usageUnit}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                usageUnit: e.target.value,
                              }))
                            }
                            style={{ ...sInput, width: 70 }}
                          >
                            {unitOpts.map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>{" "}
                      <td style={tdS}>
                        <input
                          value={editForm.usagePer1000sf}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              usagePer1000sf: e.target.value,
                            }))
                          }
                          type="number"
                          step="0.001"
                          placeholder="—"
                          style={{ ...sInput, width: 70 }}
                        />
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {p.bestPrice
                          ? `$${parseFloat(p.bestPrice).toFixed(2)}`
                          : "—"}
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontFamily: "'JetBrains Mono', monospace",
                          color: D.green,
                        }}
                      >
                        {p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : "—"}
                      </td>{" "}
                      <td style={{ ...tdS, fontSize: 11, color: D.muted }}>
                        {costSourceLabel(p)}
                      </td>{" "}
                      <td style={tdS}>
                        <input
                          type="checkbox"
                          checked={editForm.isPrimary}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              isPrimary: e.target.checked,
                            }))
                          }
                          style={{ accentColor: D.teal }}
                        />
                      </td>{" "}
                      <td style={tdS}>
                        <input
                          value={editForm.notes}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              notes: e.target.value,
                            }))
                          }
                          style={{ ...sInput, width: "100%" }}
                        />
                      </td>{" "}
                      <td style={{ ...tdS, width: 80 }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            onClick={() => saveEdit(p.id)}
                            style={{
                              fontSize: 10,
                              padding: "3px 6px",
                              borderRadius: 4,
                              border: "none",
                              background: D.green,
                              color: "#fff",
                              cursor: "pointer",
                            }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingRow(null)}
                            style={{
                              fontSize: 10,
                              padding: "3px 6px",
                              borderRadius: 4,
                              border: `1px solid ${D.border}`,
                              background: "none",
                              color: D.muted,
                              cursor: "pointer",
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </td>{" "}
                    </tr>
                  ) : (
                    <tr
                      key={p.id}
                      style={{
                        background: highlightProductCost
                          ? `${D.amber}12`
                          : "transparent",
                      }}
                    >
                      {" "}
                      <td style={{ ...tdS, fontWeight: 500 }}>
                        {p.productName}{" "}
                        {p.isPrimary && (
                          <span style={sBadge(`${D.teal}22`, D.teal)}>
                            Primary
                          </span>
                        )}
                      </td>{" "}
                      <td style={{ ...tdS, fontSize: 12 }}>
                        {p.usageAmount} {p.usageUnit}
                      </td>{" "}
                      <td style={{ ...tdS, fontSize: 12 }}>
                        {p.usagePer1000sf || "—"}
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {p.bestPrice
                          ? `$${parseFloat(p.bestPrice).toFixed(2)}`
                          : "—"}
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontFamily: "'JetBrains Mono', monospace",
                          color: D.green,
                        }}
                      >
                        {p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : "—"}
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontSize: 11,
                          color: p.costWarning ? D.amber : D.muted,
                        }}
                        title={p.costWarning || ""}
                      >
                        {costSourceLabel(p)}
                      </td>{" "}
                      <td style={{ ...tdS, fontSize: 11 }}>
                        {p.isPrimary ? "" : ""}
                      </td>{" "}
                      <td
                        style={{
                          ...tdS,
                          fontSize: 11,
                          color: D.muted,
                          maxWidth: 200,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.notes || "—"}
                      </td>{" "}
                      <td style={{ ...tdS, width: 80 }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          {" "}
                          <button
                            onClick={() => startEdit(p)}
                            style={{
                              fontSize: 10,
                              padding: "2px 6px",
                              borderRadius: 4,
                              border: `1px solid ${D.border}`,
                              background: "none",
                              color: D.teal,
                              cursor: "pointer",
                            }}
                          >
                            Edit
                          </button>{" "}
                          <button
                            onClick={() => deleteRow(p.id)}
                            style={{
                              fontSize: 10,
                              padding: "2px 6px",
                              borderRadius: 4,
                              border: "none",
                              background: `${D.red}22`,
                              color: D.red,
                              cursor: "pointer",
                            }}
                          >
                            ×
                          </button>{" "}
                        </div>
                      </td>{" "}
                    </tr>
                  );
                })}
              </tbody>{" "}
            </table>
            {showAdd === svc.serviceType && (
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: D.input,
                  borderRadius: 8,
                }}
              >
                {" "}
                <AddProtocolRow
                  products={products}
                  newRow={newRow}
                  setNewRow={setNewRow}
                  unitOpts={unitOpts}
                  onAdd={() => addRow(svc.serviceType)}
                  onCancel={() => setShowAdd(null)}
                />{" "}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AddProtocolRow({
  products,
  newRow,
  setNewRow,
  unitOpts,
  onAdd,
  onCancel,
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-end",
        flexWrap: "wrap",
      }}
    >
      {" "}
      <div>
        <label
          style={{
            fontSize: 10,
            color: D.muted,
            display: "block",
            marginBottom: 2,
          }}
        >
          Product
        </label>{" "}
        <select
          value={newRow.productId}
          onChange={(e) =>
            setNewRow((r) => ({ ...r, productId: e.target.value }))
          }
          style={{ ...sInput, width: 200 }}
        >
          <option value="">Select...</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>{" "}
      <div>
        <label
          style={{
            fontSize: 10,
            color: D.muted,
            display: "block",
            marginBottom: 2,
          }}
        >
          Amount
        </label>{" "}
        <input
          value={newRow.usageAmount}
          onChange={(e) =>
            setNewRow((r) => ({ ...r, usageAmount: e.target.value }))
          }
          type="number"
          step="0.01"
          style={{ ...sInput, width: 70 }}
        />
      </div>{" "}
      <div>
        <label
          style={{
            fontSize: 10,
            color: D.muted,
            display: "block",
            marginBottom: 2,
          }}
        >
          Unit
        </label>{" "}
        <select
          value={newRow.usageUnit}
          onChange={(e) =>
            setNewRow((r) => ({ ...r, usageUnit: e.target.value }))
          }
          style={{ ...sInput, width: 80 }}
        >
          {unitOpts.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>{" "}
      <div>
        <label
          style={{
            fontSize: 10,
            color: D.muted,
            display: "block",
            marginBottom: 2,
          }}
        >
          Per 1000sf
        </label>{" "}
        <input
          value={newRow.usagePer1000sf}
          onChange={(e) =>
            setNewRow((r) => ({ ...r, usagePer1000sf: e.target.value }))
          }
          type="number"
          step="0.001"
          placeholder="—"
          style={{ ...sInput, width: 70 }}
        />
      </div>{" "}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={newRow.isPrimary}
          onChange={(e) =>
            setNewRow((r) => ({ ...r, isPrimary: e.target.checked }))
          }
          style={{ accentColor: D.teal }}
        />
        <label style={{ fontSize: 10, color: D.muted }}>Primary</label>
      </div>{" "}
      <div>
        <label
          style={{
            fontSize: 10,
            color: D.muted,
            display: "block",
            marginBottom: 2,
          }}
        >
          Notes
        </label>{" "}
        <input
          value={newRow.notes}
          onChange={(e) => setNewRow((r) => ({ ...r, notes: e.target.value }))}
          placeholder="Usage notes..."
          style={{ ...sInput, width: 150 }}
        />
      </div>{" "}
      <button onClick={onAdd} style={sBtn(D.green, D.white)}>
        Add
      </button>{" "}
      <button
        onClick={onCancel}
        style={{
          ...sBtn("transparent", D.muted),
          border: `1px solid ${D.border}`,
        }}
      >
        Cancel
      </button>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SERVICE MARGINS TAB
// ══════════════════════════════════════════════════════════════
function MarginsTab({ showToast }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/inventory/service-usage")
      .then((d) => {
        setServices(d.services || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading service margins...
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
          marginBottom: 16,
        }}
      >
        COGS by Service Line
      </div>
      {services.length === 0 ? (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No service product mappings yet.
        </div>
      ) : (
        services.map((svc) => (
          <div key={svc.serviceType} style={{ ...sCard }}>
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
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
                {svc.serviceType}
              </div>{" "}
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 16,
                  fontWeight: 700,
                  color: D.green,
                }}
              >
                ${svc.totalCost.toFixed(2)}/app
              </div>{" "}
            </div>{" "}
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              {" "}
              <thead>
                <tr>
                  {[
                    "Product",
                    "Usage",
                    "Per 1000sf",
                    "Best Price",
                    "Cost/App",
                    "Cost Source",
                  ].map((h) => (
                    <th key={h} style={thS}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>{" "}
              <tbody>
                {svc.products.map((p) => (
                  <tr key={p.id}>
                    {" "}
                    <td style={{ ...tdS, fontWeight: 500 }}>
                      {p.productName}{" "}
                      {p.isPrimary && (
                        <span style={sBadge(`${D.teal}22`, D.teal)}>
                          Primary
                        </span>
                      )}
                    </td>{" "}
                    <td style={{ ...tdS, fontSize: 12 }}>
                      {p.usageAmount} {p.usageUnit}
                    </td>{" "}
                    <td style={{ ...tdS, fontSize: 12 }}>
                      {p.usagePer1000sf || "—"}
                    </td>{" "}
                    <td
                      style={{
                        ...tdS,
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      {p.bestPrice
                        ? `$${parseFloat(p.bestPrice).toFixed(2)}`
                        : "—"}
                    </td>{" "}
                    <td
                      style={{
                        ...tdS,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: D.green,
                      }}
                    >
                      {p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : "—"}
                    </td>{" "}
                    <td
                      style={{
                        ...tdS,
                        fontSize: 11,
                        color: p.costWarning ? D.amber : D.muted,
                      }}
                      title={p.costWarning || ""}
                    >
                      {costSourceLabel(p)}
                    </td>{" "}
                  </tr>
                ))}
              </tbody>{" "}
            </table>{" "}
          </div>
        ))
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SCRAPE HEALTH TAB
// ══════════════════════════════════════════════════════════════
function ScrapeTab({ showToast }) {
  const [vendors, setVendors] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    const [vData, jData] = await Promise.all([
      adminFetch("/admin/inventory/vendors"),
      adminFetch("/admin/inventory/scrape-jobs"),
    ]);
    setVendors((vData.vendors || []).filter((v) => v.scrapingEnabled));
    setJobs(jData.jobs || []);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const triggerScrape = async (vendorId) => {
    try {
      const r = await adminFetch(
        `/admin/inventory/scrape-jobs/${vendorId}/trigger`,
        { method: "POST" },
      );
      showToast(r.message || "Scrape triggered");
      load();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading scrape data...
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
          marginBottom: 16,
        }}
      >
        Vendor Scrape Status
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 10,
          marginBottom: 24,
        }}
      >
        {vendors.map((v) => {
          const sc =
            v.lastScrapeStatus === "completed"
              ? D.green
              : v.lastScrapeStatus === "running"
                ? D.amber
                : v.lastScrapeStatus === "failed"
                  ? D.red
                  : D.muted;
          return (
            <div
              key={v.id}
              style={{ ...sCard, marginBottom: 0, textAlign: "center" }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 4,
                }}
              >
                {v.name}
              </div>
              <div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>
                {v.productCount} products
              </div>
              <span style={sBadge(`${sc}22`, sc)}>
                {v.lastScrapeStatus || "never"}
              </span>
              <button
                onClick={() => triggerScrape(v.id)}
                style={{
                  ...sBtn(D.teal, D.white),
                  marginTop: 8,
                  width: "100%",
                  fontSize: 11,
                }}
              >
                Trigger Scrape
              </button>
            </div>
          );
        })}
        {!vendors.length && (
          <div
            style={{
              color: D.muted,
              gridColumn: "1 / -1",
              textAlign: "center",
              padding: 20,
            }}
          >
            No vendors with scraping enabled
          </div>
        )}
      </div>{" "}
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: D.heading,
          marginBottom: 12,
        }}
      >
        Recent Scrape Jobs
      </div>
      {!jobs.length ? (
        <div
          style={{ ...sCard, textAlign: "center", padding: 30, color: D.muted }}
        >
          No scrape jobs yet
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          {" "}
          <thead>
            <tr>
              {[
                "Vendor",
                "Status",
                "Products",
                "Updated",
                "New",
                "Errors",
                "Duration",
                "Date",
              ].map((h) => (
                <th key={h} style={thS}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>{" "}
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                {" "}
                <td style={{ ...tdS, fontWeight: 500 }}>
                  {j.vendor_name}
                </td>{" "}
                <td style={tdS}>
                  <span
                    style={sBadge(
                      j.status === "completed"
                        ? `${D.green}22`
                        : j.status === "failed"
                          ? `${D.red}22`
                          : `${D.amber}22`,
                      j.status === "completed"
                        ? D.green
                        : j.status === "failed"
                          ? D.red
                          : D.amber,
                    )}
                  >
                    {j.status}
                  </span>
                </td>{" "}
                <td style={tdS}>{j.products_found}</td>
                <td style={tdS}>{j.prices_updated}</td>
                <td style={tdS}>{j.prices_new}</td>{" "}
                <td style={{ ...tdS, color: j.errors > 0 ? D.red : D.muted }}>
                  {j.errors}
                </td>{" "}
                <td
                  style={{
                    ...tdS,
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {j.duration_ms
                    ? `${(j.duration_ms / 1000).toFixed(1)}s`
                    : "—"}
                </td>{" "}
                <td style={{ ...tdS, fontSize: 11, color: D.muted }}>
                  {new Date(j.created_at).toLocaleString()}
                </td>{" "}
              </tr>
            ))}
          </tbody>{" "}
        </table>
      )}
    </div>
  );
}
