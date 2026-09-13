import { useState, useEffect, useCallback, useRef } from "react";
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useSearchParams,
} from "react-router-dom";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import {
  useIntelligenceBarActions,
  usePublishIntelligenceBarPageData,
} from "../../hooks/useIntelligenceBarPageData";
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
import ProductLabelReview from "../../components/admin/ProductLabelReview";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  UiSurface,
  Field,
  cn,
} from "../../components/ui";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
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

// The flat 13-tab bar is organized into parent groups, each revealing its leaf
// tabs in a sub-row. `tab` state still holds the LEAF key, so every
// {tab === "..."} render block below is unchanged.
const TAB_GROUPS = [
  {
    key: "products",
    label: "Products",
    Icon: Package,
    tabs: ["products"],
  },
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
  products: {
    label: "Products",
    Icon: Package,
  },
  "price-sync": {
    label: "Price Sync",
    Icon: Store,
  },
  approvals: {
    label: "Approvals",
    Icon: CheckCircle2,
  },
  vendors: {
    label: "Vendors",
    Icon: Store,
  },
  scrape: {
    label: "Scrape Health",
    Icon: ShieldCheck,
  },
  forecast: {
    label: "Forecast",
    Icon: ShoppingCart,
  },
  "unit-review": {
    label: "Unit Review",
    Icon: ClipboardList,
  },
  restock: {
    label: "Restock",
    Icon: ShoppingCart,
  },
  registry: {
    label: "Registry",
    Icon: ClipboardList,
  },
  lawnFacts: {
    label: "Lawn Facts",
    Icon: ShieldCheck,
  },
  lawnContent: {
    label: "Lawn Content",
    Icon: FileText,
  },
  protocols: {
    label: "Protocols",
    Icon: FileText,
  },
  margins: {
    label: "Service Margins",
    Icon: Percent,
  },
};
const ALL_LEAF_TABS = TAB_GROUPS.flatMap((g) => g.tabs);

// Vendor credentials, pricing sync/approvals, scrape health, and service
// margins are owner-only (2026-08-25 role lockdown) — techs keep products,
// planning, content, and protocols. Server-gated in admin-inventory.js.
const OWNER_ONLY_INVENTORY_TABS = new Set([
  "price-sync",
  "approvals",
  "vendors",
  "scrape",
  "margins",
  // Content authoring (product registry copy, lawn facts/content modules)
  // is owner-only too — its PATCH/PUT surface 403s the technician role.
  "registry",
  "lawnFacts",
  "lawnContent",
  // Protocol config reads carry per-product cost/COGS data (owner-only);
  // techs get protocol reference in the tech portal instead.
  "protocols",
]);
export default function InventoryPage() {
  const { lastMutation } = useIntelligenceBarActions();
  const inventoryRefresh =
    lastMutation?.domain === "inventory" ? lastMutation.id : null;
  const statsSequence = useRef(0);
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // Server-verified role from the shell's Outlet context (never localStorage).
  const outletContext = useOutletContext();
  const isAdminRole = outletContext?.user?.role === "admin";
  const visibleGroups = TAB_GROUPS.map((g) => ({
    ...g,
    tabs: g.tabs.filter(
      (t) => isAdminRole || !OWNER_ONLY_INVENTORY_TABS.has(t),
    ),
  })).filter((g) => g.tabs.length > 0);
  const requestedTab = searchParams.get("tab");
  const tab =
    ALL_LEAF_TABS.includes(requestedTab) &&
    (isAdminRole || !OWNER_ONLY_INVENTORY_TABS.has(requestedTab))
      ? requestedTab
      : "products";

  const setTab = useCallback(
    (nextTab) => {
      const normalizedTab =
        ALL_LEAF_TABS.includes(nextTab) &&
        (isAdminRole || !OWNER_ONLY_INVENTORY_TABS.has(nextTab))
          ? nextTab
          : "products";
      if (normalizedTab === tab) return;
      const next = new URLSearchParams(searchParams);
      next.set("tab", normalizedTab);
      navigate({
        pathname: location.pathname,
        search: `?${next.toString()}`,
        hash: location.hash,
      });
    },
    [isAdminRole, location.hash, location.pathname, navigate, searchParams, tab],
  );

  // Report the validated, role-allowed leaf that actually renders. The
  // searchParams dependency also re-asserts the fallback after same-route
  // history navigation to an invalid or restricted deep link.
  useRenderedTabBeacon("/admin/inventory", tab, [searchParams]);
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState("");
  const [productFilter, setProductFilter] = useState("all");
  const [showAddForm, setShowAddForm] = useState(false);

  const loadStats = useCallback(() => {
    const sequence = ++statsSequence.current;
    return adminFetch("/admin/inventory/stats")
      .then((value) => {
        if (sequence === statsSequence.current) setStats(value);
      })

      .catch(() => {});
  }, []);
  useEffect(() => {
    loadStats();
    return () => {
      statsSequence.current += 1;
    };
  }, [loadStats, inventoryRefresh]);
  const showToast = useCallback((m) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  }, []);

  const activeGroup =
    visibleGroups.find((g) => g.tabs.includes(tab)) || visibleGroups[0];
  const groupSections = visibleGroups.map((g) => {
    let pending = 0;
    if (g.tabs.includes("approvals")) pending += stats?.approvals?.pending || 0;
    if (g.tabs.includes("restock"))
      pending += stats?.restockRequests?.open || 0;
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
    <UiSurface
      density="comfortable"
      className="mx-auto max-w-[1300px] text-ui-body text-ink-primary"
    >
      {" "}
      <AdminCommandHeader
        variant="workspace"
        title="Inventory"
        icon={Package}
        sections={groupSections}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = visibleGroups.find((x) => x.key === key);
          if (g) setTab(g.tabs[0]);
        }}
        ariaLabel="Inventory section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
        action={
          // Product authoring is owner-only (POST/PUT/DELETE 403 for techs).
          tab === "products" && isAdminRole
            ? {
                label: "Add Product",
                icon: Plus,
                onClick: () => setShowAddForm((s) => !s),
              }
            : null
        }
      />
      {activeGroup.tabs.length > 1 && (
        <div className="flex flex-wrap gap-[8px] mb-[16px]">
          {activeGroup.tabs.map((key) => {
            const active = tab === key;
            const LeafIcon = LEAF_META[key].Icon;
            return (
              <Button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                variant={active ? "primary" : "secondary"}
              >
                <LeafIcon size={14} strokeWidth={1.9} />
                {leafLabel(key)}
              </Button>
            );
          })}
        </div>
      )}
      {stats && (
        <div className="flex gap-[10px] mb-[20px] flex-wrap">
          {[
            {
              label: "Products",
              value: stats.products?.total,
              filter: "all",
            },
            {
              label: "Priced",
              value: stats.products?.priced,
              filter: "priced",
            },
            {
              label: "Needs Price",
              value: stats.products?.needsPrice,
              // Main: unconditional amber (routine, not a failure state).
              tone: "warn",
              filter: "needs_price",
            },
            {
              label: "Low Stock",
              value: stats.products?.lowStock,
              tone: stats.products?.lowStock > 0 ? "alert" : undefined,
              filter: "low_stock",
            },
            {
              label: "Vendors",
              value: stats.vendors?.total,
              action: () => setTab("vendors"),
              adminOnly: true,
            },
            {
              label: "Pending Approvals",
              value: stats.approvals?.pending,
              // Main: amber — routine queued work, not a failure.
              tone: stats.approvals?.pending > 0 ? "warn" : undefined,
              action: () => setTab("approvals"),
              adminOnly: true,
            },
            {
              label: "Restock",
              value: stats.restockRequests?.open,
              tone: stats.restockRequests?.open > 0 ? "warn" : undefined,
              action: () => setTab("restock"),
            },
            {
              label: "Scrape Jobs",
              value: stats.scrapeJobs?.completed,
              action: () => setTab("scrape"),
              adminOnly: true,
            },
            // Shortcut cards into owner-only tabs are hidden for techs —
            // clicking them would land on a tab the role can't open.
          ]
            .filter((s) => isAdminRole || !s.adminOnly)
            .map((s) => (
              <Button
                type="button"
                key={s.label}
                onClick={() => {
                  if (s.action) s.action();
                  else if (s.filter) {
                    setTab("products");
                    setProductFilter(s.filter);
                  }
                }}
                variant="secondary"
                className={cn(
                  "flex-[1_1_120px] min-w-[120px] min-h-20 flex-col text-center",
                  s.tone === "alert" && "border-alert-fg",
                  s.tone === "warn" && "border-warn-fg",
                )}
              >
                {" "}
                <div
                  className={cn(
                    "text-22 font-medium u-nums",
                    s.tone === "alert" ? "text-alert-fg" : s.tone === "warn" ? "text-warn-fg" : "text-zinc-900",
                  )}
                >
                  {s.value ?? 0}
                </div>{" "}
                <div className="text-ui-body text-ink-secondary mt-[2px]">
                  {s.label}
                </div>{" "}
              </Button>
            ))}
        </div>
      )}
      {tab === "products" && (
        <ProductsTab
          refreshId={inventoryRefresh}
          initialSearch={searchParams.get("search") || ""}
          initialProductId={searchParams.get("productId")}
          showToast={showToast}
          filter={productFilter}
          onFilterChange={setProductFilter}
          showAddForm={showAddForm}
          setShowAddForm={setShowAddForm}
          canAuthor={isAdminRole}
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
      {tab === "forecast" && (
        <WaveGuardForecastTab
          showToast={showToast}
          onUpdate={loadStats}
          refreshId={inventoryRefresh}
        />
      )}
      {tab === "unit-review" && <UnitReviewTab showToast={showToast} />}
      {tab === "restock" && (
        <RestockRequestsTab
          showToast={showToast}
          onUpdate={loadStats}
          canAuthor={isAdminRole}
          refreshId={inventoryRefresh}
          requestId={searchParams.get("requestId")}
        />
      )}
      {tab === "margins" && <MarginsTab showToast={showToast} />}
      {tab === "scrape" && <ScrapeTab showToast={showToast} />}
      {toast && (
        <ActionFeedback className="fixed bottom-[calc(20px+env(safe-area-inset-bottom,0px))] right-[calc(20px+env(safe-area-inset-right,0px))] z-[300] max-w-[calc(100vw-40px)] pointer-events-none rounded-md border-hairline border-zinc-200 bg-white px-3.5 py-3 shadow-lg">
          {" "}
          {toast}
        </ActionFeedback>
      )}
    </UiSurface>
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
      productType:
        p.productType ||
        row.readiness?.productType ||
        suggestion.productType ||
        "",
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
      labelVerifiedAt: p.labelVerifiedAt
        ? String(p.labelVerifiedAt).slice(0, 10)
        : "",
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
      customerPrecautionSummary:
        current.customerPrecautionSummary ||
        suggestion.customerPrecautionSummary ||
        "",
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
      showToast(
        approve
          ? "Product fact approved for estimate packets"
          : "Product fact saved",
      );
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
    const tone =
      status === "missing_product" ? "alert" : status === "needs_facts" ? "warn" : "neutral";
    return (
      <Badge tone={tone}>
        {String(status || "unknown").replaceAll("_", " ")}
      </Badge>
    );
  };
  if (loading)
    return <ActionFeedback>Loading lawn product facts...</ActionFeedback>;
  const visibleFacts =
    statusFilter === "all"
      ? facts
      : facts.filter((row) => row.readiness?.status === statusFilter);
  const missingFieldEntries = Object.entries(summary?.missingFields || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return (
    <div>
      <Card className="p-5 mb-3 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-[12px]">
        {[
          ["Protocol Products", summary?.total || 0],
          ["Approved", summary?.approved || 0],
          ["Ready", summary?.ready_to_approve || 0],
          ["Needs Facts", summary?.needs_facts || 0],
          ["Missing", summary?.missing_product || 0],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-22 font-medium text-zinc-900 u-nums">{value}</div>
            <div className="text-ui-body text-ink-secondary">{label}</div>
          </div>
        ))}
      </Card>

      {missingFieldEntries.length > 0 && (
        <Card className="p-5 mb-3">
          <div className="text-ui-body font-medium text-zinc-900 mb-[10px]">
            Most Common Readiness Gaps
          </div>
          <div className="flex gap-[8px] flex-wrap">
            {missingFieldEntries.map(([field, count]) => (
              <Badge key={field} tone="warn">
                {field} · {count}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5 mb-3">
        <div className="flex justify-between gap-[12px] flex-wrap items-center mb-[16px]">
          <div>
            <div className="text-18 font-medium text-zinc-900 mb-[6px]">
              Lawn Estimate Product Facts
            </div>
            <div className="text-ui-body text-ink-secondary">
              Product cards in lawn service outlines only render from products
              approved here. Draft or incomplete products stay hidden.
            </div>
          </div>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="min-w-[190px]"
          >
            <option value="all">All statuses</option>
            <option value="missing_product">Missing product</option>
            <option value="needs_facts">Needs facts</option>
            <option value="ready_to_approve">Ready to approve</option>
            <option value="approved">Approved</option>
          </Select>
        </div>
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
                <TH>Protocol item</TH>
                <TH>Used In</TH>
                <TH>Catalog match</TH>
                <TH>Status</TH>
                <TH>Missing</TH>
                <TH>Actions</TH>
              </TR>
            </THead>
            <TBody>
              {visibleFacts.map((row) => (
                <TR key={row.key || row.needle}>
                  <TD>
                    <div className="font-medium text-zinc-900">
                      {row.needle}
                    </div>
                    <div className="text-ui-body text-ink-secondary">
                      {row.expectedCategory}
                    </div>
                  </TD>
                  <TD>
                    <div className="text-ui-body text-zinc-900">
                      {(row.turfTracks || []).join(", ")}
                    </div>
                    <div className="text-ui-body text-ink-secondary">
                      {(row.months || []).join(", ")} ·{" "}
                      {row.referenceCount || 0} refs
                    </div>
                  </TD>
                  <TD>
                    {row.product ? (
                      <>
                        <div className="font-medium text-zinc-900">
                          {row.product.name}
                        </div>
                        <div className="text-ui-body text-ink-secondary">
                          {row.product.productType ||
                            row.readiness?.productType ||
                            "type pending"}{" "}
                          · {row.product.contentStatus} ·{" "}
                          {row.product.customerVisibility}
                        </div>
                      </>
                    ) : (
                      <span className="text-alert-fg">No product match</span>
                    )}
                  </TD>
                  <TD>{badge(row.readiness?.status)}</TD>
                  <TD>
                    {(row.readiness?.missing || []).length ? (
                      <ul className="m-0 pl-[18px] max-w-[360px]">
                        {row.readiness.missing.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-zinc-900">Complete</span>
                    )}
                  </TD>
                  <TD>
                    {row.product && (
                      <div className="flex gap-[8px] flex-wrap">
                        <Button
                          type="button"
                          onClick={() => startEdit(row)}
                          variant="secondary"
                        >
                          Edit
                        </Button>
                        {row.readiness?.eligible &&
                          row.readiness?.status !== "approved" && (
                            <Button
                              type="button"
                              onClick={() => approveRow(row)}
                              variant="primary"
                            >
                              Approve
                            </Button>
                          )}
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {visibleFacts.length === 0 && (
            <div className="p-[18px] text-ink-secondary">
              No products match this status.
            </div>
          )}
        </div>
      </Card>

      {editing && (
        <Card className="p-5 mb-3">
          <div className="flex justify-between gap-[12px] items-center mb-[14px]">
            <div>
              <div className="text-18 font-medium text-zinc-900">
                Edit Product Fact
              </div>
              <div className="text-ui-body text-ink-secondary">
                {editing.product?.name}
              </div>
            </div>
            <Button
              type="button"
              onClick={() => setEditing(null)}
              variant="secondary"
            >
              Close
            </Button>
          </div>
          {editing.suggestedCopy && (
            <Card className="p-3 mb-[14px] bg-zinc-50">
              <div className="text-ui-body font-medium text-zinc-900">
                Starter copy
              </div>
              <div className="text-ui-body text-ink-secondary mt-[4px]">
                This is draft customer-safe language from the protocol item
                category. It does not approve EPA numbers, label claims, or
                product eligibility.
              </div>
              <Button
                type="button"
                onClick={applySuggestedCopy}
                variant="secondary"
                className="mt-[10px]"
              >
                Fill empty copy fields
              </Button>
            </Card>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-[12px]">
            {[
              ["productType", "Product type"],
              ["customerVisibility", "Visibility"],
              ["contentStatus", "Content status"],
              ["epaRegNumber", "EPA registration number"],
              ["labelSourceUrl", "Label source URL"],
              ["labelVerifiedAt", "Label verified date"],
              ["labelVersion", "Label version"],
            ].map(([key, label]) => (
              <Field label={label} key={key} className="block">
                <Input
                  type={key === "labelVerifiedAt" ? "date" : "text"}
                  value={form[key] || ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      [key]: e.target.value,
                    }))
                  }
                  className="w-full"
                />
              </Field>
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
            <Field label={label} key={key} className="block mt-[12px]">
              <Textarea
                value={form[key] || ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    [key]: e.target.value,
                  }))
                }
                className="w-full min-h-[72px] resize-y"
              />
            </Field>
          ))}
          <div className="flex gap-[10px] mt-[16px] flex-wrap">
            <Button type="button" onClick={() => save(false)} variant="primary">
              Save
            </Button>
            <Button type="button" onClick={() => save(true)} variant="primary">
              Save + Approve
            </Button>
          </div>
        </Card>
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
  const visible =
    selectedKey === "all"
      ? latest
      : latest.filter((module) => module.key === selectedKey);
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
      showToast(
        status === "approved"
          ? "Content module approved"
          : "Content module saved",
      );
      setEditing(null);
      load();
    } catch (err) {
      showToast(err.message || "Save failed");
    }
  };
  if (loading)
    return <ActionFeedback>Loading lawn content modules...</ActionFeedback>;
  return (
    <div>
      <Card className="p-5 mb-3">
        <div className="flex justify-between gap-[12px] flex-wrap items-center">
          <div>
            <div className="text-18 font-medium text-zinc-900">
              Lawn Outline Content Library
            </div>
            <div className="text-ui-body text-ink-secondary mt-[4px]">
              These approved modules power the public page, estimate packet, and
              service-report language.
            </div>
          </div>
          <Select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="min-w-[240px]"
          >
            {keys.map((key) => (
              <option key={key} value={key}>
                {key === "all" ? "All modules" : key}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card className="p-5 mb-3">
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
                <TH>Key</TH>
                <TH>Title</TH>
                <TH>Audience</TH>
                <TH>Status</TH>
                <TH>Copy</TH>
                <TH>Actions</TH>
              </TR>
            </THead>
            <TBody>
              {visible.map((module) => (
                <TR key={module.id}>
                  <TD>
                    <div className="text-ui-body">{module.key}</div>
                    <div className="text-ui-body text-ink-secondary">
                      v{module.version}
                    </div>
                  </TD>
                  <TD>{module.title}</TD>
                  <TD>{module.audience}</TD>
                  <TD>
                    {/* Main: green when approved, amber otherwise (draft/
                        review/deprecated/retired) — the module status enum
                        has no failed/rejected state to reserve alert for.
                        The kit has no success tone, so approved is strong. */}
                    <Badge tone={module.status === "approved" ? "strong" : "warn"}>
                      {module.status}
                    </Badge>
                  </TD>
                  <TD className="max-w-[460px]">
                    <div className="line-clamp-3 overflow-hidden">{module.plain_text}</div>
                  </TD>
                  <TD>
                    <Button
                      type="button"
                      onClick={() => startEdit(module)}
                      variant="secondary"
                    >
                      Edit
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Card>

      {editing && (
        <Card className="p-5 mb-3">
          <div className="flex justify-between gap-[12px] items-center mb-[14px]">
            <div>
              <div className="text-18 font-medium text-zinc-900">
                Edit Content Module
              </div>
              <div className="text-ui-body text-ink-secondary">
                {editing.key}
              </div>
            </div>
            <Button
              type="button"
              onClick={() => setEditing(null)}
              variant="secondary"
            >
              Close
            </Button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[12px]">
            <Field label="Title">
              <Input
                value={form.title || ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    title: e.target.value,
                  }))
                }
                className="w-full"
              />
            </Field>
            <Field label="Audience">
              <Select
                value={form.audience || "estimate_packet"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    audience: e.target.value,
                  }))
                }
                className="w-full"
              >
                <option value="public">Public</option>
                <option value="estimate_packet">Estimate packet</option>
                <option value="service_report">Service report</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={form.status || "draft"}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    status: e.target.value,
                  }))
                }
                className="w-full"
              >
                <option value="draft">Draft</option>
                <option value="review">Review</option>
                <option value="approved">Approved</option>
                <option value="deprecated">Deprecated</option>
                <option value="retired">Retired</option>
              </Select>
            </Field>
          </div>
          <Field label="Approved copy" className="block mt-[12px]">
            <Textarea
              value={form.plainText || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  plainText: e.target.value,
                }))
              }
              className="w-full min-h-[140px] resize-y"
            />
          </Field>
          <Field label="Source notes" className="block mt-[12px]">
            <Textarea
              value={form.sourceNotes || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  sourceNotes: e.target.value,
                }))
              }
              className="w-full min-h-[72px] resize-y"
            />
          </Field>
          <div className="flex gap-[10px] mt-[16px] flex-wrap">
            <Button type="button" onClick={() => save()} variant="primary">
              Save
            </Button>
            <Button
              type="button"
              onClick={() => save("approved")}
              variant="primary"
            >
              Save + Approve
            </Button>
          </div>
        </Card>
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
  const [autoMapIds, setAutoMapIds] = useState(() => new Set());
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
    if (autoMapIds.has(vendorId)) return;
    setAutoMapIds((prev) => new Set(prev).add(vendorId));
    try {
      const result = await adminFetch("/admin/inventory/price-sync/auto-map", {
        method: "POST",
        body: JSON.stringify({ vendorId, limit: 8 }),
      });
      showToast?.(
        result.message || `Auto-mapped ${result.mapped || 0} products`,
      );
      await load();
    } catch (e) {
      showToast?.(`Auto-map failed: ${e.message}`);
    } finally {
      setAutoMapIds((prev) => {
        const next = new Set(prev);
        next.delete(vendorId);
        return next;
      });
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
    return <ActionFeedback>Loading price sync...</ActionFeedback>;
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
      <div className="flex gap-[10px] flex-wrap">
        {[
          {
            label: "Vendors",
            value: vendors.length,
          },
          {
            label: "Connections",
            value: totalConnections,
          },
          {
            label: "Needs Mapping",
            value: needsMapping.length,
          },
          {
            label: "Verified Maps",
            value: verifiedMappings,
          },
          {
            label: "Current Prices",
            value: currentPrices,
          },
          {
            label: "Needs Login",
            value: loginDiscoveryVendors.length,
          },
          {
            label: "Pending Review",
            value: reviewQueue.length,
          },
        ].map((item) => (
          <Card
            key={item.label}
            className="p-5 mb-3 flex-[1_1_130px] min-w-[130px] mb-[12px] text-center"
          >
            <div className="text-22 font-medium u-nums">{item.value}</div>
            <div className="text-ui-body text-ink-secondary mt-[2px]">
              {item.label}
            </div>
          </Card>
        ))}
      </div>

      <div className="flex gap-[6px] mb-[12px] flex-wrap">
        {[
          {
            key: "vendors",
            label: "Vendor Sync Status",
          },
          {
            key: "mapping",
            label: "Needs Mapping",
          },
          {
            key: "login",
            label: "Login Discovery",
          },
          {
            key: "csv",
            label: "CSV Import / Export",
          },
          {
            key: "review",
            label: "Price Review Queue",
          },
        ].map((tab) => (
          <Button
            key={tab.key}
            onClick={() => setView(tab.key)}
            variant={view === tab.key ? "primary" : "secondary"}
            aria-pressed={view === tab.key}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {view === "vendors" && (
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
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
                  <TH key={h}>{h}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {vendors.map((vendor) => (
                <TR key={vendor.id}>
                  <TD className="font-medium text-zinc-900">{vendor.name}</TD>
                  <TD>
                    <div className="flex gap-[4px] flex-wrap">
                      {(vendor.connections || []).map((connection) => (
                        <Badge
                          key={connection.id}
                          title={`${connection.approvalStatus} / ${connection.credentialStatus}`}
                          tone={connection.credentialStatus === "missing" ? "warn" : "neutral"}
                        >
                          {connection.type}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  <TD nums>{vendor.mappedProducts}</TD>
                  <TD nums>{vendor.verifiedMappings}</TD>
                  <TD nums>{vendor.currentPrices}</TD>
                  <TD nums>{vendor.bestPrices}</TD>
                  <TD nums>{vendor.pendingApprovals}</TD>
                  <TD className="text-ink-secondary">
                    <div className="flex items-center gap-[8px] flex-wrap">
                      <span>{vendor.nextAction}</span>
                      {(vendor.nextAction === "Needs mapping" ||
                        vendor.nextAction === "Verify mappings") && (
                        <Button
                          onClick={() => autoMapVendor(vendor.id)}
                          disabled={autoMapIds.has(vendor.id)}
                          title="AI-propose vendor SKUs/URLs for this vendor's unmapped products (writes unverified — review before pricing)"
                          variant="primary"
                        >
                          {autoMapIds.has(vendor.id) ? "Mapping…" : "Auto-map"}
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {view === "mapping" && (
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
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
                  <TH key={h}>{h}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {needsMapping.map((product) => (
                <TR key={product.id}>
                  <TD className="font-medium text-zinc-900">{product.name}</TD>
                  <TD>{product.category || "—"}</TD>
                  <TD>{product.sku || "—"}</TD>
                  <TD>{product.containerSize || "—"}</TD>
                  <TD>
                    <Badge tone="warn">
                      {product.bestPriceStatus || "needs_mapping"}
                    </Badge>
                  </TD>
                  <TD nums>{product.mappedVendors}</TD>
                  <TD nums>{product.verifiedMappings}</TD>
                  <TD nums>{product.completePackageMaps}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {needsMapping.length === 0 && (
            <Card className="p-5 mb-3 text-ink-secondary text-center">
              All active products have verified mappings.
            </Card>
          )}
        </div>
      )}

      {view === "login" && (
        <Card className="p-5 mb-3">
          <div className="flex justify-between gap-[12px] flex-wrap items-end mb-[14px]">
            <div>
              <h3 className="m-0 mb-1 text-zinc-900 text-18">
                Hermes vendor login discovery
              </h3>
              <div className="text-ink-secondary text-ui-body">
                Queue active vendors missing login setup so Hermes can find
                portal, registration, and rep-contact paths.
              </div>
            </div>
            <div className="flex gap-[8px] flex-wrap items-end">
              <Field label="Vendor cap">
                <Input
                  type="number"
                  min="1"
                  max="200"
                  value={loginDiscoveryLimit}
                  onChange={(e) => setLoginDiscoveryLimit(e.target.value)}
                  className="w-[110px]"
                />
              </Field>
              <Button
                type="button"
                onClick={queueLoginDiscovery}
                disabled={loginDiscoveryQueueing}
                variant="secondary"
              >
                {loginDiscoveryQueueing ? "Queueing..." : "Queue Hermes"}
              </Button>
            </div>
          </div>

          {loginDiscoveryResult && (
            <ActionFeedback className="mb-[12px]">
              Queued {loginDiscoveryResult.queued || 0}; skipped open jobs{" "}
              {loginDiscoveryResult.duplicates || 0}; candidates{" "}
              {loginDiscoveryResult.candidateCount || 0}.
            </ActionFeedback>
          )}

          <div className="overflow-x-auto">
            <Table className="w-full">
              <THead>
                <TR>
                  {[
                    "Vendor",
                    "Website",
                    "Login URL",
                    "Credentials",
                    "Status",
                    "Hermes",
                  ].map((h) => (
                    <TH key={h}>{h}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {loginDiscoveryVendors.map((vendor) => {
                  const websiteHref = safeExternalHref(vendor.website);
                  const loginHref = safeExternalHref(vendor.loginUrl);
                  return (
                    <TR key={vendor.id}>
                      <TD className="font-medium text-zinc-900">
                        {vendor.name}
                      </TD>
                      <TD>
                        {websiteHref ? (
                          <a
                            href={websiteHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-900 underline underline-offset-2"
                          >
                            {vendor.website}
                          </a>
                        ) : (
                          vendor.website || "—"
                        )}
                      </TD>
                      <TD>
                        {loginHref ? (
                          <a
                            href={loginHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-900 underline underline-offset-2"
                          >
                            {vendor.loginUrl}
                          </a>
                        ) : (
                          vendor.loginUrl || "—"
                        )}
                      </TD>
                      <TD>
                        {vendor.hasCredentials
                          ? "Saved login metadata"
                          : "Missing"}
                      </TD>
                      <TD>
                        <Badge tone={vendor.loginDiscoveryNeeded ? "warn" : "neutral"}>
                          {vendor.credentialStatus || "needs_login"}
                        </Badge>
                      </TD>
                      <TD>{vendor.loginDiscoveryStatus || "not queued"}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            {loginDiscoveryVendors.length === 0 && (
              <div className="text-ink-secondary text-center p-[18px]">
                No vendors currently need login discovery.
              </div>
            )}
          </div>
        </Card>
      )}

      {view === "csv" && (
        <Card className="p-5 mb-3">
          <div className="flex gap-[8px] flex-wrap mb-[12px]">
            <Button onClick={() => loadCsv("needs_mapping")} variant="primary">
              Needs Mapping Export
            </Button>
            <Button onClick={() => loadCsv("existing")} variant="primary">
              Existing Mappings Export
            </Button>
            <Button onClick={() => loadCsv("manual_seed")} variant="primary">
              Manual Seed Template
            </Button>
            <Button
              onClick={copyCsv}
              disabled={!csvPreview}
              variant="secondary"
            >
              Copy CSV
            </Button>
          </div>
          <div className="text-ui-body text-ink-secondary mb-[8px]">
            Mapping import writes verified product mappings only. Manual seed
            price import remains disabled until the pricing approval worker is
            built.
          </div>
          <Textarea
            readOnly
            value={csvPreview}
            placeholder="Choose an export/template..."
            className="w-full min-h-[260px]"
          />

          <div className="mt-[16px] border-t border-solid border-zinc-200 pt-[14px]">
            <div className="text-ui-body text-ink-secondary mb-[8px]">
              Mapping Import
            </div>
            <Textarea
              value={mappingImportCsv}
              onChange={(e) => setMappingImportCsv(e.target.value)}
              placeholder="Paste mapping CSV here..."
              className="w-full min-h-[180px]"
            />

            <div className="flex gap-[8px] mt-[8px]">
              <Button onClick={importMappings} variant="primary">
                Import Mappings
              </Button>
              <Button
                onClick={() => {
                  setMappingImportCsv("");
                  setImportResult(null);
                }}
                variant="secondary"
              >
                Clear
              </Button>
            </div>
            {/* Structured, multi-row result — ActionFeedback wraps children
                in a <span>, which can't hold these block-level divs without
                producing invalid DOM/nesting warnings. Use a plain surfaced
                container with the same neutral feedback styling instead. */}
            {importResult && (
              <div
                role="status"
                className="mt-[10px] rounded-lg border border-solid border-zinc-200 bg-zinc-50 p-[10px] text-ui-caption text-zinc-900"
              >
                <div>
                  Imported {importResult.imported || 0} of{" "}
                  {importResult.rowsReceived || 0} rows.
                </div>
                {(importResult.rowErrors || []).slice(0, 8).map((err) => (
                  <div key={err.row} className="text-alert-fg mt-[4px]">
                    Row {err.row}: {(err.errors || []).join("; ")}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {view === "review" && (
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
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
                  <TH key={h}>{h}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {reviewQueue.map((approval) => (
                <TR key={approval.id}>
                  <TD className="font-medium text-zinc-900">
                    {approval.productName}
                  </TD>
                  <TD>{approval.vendorName}</TD>
                  <TD nums>
                    {approval.oldPrice != null
                      ? `$${approval.oldPrice.toFixed(2)}`
                      : "—"}
                  </TD>
                  <TD nums>
                    {approval.newPrice != null
                      ? `$${approval.newPrice.toFixed(2)}`
                      : "—"}
                  </TD>
                  <TD nums>
                    {approval.changePercent != null
                      ? `${approval.changePercent.toFixed(1)}%`
                      : "—"}
                  </TD>
                  <TD>{approval.sourceType || "—"}</TD>
                  <TD nums>
                    {approval.confidence != null
                      ? `${Math.round(approval.confidence * 100)}%`
                      : "—"}
                  </TD>
                  <TD className="text-ink-secondary">
                    {approval.approvalReason || "—"}
                  </TD>
                  <TD nums>
                    {approval.capturedAt
                      ? new Date(approval.capturedAt).toLocaleDateString()
                      : "—"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {reviewQueue.length === 0 && (
            <Card className="p-5 mb-3 text-ink-secondary text-center">
              No pending price approvals.
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function WaveGuardForecastTab({ showToast, onUpdate, refreshId }) {
  const [days, setDays] = useState(14);
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const loadSequence = useRef(0);
  const [creatingId, setCreatingId] = useState("");
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const data = await adminFetch(`/admin/inventory/waveguard-forecast?days=${encodeURIComponent(days)}`);
      if (sequence === loadSequence.current) setForecast(data.forecast || null);
    } catch (err) {
      if (sequence === loadSequence.current)
        showToast(`Forecast failed: ${err.message}`);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [days, showToast]);
  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load, refreshId]);

  async function createRestock(product) {
    const qty = Number(
      product.recommendedOrderQuantity || product.shortfall || 0,
    );
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
      showToast(
        data.existing
          ? "Open restock request already exists"
          : "Forecast restock request created",
      );
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
  const statusLabel = (status) => String(status || "ok").replace(/_/g, " ");
  return (
    <Card className="p-5 mb-3">
      <div className="flex justify-between gap-[12px] flex-wrap mb-[14px]">
        <div>
          <h3 className="m-0 text-zinc-900">WaveGuard inventory forecast</h3>
          <p className="[margin:4px_0_0] text-ink-secondary text-ui-body">
            Upcoming lawn protocol demand compared against live product stock.
          </p>
        </div>
        <div className="flex gap-[8px] items-center flex-wrap">
          <Select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-[130px]"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
          </Select>
          <Button onClick={load} disabled={loading} variant="secondary">
            Refresh
          </Button>
        </div>
      </div>

      {forecast && (
        <div className="flex gap-[10px] flex-wrap mb-[14px]">
          {[
            {
              label: "Appointments",
              value: forecast.serviceCount || 0,
            },
            {
              label: "Products",
              value: forecast.productCount || 0,
            },
            {
              label: "Short",
              value: counts.short || 0,
              // Main: red when short, green (no kit equivalent) otherwise.
              tone: counts.short > 0 ? "alert" : "neutral",
            },
            {
              label: "Warnings",
              value: counts.warning || 0,
              tone: counts.warning > 0 ? "warn" : "neutral",
            },
            {
              label: "Unit Review",
              value: counts.unit_mismatch || 0,
              tone: counts.unit_mismatch > 0 ? "warn" : "neutral",
            },
          ].map((item) => (
            <Card
              key={item.label}
              className={cn(
                "min-w-[120px] p-3",
                item.tone === "alert" && "border-alert-fg",
                item.tone === "warn" && "border-warn-fg",
              )}
            >
              <div
                className={cn(
                  "text-20 font-medium u-nums",
                  item.tone === "alert" && "text-alert-fg",
                  item.tone === "warn" && "text-warn-fg",
                )}
              >
                {item.value}
              </div>
              <div className="text-ink-secondary text-ui-body">
                {item.label}
              </div>
            </Card>
          ))}
        </div>
      )}

      {loading ? (
        <ActionFeedback>Building forecast...</ActionFeedback>
      ) : products.length === 0 ? (
        <div className="text-ink-secondary text-ui-body">
          No forecasted WaveGuard product demand in this window.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
                {[
                  "Product",
                  "Demand",
                  "Stock",
                  "Projected",
                  "Status",
                  "Upcoming",
                  "Action",
                ].map((h) => (
                  <TH key={h}>{h}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {products.map((product) => (
                <TR key={product.productId}>
                  <TD>
                    <strong>{product.productName}</strong>
                    <div className="text-ink-secondary text-ui-body">
                      {product.category || "Product"}
                    </div>
                  </TD>
                  <TD nums>
                    <strong>
                      {product.committedDemand}{" "}
                      {product.demandUnit || product.inventoryUnit || ""}
                    </strong>
                    <div className="text-ui-body">
                      {String(
                        product.conversionConfidence || "exact_unit",
                      ).replace(/_/g, " ")}
                    </div>
                    {product.unconvertedDemand > 0 && (
                      <div className="text-zinc-900 text-ui-body">
                        {product.unconvertedDemand} unit review
                      </div>
                    )}
                  </TD>
                  <TD nums>
                    {product.onHand ?? "—"} {product.inventoryUnit || ""}
                    {product.lowStockThreshold != null && (
                      <div className="text-ink-secondary text-ui-body">
                        Low at {product.lowStockThreshold}
                      </div>
                    )}
                  </TD>
                  <TD nums>
                    {product.projectedRemaining ?? "—"}{" "}
                    {product.inventoryUnit || ""}
                    {product.shortfall > 0 && (
                      <div className="text-alert-fg text-ui-body">
                        Short {product.shortfall}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <Badge
                      tone={
                        product.status === "short"
                          ? "alert"
                          : ["warning", "unit_mismatch"].includes(product.status)
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {statusLabel(product.status)}
                    </Badge>
                    {product.firstShortDate && (
                      <div className="text-alert-fg text-ui-body mt-[4px]">
                        Blocks by {product.firstShortDate}
                      </div>
                    )}
                  </TD>
                  <TD>
                    {(product.appointments || []).slice(0, 3).map((appt) => (
                      <div
                        key={`${product.productId}-${appt.serviceId}`}
                        className="mb-[4px]"
                      >
                        <strong>{appt.scheduledDate}</strong> ·{" "}
                        {appt.customerName}
                        <div className="text-ink-secondary text-ui-body">
                          {appt.amount} {appt.unit}
                          {appt.inventoryAmount != null &&
                          appt.inventoryUnit &&
                          appt.inventoryUnit !== appt.unit
                            ? ` = ${appt.inventoryAmount} ${appt.inventoryUnit}`
                            : ""}
                          {" · "}
                          {appt.protocolWindowTitle || appt.serviceType}
                        </div>
                      </div>
                    ))}
                    {(product.appointments || []).length > 3 && (
                      <div className="text-ink-secondary text-ui-body">
                        +{product.appointments.length - 3} more
                      </div>
                    )}
                  </TD>
                  <TD>
                    {["short", "warning"].includes(product.status) ? (
                      <Button
                        onClick={() => createRestock(product)}
                        disabled={creatingId === product.productId}
                        variant="primary"
                      >
                        Request {product.recommendedOrderQuantity}{" "}
                        {product.inventoryUnit || product.demandUnit || ""}
                      </Button>
                    ) : (
                      <span className="text-ink-secondary">No request</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {(forecast?.errors || []).length > 0 && (
        <div className="mt-[12px] border-t border-solid border-zinc-200 pt-[12px]">
          <div className="text-zinc-900 font-medium text-ui-body">
            Plan errors
          </div>
          {(forecast.errors || []).slice(0, 5).map((err) => (
            <div
              key={err.serviceId}
              className="text-ink-secondary text-ui-body mt-[4px]"
            >
              {err.scheduledDate} · {err.customerName}: {err.message}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
function UnitReviewTab({ showToast }) {
  const [data, setData] = useState({
    products: [],
    forecastRows: [],
    counts: {},
  });
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
    const inventoryUnit =
      unit || drafts[product.id]?.inventoryUnit || product.suggestedUnit;
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
          convertExistingStock:
            drafts[product.id]?.convertExistingStock !== false,
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
    <Card className="p-5 mb-3">
      <div className="flex justify-between gap-[12px] flex-wrap mb-[14px]">
        <div>
          <h3 className="m-0 text-zinc-900">Inventory unit review</h3>
          <p className="[margin:4px_0_0] text-ink-secondary text-ui-body">
            Clean up unsupported, missing, and ambiguous inventory units before
            they affect forecast or closeout math.
          </p>
        </div>
        <Button onClick={load} disabled={loading} variant="secondary">
          Refresh
        </Button>
      </div>

      {loading ? (
        <ActionFeedback>Loading unit review...</ActionFeedback>
      ) : products.length === 0 && forecastRows.length === 0 ? (
        <div className="text-zinc-900 text-ui-body">
          No inventory unit issues found.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table className="w-full">
              <THead>
                <TR>
                  {["Product", "Current", "Issues", "Fix"].map((h) => (
                    <TH key={h}>{h}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {products.map((product) => {
                  const draft = drafts[product.id] || {};
                  return (
                    <TR key={product.id}>
                      <TD>
                        <strong>{product.name}</strong>
                        <div className="text-ink-secondary text-ui-body">
                          {product.category || "Product"} ·{" "}
                          {product.formulation || "unspecified"}
                        </div>
                      </TD>
                      <TD nums>
                        {product.inventoryOnHand ?? "—"}{" "}
                        {product.inventoryUnit || "no unit"}
                        {product.lowStockThreshold != null && (
                          <div className="text-ink-secondary text-ui-body">
                            Low at {product.lowStockThreshold}
                          </div>
                        )}
                      </TD>
                      <TD>
                        {(product.reasons || []).map((reason) => (
                          <div
                            key={reason.code}
                            className={cn(
                              "text-ui-body mb-[3px]",
                              reason.severity === "block" ? "text-alert-fg" : "text-warn-fg",
                            )}
                          >
                            {reason.message}
                          </div>
                        ))}
                      </TD>
                      <TD>
                        <div className="grid gap-[6px] min-w-[260px]">
                          <div className="flex gap-[6px] flex-wrap">
                            {unitChoices.map((unit) => (
                              <Button
                                key={unit}
                                onClick={() => fixUnit(product, unit)}
                                disabled={savingId === product.id}
                                variant={
                                  unit === product.suggestedUnit
                                    ? "primary"
                                    : "secondary"
                                }
                              >
                                {unit}
                              </Button>
                            ))}
                          </div>
                          <div className="flex gap-[6px]">
                            <Input
                              aria-label={`Custom unit for ${product.name}`}
                              value={draft.inventoryUnit ?? ""}
                              onChange={(e) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [product.id]: {
                                    ...(prev[product.id] || {}),
                                    inventoryUnit: e.target.value,
                                  },
                                }))
                              }
                              placeholder="custom supported unit"
                              className="flex-[1]"
                            />

                            <Button
                              onClick={() => fixUnit(product)}
                              disabled={savingId === product.id}
                              variant="primary"
                            >
                              Apply
                            </Button>
                          </div>
                          <Checkbox
                            label="Convert existing stock and low-stock threshold"
                            checked={draft.convertExistingStock !== false}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [product.id]: {
                                  ...(prev[product.id] || {}),
                                  convertExistingStock: e.target.checked,
                                },
                              }))
                            }
                          />
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>

          {forecastRows.length > 0 && (
            <div className="mt-[16px] border-t border-solid border-zinc-200 pt-[12px]">
              <h4 className="[margin:0_0_8px] text-zinc-900">Forecast Unit Review</h4>
              {forecastRows.map((row) => (
                <div
                  key={row.productId}
                  className="text-ink-secondary text-ui-body mb-[8px]"
                >
                  <strong className="text-zinc-900">{row.productName}</strong>:{" "}
                  {row.unconvertedDemand} {row.demandUnit || "unknown unit"}{" "}
                  could not convert to {row.inventoryUnit || "inventory unit"}{" "}
                  across {row.unitMismatchCount} appointment
                  {row.unitMismatchCount === 1 ? "" : "s"}.
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════
// PRODUCTS TAB — with inline editing
// ══════════════════════════════════════════════════════════════
export function ProductsTab({
  refreshId,
  initialSearch = "",
  initialProductId = null,
  showToast,
  filter = "all",
  onFilterChange,
  showAddForm,
  setShowAddForm,
  // Product create/edit/delete is owner-only (server 403s techs) — hide
  // the authoring affordances rather than rendering doomed forms.
  canAuthor = false,
}) {
  const [labelPipelineEnabled, setLabelPipelineEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLabelPipelineEnabled(false);
    if (canAuthor)
      adminFetch("/admin/inventory/label-pipeline")
        .then((data) => {
          if (!cancelled) setLabelPipelineEnabled(data.enabled === true);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canAuthor]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState(initialSearch);
  const [catFilter, setCatFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [expanded, setExpanded] = useState(initialProductId);
  const loadSequence = useRef(0);
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
    const sequence = ++loadSequence.current;
    const needsPricingParam =
      filter === "needs_price"
        ? "&needsPricing=true"
        : filter === "priced"
          ? "&needsPricing=false"
          : "";
    const stockParam = filter === "low_stock" ? "&stock=low" : "";
    try {
      const [pData, vData] = await Promise.all([
        adminFetch(
          `/admin/inventory?search=${encodeURIComponent(search)}&category=${encodeURIComponent(catFilter)}&limit=${PER_PAGE}&page=${page}${needsPricingParam}${stockParam}`,
        ),
        // Vendors are owner-only under the role lockdown — a technician's
        // Products load must not hang on that 403 (codex P1). Empty vendor
        // list just hides per-vendor pricing affordances they can't use.
        adminFetch("/admin/inventory/vendors").catch(() => ({
          vendors: [],
        })),
      ]);
      if (sequence !== loadSequence.current) return;
      setProducts(pData.products || []);
      setCategories(pData.categories || []);
      setTotalProducts(pData.total || 0);
      setVendors(vData.vendors || []);
      setLoadError(null);
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      // The products request had no catch, so a non-2xx left
      // "Loading products..." up forever (UI audit F0474).
      setLoadError(e?.message || "Request failed");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [search, catFilter, page, filter]);
  useEffect(() => {
    let current = true;
    void load().catch(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
      loadSequence.current += 1;
    };
  }, [load, refreshId]);

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
  if (loadError)
    return (
      <ActionFeedback error>
        Failed to load products: {loadError}{" "}
        <Button
          type="button"
          onClick={() => {
            // Clear the error first so the loading branch renders during the
            // retry; leaving it up allowed repeated clicks and overlapping loads.
            setLoadError(null);
            setLoading(true);
            load();
          }}
          variant="primary"
          className="ml-[8px]"
        >
          Retry
        </Button>
      </ActionFeedback>
    );
  if (loading) return <ActionFeedback>Loading products...</ActionFeedback>;
  return (
    <div>
      {" "}
      <div className="flex gap-[6px] mb-[12px] flex-wrap">
        {[
          {
            key: "all",
            label: "All Products",
          },
          {
            key: "priced",
            label: "Priced",
          },
          {
            key: "needs_price",
            label: "Needs Price",
          },
          {
            key: "low_stock",
            label: "Low Stock",
          },
        ].map((f) => (
          <Button
            key={f.key}
            onClick={() => {
              onFilterChange?.(f.key);
              setPage(1);
            }}
            variant={filter === f.key ? "primary" : "secondary"}
          >
            {f.label}
          </Button>
        ))}
      </div>{" "}
      <div className="flex gap-[8px] mb-[12px] flex-wrap items-center">
        {" "}
        <Input
          aria-label="Search products"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search products..."
          className="flex-[1] min-w-[200px]"
        />{" "}
        <Select
          aria-label="Product category"
          value={catFilter}
          onChange={(e) => {
            setCatFilter(e.target.value);
            setPage(1);
          }}
          className="min-w-[150px]"
        >
          {" "}
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.count})
            </option>
          ))}
        </Select>{" "}
      </div>
      {canAuthor && showAddForm && (
        <Card className="p-4 mb-[16px]">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 mb-[10px]">
            New Product
          </div>{" "}
          <div className="grid gap-3 mb-[10px] md:grid-cols-3">
            {" "}
            <Field label="Product name" required>
              <Input
                value={newProduct.name}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    name: e.target.value,
                  }))
                }
                placeholder="Product name"
              />
            </Field>{" "}
            <Field label="Category">
              <Input
                value={newProduct.category}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    category: e.target.value,
                  }))
                }
                placeholder="Category"
              />
            </Field>{" "}
            <Field label="Active ingredient">
              <Input
                value={newProduct.activeIngredient}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    activeIngredient: e.target.value,
                  }))
                }
                placeholder="Active ingredient"
              />
            </Field>{" "}
          </div>{" "}
          <div className="grid gap-3 md:grid-cols-3">
            {" "}
            <Field label="MOA/FRAC group">
              <Input
                value={newProduct.moaGroup}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    moaGroup: e.target.value,
                  }))
                }
                placeholder="MOA/FRAC group"
              />
            </Field>{" "}
            <Field label="Default unit">
              <Select
                value={newProduct.defaultUnit}
                onChange={(e) =>
                  setNewProduct((p) => ({
                    ...p,
                    defaultUnit: e.target.value,
                  }))
                }
              >
                {" "}
                <option value="oz">oz</option>
                <option value="ml">ml</option>
                <option value="gal">gal</option>
                <option value="lb">lb</option>
                <option value="g">g</option>
                <option value="each">each</option>{" "}
              </Select>
            </Field>{" "}
            <div className="grid grid-cols-3 gap-2">
              {" "}
              <Field label="Stock">
                <Input
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
                />
              </Field>{" "}
              <Field label="Unit">
                <Input
                  value={newProduct.inventoryUnit}
                  onChange={(e) =>
                    setNewProduct((p) => ({
                      ...p,
                      inventoryUnit: e.target.value,
                    }))
                  }
                  placeholder="unit"
                />
              </Field>{" "}
              <Field label="Low at">
                <Input
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
                />
              </Field>{" "}
            </div>{" "}
          </div>{" "}
          <div className="flex gap-[6px] mt-[8px]">
            {" "}
            <Button
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
              variant="primary"
              className="flex-[1]"
            >
              Save
            </Button>{" "}
            <Button onClick={() => setShowAddForm(false)} variant="secondary">
              Cancel
            </Button>{" "}
          </div>{" "}
        </Card>
      )}
      <div className="overflow-x-auto">
        {" "}
        <Table className="w-full min-w-[1120px]">
          <THead>
            <TR>
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
                <TH key={h}>{h}</TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {products.map((p) => {
              const isEditing = editing === p.id;
              const isExpanded = expanded === p.id && !isEditing;
              return [
                <TR
                  key={p.id}
                  onClick={() =>
                    !isEditing && setExpanded(expanded === p.id ? null : p.id)
                  }
                  className={cn(
                    isEditing ? "cursor-default" : "cursor-pointer",
                    isEditing ? "bg-zinc-100" : isExpanded ? "bg-zinc-50" : undefined,
                  )}
                >
                  <TD className="font-medium text-zinc-900">
                    {isEditing ? (
                      <Input
                        value={editForm.name}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            name: e.target.value,
                          }))
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="w-full"
                      />
                    ) : (
                      p.name
                    )}
                  </TD>
                  <TD>
                    {isEditing ? (
                      <Input
                        value={editForm.category}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            category: e.target.value,
                          }))
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="w-[100px]"
                      />
                    ) : (
                      <Badge tone="neutral">{p.category}</Badge>
                    )}
                  </TD>
                  <TD className="text-ink-secondary">
                    {isEditing ? (
                      <Input
                        value={editForm.activeIngredient}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            activeIngredient: e.target.value,
                          }))
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="w-full"
                      />
                    ) : (
                      p.activeIngredient || "—"
                    )}
                  </TD>
                  <TD className="text-ink-secondary">
                    {isEditing ? (
                      <Input
                        value={editForm.moaGroup}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            moaGroup: e.target.value,
                          }))
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="w-[80px]"
                      />
                    ) : (
                      p.moaGroup || "—"
                    )}
                  </TD>
                  <TD>
                    {isEditing ? (
                      <Input
                        value={editForm.containerSize}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            containerSize: e.target.value,
                          }))
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="w-[80px]"
                      />
                    ) : (
                      p.containerSize || "—"
                    )}
                  </TD>
                  <TD nums>
                    {isEditing ? (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="flex gap-[4px]"
                      >
                        {" "}
                        <Input
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
                          className="w-[76px]"
                        />{" "}
                        <Input
                          value={editForm.inventoryUnit}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              inventoryUnit: e.target.value,
                            }))
                          }
                          placeholder="unit"
                          className="w-[56px]"
                        />{" "}
                        <Input
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
                          className="w-[66px]"
                        />{" "}
                      </div>
                    ) : (
                      <span>
                        {p.inventoryOnHand != null
                          ? `${p.inventoryOnHand} ${p.inventoryUnit || ""}`
                          : "—"}
                        {p.lowStock && (
                          <Badge tone="alert" className="ml-[6px]">
                            Low
                          </Badge>
                        )}
                      </span>
                    )}
                  </TD>
                  <TD nums>{formatMoney(p.bestPrice)}</TD>
                  <TD nums>
                    {formatUnitPriceList(p.unitPrices) ||
                      formatUnitCost(p.costPerUnit, p.costUnit)}
                  </TD>
                  <TD>{p.bestVendor || "—"}</TD>
                  <TD>
                    {/* Main painted these amber vs green; both sides neutral
                        erased the at-a-glance signal. The kit has no success
                        tone, so Priced keeps neutral and Needs Price is warn. */}
                    {p.needsPricing ? (
                      <Badge tone="warn">Needs Price</Badge>
                    ) : (
                      <Badge tone="neutral">Priced</Badge>
                    )}
                  </TD>
                  <TD className="min-w-[128px]">
                    {" "}
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="flex gap-[4px]"
                    >
                      {canAuthor &&
                        (isEditing ? (
                          <>
                            {" "}
                            <Button
                              onClick={() => saveEdit(p.id)}
                              variant="primary"
                            >
                              Save
                            </Button>{" "}
                            <Button
                              onClick={() => setEditing(null)}
                              variant="secondary"
                            >
                              ×
                            </Button>{" "}
                          </>
                        ) : (
                          <>
                            {" "}
                            <Button
                              onClick={(e) => startEdit(p, e)}
                              title="Edit"
                              variant="secondary"
                            >
                              Edit
                            </Button>
                            {deleting === p.id ? (
                              <>
                                {" "}
                                <Button
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
                                  variant="danger"
                                >
                                  Yes
                                </Button>{" "}
                                <Button
                                  onClick={() => setDeleting(null)}
                                  variant="secondary"
                                >
                                  No
                                </Button>{" "}
                              </>
                            ) : (
                              <Button
                                onClick={() => setDeleting(p.id)}
                                variant="secondary"
                              >
                                ×
                              </Button>
                            )}
                          </>
                        ))}
                    </div>{" "}
                  </TD>
                </TR>,
                isExpanded && (
                  <TR key={`${p.id}-exp`}>
                    <TD colSpan={10}>
                      {" "}
                      <ExpandedProduct
                        product={p}
                        vendors={vendors}
                        canAuthor={canAuthor}
                        labelPipelineEnabled={labelPipelineEnabled}
                        onSave={savePrice}
                        onInventoryChanged={load}
                        showToast={showToast}
                      />{" "}
                    </TD>
                  </TR>
                ),
              ];
            })}
          </TBody>
        </Table>{" "}
      </div>
      {products.length === 0 && (
        <Card className="p-5 mb-3 text-center p-[40px] text-ink-secondary">
          No products found
        </Card>
      )}
      {totalProducts > PER_PAGE && (
        <div className="flex justify-between items-center">
          {" "}
          <div className="text-ui-body text-ink-secondary">
            Showing {(page - 1) * PER_PAGE + 1}–
            {Math.min(page * PER_PAGE, totalProducts)} of {totalProducts}{" "}
            products
          </div>{" "}
          <div className="flex gap-[6px]">
            {" "}
            <Button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              variant="secondary"
            >
              ← Prev
            </Button>{" "}
            <span className="text-ui-body text-zinc-900">
              {page} / {Math.ceil(totalProducts / PER_PAGE)}
            </span>{" "}
            <Button
              disabled={page >= Math.ceil(totalProducts / PER_PAGE)}
              onClick={() => setPage((p) => p + 1)}
              variant="secondary"
            >
              Next →
            </Button>{" "}
          </div>{" "}
        </div>
      )}
    </div>
  );
}

// Presigned evidence URLs last 1 h server-side; treat them as stale 5 min early.
const EVIDENCE_LINK_TTL_MS = 55 * 60 * 1000;

function RestockRequestsTab({
  showToast,
  onUpdate,
  canAuthor = false,
  refreshId,
  requestId = null,
}) {
  const [, setSearchParams] = useSearchParams();

  const [requests, setRequests] = useState([]);
  const [status, setStatus] = useState("active");
  // Back may restore the pinned URL before React commits the intermediate
  // unpinned render. A saved request always includes its terminal state.
  const queueStatus = requestId ? "all" : status;
  const [loading, setLoading] = useState(true);
  const loadSequence = useRef(0);
  const [receivingId, setReceivingId] = useState("");
  const [receiveDrafts, setReceiveDrafts] = useState({});
  // requestId → { screenshots: [{ label, url }], expiresAt } once fetched. The
  // server presigns for 1 h; the cell drops the links a little before that
  // and offers Refresh, so a tab left open can always re-request fresh URLs.
  const [evidence, setEvidence] = useState({});
  // React does not rerender because time passed: drop each entry AT its
  // expiry so the cell actually falls back to the Refresh action (Codex
  // #3853 r20 P2).
  useEffect(() => {
    const next = Math.min(
      ...Object.values(evidence)
        .map((e) => e.expiresAt)
        .filter((t) => Number.isFinite(t)),
    );
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(
      () => {
        setEvidence((e) =>
          Object.fromEntries(
            Object.entries(e).filter(([, v]) => v.expiresAt > Date.now()),
          ),
        );
      },
      Math.max(0, next - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [evidence]);
  const loadEvidence = async (requestId) => {
    try {
      const data = await adminFetch(`/admin/inventory/restock-requests/${requestId}/order-evidence`);
      const screenshots = data.screenshots || [];
      setEvidence((e) => ({
        ...e,
        [requestId]: {
          screenshots,
          expiresAt: Date.now() + EVIDENCE_LINK_TTL_MS,
        },
      }));
      if (!screenshots.length)
        showToast?.("No screenshots were captured for this order");
    } catch (e) {
      showToast?.(`Failed: ${e.message}`);
    }
  };
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const data = await adminFetch(`/admin/inventory/restock-requests?status=${encodeURIComponent(queueStatus)}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ""}`);
      if (sequence === loadSequence.current) setRequests(data.requests || []);
    } catch (err) {
      if (sequence === loadSequence.current)
        showToast(`Failed to load restock requests: ${err.message}`);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [queueStatus, showToast, requestId]);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load, refreshId]);

  async function runAction(request, action) {
    setReceivingId(request.id);
    try {
      const draft = receiveDrafts[request.id] || {};
      await adminFetch(`/admin/inventory/restock-requests/${request.id}/action`, {
        method: "POST",
        body: JSON.stringify({
          action,
          // Only what the admin actually typed: with no draft the server's locked read picks the
          // figure the automatic order actually bought (packages round up), else the requested
          // amount — a row loaded before the order placed must not send a stale quantity.
          quantity: draft.quantity || null,
          unit: draft.unit || null,
          note: draft.note || null,
        }),
      });
      if (action === "receive") {
        showToast("Stock received.");
      } else {
        showToast(
          action === "mark_ordered" ? "Marked ordered" : "Request cancelled",
        );
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
    <Card className="p-5 mb-3">
      <div className="flex justify-between gap-[12px] flex-wrap mb-[14px]">
        <div>
          <h3 className="m-0 text-zinc-900">Restock requests</h3>
          <p className="[margin:4px_0_0] text-ink-secondary text-ui-body">
            Product requests for inventory needs.
          </p>
        </div>
        {requestId ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setSearchParams((params) => {
                const next = new URLSearchParams(params);
                next.delete("requestId");
                return next;
              });
              setStatus("active");
            }}
          >
            Show all requests
          </Button>
        ) : (
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-[160px]"
          >
            <option value="active">Open + Ordered</option>
            <option value="open">Open</option>
            <option value="ordered">Ordered</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </Select>
        )}
      </div>
      {loading ? (
        <ActionFeedback>Loading restock requests...</ActionFeedback>
      ) : requests.length === 0 ? (
        <div className="text-ink-secondary text-ui-body">
          No restock requests in this view.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
                {["Product", "Need", "Source", "Status", "Receive"].map((h) => (
                  <TH key={h}>{h}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {requests.map((request) => {
                const draft = receiveDrafts[request.id] || {};
                return (
                  <TR key={request.id}>
                    <TD>
                      <strong>{request.productName}</strong>
                      <div className="text-ink-secondary text-ui-body">
                        {request.productCategory || "Product"} · live stock{" "}
                        {request.liveStock ?? "—"}{" "}
                        {request.inventoryUnit || request.unit || ""}
                      </div>
                    </TD>
                    <TD nums>
                      <strong>
                        {request.requestedQuantity ?? "—"} {request.unit || ""}
                      </strong>
                      <div className="text-ink-secondary text-ui-body">
                        Needed {request.neededBy || "as soon as possible"} ·{" "}
                        {request.priority}
                      </div>
                      {request.vendor && (
                        <div className="text-ink-secondary text-ui-body">
                          Vendor: {request.vendor}
                          {request.vendorSku
                            ? ` · SKU ${request.vendorSku}`
                            : ""}
                        </div>
                      )}
                      {safeExternalHref(request.vendorProductUrl) && (
                        <a
                          href={safeExternalHref(request.vendorProductUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-zinc-900 text-ui-body underline underline-offset-2"
                        >
                          Open order page ↗
                        </a>
                      )}
                    </TD>
                    <TD>
                      <div>
                        {request.customerName ||
                          (request.source === "auto_reorder"
                            ? "Auto-reorder sweep"
                            : request.source)}
                      </div>
                      <div className="text-ink-secondary text-ui-body">
                        {request.scheduledDate ||
                          request.createdAt?.slice?.(0, 10)}{" "}
                        · {request.serviceType || "inventory"}
                      </div>
                      <div className="text-ink-secondary text-ui-body">
                        {request.reason}
                      </div>
                    </TD>
                    <RestockStatusCell
                      request={request}
                      receivingId={receivingId}
                      runAction={runAction}
                      canAuthor={canAuthor}
                      evidence={evidence[request.id]}
                      loadEvidence={loadEvidence}
                    />
                    <RestockActionCell
                      request={request}
                      draft={draft}
                      setReceiveDrafts={setReceiveDrafts}
                      receivingId={receivingId}
                      runAction={runAction}
                    />
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// Main coloured a vendor's last scrape green/amber/red/muted; the kit has no
// success tone, so completed reads in the default ink.
function scrapeStatusTone(status) {
  if (status === "failed") return "alert";
  return status === "running" ? "warn" : "neutral";
}

// How an automatic order's outcome reads on the Restock tab: colour + label.
function autoOrderSummary(order) {
  if (order.status === "placed") {
    const number = order.externalOrderNumber
      ? ` · #${order.externalOrderNumber}`
      : "";
    const total =
      order.amountCents != null
        ? ` · $${(order.amountCents / 100).toFixed(2)}`
        : "";
    // Main carried a colour with each outcome. The kit has no success tone, so a
    // placed order reads in the default ink, but "failed"/"needs review" keeps
    // its amber and the in-progress state its muted ink.
    return {
      label: `Ordered automatically${number}${total}`,
    };
  }
  if (order.status === "placing")
    return {
      tone: "text-ink-secondary",
      label: "Auto-order in progress",
    };
  return {
    tone: "text-warn-fg",
    label: `Auto-order ${order.status === "failed" ? "failed" : "needs review"}`,
  };
}

// Restock tab — the request's status pill, its automatic-order outcome and
// the Mark Ordered action, in one cell.
function RestockStatusCell({
  request,
  receivingId,
  runAction,
  canAuthor = false,
  evidence = null,
  loadEvidence = null,
}) {
  const order = request.order;
  const summary = order ? autoOrderSummary(order) : null;
  // Links show only while their presigned URLs are live; an expired or empty
  // fetch falls back to the button, and live links keep a Refresh beside them.
  const liveShots =
    evidence && evidence.expiresAt > Date.now() ? evidence.screenshots : [];
  const evidenceButton = (label) => (
    <Button
      type="button"
      onClick={() => loadEvidence?.(request.id)}
      variant="secondary"
    >
      {label}
    </Button>
  );
  return (
    <TD>
      <Badge
        tone={
          ["cancelled", "failed"].includes(request.status) ? "alert" : "neutral"
        }
      >
        {request.status}
      </Badge>
      {order && (
        <div className={`mt-[6px] text-ui-body u-nums ${summary.tone || ""}`}>
          {summary.label}
          {order.status !== "placed" && order.error && (
            <div className="text-ink-secondary mt-[2px] max-w-[260px]">
              {order.error}
            </div>
          )}
          {/* Owner-only: the screenshots show the billing account + totals; the route is requireAdmin. */}
          {canAuthor && (
            <div className="mt-[4px] flex gap-[8px] flex-wrap items-center">
              {liveShots.length ? (
                <>
                  {liveShots.map((s) => (
                    <a
                      key={s.label}
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-900 underline underline-offset-2"
                    >
                      {s.label} ↗
                    </a>
                  ))}
                  {evidenceButton("Refresh")}
                </>
              ) : (
                evidenceButton("Screenshots")
              )}
            </div>
          )}
        </div>
      )}
      {request.status === "open" && order?.status !== "placing" && (
        <Button
          onClick={() => runAction(request, "mark_ordered")}
          disabled={receivingId === request.id}
          variant="secondary"
          className="mt-[8px] block"
        >
          Mark Ordered
        </Button>
      )}
    </TD>
  );
}

// Restock tab — the receive draft (quantity / unit) and the Receive / Cancel
// actions; the dispatcher owns a placing request, and a dispatched order that
// is neither received nor revoked cannot be cancelled (the server 409s both).
// A received request whose automatic order landed after that receipt gets
// ONE more receive — the late order's own (the server admits exactly that).
function RestockActionCell({
  request,
  draft,
  setReceiveDrafts,
  receivingId,
  runAction,
}) {
  const setDraft = (patch) =>
    setReceiveDrafts((prev) => ({
      ...prev,
      [request.id]: {
        ...(prev[request.id] || {}),
        ...patch,
      },
    }));
  if (request.order?.status === "placing")
    return (
      <TD>
        <span className="text-ink-secondary">Auto-order in progress</span>
      </TD>
    );
  const lateOrderReceive =
    request.status === "received" && !!request.order?.landedAfterReceive;
  if (!["open", "ordered"].includes(request.status) && !lateOrderReceive)
    return (
      <TD>
        <span className="text-ink-secondary">Closed</span>
      </TD>
    );
  const orderOut = !!request.order?.placedAt && !request.order?.revokedAt;
  return (
    <TD>
      <div className="grid gap-[6px] min-w-[220px]">
        <div className="grid grid-cols-[1fr_80px] gap-[6px]">
          <Input
            value={
              draft.quantity ??
              request.order?.orderedQuantity ??
              request.requestedQuantity ??
              ""
            }
            onChange={(e) =>
              setDraft({
                quantity: e.target.value,
              })
            }
            placeholder="Qty"
          />

          <Input
            value={draft.unit ?? request.unit ?? request.inventoryUnit ?? ""}
            onChange={(e) =>
              setDraft({
                unit: e.target.value,
              })
            }
            placeholder="Unit"
          />
        </div>
        <div className="flex gap-[6px]">
          <Button
            onClick={() => runAction(request, "receive")}
            disabled={receivingId === request.id}
            variant="primary"
          >
            Receive
          </Button>
          {lateOrderReceive ? (
            <span className="text-ink-secondary text-ui-body self-center">
              Late auto-order — receive it, or revoke
            </span>
          ) : orderOut ? (
            <span className="text-ink-secondary text-ui-body self-center">
              Order out — receive, or revoke first
            </span>
          ) : (
            <Button
              onClick={() => runAction(request, "cancel")}
              disabled={receivingId === request.id}
              variant="danger"
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </TD>
  );
}

// detectServiceLine ids (server/services/service-report/service-line-configs.js)
const COMPLETION_SERVICE_LINES = [
  {
    id: "pest",
    label: "Pest",
  },
  {
    id: "lawn",
    label: "Lawn",
  },
  {
    id: "mosquito",
    label: "Mosquito",
  },
  {
    id: "tree_shrub",
    label: "Tree & shrub",
  },
  {
    id: "termite",
    label: "Termite",
  },
  {
    id: "rodent",
    label: "Rodent",
  },
  {
    id: "palm",
    label: "Palm",
  },
];

// Auto-reorder + per-visit consumable authoring for one product: its own
// form state and save path (PUT /admin/inventory/:id).
function AutoReorderEditor({
  product,
  vendors,
  showToast,
  onInventoryChanged,
}) {
  const [autoForm, setAutoForm] = useState({
    autoReorderEnabled: !!product.autoReorderEnabled,
    autoReorderVendorId: product.autoReorderVendorId || "",
    reorderQuantity: product.reorderQuantity ?? "",
    perCompletionUsage: product.perCompletionUsage ?? "",
    // null = every service line; array = only those lines consume this item
    perCompletionServiceLines: Array.isArray(product.perCompletionServiceLines)
      ? product.perCompletionServiceLines
      : null,
  });
  const [autoSaving, setAutoSaving] = useState(false);
  const saveAutoReorder = async () => {
    setAutoSaving(true);
    try {
      await adminFetch(`/admin/inventory/${product.id}`, {
        method: "PUT",
        body: JSON.stringify({
          autoReorderEnabled: !!autoForm.autoReorderEnabled,
          autoReorderVendorId: autoForm.autoReorderVendorId || null,
          reorderQuantity:
            autoForm.reorderQuantity === ""
              ? null
              : Number(autoForm.reorderQuantity),
          perCompletionUsage:
            autoForm.perCompletionUsage === ""
              ? null
              : Number(autoForm.perCompletionUsage),
          perCompletionServiceLines: autoForm.perCompletionServiceLines,
        }),
      });
      showToast?.("Auto-reorder settings saved");
      onInventoryChanged?.();
    } catch (e) {
      showToast?.(`Failed: ${e.message}`);
    } finally {
      setAutoSaving(false);
    }
  };
  return (
    <div className="mb-[12px]">
      <div className="text-ui-body text-ink-secondary mb-[6px]">
        Auto-reorder
      </div>
      <div className="flex gap-[8px] items-center flex-wrap text-ui-body">
        <Checkbox
          label="Reorder when low"
          checked={!!autoForm.autoReorderEnabled}
          onChange={(e) =>
            setAutoForm((f) => ({
              ...f,
              autoReorderEnabled: e.target.checked,
            }))
          }
        />
        <Select
          value={autoForm.autoReorderVendorId}
          onChange={(e) =>
            setAutoForm((f) => ({
              ...f,
              autoReorderVendorId: e.target.value,
            }))
          }
          className="w-[160px]"
        >
          <option value="">No vendor</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
        <Input
          type="number"
          step="0.0001"
          min="0"
          placeholder="Reorder qty"
          title="Quantity to request when stock reaches the low-stock threshold"
          value={autoForm.reorderQuantity}
          onChange={(e) =>
            setAutoForm((f) => ({
              ...f,
              reorderQuantity: e.target.value,
            }))
          }
          className="w-[100px]"
        />

        <Input
          type="number"
          step="0.0001"
          min="0"
          placeholder="Used per visit"
          title="Units consumed by every completed visit (yard-sign kit items); blank = not a per-visit consumable"
          value={autoForm.perCompletionUsage}
          onChange={(e) =>
            setAutoForm((f) => ({
              ...f,
              perCompletionUsage: e.target.value,
            }))
          }
          className="w-[110px]"
        />

        <Button
          type="button"
          onClick={saveAutoReorder}
          disabled={autoSaving}
          variant="primary"
        >
          {autoSaving ? "Saving…" : "Save"}
        </Button>
      </div>
      <div
        title="Which completed visits consume this item. All = every service line."
        className="flex gap-[10px] items-center flex-wrap text-ui-body mt-[6px]"
      >
        <span className="text-ink-secondary">Used on:</span>
        <Checkbox
          label="All"
          checked={autoForm.perCompletionServiceLines == null}
          onChange={(e) =>
            setAutoForm((f) => ({
              ...f,
              perCompletionServiceLines: e.target.checked ? null : [],
            }))
          }
        />
        {COMPLETION_SERVICE_LINES.map((line) => {
          const scoped = Array.isArray(autoForm.perCompletionServiceLines);
          const on =
            scoped && autoForm.perCompletionServiceLines.includes(line.id);
          return (
            <Checkbox
              key={line.id}
              label={line.label}
              disabled={!scoped}
              checked={on}
              onChange={(e) =>
                setAutoForm((f) => {
                  const cur = Array.isArray(f.perCompletionServiceLines)
                    ? f.perCompletionServiceLines
                    : [];
                  return {
                    ...f,
                    perCompletionServiceLines: e.target.checked
                      ? [...new Set([...cur, line.id])]
                      : cur.filter((x) => x !== line.id),
                  };
                })
              }
            />
          );
        })}
      </div>
    </div>
  );
}
function ExpandedProduct({
  labelPipelineEnabled = false,
  product,
  vendors,
  canAuthor = false,
  onSave,
  onInventoryChanged,
  showToast,
}) {
  usePublishIntelligenceBarPageData({ product_id: product.id });
  const { lastMutation } = useIntelligenceBarActions();
  const inventoryRefresh =
    lastMutation?.product_id === product.id ? lastMutation.id : null;
  const [vendorId, setVendorId] = useState(vendors[0]?.id || "");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [movements, setMovements] = useState([]);
  const [movementLoading, setMovementLoading] = useState(true);
  const movementSequence = useRef(0);
  const [adjustForm, setAdjustForm] = useState({
    movementType: "restock",
    quantity: "",
    unit: product.inventoryUnit || "oz",
    lotNumber: "",
    reason: "",
    note: "",
  });
  const loadMovements = useCallback(async () => {
    const sequence = ++movementSequence.current;
    setMovementLoading(true);
    try {
      // Movements are owner-only (rows carry costUsed) — a technician's
      // expanded product just shows no history instead of erroring.
      const data = await adminFetch(`/admin/inventory/${product.id}/movements`);
      if (sequence === movementSequence.current)
        setMovements(data.movements || []);
    } catch {
      if (sequence === movementSequence.current) setMovements([]);
    } finally {
      if (sequence === movementSequence.current) setMovementLoading(false);
    }
  }, [product.id]);
  useEffect(() => {
    void loadMovements();
    setAdjustForm((f) => ({
      ...f,
      unit: product.inventoryUnit || f.unit || "oz",
    }));
    return () => {
      movementSequence.current += 1;
    };
  }, [loadMovements, product.inventoryUnit, inventoryRefresh]);

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
    <div className="p-[12px]">
      {" "}
      <div className="flex gap-[16px] mb-[12px] flex-wrap text-ui-body">
        {product.formulation && (
          <span className="text-ink-secondary">
            Formulation:{" "}
            <span className="text-zinc-900">{product.formulation}</span>
          </span>
        )}
        {product.unitSizeOz && (
          <span className="text-ink-secondary">
            Size (oz):{" "}
            <span className="text-zinc-900">{product.unitSizeOz}</span>
          </span>
        )}
        {product.sku && (
          <span className="text-ink-secondary">
            SKU: <span className="text-zinc-900">{product.sku}</span>
          </span>
        )}
        <span className="text-ink-secondary">
          Stock:{" "}
          <span>
            {product.inventoryOnHand != null
              ? `${product.inventoryOnHand} ${product.inventoryUnit || ""}`
              : "not set"}
          </span>
        </span>
        {product.lowStockThreshold != null && (
          <span className="text-ink-secondary">
            Low at:{" "}
            <span className="text-zinc-900">
              {product.lowStockThreshold} {product.inventoryUnit || ""}
            </span>
          </span>
        )}
      </div>
      {/* Authoring only: PUT /admin/inventory/:id is requireAdmin, so a
           technician would only ever see a 403 here. */}
      {canAuthor && (
        <AutoReorderEditor
          product={product}
          vendors={vendors}
          showToast={showToast}
          onInventoryChanged={onInventoryChanged}
        />
      )}
      {canAuthor && labelPipelineEnabled && (
        <ProductLabelReview key={product.id} product={product} />
      )}
      {product.vendorPricing.length > 0 && (
        <div className="mb-[12px]">
          {" "}
          <div className="text-ui-body text-ink-secondary mb-[6px]">
            Vendor Prices
          </div>{" "}
          <div className="grid gap-[4px]">
            {product.vendorPricing.map((vp, i) => (
              <div
                key={i}
                className="flex items-center gap-[12px] text-ui-body"
              >
                {" "}
                <span className="text-zinc-900 font-medium min-w-[140px]">
                  {vp.vendorName}
                </span>{" "}
                <span className="u-nums">${vp.price.toFixed(2)}</span>
                {vp.quantity && (
                  <span className="text-ink-secondary u-nums">{vp.quantity}</span>
                )}
                {(() => {
                  const unitLabel =
                    formatUnitPriceList(vp.unitPrices) ||
                    (vp.normalizedUnitPrice != null && vp.normalizedUnit
                      ? formatUnitCost(
                          vp.normalizedUnitPrice,
                          vp.normalizedUnit,
                        )
                      : null);
                  return unitLabel ? (
                    <span className="text-ink-secondary text-ui-body">
                      {unitLabel}
                    </span>
                  ) : null;
                })()}
                {vp.sourceType && (
                  <Badge tone="neutral">
                    {String(vp.sourceType).replace(/_/g, " ")}
                  </Badge>
                )}
                {vp.availability && (
                  <span className="text-ink-secondary text-ui-body">
                    {vp.availability}
                  </span>
                )}
                {vp.branchLocation && (
                  <span className="text-ink-secondary text-ui-body">
                    {vp.branchLocation}
                  </span>
                )}
                {vp.confidenceScore != null && (
                  <span className="text-ink-secondary text-ui-body">
                    {Math.round(vp.confidenceScore * 100)}% conf
                  </span>
                )}
                {vp.isBest && <Badge tone="neutral">Best</Badge>}
                {vp.url && (
                  <a
                    href={vp.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900 text-ui-body underline underline-offset-2"
                  >
                    Open
                  </a>
                )}
                {vp.lastChecked && (
                  <span className="text-ink-secondary text-ui-body">
                    {new Date(vp.lastChecked).toLocaleDateString()}
                  </span>
                )}
                <Button onClick={() => queueRefresh(vp)} variant="secondary">
                  Refresh
                </Button>
              </div>
            ))}
          </div>{" "}
        </div>
      )}
      <div className="flex gap-[8px] items-end">
        {" "}
        <Field label="Vendor">
          <Select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="w-[160px]"
          >
            {vendors
              .filter((v) => v.active)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
          </Select>
        </Field>{" "}
        <Field label="Price">
          <Input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            type="number"
            step="0.01"
            placeholder="0.00"
            className="w-[100px]"
          />
        </Field>{" "}
        <Field label="Quantity">
          <Input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="e.g. 32 oz"
            className="w-[120px]"
          />
        </Field>{" "}
        <Button
          onClick={() => {
            if (price) {
              onSave(product.id, vendorId, price, qty);
              setPrice("");
              setQty("");
            }
          }}
          variant="primary"
        >
          Add Price
        </Button>{" "}
      </div>{" "}
      <div className="grid grid-cols-[minmax(260px,380px)_1fr] gap-[12px] mt-[14px]">
        {" "}
        <Card className="p-3">
          {" "}
          <div className="text-ui-body text-ink-secondary mb-[8px]">
            Manual Adjustment
          </div>{" "}
          <div className="grid grid-cols-2 gap-[8px]">
            {" "}
            <Select
              value={adjustForm.movementType}
              onChange={(e) =>
                setAdjustForm((f) => ({
                  ...f,
                  movementType: e.target.value,
                }))
              }
            >
              {" "}
              <option value="restock">Restock</option>{" "}
              <option value="correction">Correction</option>{" "}
              <option value="damaged_lost">Damaged/Lost</option>{" "}
            </Select>{" "}
            <div className="flex gap-[6px]">
              {" "}
              <Input
                value={adjustForm.quantity}
                onChange={(e) =>
                  setAdjustForm((f) => ({
                    ...f,
                    quantity: e.target.value,
                  }))
                }
                type="number"
                step="0.0001"
                placeholder="Amount"
                className="w-full"
              />{" "}
              <Input
                value={adjustForm.unit}
                onChange={(e) =>
                  setAdjustForm((f) => ({
                    ...f,
                    unit: e.target.value,
                  }))
                }
                placeholder="unit"
                className="w-[70px]"
              />{" "}
            </div>{" "}
            <Input
              value={adjustForm.lotNumber}
              onChange={(e) =>
                setAdjustForm((f) => ({
                  ...f,
                  lotNumber: e.target.value,
                }))
              }
              placeholder="Lot number"
            />{" "}
            <Input
              value={adjustForm.reason}
              onChange={(e) =>
                setAdjustForm((f) => ({
                  ...f,
                  reason: e.target.value,
                }))
              }
              placeholder="Reason"
            />{" "}
            <Input
              value={adjustForm.note}
              onChange={(e) =>
                setAdjustForm((f) => ({
                  ...f,
                  note: e.target.value,
                }))
              }
              placeholder="Note"
              className="col-span-full"
            />{" "}
          </div>{" "}
          <Button
            onClick={submitAdjustment}
            variant="primary"
            className="mt-[8px] w-full"
          >
            Apply Adjustment
          </Button>{" "}
        </Card>{" "}
        <Card className="p-3 min-w-[0px]">
          {" "}
          <div className="text-ui-body text-ink-secondary mb-[8px]">
            Movement History
          </div>
          {movementLoading ? (
            <div className="text-ink-secondary text-ui-body">
              Loading movements...
            </div>
          ) : movements.length === 0 ? (
            <div className="text-ink-secondary text-ui-body">
              No inventory movements yet.
            </div>
          ) : (
            // overflowX spelled explicitly (not the `overflow` shorthand) so
            // the serialized style attribute contains "overflow-x: auto" and
            // the index.css scroll-shadow affordance selector matches.
            <div className="max-h-[220px] overflow-y-auto overflow-x-auto">
              {" "}
              <Table className="w-full">
                <THead>
                  <TR>
                    {["Date", "Type", "Amount", "Stock", "Job/Reason"].map(
                      (h) => (
                        <TH key={h}>{h}</TH>
                      ),
                    )}
                  </TR>
                </THead>
                <TBody>
                  {movements.map((m) => (
                    <TR key={m.id}>
                      <TD nums className="text-ink-secondary">
                        {m.createdAt
                          ? new Date(m.createdAt).toLocaleDateString()
                          : "—"}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            m.movementType === "damaged_lost"
                              ? "alert"
                              : "neutral"
                          }
                        >
                          {m.movementType}
                        </Badge>
                      </TD>
                      <TD nums>
                        {m.quantity ?? "—"} {m.unit || ""}
                      </TD>
                      <TD nums>
                        {m.stockBefore ?? "—"} → {m.stockAfter ?? "—"}
                      </TD>
                      <TD className="text-ink-secondary">
                        {m.customerName ||
                          m.metadata?.reason ||
                          m.metadata?.note ||
                          "—"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>{" "}
            </div>
          )}
        </Card>{" "}
      </div>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// REGISTRY TAB — Customer-facing content & visibility
// ══════════════════════════════════════════════════════════════
const VISIBILITY_OPTIONS = [
  {
    value: "internal_only",
    label: "Internal Only",
  },
  {
    value: "portal_only",
    label: "Portal",
  },
  {
    value: "public",
    label: "Public",
  },
];
const STATUS_OPTIONS = [
  {
    value: "draft",
    label: "Draft",
  },
  {
    value: "approved_for_portal",
    label: "Approved (Portal)",
  },
  {
    value: "approved_for_public",
    label: "Approved (Public)",
  },
  {
    value: "retired",
    label: "Retired",
  },
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
  useEffect(() => {
    load();
  }, [load]);
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
          ? form.targetPests
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        applicationZones: form.applicationZones
          ? form.applicationZones
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
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
    if (filter === "needs_content")
      return p.customerVisibility !== "internal_only" && !p.publicSummary;
    return true;
  });
  if (loading)
    return <ActionFeedback>Loading...</ActionFeedback>;
  return (
    <div>
      <div className="flex gap-[6px] mb-[12px] flex-wrap">
        {[
          {
            key: "all",
            label: "All Products",
          },
          {
            key: "public",
            label: "Public",
          },
          {
            key: "portal",
            label: "Portal",
          },
          {
            key: "draft",
            label: "Drafts",
          },
          {
            key: "needs_content",
            label: "Needs Content",
          },
        ].map((f) => (
          <Button
            key={f.key}
            onClick={() => setFilter(f.key)}
            variant={filter === f.key ? "primary" : "secondary"}
            aria-pressed={filter === f.key}
          >
            {f.label}
          </Button>
        ))}
        <span className="text-ink-secondary text-ui-body self-center ml-[8px]">
          {filtered.length} product{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="grid gap-[8px]">
        {filtered.map((p) => {
          const isEditing = editing === p.id;
          const vis = VISIBILITY_OPTIONS.find(
            (v) => v.value === (p.customerVisibility || "internal_only"),
          );
          const stat = STATUS_OPTIONS.find(
            (s) => s.value === (p.contentStatus || "draft"),
          );
          return (
            <Card key={p.id} className="p-5 mb-3 p-[12px]">
              <div className="flex items-center gap-[10px]">
                <span className="text-zinc-900 font-medium flex-[1]">
                  {p.name}
                </span>
                <span className="text-ui-body text-ink-secondary">
                  {p.category}
                </span>
                <Badge tone="neutral">{vis.label}</Badge>
                {/* Main: muted/teal/green for the rest (no kit equivalent,
                    stay neutral) but retired was red. */}
                <Badge tone={stat.value === "retired" ? "alert" : "neutral"}>
                  {stat.label}
                </Badge>
                {!isEditing && (
                  <Button onClick={() => startEdit(p)} variant="secondary">
                    Edit
                  </Button>
                )}
              </div>

              {isEditing && (
                <div className="grid gap-[10px]">
                  <div className="grid grid-cols-3 gap-[8px]">
                    <Field label="Visibility">
                      <Select
                        value={form.customerVisibility}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            customerVisibility: e.target.value,
                          }))
                        }
                      >
                        {VISIBILITY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Status">
                      <Select
                        value={form.contentStatus}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            contentStatus: e.target.value,
                          }))
                        }
                      >
                        {STATUS_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Common Name">
                      <Input
                        value={form.commonName}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            commonName: e.target.value,
                          }))
                        }
                        placeholder="Plain-language name"
                      />
                    </Field>
                  </div>

                  <div className="grid grid-cols-2 gap-[8px]">
                    <Field label="Target Pests (comma-separated)">
                      <Input
                        value={form.targetPests}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            targetPests: e.target.value,
                          }))
                        }
                        placeholder="ants, roaches, spiders"
                      />
                    </Field>
                    <Field label="Application Zones (comma-separated)">
                      <Input
                        value={form.applicationZones}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            applicationZones: e.target.value,
                          }))
                        }
                        placeholder="exterior perimeter, interior cracks"
                      />
                    </Field>
                  </div>

                  <Field label="Public Summary (why we use it — 1-2 sentences)">
                    <Textarea
                      value={form.publicSummary}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          publicSummary: e.target.value,
                        }))
                      }
                      rows={2}
                      placeholder="Non-repellent transfer insecticide that eliminates entire colonies..."
                      className="resize-y"
                    />
                  </Field>

                  <Field label="Portal Summary (shown in service history)">
                    <Textarea
                      value={form.portalSummary}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          portalSummary: e.target.value,
                        }))
                      }
                      rows={2}
                      placeholder="Applied to your exterior perimeter to create a transfer zone..."
                      className="resize-y"
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-[8px]">
                    <Field label="Customer Safety Summary">
                      <Textarea
                        value={form.customerSafetySummary}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            customerSafetySummary: e.target.value,
                          }))
                        }
                        rows={2}
                        placeholder="Applied according to label directions..."
                        className="resize-y"
                      />
                    </Field>
                    <Field label="Pet/Kid Guidance">
                      <Textarea
                        value={form.petKidGuidanceText}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            petKidGuidanceText: e.target.value,
                          }))
                        }
                        rows={2}
                        placeholder="Safe once dry — technician confirms timing"
                        className="resize-y"
                      />
                    </Field>
                  </div>

                  <div className="flex gap-[8px] justify-end">
                    <Button
                      onClick={() => setEditing(null)}
                      variant="secondary"
                    >
                      Cancel
                    </Button>
                    <Button onClick={() => save(p.id)} variant="primary">
                      Save Registry
                    </Button>
                  </div>
                </div>
              )}

              {!isEditing && p.publicSummary && (
                <div className="mt-[6px] text-ui-body text-ink-secondary">
                  {p.publicSummary}
                </div>
              )}
            </Card>
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
  if (loading) return <ActionFeedback>Loading vendors...</ActionFeedback>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[12px]">
      {vendors.map((v) => (
        <Card key={v.id} className="p-5 mb-3 mb-[0px]">
          {" "}
          <div className="flex justify-between items-start mb-[8px]">
            {" "}
            <div>
              <div className="text-ui-body font-medium text-zinc-900">
                {v.name}
              </div>
              <div className="text-ui-body text-ink-secondary">{v.type}</div>
            </div>{" "}
            <div className="flex gap-[4px]">
              {v.scrapingEnabled && <Badge tone="neutral">Scrape</Badge>}
              {v.hasCredentials && <Badge tone="neutral">Login</Badge>}
              {!v.active && <Badge tone="alert">Inactive</Badge>}
            </div>{" "}
          </div>{" "}
          <div className="flex gap-[12px] text-ui-body text-ink-secondary mb-[8px]">
            <span>{v.productCount} products</span>
            <span>{v.bestPriceCount} best prices</span>
          </div>
          {v.website && (
            <a
              href={v.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ui-body text-zinc-900 underline underline-offset-2 block mt-[4px]"
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
            <Button
              onClick={() => setEditing(v.id)}
              variant="secondary"
              className="mt-[8px] w-full"
            >
              Edit Credentials
            </Button>
          )}
        </Card>
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
    <Card className="mt-[8px] p-3 bg-zinc-50">
      {[
        {
          key: "loginUsername",
          label: "Username",
        },
        {
          key: "loginEmail",
          label: "Email",
        },
        {
          key: "loginPassword",
          label: "Password",
          type: "password",
        },
        {
          key: "accountNumber",
          label: "Account #",
        },
        {
          key: "loginUrl",
          label: "Login URL",
        },
      ].map((f) => (
        <Field key={f.key} label={f.label} className="mb-[6px]">
          <Input
            value={form[f.key]}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                [f.key]: e.target.value,
              }))
            }
            type={f.type || "text"}
            placeholder={f.label}
            className="w-full"
          />
        </Field>
      ))}
      <div className="flex gap-[6px] mt-[8px]">
        <Button onClick={() => onSave(vendor.id, form)} variant="primary">
          Save
        </Button>
        <Button onClick={onCancel} variant="secondary">
          Cancel
        </Button>
      </div>{" "}
    </Card>
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
      // Partial failures are real (codex GH r3 P2): the endpoint returns
      // 200 with per-id processed/skipped/failed — report them instead of
      // claiming every selected price applied, and keep the unprocessed
      // ids selected for a retry.
      const result = await adminFetch("/admin/inventory/approvals/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], action }),
      });
      const failed = result?.failed || [];
      const skipped = result?.skipped || [];
      const verb = action === "approve" ? "Approved" : "Rejected";
      if (failed.length || skipped.length) {
        showToast(
          `${verb} ${result?.processed ?? 0} of ${selected.size}` +
            `${failed.length ? ` — ${failed.length} failed (kept selected)` : ""}` +
            `${skipped.length ? ` — ${skipped.length} already decided` : ""}`,
        );
        setSelected(new Set(failed));
      } else {
        showToast(`${verb} ${selected.size} items`);
        setSelected(new Set());
      }
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
  if (loading) return <ActionFeedback>Loading approvals...</ActionFeedback>;
  return (
    <div>
      {selected.size > 0 && (
        <Card className="flex gap-[8px] items-center mb-[12px] p-3">
          {" "}
          <span className="text-ui-body font-medium text-zinc-900">
            {selected.size} selected
          </span>{" "}
          <Button onClick={() => handleBulk("approve")} variant="primary">
            Approve All
          </Button>{" "}
          <Button onClick={() => handleBulk("reject")} variant="danger">
            Reject All
          </Button>{" "}
          <Button onClick={() => setSelected(new Set())} variant="secondary">
            Clear
          </Button>{" "}
        </Card>
      )}
      {approvals.length === 0 ? (
        <Card className="p-5 mb-3 text-center p-[40px] text-ink-secondary">
          No pending approvals
        </Card>
      ) : (
        <div className="grid gap-[8px]">
          {approvals.map((a) => {
            const pct =
              a.price_change_pct ||
              (a.old_price
                ? (((a.new_price - a.old_price) / a.old_price) * 100).toFixed(1)
                : null);
            const isUp = pct > 0;
            return (
              <Card
                key={a.id}
                className="p-5 mb-3 mb-[0px] flex items-center gap-[12px]"
              >
                {" "}
                <Checkbox
                  aria-label={`Select ${a.product_name} from ${a.vendor_name}`}
                  checked={selected.has(a.id)}
                  onChange={() => toggleSel(a.id)}
                />{" "}
                <div className="flex-[1]">
                  {" "}
                  <div className="text-ui-body font-medium text-zinc-900">
                    {a.product_name}
                  </div>{" "}
                  <div className="text-ui-body text-ink-secondary">
                    {a.vendor_name} · {a.category}
                  </div>
                  {a.notes && (
                    <div className="text-ui-body text-zinc-900 mt-[2px]">
                      {a.notes}
                    </div>
                  )}
                </div>{" "}
                <div className="text-center min-w-[80px]">
                  {a.old_price && (
                    <div className="text-ui-body text-ink-secondary line-through">
                      ${parseFloat(a.old_price).toFixed(2)}
                    </div>
                  )}
                  <div className="text-ui-body font-medium text-zinc-900">
                    ${parseFloat(a.new_price).toFixed(2)}
                  </div>{" "}
                </div>
                {pct !== null && (
                  <Badge tone={isUp ? "strong" : "neutral"}>
                    {isUp ? "+" : ""}
                    {pct}%
                  </Badge>
                )}
                <div className="flex gap-[4px]">
                  {" "}
                  <Button
                    onClick={() => handleAction(a.id, "approve")}
                    variant="primary"
                  >
                    Approve
                  </Button>{" "}
                  <Button
                    onClick={() => handleAction(a.id, "reject")}
                    variant="danger"
                  >
                    Reject
                  </Button>{" "}
                </div>{" "}
              </Card>
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
  {
    key: "all",
    label: "All",
  },
  {
    key: "pest",
    label: "Pest",
  },
  {
    key: "termite",
    label: "Termite",
  },
  {
    key: "lawn",
    label: "Lawn",
  },
  {
    key: "mosquito",
    label: "Mosquito",
  },
  {
    key: "rodent",
    label: "Rodent",
  },
  {
    key: "tree_shrub",
    label: "Tree & Shrub",
  },
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
  if (loading) return <ActionFeedback>Loading protocols...</ActionFeedback>;
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
      <div className="flex justify-between items-center mb-[16px]">
        {" "}
        <div>
          <div className="text-ui-body font-medium text-zinc-900">
            Treatment Protocols by Service Line
          </div>{" "}
          <div className="text-ui-body text-ink-secondary">
            Define which products each service uses, at what rates — drives COGS
            calculations
          </div>
        </div>{" "}
        <Button
          onClick={() => setShowNewService(!showNewService)}
          variant="primary"
        >
          + New Service Type
        </Button>{" "}
      </div>
      {health?.lines?.length > 0 && (
        <Card className="p-5 mb-3 p-[16px]">
          {" "}
          <div className="flex justify-between gap-[12px] items-center mb-[12px]">
            {" "}
            <div>
              {" "}
              <div className="text-ui-body font-medium text-zinc-900">
                Protocol Health
              </div>{" "}
              <div className="text-ui-body text-ink-secondary">
                Template coverage, linked inventory COGS rows, and missing cost
                warnings
              </div>{" "}
            </div>{" "}
            <Button onClick={load} variant="secondary">
              Refresh
            </Button>{" "}
          </div>{" "}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(155px,1fr))] gap-[8px]">
            {health.lines.map((line) => {
              const label = lineLabel(line.serviceLine);
              const needsCogs = line.cogsRows === 0;
              const needsCosts = line.missingCostRows > 0;
              // Main colored these by line.status (healthy/warning/missing),
              // not by the needsCogs/needsCosts booleans — a "warning" line
              // was amber, only "missing" was red.
              const lineTone =
                line.status === "warning" ? "warn" : line.status === "healthy" ? "neutral" : "alert";
              return (
                <Card
                  key={line.serviceLine}
                  title={(line.warnings || [])
                    .map((w) => `${w.serviceType}: ${w.warning}`)
                    .join("\n")}
                  className={cn(
                    "text-left p-3",
                    lineTone === "alert" && "border-alert-fg",
                    lineTone === "warn" && "border-warn-fg",
                  )}
                >
                  {" "}
                  <div className="flex justify-between items-center gap-[8px]">
                    {" "}
                    <div className="text-ui-body font-medium text-zinc-900">
                      {label}
                    </div>{" "}
                    <Badge tone={lineTone}>
                      {line.status}
                    </Badge>{" "}
                  </div>{" "}
                  <div className="grid grid-cols-3 gap-[6px] mt-[8px]">
                    {" "}
                    <div>
                      <div className="text-ui-body text-zinc-900">
                        {line.templateCount}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        Templates
                      </div>
                    </div>{" "}
                    <div>
                      <div className="text-ui-body text-zinc-900">
                        {line.cogsRows}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        COGS
                      </div>
                    </div>{" "}
                    <div>
                      <div className="text-ui-body">{line.missingCostRows}</div>
                      <div className="text-ui-body text-ink-secondary">
                        Missing
                      </div>
                    </div>{" "}
                  </div>{" "}
                  <div className="flex gap-[6px] flex-wrap mt-[10px]">
                    {" "}
                    <Button
                      onClick={() => filterToLine(line.serviceLine)}
                      variant="secondary"
                    >
                      View
                    </Button>
                    {needsCogs && (
                      <Button
                        onClick={() => openAddForLine(line.serviceLine)}
                        variant="primary"
                      >
                        + COGS
                      </Button>
                    )}
                    {needsCosts && (
                      <Button
                        onClick={() => highlightMissingCosts(line.serviceLine)}
                        variant="primary"
                      >
                        Cost Data
                      </Button>
                    )}
                    <Button
                      onClick={() => {
                        window.location.href = "/admin/dispatch?tab=protocols";
                      }}
                      variant={
                        line.templateCount === 0 ? "danger" : "secondary"
                      }
                    >
                      Templates
                    </Button>{" "}
                  </div>{" "}
                </Card>
              );
            })}
          </div>{" "}
        </Card>
      )}
      <div className="flex gap-[6px] flex-wrap mb-[14px]">
        {PROTOCOL_FILTERS.map((filter) => {
          const active = serviceFilter === filter.key;
          return (
            <Button
              key={filter.key}
              onClick={() => {
                setServiceFilter(filter.key);
                setCostHighlightLine(null);
              }}
              variant={active ? "primary" : "secondary"}
            >
              {filter.label}
            </Button>
          );
        })}
      </div>
      {showNewService && (
        <Card className="p-5 mb-3 flex gap-[8px] items-center">
          {" "}
          <Input
            value={newServiceType}
            onChange={(e) => setNewServiceType(e.target.value)}
            placeholder="Service type (e.g. Mole Trapping)"
            className="flex-[1]"
          />{" "}
          <Button
            onClick={() => {
              if (newServiceType.trim()) {
                setShowAdd(newServiceType.trim());
                setShowNewService(false);
              }
            }}
            variant="primary"
          >
            Create
          </Button>{" "}
          <Button onClick={() => setShowNewService(false)} variant="secondary">
            Cancel
          </Button>{" "}
        </Card>
      )}
      {showAdd && !services.find((s) => s.serviceType === showAdd) && (
        <Card className="p-5 mb-3">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 mb-[12px]">
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
        </Card>
      )}
      {services.length === 0 && !showAdd && (
        <Card className="p-5 mb-3 text-center p-[40px] text-ink-secondary">
          No protocols defined yet.
        </Card>
      )}
      {services.length > 0 && visibleServices.length === 0 && !showAdd && (
        <Card className="p-5 mb-3 text-center p-[40px] text-ink-secondary">
          No protocols in this service category yet.
        </Card>
      )}
      {visibleServices.map((svc) => {
        const serviceLine = protocolLineForService(svc.serviceType);
        const highlightService =
          costHighlightLine === serviceLine &&
          svc.products.some((p) => p.costWarning || !p.costPerApp);
        return (
          <Card
            key={svc.serviceType}
            className={
              highlightService
                ? "p-5 mb-3 border-warn-fg ring-2 ring-warn-bg"
                : "p-5 mb-3"
            }
          >
            {" "}
            <div className="flex justify-between items-center mb-[12px]">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900">
                {svc.serviceType}
              </div>{" "}
              <div className="flex gap-[8px] items-center">
                {" "}
                <div className="text-ui-body font-medium text-zinc-900">
                  ${svc.totalCost.toFixed(2)}/app
                </div>{" "}
                <Button
                  onClick={() => {
                    setCostHighlightLine(null);
                    setShowAdd(
                      showAdd === svc.serviceType ? null : svc.serviceType,
                    );
                  }}
                  variant="primary"
                >
                  + Product
                </Button>{" "}
              </div>{" "}
            </div>{" "}
            {/* overflow-x wrapper: phones scroll the wide table instead of
                 clipping it; index.css adds the scroll-shadow affordance. */}
            <div className="overflow-x-auto">
              <Table className="w-full">
                <THead>
                  <TR>
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
                      <TH key={h}>{h}</TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {svc.products.map((p) => {
                    const highlightProductCost =
                      costHighlightLine === serviceLine &&
                      (p.costWarning || !p.costPerApp);
                    return editingRow === p.id ? (
                      <TR key={p.id} className="bg-zinc-50">
                        <TD className="font-medium">{p.productName}</TD>
                        <TD>
                          <div className="flex gap-[4px]">
                            <Input
                              value={editForm.usageAmount}
                              onChange={(e) =>
                                setEditForm((f) => ({
                                  ...f,
                                  usageAmount: e.target.value,
                                }))
                              }
                              type="number"
                              step="0.01"
                              className="w-[60px]"
                            />

                            <Select
                              value={editForm.usageUnit}
                              onChange={(e) =>
                                setEditForm((f) => ({
                                  ...f,
                                  usageUnit: e.target.value,
                                }))
                              }
                              className="w-[70px]"
                            >
                              {unitOpts.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </TD>
                        <TD>
                          <Input
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
                            className="w-[70px]"
                          />
                        </TD>
                        <TD nums>
                          {p.bestPrice
                            ? `$${parseFloat(p.bestPrice).toFixed(2)}`
                            : "—"}
                        </TD>
                        <TD nums className="text-zinc-900">
                          {p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : "—"}
                        </TD>
                        <TD className="text-ink-secondary">
                          {costSourceLabel(p)}
                        </TD>
                        <TD>
                          <Checkbox
                            aria-label={`Set ${p.productName} as primary`}
                            checked={editForm.isPrimary}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                isPrimary: e.target.checked,
                              }))
                            }
                          />
                        </TD>
                        <TD>
                          <Input
                            value={editForm.notes}
                            onChange={(e) =>
                              setEditForm((f) => ({
                                ...f,
                                notes: e.target.value,
                              }))
                            }
                            className="w-full"
                          />
                        </TD>
                        <TD className="w-[80px]">
                          <div className="flex gap-[4px]">
                            <Button
                              onClick={() => saveEdit(p.id)}
                              variant="primary"
                            >
                              Save
                            </Button>
                            <Button
                              onClick={() => setEditingRow(null)}
                              variant="secondary"
                            >
                              ×
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    ) : (
                      <TR
                        key={p.id}
                        className={highlightProductCost ? "bg-warn-bg" : ""}
                      >
                        <TD className="font-medium">
                          {p.productName}{" "}
                          {p.isPrimary && <Badge tone="neutral">Primary</Badge>}
                        </TD>
                        <TD nums>
                          {p.usageAmount} {p.usageUnit}
                        </TD>
                        <TD nums>{p.usagePer1000sf || "—"}</TD>
                        <TD nums>
                          {p.bestPrice
                            ? `$${parseFloat(p.bestPrice).toFixed(2)}`
                            : "—"}
                        </TD>
                        <TD nums className="text-zinc-900">
                          {p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : "—"}
                        </TD>
                        <TD title={p.costWarning || ""}>
                          {costSourceLabel(p)}
                        </TD>
                        <TD>{p.isPrimary ? "" : ""}</TD>
                        <TD className="text-ink-secondary max-w-[200px] overflow-hidden whitespace-nowrap text-ellipsis">
                          {p.notes || "—"}
                        </TD>
                        <TD className="w-[80px]">
                          <div className="flex gap-[4px]">
                            {" "}
                            <Button
                              onClick={() => startEdit(p)}
                              variant="secondary"
                            >
                              Edit
                            </Button>{" "}
                            <Button
                              onClick={() => deleteRow(p.id)}
                              variant="danger"
                            >
                              ×
                            </Button>{" "}
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            {showAdd === svc.serviceType && (
              <Card className="mt-[8px] p-3 bg-zinc-50">
                {" "}
                <AddProtocolRow
                  products={products}
                  newRow={newRow}
                  setNewRow={setNewRow}
                  unitOpts={unitOpts}
                  onAdd={() => addRow(svc.serviceType)}
                  onCancel={() => setShowAdd(null)}
                />{" "}
              </Card>
            )}
          </Card>
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
    <div className="flex gap-[8px] items-end flex-wrap">
      {" "}
      <Field label="Product">
        <Select
          value={newRow.productId}
          onChange={(e) =>
            setNewRow((r) => ({
              ...r,
              productId: e.target.value,
            }))
          }
          className="w-[200px]"
        >
          <option value="">Select...</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>{" "}
      <Field label="Amount">
        <Input
          value={newRow.usageAmount}
          onChange={(e) =>
            setNewRow((r) => ({
              ...r,
              usageAmount: e.target.value,
            }))
          }
          type="number"
          step="0.01"
          className="w-[70px]"
        />
      </Field>{" "}
      <Field label="Unit">
        <Select
          value={newRow.usageUnit}
          onChange={(e) =>
            setNewRow((r) => ({
              ...r,
              usageUnit: e.target.value,
            }))
          }
          className="w-[80px]"
        >
          {unitOpts.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      </Field>{" "}
      <Field label="Per 1000sf">
        <Input
          value={newRow.usagePer1000sf}
          onChange={(e) =>
            setNewRow((r) => ({
              ...r,
              usagePer1000sf: e.target.value,
            }))
          }
          type="number"
          step="0.001"
          placeholder="—"
          className="w-[70px]"
        />
      </Field>{" "}
      <div className="flex items-center">
        <Checkbox
          label="Primary"
          checked={newRow.isPrimary}
          onChange={(e) =>
            setNewRow((r) => ({
              ...r,
              isPrimary: e.target.checked,
            }))
          }
        />
      </div>{" "}
      <Field label="Notes">
        <Input
          value={newRow.notes}
          onChange={(e) =>
            setNewRow((r) => ({
              ...r,
              notes: e.target.value,
            }))
          }
          placeholder="Usage notes..."
          className="w-[150px]"
        />
      </Field>{" "}
      <Button onClick={onAdd} variant="primary">
        Add
      </Button>{" "}
      <Button onClick={onCancel} variant="secondary">
        Cancel
      </Button>{" "}
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
  if (loading) return <ActionFeedback>Loading service margins...</ActionFeedback>;
  return (
    <div>
      {" "}
      <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
        COGS by Service Line
      </div>
      {services.length === 0 ? (
        <Card className="p-5 mb-3 text-center p-[40px] text-ink-secondary">
          No service product mappings yet.
        </Card>
      ) : (
        services.map((svc) => (
          <Card key={svc.serviceType} className="p-5 mb-3">
            {" "}
            <div className="flex justify-between items-center mb-[12px]">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900">
                {svc.serviceType}
              </div>{" "}
              <div className="text-ui-body font-medium text-zinc-900">
                ${svc.totalCost.toFixed(2)}/app
              </div>{" "}
            </div>{" "}
            {/* overflow-x wrapper: phones scroll the wide table instead of
             clipping it; index.css adds the scroll-shadow affordance. */}
            <div className="overflow-x-auto">
              <Table className="w-full">
                <THead>
                  <TR>
                    {[
                      "Product",
                      "Usage",
                      "Per 1000sf",
                      "Best Price",
                      "Cost/App",
                      "Cost Source",
                    ].map((h) => (
                      <TH key={h}>{h}</TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {svc.products.map((p) => (
                    <TR key={p.id}>
                      <TD className="font-medium">
                        {p.productName}{" "}
                        {p.isPrimary && <Badge tone="neutral">Primary</Badge>}
                      </TD>
                      <TD nums>
                        {p.usageAmount} {p.usageUnit}
                      </TD>
                      <TD nums>{p.usagePer1000sf || "—"}</TD>
                      <TD nums>
                        {p.bestPrice
                          ? `$${parseFloat(p.bestPrice).toFixed(2)}`
                          : "—"}
                      </TD>
                      <TD nums className="text-zinc-900">
                        {p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : "—"}
                      </TD>
                      <TD title={p.costWarning || ""}>{costSourceLabel(p)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>{" "}
            </div>
          </Card>
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
  if (loading) return <ActionFeedback>Loading scrape data...</ActionFeedback>;
  return (
    <div>
      {" "}
      <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
        Vendor Scrape Status
      </div>{" "}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-[10px] mb-[24px]">
        {vendors.map((v) => {
          return (
            <Card key={v.id} className="p-5 mb-3 mb-[0px] text-center">
              <div className="text-ui-body font-medium text-zinc-900 mb-[4px]">
                {v.name}
              </div>
              <div className="text-ui-body text-ink-secondary mb-[8px]">
                {v.productCount} products
              </div>
              <Badge tone={scrapeStatusTone(v.lastScrapeStatus)}>{v.lastScrapeStatus || "never"}</Badge>
              <Button
                onClick={() => triggerScrape(v.id)}
                variant="primary"
                className="mt-[8px] w-full"
              >
                Trigger Scrape
              </Button>
            </Card>
          );
        })}
        {!vendors.length && (
          <div className="text-ink-secondary col-span-full text-center p-[20px]">
            No vendors with scraping enabled
          </div>
        )}
      </div>{" "}
      <div className="text-ui-body font-medium text-zinc-900 mb-[12px]">
        Recent Scrape Jobs
      </div>
      {!jobs.length ? (
        <Card className="p-5 mb-3 text-center p-[30px] text-ink-secondary">
          No scrape jobs yet
        </Card>
      ) : (
        // overflow-x wrapper: phones scroll the wide table instead of
        // clipping it; index.css adds the scroll-shadow affordance.
        <div className="overflow-x-auto">
          <Table className="w-full">
            <THead>
              <TR>
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
                  <TH key={h}>{h}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {jobs.map((j) => (
                <TR key={j.id}>
                  <TD className="font-medium">{j.vendor_name}</TD>
                  <TD>
                    <Badge
                      tone={
                        j.status === "failed"
                          ? "alert"
                          : j.status === "completed"
                            ? "neutral"
                            : "warn"
                      }
                    >
                      {j.status}
                    </Badge>
                  </TD>
                  <TD nums>{j.products_found}</TD>
                  <TD nums>{j.prices_updated}</TD>
                  <TD nums>{j.prices_new}</TD>
                  <TD nums>{j.errors}</TD>
                  <TD nums>
                    {j.duration_ms
                      ? `${(j.duration_ms / 1000).toFixed(1)}s`
                      : "—"}
                  </TD>
                  <TD nums className="text-ink-secondary">
                    {new Date(j.created_at).toLocaleString()}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
