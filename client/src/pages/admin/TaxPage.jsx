import {
  Button,
  buttonStyles,
  Field,
  Input,
  Select,
  Checkbox,
  Badge,
  Card,
  UiSurface,
  ActionFeedback,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../../components/ui";
import { useState, useEffect, useCallback, useRef } from "react";
import useIsMobile from "../../hooks/useIsMobile";
import {
  BarChart3,
  Bot,
  CalendarDays,
  DollarSign,
  Download,
  FileText,
  LayoutDashboard,
  ListChecks,
  Package,
  Percent,
  Landmark,
  Receipt,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { etDateString, formatETDateOnly } from "../../lib/timezone";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
function useTaxRead(path, setData, field) {
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    adminFetch(path)
      .then((data) => {
        if (active) setData(field ? data[field] || [] : data);
      })
      .catch((error) => {
        if (active) setError(error.message || "Request failed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, setData, field, attempt]);
  return {
    loading,
    error,
    retry,
  };
}
function TaxReadFeedback({ read, label }) {
  return (
    <div className="min-h-60 py-6">
      <ActionFeedback
        error={!!read.error}
        onRetry={read.error ? read.retry : undefined}
      >
        {read.error
          ? "Could not load " + label + ": " + read.error
          : "Loading " + label + "…"}
      </ActionFeedback>
    </div>
  );
}
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/blue/purple/orange fold to zinc-900. Semantic accents preserved.

const MONO = "'JetBrains Mono', monospace";
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      // the intentional 400/409s carry actionable operator guidance in
      // {error} — surface it instead of a bare status code
      let detail = "";
      try {
        detail = (await r.json())?.error || "";
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail || `HTTP ${r.status}`);
    }
    return r.json();
  });
}
function StatCard({ label, value, color, sub, onClick }) {
  const isMobile = useIsMobile(640);
  const Control = onClick ? Button : Card;
  return (
    <Control
      variant="secondary"
      className="!block !h-auto text-left whitespace-normal"
      onClick={onClick}
      style={{
        padding: isMobile ? "12px 10px" : "16px 20px",
        flex: isMobile ? "1 1 calc(50% - 6px)" : "1 1 0",
        minWidth: isMobile ? 0 : 140,
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.borderColor = color || "#18181B";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#E4E4E7";
      }}
    >
      {" "}
      <div
        style={{
          color: "#71717A",
          fontSize: 14,
          marginBottom: 6,
        }}
      >
        {label}
      </div>{" "}
      <div
        style={{
          fontFamily: MONO,
          fontSize: 22,
          fontWeight: 500,
          color: color || "#09090B",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 14,
            color: "#71717A",
            marginTop: 4,
          }}
        >
          {sub}
        </div>
      )}
    </Control>
  );
}
// Date-only values (filing due dates, expense/purchase dates) arrive as
// UTC-midnight strings — bare toLocaleDateString rendered them one day early
// in ET, so the DR-15 "Apr 30" deadline printed as 4/29 while the countdown
// chip beside it said otherwise. formatETDateOnly anchors the calendar day.
const fmtD = (d) => (d ? formatETDateOnly(d) : "—");
const fmtM = (n) =>
  n != null
    ? "$" +
      Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : "—";
const fmtPct = (n) => (n != null ? (n * 100).toFixed(2) + "%" : "—");
// Calendar-day diff (due date - today in ET) with both anchored at UTC midnight so same-day = 0.
const daysUntil = (due) => {
  if (!due) return 0;
  const dueStr = String(due).slice(0, 10);
  const todayStr = etDateString();
  return Math.floor(
    (new Date(dueStr + "T00:00:00Z") - new Date(todayStr + "T00:00:00Z")) /
      86400000,
  );
};
const PRIORITY_COLORS = {
  high: "#C8312F",
  medium: "#52525B",
  low: "#18181B",
};
const STATUS_COLORS = {
  upcoming: "#18181B",
  prepared: "#52525B",
  filed: "#18181B",
  paid: "#18181B",
  late: "#C8312F",
  new: "#18181B",
  reviewed: "#52525B",
  acted_on: "#18181B",
  dismissed: "#71717A",
};
const FILING_STATUS_OPTIONS = ["upcoming", "prepared", "filed", "paid", "late"];
const TAX_SECTIONS = [
  {
    key: "overview",
    label: "Overview",
    Icon: LayoutDashboard,
  },
  {
    key: "rates",
    label: "Tax Rates",
    Icon: Percent,
  },
  {
    key: "services",
    label: "Taxability",
    Icon: ShieldCheck,
  },
  {
    key: "exemptions",
    label: "Exemptions",
    Icon: FileText,
  },
  {
    key: "equipment",
    label: "Equipment",
    Icon: Package,
  },
  {
    key: "expenses",
    label: "Expenses",
    Icon: ListChecks,
  },
  {
    key: "bankimport",
    label: "Bank Import",
    Icon: Landmark,
  },
  {
    key: "mileage",
    label: "Mileage",
    Icon: Truck,
  },
  {
    key: "revenue",
    label: "Revenue",
    Icon: DollarSign,
  },
  {
    key: "pnl",
    label: "P&L",
    Icon: BarChart3,
  },
  {
    key: "filings",
    label: "Filing Calendar",
    Icon: CalendarDays,
  },
  {
    key: "advisor",
    label: "AI Advisor",
    Icon: Bot,
  },
  {
    key: "exports",
    label: "Exports",
    Icon: Download,
  },
  {
    key: "ar",
    label: "A/R",
    Icon: Receipt,
  },
];

// The 13-tab bar is grouped into parent sections, each revealing its leaf tabs
// in a sub-row. `activeTab` still holds the LEAF key, so every
// {activeTab === "..."} render block below is unchanged.
const TAX_TAB_GROUPS = [
  {
    key: "overview",
    label: "Overview",
    Icon: LayoutDashboard,
    tabs: ["overview"],
  },
  {
    key: "setup",
    label: "Tax Setup",
    Icon: ShieldCheck,
    tabs: ["rates", "services", "exemptions"],
  },
  {
    key: "expenses",
    label: "Expenses",
    Icon: ListChecks,
    tabs: ["expenses"],
  },
  {
    key: "revenue",
    label: "Revenue",
    Icon: DollarSign,
    tabs: ["revenue"],
  },
  {
    key: "assets",
    label: "Assets",
    Icon: Package,
    tabs: ["equipment", "mileage"],
  },
  {
    key: "reports",
    label: "Reports",
    Icon: BarChart3,
    tabs: ["pnl", "filings", "advisor"],
  },
  {
    key: "compliance",
    label: "Exports & A/R",
    Icon: Download,
    tabs: ["exports", "ar"],
  },
];
const TAX_LEAF_BY_KEY = Object.fromEntries(TAX_SECTIONS.map((s) => [s.key, s]));

// ═══════════════════════════════════════════════════════════════
// TAX RATES TAB
// ═══════════════════════════════════════════════════════════════
function TaxRatesTab() {
  const isMobile = useIsMobile(640);
  const [rates, setRates] = useState([]);
  const read = useTaxRead("/admin/tax/rates", setRates, "rates");
  if (read.loading || read.error)
    return <TaxReadFeedback read={read} label="tax rates" />;
  return (
    <div>
      {" "}
      <h2
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 12,
        }}
      >
        Florida Sales Tax Rates by County
      </h2>{" "}
      {rates.length === 0 && (
        <Card className="p-6 text-zinc-500">No tax rates are available.</Card>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile
            ? "1fr"
            : "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 10,
        }}
      >
        {rates
          .filter((r) => r.active)
          .map((r) => (
            <Card
              key={r.id}
              style={{
                padding: "14px 16px",
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                {" "}
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 500,
                    color: "#09090B",
                  }}
                >
                  {r.county} County
                </span>{" "}
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 18,
                    fontWeight: 500,
                    color: "#18181B",
                  }}
                >
                  {fmtPct(r.combinedRate)}
                </span>{" "}
              </div>{" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                  marginBottom: 4,
                }}
              >
                State: {fmtPct(r.stateRate)} + County surtax:{" "}
                {fmtPct(r.countySurtax)}
              </div>{" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                }}
              >
                Zone: {r.serviceZone}
              </div>{" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                  marginTop: 4,
                }}
              >
                Effective: {fmtD(r.effectiveDate)}
              </div>
              {r.notes && (
                <div
                  style={{
                    fontSize: 14,
                    color: "#71717A",
                    marginTop: 4,
                  }}
                >
                  {r.notes}
                </div>
              )}
            </Card>
          ))}
      </div>
      {rates.filter((r) => !r.active).length > 0 && (
        <div
          style={{
            marginTop: 20,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginBottom: 8,
            }}
          >
            Historical Rates
          </div>
          {rates
            .filter((r) => !r.active)
            .map((r) => (
              <Card
                key={r.id}
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "6px 12px",
                  fontSize: 14,
                  color: "#71717A",
                  marginBottom: 3,
                  opacity: 0.6,
                }}
              >
                {" "}
                <span>{r.county}</span>
                <span
                  style={{
                    fontFamily: MONO,
                  }}
                >
                  {fmtPct(r.combinedRate)}
                </span>{" "}
                <span>
                  {fmtD(r.effectiveDate)} — {fmtD(r.expiryDate)}
                </span>{" "}
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SERVICE TAXABILITY TAB
// ═══════════════════════════════════════════════════════════════
function ServiceTaxabilityTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [services, setServices] = useState([]);
  const read = useTaxRead(
    "/admin/tax/service-taxability",
    setServices,
    "services",
  );
  const [toggling, setToggling] = useState(null);
  const toggleTaxable = async (s) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("toggleTaxable");
    setActionError("");
    try {
      // A stray click must not silently flip the tax base every future
      // invoice of this service is built on — confirm the FL taxability
      // change before writing it.
      const next = s.isTaxable ? "EXEMPT" : "TAXABLE";
      if (
        !window.confirm(
          `Mark "${s.serviceLabel}" as ${next} for FL sales tax? This changes the tax determination used going forward.`,
        )
      ) {
        return;
      }
      setToggling(s.id);
      try {
        await adminFetch(`/admin/tax/service-taxability/${s.id}`, {
          method: "PUT",
          body: JSON.stringify({
            isTaxable: !s.isTaxable,
          }),
        });
        setServices((prev) =>
          prev.map((svc) =>
            svc.id === s.id
              ? {
                  ...svc,
                  isTaxable: !svc.isTaxable,
                }
              : svc,
          ),
        );
      } catch (err) {
        setActionError("Failed to update: " + (err.message || "Unknown error"));
      }
      setToggling(null);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  if (read.loading || read.error)
    return <TaxReadFeedback read={read} label="service taxability" />;
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}{" "}
      <h2
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 4,
        }}
      >
        Service Taxability Matrix
      </h2>{" "}
      <div
        style={{
          fontSize: 14,
          color: "#71717A",
          marginBottom: 14,
        }}
      >
        Click a service to toggle FL sales tax collection
      </div>
      {services.length === 0 && (
        <Card className="p-6 text-zinc-500">
          No service taxability records are available.
        </Card>
      )}
      {services.map((s) => (
        <Button
          key={s.id}
          onClick={() => toggleTaxable(s)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            marginBottom: 4,
            cursor: "pointer",
            opacity: toggling === s.id ? 0.5 : 1,
          }}
          variant="secondary"
          className="!flex flex-wrap !h-auto w-full text-left whitespace-normal"
          type="button"
          disabled={!!pendingAction}
        >
          {" "}
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: s.isTaxable ? "#18181B" : "#71717A",
              flexShrink: 0,
            }}
          />{" "}
          <div
            style={{
              flex: 1,
            }}
          >
            {" "}
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: "#09090B",
              }}
            >
              {s.serviceLabel}
            </span>{" "}
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
                marginLeft: 8,
              }}
            >
              {s.serviceKey}
            </span>{" "}
          </div>{" "}
          <Badge tone="neutral">{s.isTaxable ? "Taxable" : "Exempt"}</Badge>
          {s.taxCategory && <Badge tone="neutral">{s.taxCategory}</Badge>}
          {s.flStatuteRef && (
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              {s.flStatuteRef}
            </span>
          )}
        </Button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EQUIPMENT TAB
// ═══════════════════════════════════════════════════════════════
function EquipmentTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [equipment, setEquipment] = useState([]);
  const read = useTaxRead("/admin/tax/equipment", setEquipment, "equipment");
  const reload = read.retry;
  const [showAdd, setShowAdd] = useState(false);
  const emptyForm = {
    name: "",
    assetCategory: "equipment",
    purchaseDate: "",
    purchaseCost: "",
    depreciationMethod: "section_179",
    usefulLifeYears: "7",
    makeModel: "",
    businessUsePct: "100",
    luxuryAutoExempt: false,
  };
  const [form, setForm] = useState(emptyForm);
  // Confirm a vehicle's business use inline (needed before its depreciation
  // computes — a vehicle is unconfirmed until the % is explicitly set).
  const confirmVehicleUse = async (id, currentPct) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("confirmVehicleUse");
    setActionError("");
    try {
      const input = window.prompt(
        "Business-use % for this vehicle (0–100)? This confirms it so depreciation computes.",
        String(currentPct ?? 100),
      );
      if (input == null) return;
      const pct = Number(input);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        alert("Enter a number between 0 and 100.");
        return;
      }
      // §280F: full MACRS only applies to a HEAVY vehicle (>6,000 lb GVWR) exempt
      // from the passenger-auto caps. Confirm with the CPA before computing.
      const exempt = window.confirm(
        "Is this vehicle EXEMPT from the IRS §280F passenger-auto depreciation limits (heavy vehicle, >6,000 lb GVWR)? OK = exempt (full MACRS); Cancel = not exempt (leave $0 for CPA-capped calc).",
      );
      try {
        await adminFetch(`/admin/tax/equipment/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            businessUsePct: pct,
            luxuryAutoExempt: exempt,
          }),
        });
        reload();
      } catch (e) {
        setActionError("Failed: " + e.message);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const handleAdd = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleAdd");
    setActionError("");
    try {
      if (!form.name || !form.purchaseCost) return;
      try {
        await adminFetch("/admin/tax/equipment", {
          method: "POST",
          body: JSON.stringify({
            ...form,
            purchaseCost: parseFloat(form.purchaseCost),
            usefulLifeYears: parseInt(form.usefulLifeYears),
            // The recovery LIFE is the operator's choice (drives the MACRS class);
            // no longer a hidden 7-year default.
            section179Elected: form.depreciationMethod === "section_179",
            // Send business use + §280F exemption only for vehicles — both are
            // needed to CONFIRM a vehicle so its depreciation computes.
            businessUsePct:
              form.assetCategory === "vehicle"
                ? Number(form.businessUsePct)
                : undefined,
            luxuryAutoExempt:
              form.assetCategory === "vehicle"
                ? form.luxuryAutoExempt
                : undefined,
          }),
        });
        setShowAdd(false);
        setForm(emptyForm);
        const d = await adminFetch("/admin/tax/equipment");
        setEquipment(d.equipment || []);
      } catch (e) {
        setActionError("Failed: " + e.message);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const totalCost = equipment
    .filter((e) => e.active)
    .reduce((s, e) => s + e.purchaseCost, 0);
  const totalBookVal = equipment
    .filter((e) => e.active)
    .reduce((s, e) => s + e.currentBookValue, 0);
  const totalDepr = equipment
    .filter((e) => e.active)
    .reduce((s, e) => s + e.accumulatedDepreciation, 0);
  if (read.loading || read.error)
    return <TaxReadFeedback read={read} label="equipment" />;
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}{" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        {" "}
        <div>
          {" "}
          <h2
            style={{
              fontSize: 18,
              fontWeight: 500,
              color: "#09090B",
            }}
          >
            Equipment & Depreciation Register
          </h2>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
            }}
          >
            Section 179 & MACRS tracking
          </div>{" "}
        </div>{" "}
        <Button
          onClick={() => setShowAdd(!showAdd)}
          type="button"
          variant="primary"
          className="min-w-11"
          disabled={!!pendingAction}
        >
          + Add Equipment
        </Button>{" "}
      </div>
      {/* Summary */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 14,
        }}
      >
        {" "}
        <StatCard label="Total Cost" value={fmtM(totalCost)} />{" "}
        <StatCard
          label="Book Value"
          value={fmtM(totalBookVal)}
          color={"#18181B"}
        />{" "}
        <StatCard
          label="Depreciated"
          value={fmtM(totalDepr)}
          color={"#52525B"}
        />{" "}
      </div>
      {showAdd && (
        <div
          style={{
            background: "#F4F4F5",
            border: "1px solid #18181B44",
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "end",
          }}
        >
          {" "}
          <div>
            <Field label="Name *" className="min-w-0">
              <Input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    name: e.target.value,
                  }))
                }
                style={{
                  width: 180,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="Make/Model" className="min-w-0">
              <Input
                value={form.makeModel}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    makeModel: e.target.value,
                  }))
                }
                style={{
                  width: 150,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            {" "}
            <Field label="Category" className="min-w-0">
              <Select
                value={form.assetCategory}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    assetCategory: e.target.value,
                    // Vehicles are 5-year MACRS property — default the life so a
                    // vehicle isn't silently created on the 7-year table.
                    usefulLifeYears:
                      e.target.value === "vehicle" ? "5" : f.usefulLifeYears,
                  }))
                }
                style={{
                  minWidth: 100,
                }}
                disabled={!!pendingAction}
              >
                {" "}
                <option value="vehicle">Vehicle</option>
                <option value="equipment">Equipment</option>
                <option value="tool">Tool</option>
                <option value="technology">Technology</option>{" "}
              </Select>
            </Field>
          </div>{" "}
          <div>
            <Field label="Purchase Date" className="min-w-0">
              <Input
                type="date"
                value={form.purchaseDate}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    purchaseDate: e.target.value,
                  }))
                }
                style={{
                  width: 130,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="Cost *" className="min-w-0">
              <Input
                type="number"
                step="0.01"
                value={form.purchaseCost}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    purchaseCost: e.target.value,
                  }))
                }
                style={{
                  width: 90,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            {" "}
            <Field label="Method" className="min-w-0">
              <Select
                value={form.depreciationMethod}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    depreciationMethod: e.target.value,
                  }))
                }
                style={{
                  minWidth: 110,
                }}
                disabled={!!pendingAction}
              >
                {" "}
                <option value="section_179">Section 179</option>
                <option value="MACRS">MACRS</option>
                <option value="SL">Straight Line</option>
                <option value="bonus_100">100% Bonus</option>{" "}
              </Select>
            </Field>
          </div>{" "}
          {(form.depreciationMethod === "MACRS" ||
            form.assetCategory === "vehicle") && (
            <div>
              {" "}
              <Field label="Recovery life" className="min-w-0">
                <Select
                  value={form.usefulLifeYears}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      usefulLifeYears: e.target.value,
                    }))
                  }
                  style={{
                    minWidth: 90,
                  }}
                  disabled={!!pendingAction}
                >
                  {" "}
                  <option value="3">3-year</option>
                  <option value="5">5-year</option>
                  <option value="7">7-year</option>{" "}
                </Select>
              </Field>
            </div>
          )}{" "}
          {form.assetCategory === "vehicle" && (
            <div>
              {" "}
              <Field label="Business use %" className="min-w-0">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={form.businessUsePct}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      businessUsePct: e.target.value,
                    }))
                  }
                  style={{
                    width: 90,
                  }}
                  disabled={!!pendingAction}
                />
              </Field>
            </div>
          )}{" "}
          {form.assetCategory === "vehicle" && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 14,
                color: "#71717A",
              }}
              className="ui-choice-label"
            >
              <Checkbox
                type="checkbox"
                checked={form.luxuryAutoExempt}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    luxuryAutoExempt: e.target.checked,
                  }))
                }
                disabled={!!pendingAction}
              />
              §280F-exempt (heavy, &gt;6,000 lb)
            </label>
          )}{" "}
          <Button
            onClick={handleAdd}
            type="button"
            variant="primary"
            className="min-w-11"
            disabled={!!pendingAction}
            loading={pendingAction === "handleAdd"}
          >
            Save
          </Button>{" "}
          <Button
            onClick={() => setShowAdd(false)}
            type="button"
            variant="secondary"
            className="min-w-11"
            disabled={!!pendingAction}
          >
            Cancel
          </Button>{" "}
        </div>
      )}
      {!equipment.some((e) => e.active) && (
        <Card className="p-6 text-zinc-500">
          No equipment recorded. Use Add Equipment to record an asset.
        </Card>
      )}
      {equipment
        .filter((e) => e.active)
        .map((e) => (
          <Card
            key={e.id}
            style={{
              padding: "12px 14px",
              marginBottom: 4,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
                marginBottom: 6,
              }}
            >
              {" "}
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  flex: 1,
                }}
              >
                {e.name}
              </span>{" "}
              <Badge tone="neutral">{e.assetCategory}</Badge>{" "}
              <Badge tone="neutral">{e.depreciationMethod}</Badge>{" "}
              {e.assetCategory === "vehicle" &&
                !(e.businessUseConfirmed && e.luxuryAutoExempt) && (
                  <Button
                    onClick={() => confirmVehicleUse(e.id, e.businessUsePct)}
                    title="Depreciation won't compute until business use and §280F exemption are confirmed"
                    type="button"
                    variant="secondary"
                    className="min-w-11"
                    disabled={!!pendingAction}
                  >
                    Confirm for depreciation
                  </Button>
                )}{" "}
              {e.assetCategory === "vehicle" &&
                e.businessUseConfirmed &&
                e.luxuryAutoExempt && (
                  <span
                    style={{
                      fontSize: 14,
                      color: "#71717A",
                    }}
                  >
                    {e.businessUsePct}% business · §280F-exempt
                  </span>
                )}{" "}
            </div>{" "}
            <div
              style={{
                display: "flex",
                gap: 16,
                fontSize: 14,
                color: "#71717A",
                flexWrap: "wrap",
              }}
            >
              {e.makeModel && <span>{e.makeModel}</span>}
              <span>
                Cost:{" "}
                <span
                  style={{
                    fontFamily: MONO,
                    color: "#27272A",
                  }}
                >
                  {fmtM(e.purchaseCost)}
                </span>
              </span>{" "}
              <span>
                Book:{" "}
                <span
                  style={{
                    fontFamily: MONO,
                    color: "#18181B",
                  }}
                >
                  {fmtM(e.currentBookValue)}
                </span>
              </span>{" "}
              <span>
                Depr:{" "}
                <span
                  style={{
                    fontFamily: MONO,
                    color: "#52525B",
                  }}
                >
                  {fmtM(e.accumulatedDepreciation)}
                </span>
              </span>
              {e.irsClass && <span>IRS: {e.irsClass}</span>}
              <span>Purchased: {fmtD(e.purchaseDate)}</span>{" "}
            </div>{" "}
          </Card>
        ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPENSES TAB
// ═══════════════════════════════════════════════════════════════
function ExpensesTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const readSeq = useRef(0);
  const [readLoading, setReadLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [summary, setSummary] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    categoryId: "",
    description: "",
    amount: "",
    expenseDate: "",
    vendorName: "",
    paymentMethod: "card",
  });
  const [yearFilter, setYearFilter] = useState(
    String(new Date().getFullYear()),
  );
  const [categorizing, setCategorizing] = useState(false);
  const [saving, setSaving] = useState(false);

  // YEAR-wide uncategorized count from the summary (grouped by category, so
  // the null-category bucket is the whole year's backlog) — NOT just the 50
  // rows this page loaded. Scoping the run by year alone lets it drain the
  // entire year's backlog across pages instead of stalling after page 1, while
  // still never touching a different tax year.
  const uncategorizedCount = summary.find((s) => !s.category)?.count || 0;
  const runAutoCategorize = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("runAutoCategorize");
    setActionError("");
    try {
      if (
        !window.confirm(
          `AI-categorize up to 20 of the ${uncategorizedCount} uncategorized ${yearFilter} expenses into Schedule C categories? Each pick is recorded and reviewable — run again to continue through the backlog.`,
        )
      ) {
        return;
      }
      setCategorizing(true);
      try {
        const r = await adminFetch("/admin/tax/expenses/auto-categorize", {
          method: "POST",
          body: JSON.stringify({
            limit: 20,
            year: yearFilter,
          }),
        });
        alert(
          `Categorized ${r.applied} of ${r.processed} — ${r.remaining} uncategorized remaining${r.remaining > 0 ? " (run again to continue)" : ""}`,
        );
        load();
      } catch (e) {
        setActionError(`Auto-categorize failed: ${e.message}`);
      }
      setCategorizing(false);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    setReadLoading(true);
    setReadError("");
    try {
      const [exp, cats] = await Promise.all([
        adminFetch(`/admin/tax/expenses?year=${yearFilter}`),
        adminFetch("/admin/tax/expense-categories"),
      ]);
      if (seq !== readSeq.current) return;
      setExpenses(exp.expenses || []);
      setSummary(exp.summary || []);
      setCategories(cats.categories || []);
    } catch (error) {
      if (seq === readSeq.current) setReadError(error.message);
    } finally {
      if (seq === readSeq.current) setReadLoading(false);
    }
  }, [yearFilter]);
  useEffect(() => {
    load();
  }, [load]);
  const handleAdd = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleAdd");
    setActionError("");
    try {
      if (!form.description || !form.amount || !form.expenseDate) return;
      // Money-recording write — single-flight so a double click records one row.
      if (saving) return;
      setSaving(true);
      try {
        await adminFetch("/admin/tax/expenses", {
          method: "POST",
          body: JSON.stringify({
            ...form,
            amount: parseFloat(form.amount),
          }),
        });
        setShowAdd(false);
        setForm({
          categoryId: "",
          description: "",
          amount: "",
          expenseDate: "",
          vendorName: "",
          paymentMethod: "card",
        });
        load();
      } catch (e) {
        setActionError("Failed: " + e.message);
      } finally {
        setSaving(false);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const totalExpenses = summary.reduce((s, c) => s + c.total, 0);
  const totalDeductible = summary.reduce((s, c) => s + c.deductible, 0);
  if (readLoading || readError)
    return (
      <TaxReadFeedback
        read={{
          loading: readLoading,
          error: readError,
          retry: load,
        }}
        label="expenses"
      />
    );
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}{" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        {" "}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {" "}
          <Field label="Business Expenses" className="min-w-0">
            <Select
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
              style={{
                minWidth: 80,
              }}
              disabled={!!pendingAction}
            >
              {" "}
              {/* Dynamic so the current tax year is always selectable (the
                hardcoded list dead-ended every January). */}
              {Array.from(
                {
                  length: new Date().getFullYear() - 2023,
                },
                (_, i) => String(new Date().getFullYear() - i),
              ).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}{" "}
            </Select>
          </Field>{" "}
        </div>{" "}
        {uncategorizedCount > 0 && (
          <Button
            onClick={runAutoCategorize}
            disabled={!!pendingAction || categorizing}
            type="button"
            variant="secondary"
            loading={categorizing}
            className="min-w-11"
          >
            {`AI-categorize (${uncategorizedCount} uncategorized shown)`}
          </Button>
        )}{" "}
        <Button
          onClick={() => setShowAdd(!showAdd)}
          type="button"
          variant="primary"
          className="min-w-11"
          disabled={!!pendingAction}
        >
          + Add Expense
        </Button>{" "}
      </div>{" "}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 14,
        }}
      >
        {" "}
        <StatCard label="Total Expenses" value={fmtM(totalExpenses)} />{" "}
        <StatCard
          label="Tax Deductible"
          value={fmtM(totalDeductible)}
          color={"#18181B"}
        />{" "}
        <StatCard
          label="Records"
          value={expenses.length}
          color={"#18181B"}
        />{" "}
      </div>
      {showAdd && (
        <div
          style={{
            background: "#F4F4F5",
            border: "1px solid #18181B44",
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "end",
          }}
        >
          {" "}
          <div>
            {" "}
            <Field label="Category" className="min-w-0">
              <Select
                value={form.categoryId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    categoryId: e.target.value,
                  }))
                }
                style={{
                  minWidth: 160,
                }}
                disabled={!!pendingAction}
              >
                {" "}
                <option value="">Select...</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (Line {c.irsLine})
                  </option>
                ))}
              </Select>
            </Field>
          </div>{" "}
          <div>
            <Field label="Description *" className="min-w-0">
              <Input
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    description: e.target.value,
                  }))
                }
                style={{
                  width: 200,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="Amount *" className="min-w-0">
              <Input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    amount: e.target.value,
                  }))
                }
                style={{
                  width: 90,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="Date *" className="min-w-0">
              <Input
                type="date"
                value={form.expenseDate}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    expenseDate: e.target.value,
                  }))
                }
                style={{
                  width: 130,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="Vendor" className="min-w-0">
              <Input
                value={form.vendorName}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    vendorName: e.target.value,
                  }))
                }
                style={{
                  width: 130,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <Button
            onClick={handleAdd}
            disabled={!!pendingAction || saving}
            type="button"
            variant="primary"
            className="min-w-11"
            loading={pendingAction === "handleAdd"}
          >
            {saving ? "Saving…" : "Save"}
          </Button>{" "}
          <Button
            onClick={() => setShowAdd(false)}
            type="button"
            variant="secondary"
            className="min-w-11"
            disabled={!!pendingAction}
          >
            Cancel
          </Button>{" "}
        </div>
      )}
      {/* Category summary */}
      {summary.length > 0 && (
        <div
          style={{
            marginBottom: 16,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginBottom: 8,
            }}
          >
            By Schedule C Category
          </div>
          {summary.map((c, i) => (
            <Card
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 12px",
                marginBottom: 3,
              }}
            >
              {" "}
              <span
                style={{
                  fontSize: 14,
                  color: "#09090B",
                  fontWeight: 500,
                  flex: 1,
                }}
              >
                {c.category || "Uncategorized"}
              </span>{" "}
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 14,
                  color: "#27272A",
                }}
              >
                {fmtM(c.total)}
              </span>{" "}
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 14,
                  color: "#18181B",
                }}
              >
                {fmtM(c.deductible)} deductible
              </span>{" "}
              <span
                style={{
                  fontSize: 14,
                  color: "#71717A",
                }}
              >
                {c.count} items
              </span>{" "}
            </Card>
          ))}
        </div>
      )}
      {/* Expense list */}
      {expenses.map((e) => (
        <Card
          key={e.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            marginBottom: 3,
          }}
        >
          {" "}
          <span
            style={{
              fontSize: 14,
              color: "#71717A",
              minWidth: 70,
            }}
          >
            {fmtD(e.expenseDate)}
          </span>{" "}
          <span
            style={{
              fontSize: 14,
              color: "#09090B",
              flex: 1,
            }}
          >
            {e.description}
          </span>
          {e.categoryName && <Badge tone="neutral">{e.categoryName}</Badge>}
          {e.vendorName && (
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              {e.vendorName}
            </span>
          )}
          <span
            style={{
              fontFamily: MONO,
              fontSize: 14,
              fontWeight: 500,
              color: "#27272A",
            }}
          >
            {fmtM(e.amount)}
          </span>{" "}
        </Card>
      ))}
      {expenses.length === 0 && (
        <div
          style={{
            padding: 30,
            textAlign: "center",
            color: "#71717A",
            fontSize: 14,
          }}
        >
          No expenses recorded for {yearFilter}.
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// FILING CALENDAR TAB
// ═══════════════════════════════════════════════════════════════
function FilingCalendarTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [filings, setFilings] = useState([]);
  const read = useTaxRead("/admin/tax/filings", setFilings, "filings");
  const load = read.retry;
  const handleStatusChange = async (id, status) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleStatusChange");
    setActionError("");
    try {
      try {
        const update = {
          status,
        };
        if (status === "filed") update.filedDate = etDateString();
        if (status === "paid") {
          update.paidDate = etDateString();
          // The quarterly estimate credits SUM(amount_paid) for filed/paid
          // 1040-ES rows — without the amount the credit reads $0 and the
          // operator can be told to re-pay an installment. Prefill with the
          // row's amount due when it has one.
          const row = filings.find((f) => f.id === id);
          // Cancel ABORTS and a paid filing REQUIRES a persisted amount
          // (codex r4 P1): an amount-less "paid" row credits $0 to later
          // estimates, which can then instruct re-paying the installment.
          const entered = window.prompt(
            "Amount paid (required — credits future estimates):",
            row?.amountDue != null ? String(row.amountDue) : "",
          );
          if (entered === null) return; // operator cancelled — no status change
          const amt = Number(entered);
          if (entered.trim() === "" || !Number.isFinite(amt) || amt < 0) {
            return alert(
              "Enter a valid non-negative amount — a filing cannot be marked paid without one.",
            );
          }
          update.amountPaid = amt;
        }
        await adminFetch(`/admin/tax/filings/${id}`, {
          method: "PUT",
          body: JSON.stringify(update),
        });
        load();
      } catch (e) {
        setActionError("Failed: " + e.message);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const upcoming = filings.filter(
    (f) => f.status === "upcoming" || f.status === "prepared",
  );
  const completed = filings.filter(
    (f) => f.status === "filed" || f.status === "paid",
  );
  if (read.loading || read.error)
    return <TaxReadFeedback read={read} label="filings" />;
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}{" "}
      <h2
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 14,
        }}
      >
        Tax Filing Calendar
      </h2>
      {/* Upcoming */}
      <div
        style={{
          fontSize: 14,
          color: "#71717A",
          marginBottom: 8,
        }}
      >
        Upcoming Deadlines
      </div>
      {upcoming.length === 0 && (
        <div
          style={{
            padding: 20,
            textAlign: "center",
            color: "#71717A",
            fontSize: 14,
            marginBottom: 16,
          }}
        >
          All caught up!
        </div>
      )}
      {upcoming.map((f) => {
        const du = daysUntil(f.dueDate);
        const urgentColor =
          du <= 7 ? "#C8312F" : du <= 30 ? "#52525B" : "#71717A";
        return (
          <Card
            key={f.id}
            style={{
              padding: "12px 14px",
              marginBottom: 6,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
                marginBottom: 6,
              }}
            >
              {" "}
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  flex: 1,
                }}
              >
                {f.title}
              </span>{" "}
              <Badge
                tone={
                  STATUS_COLORS[f.status] === "#C8312F" ? "alert" : "neutral"
                }
              >
                {f.status}
              </Badge>{" "}
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 14,
                  fontWeight: 500,
                  color: urgentColor,
                }}
              >
                {du > 0
                  ? `${du}d`
                  : du === 0
                    ? "TODAY"
                    : `${Math.abs(du)}d OVERDUE`}
              </span>{" "}
            </div>{" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 14,
                color: "#71717A",
              }}
            >
              {" "}
              <span>Due: {fmtD(f.dueDate)}</span>
              {f.extendedDueDate && (
                <span>Extended: {fmtD(f.extendedDueDate)}</span>
              )}
              {f.amountDue && (
                <span>
                  Amount:{" "}
                  <span
                    style={{
                      fontFamily: MONO,
                      color: "#27272A",
                    }}
                  >
                    {fmtM(f.amountDue)}
                  </span>
                </span>
              )}{" "}
              <Field label="Filing status" className="min-w-0">
                <Select
                  value={f.status}
                  onChange={(e) => handleStatusChange(f.id, e.target.value)}
                  style={{
                    minWidth: 100,
                  }}
                  disabled={!!pendingAction}
                >
                  {FILING_STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </Select>
              </Field>{" "}
            </div>{" "}
          </Card>
        );
      })}
      {/* Completed */}
      {completed.length > 0 && (
        <div
          style={{
            marginTop: 20,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              marginBottom: 8,
            }}
          >
            Completed ({completed.length})
          </div>
          {completed.map((f) => (
            <Card
              key={f.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                marginBottom: 3,
                opacity: 0.7,
              }}
            >
              {" "}
              <Badge tone="neutral">{f.status}</Badge>{" "}
              <span
                style={{
                  fontSize: 14,
                  color: "#27272A",
                  flex: 1,
                }}
              >
                {f.title}
              </span>{" "}
              <span
                style={{
                  fontSize: 14,
                  color: "#71717A",
                }}
              >
                Due: {fmtD(f.dueDate)}
              </span>
              {f.filedDate && (
                <span
                  style={{
                    fontSize: 14,
                    color: "#18181B",
                  }}
                >
                  Filed: {fmtD(f.filedDate)}
                </span>
              )}
              {f.amountPaid && (
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 14,
                    color: "#18181B",
                  }}
                >
                  {fmtM(f.amountPaid)}
                </span>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// AI ADVISOR TAB
// ═══════════════════════════════════════════════════════════════
function AdvisorTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [reports, setReports] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [alertCounts, setAlertCounts] = useState({});
  const [selectedReport, setSelectedReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [alertFilter, setAlertFilter] = useState("new");
  const reportsRead = useTaxRead(
    "/admin/tax/advisor/reports",
    setReports,
    "reports",
  );
  const applyAlerts = useCallback((data) => {
    setAlerts(data.alerts || []);
    setAlertCounts(data.counts || {});
  }, []);
  const alertsRead = useTaxRead(
    `/admin/tax/advisor/alerts?status=${alertFilter}`,
    applyAlerts,
  );
  useEffect(() => {
    setSelectedReport((prev) => prev || reports[0] || null);
  }, [reports]);
  const handleRunAdvisor = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleRunAdvisor");
    setActionError("");
    try {
      setRunning(true);
      try {
        await adminFetch("/admin/tax/advisor/run", {
          method: "POST",
        });
        const rpt = await adminFetch("/admin/tax/advisor/reports");
        setReports(rpt.reports || []);
        if (rpt.reports?.length) setSelectedReport(rpt.reports[0]);
        const alt = await adminFetch("/admin/tax/advisor/alerts?status=new");
        setAlerts(alt.alerts || []);
        setAlertCounts(alt.counts || {});
      } catch (e) {
        setActionError("Failed: " + e.message);
      }
      setRunning(false);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const handleAlertAction = async (id, status) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleAlertAction");
    setActionError("");
    try {
      try {
        await adminFetch(`/admin/tax/advisor/alerts/${id}`, {
          method: "PUT",
          body: JSON.stringify({
            status,
          }),
        });
        const alt = await adminFetch(
          `/admin/tax/advisor/alerts?status=${alertFilter}`,
        );
        setAlerts(alt.alerts || []);
        setAlertCounts(alt.counts || {});
      } catch (error) {
        setActionError(error.message);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const r = selectedReport;
  const gradeColor =
    {
      A: "#18181B",
      B: "#18181B",
      C: "#52525B",
      D: "#18181B",
      F: "#C8312F",
    }[r?.grade] || "#71717A";
  return (
    <div>
      {(reportsRead.loading || reportsRead.error) && (
        <TaxReadFeedback read={reportsRead} label="advisor reports" />
      )}
      {(alertsRead.loading || alertsRead.error) && (
        <TaxReadFeedback read={alertsRead} label="advisor alerts" />
      )}
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}{" "}
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
          {" "}
          <h2
            style={{
              fontSize: 18,
              fontWeight: 500,
              color: "#09090B",
            }}
          >
            AI Tax Advisor
          </h2>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
            }}
          >
            Weekly analysis of tax situation, regulations & savings
          </div>{" "}
        </div>{" "}
        <Button
          onClick={handleRunAdvisor}
          disabled={!!pendingAction || running}
          type="button"
          variant="secondary"
          className="min-w-11"
          loading={pendingAction === "handleRunAdvisor"}
        >
          {"Run Advisor Now"}
        </Button>{" "}
      </div>
      {/* Alerts */}
      {(alertCounts.new || 0) > 0 && (
        <div
          style={{
            marginBottom: 20,
          }}
        >
          {" "}
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: "#09090B",
              }}
            >
              Action Items
            </div>
            {["new", "reviewed", "acted_on", "dismissed"].map((s) => (
              <Button
                key={s}
                onClick={() => {
                  setAlertFilter(s);
                }}
                type="button"
                variant={alertFilter === s ? "primary" : "secondary"}
                aria-pressed={alertFilter === s}
                className="min-w-11"
                disabled={!!pendingAction}
              >
                {s.replace("_", " ")}{" "}
                {alertCounts[s] ? `(${alertCounts[s]})` : ""}
              </Button>
            ))}
          </div>
          {alerts.map((a) => (
            <Card
              key={a.id}
              style={{
                padding: "10px 14px",
                marginBottom: 4,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                {" "}
                <Badge
                  tone={
                    PRIORITY_COLORS[a.priority] === "#C8312F"
                      ? "alert"
                      : "neutral"
                  }
                >
                  {a.priority}
                </Badge>{" "}
                <Badge tone="neutral">{a.type}</Badge>{" "}
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "#09090B",
                    flex: 1,
                  }}
                >
                  {a.title}
                </span>
                {a.estimatedSavings && (
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 14,
                      fontWeight: 500,
                      color: "#18181B",
                    }}
                  >
                    ~{fmtM(a.estimatedSavings)}/yr
                  </span>
                )}
              </div>
              {a.description && (
                <div
                  style={{
                    fontSize: 14,
                    color: "#71717A",
                    marginBottom: 6,
                  }}
                >
                  {a.description}
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  gap: 4,
                }}
              >
                {a.status === "new" && (
                  <Button
                    onClick={() => handleAlertAction(a.id, "reviewed")}
                    type="button"
                    variant="primary"
                    className="min-w-11"
                    disabled={!!pendingAction}
                  >
                    Mark Reviewed
                  </Button>
                )}
                {(a.status === "new" || a.status === "reviewed") && (
                  <Button
                    onClick={() => handleAlertAction(a.id, "acted_on")}
                    type="button"
                    variant="primary"
                    className="min-w-11"
                    disabled={!!pendingAction}
                  >
                    Done
                  </Button>
                )}
                {a.status !== "dismissed" && (
                  <Button
                    onClick={() => handleAlertAction(a.id, "dismissed")}
                    type="button"
                    variant="secondary"
                    className="min-w-11"
                    disabled={!!pendingAction}
                  >
                    Dismiss
                  </Button>
                )}
              </div>{" "}
            </Card>
          ))}
        </div>
      )}
      {/* Report selector */}
      {reports.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          {reports.slice(0, 8).map((rp) => (
            <Button
              key={rp.id}
              onClick={() => setSelectedReport(rp)}
              type="button"
              variant={selectedReport?.id === rp.id ? "primary" : "secondary"}
              aria-pressed={selectedReport?.id === rp.id}
              className="min-w-11"
              disabled={!!pendingAction}
            >
              {rp.period || fmtD(rp.date)}{" "}
              <span
                style={{
                  fontWeight: 500,
                  color:
                    {
                      A: "#18181B",
                      B: "#18181B",
                      C: "#52525B",
                    }[rp.grade] || "#71717A",
                }}
              >
                {rp.grade}
              </span>{" "}
            </Button>
          ))}
        </div>
      )}
      {/* Selected report */}
      {r ? (
        <div>
          {" "}
          <Card
            style={{
              padding: "16px 20px",
              marginBottom: 12,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 10,
              }}
            >
              {" "}
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 32,
                  fontWeight: 500,
                  color: gradeColor,
                }}
              >
                {r.grade}
              </span>{" "}
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "#09090B",
                  }}
                >
                  {r.period}
                </div>{" "}
                <div
                  style={{
                    fontSize: 14,
                    color: "#71717A",
                  }}
                >
                  {r.date}
                </div>{" "}
              </div>{" "}
            </div>{" "}
            <div
              style={{
                fontSize: 14,
                color: "#27272A",
                lineHeight: 1.6,
              }}
            >
              {r.summary}
            </div>{" "}
          </Card>
          {/* Regulation changes */}
          {r.regulationChanges?.length > 0 && (
            <div
              style={{
                marginBottom: 14,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  marginBottom: 8,
                }}
              >
                Regulation Changes Found
              </div>
              {r.regulationChanges.map((rc, i) => (
                <Card
                  key={i}
                  style={{
                    padding: "10px 14px",
                    marginBottom: 4,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: "#09090B",
                      marginBottom: 4,
                    }}
                  >
                    {rc.change}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 14,
                      color: "#71717A",
                    }}
                  >
                    {rc.impact}
                  </div>
                  {rc.action_required && (
                    <div
                      style={{
                        fontSize: 14,
                        color: "#52525B",
                        marginTop: 4,
                      }}
                    >
                      Action: {rc.action_required}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 14,
                      color: "#71717A",
                      marginTop: 4,
                    }}
                  >
                    {rc.source}{" "}
                    {rc.effective_date && `· Effective ${rc.effective_date}`}
                  </div>{" "}
                </Card>
              ))}
            </div>
          )}
          {/* Savings opportunities */}
          {r.savingsOpportunities?.length > 0 && (
            <div
              style={{
                marginBottom: 14,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  marginBottom: 8,
                }}
              >
                Savings Opportunities
              </div>
              {r.savingsOpportunities.map((s, i) => (
                <Card
                  key={i}
                  style={{
                    padding: "10px 14px",
                    marginBottom: 4,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    {" "}
                    <Badge
                      tone={
                        PRIORITY_COLORS[s.priority] === "#C8312F"
                          ? "alert"
                          : "neutral"
                      }
                    >
                      {s.priority}
                    </Badge>{" "}
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#09090B",
                        flex: 1,
                      }}
                    >
                      {s.title}
                    </span>
                    {s.estimated_annual_savings && (
                      <span
                        style={{
                          fontFamily: MONO,
                          fontSize: 14,
                          fontWeight: 500,
                          color: "#18181B",
                        }}
                      >
                        ~{fmtM(s.estimated_annual_savings)}/yr
                      </span>
                    )}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 14,
                      color: "#71717A",
                      marginTop: 4,
                    }}
                  >
                    {s.action}
                  </div>{" "}
                </Card>
              ))}
            </div>
          )}
          {/* Deduction gaps */}
          {r.deductionGaps?.length > 0 && (
            <div
              style={{
                marginBottom: 14,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  marginBottom: 8,
                }}
              >
                Deduction Gaps
              </div>
              {r.deductionGaps.map((d, i) => (
                <Card
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    marginBottom: 3,
                  }}
                >
                  {" "}
                  <span
                    style={{
                      fontSize: 14,
                      color: "#09090B",
                      flex: 1,
                    }}
                  >
                    {d.deduction}
                  </span>
                  {d.estimated_value && (
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 14,
                        color: "#18181B",
                      }}
                    >
                      {fmtM(d.estimated_value)}
                    </span>
                  )}
                  {d.irs_reference && (
                    <span
                      style={{
                        fontSize: 14,
                        color: "#71717A",
                      }}
                    >
                      {d.irs_reference}
                    </span>
                  )}
                </Card>
              ))}
            </div>
          )}
          {/* Compliance alerts */}
          {r.complianceAlerts?.length > 0 && (
            <div>
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  marginBottom: 8,
                }}
              >
                Compliance Alerts
              </div>
              {r.complianceAlerts.map((a, i) => (
                <Card
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    marginBottom: 3,
                  }}
                >
                  {" "}
                  <Badge
                    tone={
                      PRIORITY_COLORS[a.severity] === "#C8312F"
                        ? "alert"
                        : "neutral"
                    }
                  >
                    {a.severity}
                  </Badge>{" "}
                  <span
                    style={{
                      fontSize: 14,
                      color: "#09090B",
                      flex: 1,
                    }}
                  >
                    {a.alert}
                  </span>
                  {a.deadline && (
                    <span
                      style={{
                        fontSize: 14,
                        color: "#52525B",
                      }}
                    >
                      By: {a.deadline}
                    </span>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            padding: 40,
            textAlign: "center",
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 48,
              marginBottom: 12,
            }}
          >
            AI
          </div>{" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 500,
              color: "#09090B",
              marginBottom: 6,
            }}
          >
            No Advisor Reports Yet
          </div>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
              maxWidth: 400,
              margin: "0 auto",
            }}
          >
            Click "Run Advisor Now" to generate your first weekly tax analysis.
            The advisor will search for current regulations, analyze your
            financials, and identify savings opportunities.
          </div>{" "}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXEMPTIONS TAB
// ═══════════════════════════════════════════════════════════════
function ExemptionsTab() {
  const [exemptions, setExemptions] = useState([]);
  const read = useTaxRead("/admin/tax/exemptions", setExemptions, "exemptions");
  if (read.loading || read.error)
    return <TaxReadFeedback read={read} label="exemptions" />;
  return (
    <div>
      {" "}
      <h2
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 4,
        }}
      >
        Tax Exemption Certificates
      </h2>{" "}
      <div
        style={{
          fontSize: 14,
          color: "#71717A",
          marginBottom: 14,
        }}
      >
        DR-14 exemption certificates for tax-exempt customers
      </div>
      {exemptions.length === 0 ? (
        <div
          style={{
            padding: 30,
            textAlign: "center",
            color: "#71717A",
            fontSize: 14,
          }}
        >
          No exemption certificates on file. Add one when a customer provides a
          DR-14.
        </div>
      ) : (
        exemptions.map((e) => (
          <Card
            key={e.id}
            style={{
              padding: "10px 14px",
              marginBottom: 4,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {" "}
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  flex: 1,
                }}
              >
                {e.customerName}
              </span>{" "}
              <Badge tone="neutral">
                {e.verified ? "Verified" : "Unverified"}
              </Badge>{" "}
              <Badge tone="neutral">{e.exemptionType}</Badge>{" "}
            </div>{" "}
            <div
              style={{
                display: "flex",
                gap: 12,
                fontSize: 14,
                color: "#71717A",
                marginTop: 4,
              }}
            >
              {" "}
              <span>Cert: {e.certificateNumber || "—"}</span>{" "}
              <span>Expires: {fmtD(e.expiryDate)}</span>{" "}
            </div>{" "}
          </Card>
        ))
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// MILEAGE TAB
// ═══════════════════════════════════════════════════════════════
function MileageTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const isMobile = useIsMobile(640);
  const readSeq = useRef(0);
  const [listError, setListError] = useState("");
  const [entries, setEntries] = useState([]);
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // Classification review: the geofence classifier is retired, so synced
  // trips sit 'unclassified' at $0 deduction until reviewed here.
  const [purposeFilter, setPurposeFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  const [classifying, setClassifying] = useState(false);
  const [form, setForm] = useState({
    trip_date: etDateString(),
    start_address: "",
    end_address: "",
    distance_miles: "",
    purpose: "business",
    notes: "",
  });
  const load = (filter = purposeFilter) => {
    const seq = ++readSeq.current;
    setLoading(true);
    setListError("");
    const listUrl =
      filter === "all"
        ? "/admin/tax/mileage?limit=200"
        : `/admin/tax/mileage?limit=200&purpose=${filter}`;
    Promise.all([
      adminFetch(listUrl).catch((err) => {
        return {
          entries: [],
          error: err.message,
        };
      }),
      adminFetch("/admin/tax/mileage/stats").catch((err) => {
        return {
          error: err?.message || "Failed to load",
        };
      }),
    ]).then(([m, s]) => {
      if (seq !== readSeq.current) return;
      setListError(m?.error || "");
      setEntries((m && (m.entries || m)) || []);
      // A stats failure renders as unknown, never as a confident $0 YTD
      // deduction at a made-up rate.
      if (s && s.error) {
        setStats(null);
        setStatsError(s.error);
      } else {
        setStats(s);
        setStatsError(null);
      }
      setSelected(new Set());
      setLoading(false);
    });
  };
  useEffect(() => load(purposeFilter), [purposeFilter]);
  const bulkClassify = async (purpose) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("bulkClassify");
    setActionError("");
    try {
      const ids = [...selected];
      if (!ids.length) return;
      if (
        !window.confirm(
          `Mark ${ids.length} trip${ids.length === 1 ? "" : "s"} as ${purpose.toUpperCase()}?${purpose === "business" ? " Their deduction recomputes at that year's IRS rate." : " Their deduction becomes $0."}`,
        )
      ) {
        return;
      }
      setClassifying(true);
      try {
        const r = await adminFetch("/admin/tax/mileage/bulk-classify", {
          method: "POST",
          body: JSON.stringify({
            ids,
            purpose,
          }),
        });
        let msg = `${r.updated} trip${r.updated === 1 ? "" : "s"} marked ${purpose}${purpose === "business" ? ` — ${fmtM(r.deductionTotal)} in deductions` : ""}`;
        // Surface the honest edges the server reports, rather than a bare success.
        if (r.skippedNoRate) {
          msg += `\n\n⚠ ${r.skippedNoRate} trip${r.skippedNoRate === 1 ? "" : "s"} left UNCLASSIFIED — no verified IRS rate for their date yet. Add the published rate, then reclassify.`;
        }
        if (r.summaryRecomputeFailures) {
          msg += `\n\n⚠ Mileage summaries for ${r.summaryRecomputeFailures} day/month bucket${r.summaryRecomputeFailures === 1 ? "" : "s"} could not be recomputed — dashboards may be briefly stale (the classification itself is saved). Re-run Sync to repair.`;
        }
        alert(msg);
        load();
      } catch (e) {
        setActionError(`Classification failed: ${e.message}`);
      }
      setClassifying(false);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const handleSync = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleSync");
    setActionError("");
    try {
      setSyncing(true);
      try {
        const r = await adminFetch("/admin/tax/mileage/sync-bouncie", {
          method: "POST",
        });
        alert(
          `Bouncie sync: ${r.tripsImported || 0} trips imported, ${r.totalMiles?.toFixed(1) || 0} miles, ${fmtM(r.deductionAmount)} deduction`,
        );
        load();
      } catch (e) {
        setActionError(`Sync failed: ${e.message}`);
      }
      setSyncing(false);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const handleAdd = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("handleAdd");
    setActionError("");
    try {
      if (!form.distance_miles) return;
      try {
        await adminFetch("/admin/tax/mileage", {
          method: "POST",
          body: JSON.stringify(form),
        });
        setForm((f) => ({
          ...f,
          start_address: "",
          end_address: "",
          distance_miles: "",
          notes: "",
        }));
        load();
      } catch (e) {
        setActionError(`Failed: ${e.message}`);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  if (loading)
    return (
      <div
        style={{
          color: "#71717A",
          padding: 40,
          textAlign: "center",
        }}
      >
        Loading mileage...
      </div>
    );
  return (
    <div>
      {listError && (
        <ActionFeedback error onRetry={() => load()}>
          Could not load mileage entries: {listError}
        </ActionFeedback>
      )}
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}
      {/* Stats */}
      {statsError && (
        <div
          style={{
            background: "#C8312F11",
            border: "1px solid #C8312F",
            borderRadius: 8,
            padding: "12px 16px",
            marginBottom: 16,
            color: "#C8312F",
            fontSize: 14,
          }}
        >
          Couldn't load mileage totals ({statsError}) — YTD figures are unknown,
          not zero.
        </div>
      )}
      {stats && (
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          {" "}
          <StatCard
            label="YTD Miles Logged"
            value={`${(stats.totalMiles || 0).toLocaleString()} mi`}
            color={"#18181B"}
          />{" "}
          <StatCard
            label="YTD Deduction"
            value={fmtM(stats.totalDeduction)}
            color={"#18181B"}
            sub={stats.irsRate != null ? `@ $${stats.irsRate}/mile` : undefined}
          />{" "}
          <StatCard
            label="Total Trips"
            value={stats.totalTrips || 0}
            color={"#18181B"}
          />{" "}
          <StatCard
            label="Avg Trip"
            value={`${(stats.avgDistance || 0).toFixed(1)} mi`}
            color={"#71717A"}
          />{" "}
        </div>
      )}
      {/* Classification review bar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Field label="Show:" className="min-w-0">
          <Select
            value={purposeFilter}
            onChange={(e) => setPurposeFilter(e.target.value)}
            disabled={!!pendingAction}
          >
            <option value="all">All trips</option>
            <option value="unclassified">Unclassified</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
          </Select>
        </Field>
        {selected.size > 0 && (
          <>
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              {selected.size} selected
            </span>
            <Button
              onClick={() => bulkClassify("business")}
              disabled={!!pendingAction || classifying}
              type="button"
              variant="primary"
              className="min-w-11"
            >
              Mark business
            </Button>
            <Button
              onClick={() => bulkClassify("personal")}
              disabled={!!pendingAction || classifying}
              type="button"
              variant="secondary"
              className="min-w-11"
            >
              Mark personal
            </Button>
          </>
        )}
      </div>

      {/* Sync + Add */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 16,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        {" "}
        <Button
          onClick={handleSync}
          disabled={!!pendingAction || syncing}
          type="button"
          variant="primary"
          className="min-w-11"
          loading={pendingAction === "handleSync"}
        >
          {" Sync from Bouncie"}
        </Button>{" "}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "flex-end",
          }}
        >
          {" "}
          <div>
            <Field label="Date" className="min-w-0">
              <Input
                type="date"
                value={form.trip_date}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    trip_date: e.target.value,
                  }))
                }
                style={{
                  width: 130,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="From" className="min-w-0">
              <Input
                value={form.start_address}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    start_address: e.target.value,
                  }))
                }
                placeholder="Start"
                style={{
                  width: 140,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="To" className="min-w-0">
              <Input
                value={form.end_address}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    end_address: e.target.value,
                  }))
                }
                placeholder="End"
                style={{
                  width: 140,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <div>
            <Field label="Miles" className="min-w-0">
              <Input
                type="number"
                value={form.distance_miles}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    distance_miles: e.target.value,
                  }))
                }
                placeholder="0.0"
                step="0.1"
                style={{
                  width: 70,
                }}
                disabled={!!pendingAction}
              />
            </Field>
          </div>{" "}
          <Field label="Trip purpose" className="min-w-0">
            <Select
              value={form.purpose}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  purpose: e.target.value,
                }))
              }
              disabled={!!pendingAction}
            >
              <option value="business">Business</option>
              <option value="personal">Personal</option>
              <option value="commute">Commute</option>
            </Select>
          </Field>{" "}
          <Button
            onClick={handleAdd}
            type="button"
            variant="primary"
            className="min-w-11"
            disabled={!!pendingAction}
            loading={pendingAction === "handleAdd"}
          >
            + Add
          </Button>{" "}
        </div>{" "}
      </div>
      {/* Entries */}
      {entries.length === 0 ? (
        <Card
          style={{
            padding: 40,
            textAlign: "center",
            color: "#71717A",
          }}
        >
          No mileage entries yet. Sync from Bouncie or add manually.
        </Card>
      ) : (
        <Card
          style={{
            overflow: "hidden",
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {" "}
          <Table
            style={{
              minWidth: isMobile ? 600 : undefined,
            }}
          >
            <THead>
              <TR>
                <TH>
                  <label className="ui-choice-label justify-center">
                    <Checkbox
                      type="checkbox"
                      checked={
                        entries.length > 0 && selected.size === entries.length
                      }
                      onChange={(ev) =>
                        setSelected(
                          ev.target.checked
                            ? new Set(entries.map((e) => e.id))
                            : new Set(),
                        )
                      }
                      aria-label="Select all listed trips"
                      disabled={!!pendingAction}
                    />
                  </label>
                </TH>
                {[
                  "Date",
                  "From",
                  "To",
                  "Miles",
                  "Purpose",
                  "Deduction",
                  "Source",
                ].map((h) => (
                  <TH
                    key={h}
                    style={{
                      color: "#71717A",
                      textAlign: "left",
                    }}
                  >
                    {h}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {/* API fields are camelCase (tripDate/distanceMiles/…) — the old
                  snake_case reads rendered every cell as a dash. */}
              {entries.map((e, i) => (
                <TR
                  key={e.id || i}
                  style={{
                    borderBottom: "1px solid #E4E4E722",
                  }}
                >
                  <TD>
                    <label className="ui-choice-label justify-center">
                      <Checkbox
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={(ev) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (ev.target.checked) next.add(e.id);
                            else next.delete(e.id);
                            return next;
                          })
                        }
                        aria-label="Select trip"
                        disabled={!!pendingAction}
                      />
                    </label>
                  </TD>
                  <TD>{fmtD(e.tripDate || e.trip_date)}</TD>
                  <TD
                    style={{
                      color: "#71717A",
                      maxWidth: 150,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {e.startAddress || e.start_address || "—"}
                  </TD>
                  <TD
                    style={{
                      color: "#71717A",
                      maxWidth: 150,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {e.endAddress || e.end_address || "—"}
                  </TD>
                  <TD
                    style={{
                      color: "#09090B",
                    }}
                  >
                    {parseFloat(
                      e.distanceMiles ?? e.distance_miles ?? 0,
                    ).toFixed(1)}
                  </TD>
                  <TD>
                    <Badge tone="neutral">{e.purpose}</Badge>
                  </TD>
                  <TD
                    style={{
                      color: "#18181B",
                    }}
                  >
                    {fmtM(e.deductionAmount ?? e.deduction_amount)}
                  </TD>
                  <TD>
                    <Badge tone="neutral">{e.source || "manual"}</Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>{" "}
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// REVENUE TAB (Sales Tax Reconciliation)
// ═══════════════════════════════════════════════════════════════
function RevenueTab() {
  const readSeq = useRef(0);
  const isMobile = useIsMobile(640);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [reconcile, setReconcile] = useState(null);
  const [quarterly, setQuarterly] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = () => {
    const seq = ++readSeq.current;
    setLoading(true);
    // Quarter AND year follow the SELECTED month, not browser-local
    // "today" — the old derivation left the quarterly card frozen on the
    // current quarter (and the server on the current year), stacking two
    // different periods as if related.
    const [selYear, selMonthStr] = String(month).split("-");
    const selMonth = parseInt(selMonthStr, 10) || 1;
    const q = `Q${Math.ceil(selMonth / 3)}`;
    Promise.all([
      adminFetch(`/admin/tax/revenue/reconcile?month=${month}`).catch(
        () => null,
      ),
      adminFetch(
        `/admin/tax/revenue/quarterly-estimate?quarter=${q}&year=${selYear}`,
      ).catch(() => null),
    ]).then(([r, qe]) => {
      if (seq !== readSeq.current) return;
      setReconcile(r);
      setQuarterly(qe);
      setLoading(false);
    });
  };
  useEffect(load, [month]);
  if (loading)
    return (
      <div
        style={{
          color: "#71717A",
          padding: 40,
          textAlign: "center",
        }}
      >
        Loading revenue data...
      </div>
    );
  return (
    <div>
      {!reconcile && (
        <ActionFeedback error onRetry={load}>
          Could not load revenue reconciliation.
        </ActionFeedback>
      )}
      {!quarterly && (
        <ActionFeedback error onRetry={load}>
          Could not load the quarterly estimate.
        </ActionFeedback>
      )}
      {/* Month selector */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        {" "}
        <Field label="Month:" className="min-w-0">
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{
              width: 160,
            }}
          />
        </Field>{" "}
      </div>
      {/* Reconciliation */}
      {reconcile && (
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          {" "}
          <StatCard
            label="Revenue"
            value={fmtM(reconcile.totalRevenue)}
            color={"#18181B"}
          />{" "}
          <StatCard
            label="Tax Collected"
            value={fmtM(reconcile.taxCollected)}
            color={"#52525B"}
          />{" "}
          <StatCard
            label="Tax Owed"
            value={fmtM(reconcile.taxOwed)}
            color={"#18181B"}
          />{" "}
          {/* Only render a verdict when BOTH figures exist — with either null
              (tax collection isn't recorded in the portal) the old math
              treated null as $0 and confidently declared "Over-collected". */}
          <StatCard
            label="Difference"
            value={
              reconcile.taxCollected != null && reconcile.taxOwed != null
                ? fmtM(reconcile.taxCollected - reconcile.taxOwed)
                : "—"
            }
            color={
              reconcile.taxCollected != null && reconcile.taxOwed != null
                ? reconcile.taxCollected >= reconcile.taxOwed
                  ? "#18181B"
                  : "#C8312F"
                : "#71717A"
            }
            sub={
              reconcile.taxCollected != null && reconcile.taxOwed != null
                ? reconcile.taxCollected >= reconcile.taxOwed
                  ? "Over-collected"
                  : "Under-collected"
                : "Not recorded"
            }
          />{" "}
        </div>
      )}
      {reconcile?.note && (
        <div
          style={{
            fontSize: 14,
            color: "#71717A",
            marginTop: -6,
            marginBottom: 16,
          }}
        >
          {reconcile.note}
        </div>
      )}

      {/* Quarterly Estimate */}
      {quarterly && (
        <Card
          style={{
            padding: 20,
            marginBottom: 16,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: "#09090B",
              marginBottom: 12,
            }}
          >
            Quarterly Estimated Tax Payment — {quarterly.quarter}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: 8,
              fontSize: 14,
            }}
          >
            {[
              ["YTD Revenue (excl. sales tax)", fmtM(quarterly.ytdRevenue)],
              ["YTD Deductible Expenses", fmtM(quarterly.ytdExpenses)],
              ["YTD Net Income", fmtM(quarterly.estimatedNetIncome)],
              ["Annualized Net Income", fmtM(quarterly.annualizedNet)],
              ["Self-Employment Tax (15.3%, annual)", fmtM(quarterly.seTax)],
              ["Estimated Income Tax (22%, annual)", fmtM(quarterly.incomeTax)],
              [
                "Required Cumulative Through Quarter",
                fmtM(quarterly.requiredCumulative),
              ],
              [
                "Prior 1040-ES Payments Credited",
                fmtM(quarterly.priorPaymentsCredited),
              ],
              ["Total Quarterly Payment", fmtM(quarterly.quarterlyPayment)],
            ].map(([l, v]) => (
              <div
                key={l}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "4px 0",
                  borderBottom: "1px solid #E4E4E722",
                }}
              >
                {" "}
                <span
                  style={{
                    color: "#71717A",
                  }}
                >
                  {l}
                </span>{" "}
                <span
                  style={{
                    color: "#09090B",
                    fontFamily: MONO,
                  }}
                >
                  {v}
                </span>{" "}
              </div>
            ))}
          </div>
          {quarterly.dueDate && (
            <div
              style={{
                marginTop: 12,
                fontSize: 14,
                color: "#52525B",
              }}
            >
              Due: {fmtD(quarterly.dueDate)}
            </div>
          )}
          {quarterly.note && (
            <div
              style={{
                marginTop: 8,
                fontSize: 14,
                color: "#71717A",
              }}
            >
              {quarterly.note}
            </div>
          )}
        </Card>
      )}

      {!reconcile && !quarterly && (
        <Card
          style={{
            padding: 40,
            textAlign: "center",
            color: "#71717A",
          }}
        >
          No revenue data available for this period.
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// P&L TAB
// ═══════════════════════════════════════════════════════════════
function PnlTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const readSeq = useRef(0);
  const [readError, setReadError] = useState("");
  const [pnl, setPnl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("mtd");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [savingMethod, setSavingMethod] = useState(false);
  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    setReadError("");
    setLoading(true);
    try {
      let url = `/admin/tax/pnl?period=${period}`;
      if (period === "custom" && customStart && customEnd)
        url += `&start_date=${customStart}&end_date=${customEnd}`;
      const data = await adminFetch(url);
      if (seq !== readSeq.current) return;
      setPnl(data);
    } catch (error) {
      if (seq === readSeq.current) {
        setPnl(null);
        setReadError(error.message);
      }
    }
    if (seq === readSeq.current) setLoading(false);
  }, [period, customStart, customEnd]);
  useEffect(() => {
    load();
  }, [load]);

  // Elect (or un-elect) the vehicle deduction method. Persisted on
  // company_financials via the canonical revenue-settings writer; a confirm
  // guards the change because it moves real deduction dollars.
  const setVehicleMethod = async (value) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("setVehicleMethod");
    setActionError("");
    try {
      const method = value === "" ? null : value;
      const labels = {
        standard_mileage: "Standard mileage",
        actual_expenses: "Actual vehicle expenses",
        null: "Not elected",
      };
      if (
        !window.confirm(
          `Record your intended vehicle deduction method as "${labels[method]}"? This P&L always reports ACTUAL vehicle costs — the setting doesn't change the totals; if you choose standard mileage it just discloses the mileage figure to apply manually with your CPA (line 9 allows one method, not both).`,
        )
      ) {
        return;
      }
      setSavingMethod(true);
      try {
        await adminFetch("/admin/revenue/settings", {
          method: "PUT",
          body: JSON.stringify({
            vehicleDeductionMethod: method,
          }),
        });
        await load();
      } catch (e) {
        setActionError(`Could not save election: ${e.message || e}`);
      }
      setSavingMethod(false);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const downloadPnl = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("downloadPnl");
    setActionError("");
    try {
      try {
        let url = `${API_BASE}/admin/tax/export/pnl?period=${period}`;
        if (period === "custom" && customStart && customEnd)
          url += `&start_date=${customStart}&end_date=${customEnd}`;
        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
        });
        // Never save an error page as a .csv a CPA might open.
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `waves-pnl-${period}-${etDateString()}.csv`;
        a.click();
      } catch (e) {
        setActionError("Download failed: " + e.message);
      }
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const periods = [
    {
      id: "mtd",
      label: "This Month",
    },
    {
      id: "last_month",
      label: "Last Month",
    },
    {
      id: "quarterly",
      label: "This Quarter",
    },
    {
      id: "ytd",
      label: "YTD",
    },
    {
      id: "last_year",
      label: "Last Year",
    },
    {
      id: "custom",
      label: "Custom",
    },
  ];
  const PnlRow = ({ label, value, bold, indent, color }) => (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: `${bold ? 6 : 4}px 0`,
        borderBottom: bold ? "1px solid #E4E4E7" : "1px solid #E4E4E722",
        marginLeft: indent ? 20 : 0,
      }}
    >
      {" "}
      <span
        style={{
          fontSize: 14,
          color: bold ? "#09090B" : "#71717A",
          fontWeight: bold ? 700 : 400,
        }}
      >
        {label}
      </span>{" "}
      <span
        style={{
          fontFamily: MONO,
          fontSize: 14,
          fontWeight: bold ? 700 : 400,
          color: color || (bold ? "#09090B" : "#27272A"),
          textAlign: "right",
        }}
      >
        {fmtM(value)}
      </span>{" "}
    </div>
  );
  return (
    <div>
      {readError && (
        <ActionFeedback error onRetry={load}>
          Could not load P&L: {readError}
        </ActionFeedback>
      )}
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}{" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        {" "}
        <div>
          {" "}
          <h2
            style={{
              fontSize: 18,
              fontWeight: 500,
              color: "#09090B",
            }}
          >
            Profit & Loss Statement
          </h2>{" "}
          <div
            style={{
              fontSize: 14,
              color: "#71717A",
            }}
          >
            {pnl ? `${pnl.startDate} to ${pnl.endDate}` : "Select a period"}
          </div>
          {/* Coverage disclosure: refunds/disputes/fees come from the synced
              payout ledger — when it lags the window, the figures are NOT
              final and must say so instead of reading as complete. */}
          {pnl?.coverage?.note && (
            <div
              style={{
                fontSize: 14,
                color: "#52525B",
                marginTop: 4,
                maxWidth: 620,
              }}
            >
              {pnl.coverage.note}
            </div>
          )}{" "}
        </div>{" "}
        <Button
          onClick={downloadPnl}
          type="button"
          variant="primary"
          className="min-w-11"
          disabled={!!pendingAction}
          loading={pendingAction === "downloadPnl"}
        >
          Download P&L
        </Button>{" "}
      </div>
      {/* Period selector */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 14,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {periods.map((p) => (
          <Button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            type="button"
            variant={period === p.id ? "primary" : "secondary"}
            aria-pressed={period === p.id}
            className="min-w-11"
            disabled={!!pendingAction}
          >
            {p.label}
          </Button>
        ))}
        {period === "custom" && (
          <>
            {" "}
            <Field label="Start date" className="min-w-0">
              <Input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                style={{
                  width: 130,
                }}
                disabled={!!pendingAction}
              />
            </Field>{" "}
            <span
              style={{
                color: "#71717A",
                fontSize: 14,
              }}
            >
              to
            </span>{" "}
            <Field label="End date" className="min-w-0">
              <Input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                style={{
                  width: 130,
                }}
                disabled={!!pendingAction}
              />
            </Field>{" "}
          </>
        )}
      </div>
      {loading ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "#71717A",
          }}
        >
          Loading P&L...
        </div>
      ) : pnl ? (
        <Card
          style={{
            padding: "20px 24px",
          }}
        >
          {" "}
          <PnlRow label="REVENUE" value={null} bold />{" "}
          <PnlRow
            label="Service Revenue"
            value={pnl.revenue?.serviceRevenue}
            indent
          />{" "}
          <PnlRow
            label="Other Revenue"
            value={pnl.revenue?.otherRevenue}
            indent
          />{" "}
          <PnlRow label="Total Revenue" value={pnl.revenue?.total} bold />{" "}
          <PnlRow
            label="Sales tax collected (liability, not income)"
            value={pnl.revenue?.salesTaxCollected}
            indent
          />{" "}
          <div
            style={{
              height: 12,
            }}
          />{" "}
          <PnlRow label="COST OF GOODS SOLD" value={null} bold />{" "}
          <PnlRow label="Labor" value={pnl.cogs?.labor} indent />{" "}
          <PnlRow
            label="Materials & Supplies"
            value={pnl.cogs?.materials}
            indent
          />{" "}
          <PnlRow label="Total COGS" value={pnl.cogs?.total} bold />{" "}
          <div
            style={{
              height: 12,
            }}
          />{" "}
          <PnlRow
            label="GROSS PROFIT"
            value={pnl.grossProfit}
            bold
            color={pnl.grossProfit >= 0 ? "#18181B" : "#C8312F"}
          />{" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "4px 0",
              borderBottom: "1px solid #E4E4E722",
            }}
          >
            {" "}
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              Gross Margin
            </span>{" "}
            <span
              style={{
                fontFamily: MONO,
                fontSize: 14,
                color: "#27272A",
              }}
            >
              {((pnl.grossMargin || 0) * 100).toFixed(1)}%
            </span>{" "}
          </div>{" "}
          <div
            style={{
              height: 12,
            }}
          />{" "}
          <PnlRow label="OPERATING EXPENSES" value={null} bold />
          {pnl.operatingExpenses?.categories?.map((c, i) => (
            <PnlRow key={i} label={c.name} value={c.amount} indent />
          ))}
          <PnlRow
            label="Total Operating Expenses"
            value={pnl.operatingExpenses?.total}
            bold
          />{" "}
          <div
            style={{
              height: 12,
            }}
          />{" "}
          <PnlRow label="DEDUCTIONS" value={null} bold />{" "}
          <PnlRow
            label="Mileage Deduction"
            value={pnl.deductions?.mileage}
            indent
          />{" "}
          <PnlRow
            label={
              pnl.deductions?.depreciationComplete === false
                ? "Depreciation (incomplete)"
                : "Depreciation"
            }
            value={pnl.deductions?.depreciation}
            indent
          />{" "}
          <PnlRow label="Total Deductions" value={pnl.deductions?.total} bold />{" "}
          {pnl.depreciationDisclosure?.note && (
            <div
              style={{
                marginTop: 6,
                padding: "8px 10px",
                border: "1px solid #52525B",
                borderRadius: 6,
                color: "#52525B",
                fontSize: 14,
                lineHeight: 1.45,
              }}
            >
              {pnl.depreciationDisclosure.note}
            </div>
          )}{" "}
          {pnl.vehicleDeduction && (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 14,
                color: "#71717A",
              }}
            >
              <Field
                label="Intended vehicle method (informational \u2014 P&L reports actual costs):"
                className="min-w-0"
              >
                <Select
                  value={pnl.vehicleDeduction.method || ""}
                  disabled={!!pendingAction || savingMethod}
                  onChange={(e) => setVehicleMethod(e.target.value)}
                  style={{
                    minWidth: 180,
                  }}
                >
                  <option value="">Not elected</option>
                  <option value="standard_mileage">Standard mileage</option>
                  <option value="actual_expenses">
                    Actual vehicle expenses
                  </option>
                </Select>
              </Field>
            </div>
          )}{" "}
          {pnl.vehicleDeduction &&
            pnl.vehicleDeduction.standardMileageComputed > 0 &&
            !pnl.vehicleDeduction.methodConflict && (
              <div
                style={{
                  marginTop: 6,
                  padding: "8px 10px",
                  border: "1px solid #52525B",
                  borderRadius: 6,
                  color: "#52525B",
                  fontSize: 14,
                  lineHeight: 1.45,
                }}
              >
                This P&amp;L deducts actual vehicle costs. Standard mileage for
                the period would be{" "}
                {fmtM(pnl.vehicleDeduction.standardMileageComputed)} — it is not
                added here (Schedule&nbsp;C line 9 allows actual expenses OR
                mileage, not both). Apply it with your CPA in place of the
                actual vehicle costs only if you use the standard method.
              </div>
            )}{" "}
          {pnl.vehicleDeduction?.methodConflict && (
            <div
              style={{
                marginTop: 6,
                padding: "8px 10px",
                border: "1px solid #C8312F",
                borderRadius: 6,
                color: "#C8312F",
                fontSize: 14,
                lineHeight: 1.45,
              }}
            >
              {pnl.vehicleDeduction.methodConflict.note}
            </div>
          )}{" "}
          <div
            style={{
              height: 16,
            }}
          />{" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "10px 0",
              borderTop: "2px solid #E4E4E7",
            }}
          >
            {" "}
            <span
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: "#09090B",
              }}
            >
              NET INCOME
            </span>{" "}
            <span
              style={{
                fontFamily: MONO,
                fontSize: 18,
                fontWeight: 500,
                color: pnl.netIncome >= 0 ? "#18181B" : "#C8312F",
              }}
            >
              {fmtM(pnl.netIncome)}
            </span>{" "}
          </div>{" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "4px 0",
            }}
          >
            {" "}
            <span
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              Net Margin
            </span>{" "}
            <span
              style={{
                fontFamily: MONO,
                fontSize: 14,
                color: pnl.netIncome >= 0 ? "#18181B" : "#C8312F",
              }}
            >
              {((pnl.netMargin || 0) * 100).toFixed(1)}%
            </span>{" "}
          </div>{" "}
        </Card>
      ) : (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "#71717A",
          }}
        >
          No financial data available for this period.
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS TAB
// ═══════════════════════════════════════════════════════════════
function ExportsTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const isMobile = useIsMobile(640);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [startDate, setStartDate] = useState(
    `${new Date().getFullYear()}-01-01`,
  );
  const [endDate, setEndDate] = useState(etDateString());
  const [downloading, setDownloading] = useState("");
  const download = async (type, filename) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("download");
    setActionError("");
    try {
      setDownloading(type);
      try {
        let url = `${API_BASE}/admin/tax/export/${type}`;
        if (type === "tax-package") {
          url += `?year=${year}`;
        } else if (type !== "depreciation") {
          url += `?start_date=${startDate}&end_date=${endDate}`;
        }
        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        setActionError("Download failed: " + e.message);
      }
      setDownloading("");
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  const exports = [
    {
      type: "transactions",
      label: "Transactions",
      desc: "All payment transactions",
      icon: "$",
      color: "#18181B",
    },
    {
      type: "expenses",
      label: "Expenses",
      desc: "Schedule C categories",
      icon: "E",
      color: "#52525B",
    },
    {
      type: "mileage",
      label: "Mileage",
      desc: "IRS mileage log",
      icon: "M",
      color: "#18181B",
    },
    {
      type: "depreciation",
      label: "Depreciation",
      desc: "Equipment schedule",
      icon: "D",
      color: "#18181B",
    },
    {
      type: "labor",
      label: "Labor",
      desc: "Hours by technician",
      icon: "L",
      color: "#18181B",
    },
    {
      type: "pnl",
      label: "P&L Statement",
      desc: "Profit & Loss report",
      icon: "P",
      color: "#18181B",
    },
  ];
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}
      {/* Hero: Tax Package ZIP */}
      <Card
        style={{
          padding: "24px 28px",
          marginBottom: 20,
        }}
      >
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          {" "}
          <div>
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: "#09090B",
                marginBottom: 4,
              }}
            >
              Download Complete Tax Package
            </div>{" "}
            <div
              style={{
                fontSize: 14,
                color: "#71717A",
              }}
            >
              ZIP file with all CSVs + README for your CPA
            </div>{" "}
          </div>{" "}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {" "}
            <Field label="Tax year" className="min-w-0">
              <Select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                style={{
                  minWidth: 80,
                }}
                disabled={!!pendingAction}
              >
                {" "}
                {Array.from(
                  {
                    length: new Date().getFullYear() - 2023,
                  },
                  (_, i) => String(new Date().getFullYear() - i),
                ).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}{" "}
              </Select>
            </Field>{" "}
            <Button
              onClick={() =>
                download("tax-package", `waves-tax-package-${year}.zip`)
              }
              disabled={!!pendingAction || downloading === "tax-package"}
              type="button"
              variant="primary"
              loading={downloading === "tax-package"}
              className="min-w-11"
            >
              {"Download ZIP"}
            </Button>{" "}
          </div>{" "}
        </div>{" "}
      </Card>
      {/* Date range for individual exports */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        {" "}
        <span
          style={{
            fontSize: 14,
            color: "#71717A",
          }}
        >
          Date range:
        </span>{" "}
        <Field label="Start date" className="min-w-0">
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{
              width: 130,
            }}
            disabled={!!pendingAction}
          />
        </Field>{" "}
        <span
          style={{
            color: "#71717A",
            fontSize: 14,
          }}
        >
          to
        </span>{" "}
        <Field label="End date" className="min-w-0">
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{
              width: 130,
            }}
            disabled={!!pendingAction}
          />
        </Field>{" "}
      </div>
      {/* Export cards grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)",
          gap: 10,
        }}
      >
        {exports.map((exp) => (
          <Card
            key={exp.type}
            style={{
              padding: "16px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              {" "}
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: `${exp.color}22`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: MONO,
                  fontSize: 14,
                  fontWeight: 500,
                  color: exp.color,
                }}
              >
                {exp.icon}
              </div>{" "}
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "#09090B",
                  }}
                >
                  {exp.label}
                </div>{" "}
                <div
                  style={{
                    fontSize: 14,
                    color: "#71717A",
                  }}
                >
                  {exp.desc}
                </div>{" "}
              </div>{" "}
            </div>{" "}
            <Button
              onClick={() =>
                download(
                  exp.type,
                  `waves-${exp.type}-${startDate}-to-${endDate}.csv`,
                )
              }
              disabled={!!pendingAction || downloading === exp.type}
              style={{
                marginTop: "auto",
              }}
              type="button"
              variant="secondary"
              loading={downloading === exp.type}
              className="min-w-11"
            >
              {"Download CSV"}
            </Button>{" "}
          </Card>
        ))}
      </div>{" "}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNTS RECEIVABLE TAB
// ═══════════════════════════════════════════════════════════════
function AccountsReceivableTab() {
  const actionRef = useRef(false);
  const [pendingAction, setPendingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const isMobile = useIsMobile(640);
  const [data, setData] = useState(null);
  const [sending, setSending] = useState(null);
  const read = useTaxRead("/admin/tax/accounts-receivable", setData);
  const loading = read.loading,
    loadError = read.error;
  const sendReminder = async (inv) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setPendingAction("sendReminder");
    setActionError("");
    try {
      // Outbound customer SMS — never one accidental click away.
      if (
        !window.confirm(
          `Text ${inv.customerName} a payment reminder for ${fmtM(inv.amount)} (Invoice #${inv.invoiceNumber})?`,
        )
      ) {
        return;
      }
      setSending(inv.id);
      try {
        await adminFetch("/admin/sms/send", {
          method: "POST",
          body: JSON.stringify({
            to: inv.phone,
            message: `Hi ${inv.customerName}, this is Waves Pest Control. You have an outstanding balance of ${fmtM(inv.amount)} (Invoice #${inv.invoiceNumber}). Please call or reply to arrange payment. Thank you!`,
          }),
        });
        alert("Reminder sent!");
      } catch (e) {
        setActionError("Failed to send: " + e.message);
      }
      setSending(null);
    } finally {
      actionRef.current = false;
      setPendingAction("");
    }
  };
  if (loading)
    return (
      <div
        style={{
          padding: 40,
          textAlign: "center",
          color: "#71717A",
        }}
      >
        Loading A/R...
      </div>
    );
  if (loadError)
    return <TaxReadFeedback read={read} label="accounts receivable" />;
  const s = data?.summary || {};
  const invoices = data?.invoices || [];
  const bucketColor = (bucket) => {
    if (bucket === "90+") return "#C8312F";
    if (bucket === "60") return "#18181B";
    if (bucket === "30") return "#52525B";
    return "#18181B";
  };
  return (
    <div>
      {actionError && (
        <ActionFeedback error className="mb-4 whitespace-pre-wrap">
          {actionError}
        </ActionFeedback>
      )}{" "}
      <h2
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 4,
        }}
      >
        Accounts Receivable Aging
      </h2>{" "}
      <div
        style={{
          fontSize: 14,
          color: "#71717A",
          marginBottom: 14,
        }}
      >
        Outstanding invoices by aging bucket
      </div>
      {/* Aging summary cards */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        {" "}
        <StatCard
          label="Total Outstanding"
          value={fmtM(s.total)}
          color={s.total > 500 ? "#C8312F" : "#09090B"}
          sub={`${s.count} invoices`}
        />{" "}
        <StatCard label="Current" value={fmtM(s.current)} color={"#18181B"} />{" "}
        <StatCard label="30 Days" value={fmtM(s.over30)} color={"#52525B"} />{" "}
        <StatCard label="60 Days" value={fmtM(s.over60)} color={"#18181B"} />{" "}
        <StatCard
          label="90+ Days"
          value={fmtM(s.over90)}
          color={s.over90 > 0 ? "#C8312F" : "#09090B"}
        />{" "}
      </div>
      {/* Invoices table */}
      {invoices.length === 0 ? (
        <div
          style={{
            padding: 30,
            textAlign: "center",
            color: "#71717A",
            fontSize: 14,
          }}
        >
          No outstanding invoices. All caught up!
        </div>
      ) : (
        <Card
          style={{
            overflow: "hidden",
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {" "}
          <Table
            className="whitespace-nowrap"
            style={{
              minWidth: isMobile ? 800 : undefined,
            }}
          >
            <THead>
              <TR>
                {[
                  "Customer",
                  "Invoice",
                  "Amount",
                  "Due Date",
                  "Days Overdue",
                  "Bucket",
                  "",
                ].map((h) => (
                  <TH
                    key={h}
                    style={{
                      color: "#71717A",
                      textAlign: "left",
                    }}
                  >
                    {h}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {invoices.map((inv, i) => {
                const rowBg =
                  inv.daysOverdue >= 90
                    ? "#C8312F11"
                    : inv.daysOverdue >= 60
                      ? "#18181B11"
                      : inv.daysOverdue >= 30
                        ? "#52525B11"
                        : "transparent";
                return (
                  <TR
                    key={inv.id || i}
                    style={{
                      background: rowBg,
                      borderBottom: "1px solid #E4E4E722",
                    }}
                  >
                    <TD
                      style={{
                        color: "#09090B",
                      }}
                    >
                      {inv.customerName}
                    </TD>
                    <TD
                      style={{
                        color: "#71717A",
                      }}
                    >
                      {inv.invoiceNumber}
                    </TD>
                    <TD
                      style={{
                        color: "#09090B",
                      }}
                    >
                      {fmtM(inv.amount)}
                    </TD>
                    <TD
                      style={{
                        color: "#71717A",
                      }}
                    >
                      {fmtD(inv.dueDate)}
                    </TD>
                    <TD
                      style={{
                        color: bucketColor(inv.bucket),
                      }}
                    >
                      {inv.daysOverdue}d
                    </TD>
                    <TD>
                      <Badge
                        tone={
                          bucketColor(inv.bucket) === "#C8312F"
                            ? "alert"
                            : "neutral"
                        }
                      >
                        {inv.bucket === "90+"
                          ? "90+ days"
                          : inv.bucket === "60"
                            ? "60 days"
                            : inv.bucket === "30"
                              ? "30 days"
                              : "Current"}
                      </Badge>
                    </TD>
                    <TD>
                      {inv.phone && inv.daysOverdue > 0 && (
                        <Button
                          onClick={() => sendReminder(inv)}
                          disabled={!!pendingAction || sending === inv.id}
                          type="button"
                          variant="secondary"
                          loading={sending === inv.id}
                          className="min-w-11"
                        >
                          {"Send Reminder"}
                        </Button>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>{" "}
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// BANK IMPORT TAB (GATE_BANK_IMPORT)
// ═══════════════════════════════════════════════════════════════

const BANK_STATUS_COLORS = {
  unmatched: "#52525B",
  matched_expense: "#18181B",
  matched_payout: "#18181B",
  created_expense: "#18181B",
  refund_applied: "#18181B",
  ignored: "#71717A",
};
const BANK_STATUS_LABELS = {
  unmatched: "review",
  matched_expense: "expense",
  matched_payout: "payout",
  created_expense: "created",
  refund_applied: "refund",
  ignored: "ignored",
};
function BankImportTab() {
  // 14px floor on this financial-review surface (repo minimum readable
  // size) — the shared inputStyle stays 12px for the legacy tabs

  const busyRef = useRef(false);
  const rowsSeq = useRef(0);
  const rowsPending = useRef(false);
  const coverageSeq = useRef(0);
  const [readErrors, setReadErrors] = useState({});
  const [rowsLoading, setRowsLoading] = useState(true);
  const [countsReady, setCountsReady] = useState(false);
  const [categoryAttempt, setCategoryAttempt] = useState(0);
  const [counts, setCounts] = useState({});
  const [rows, setRows] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [filter, setFilter] = useState("");
  const [accountLabel, setAccountLabel] = useState("capone-checking");
  const [accountType, setAccountType] = useState("bank");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  // per-row candidate pick for the manual link path (row id → expense id)
  const [linkPick, setLinkPick] = useState({});
  // per-row category override for Create (row id → category id) — the AI
  // suggestion is a default, never the only option
  const [catPick, setCatPick] = useState({});
  const [categories, setCategories] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  // ET-derived, NOT the browser's UTC calendar: between 7pm ET and
  // midnight on Dec 31 the UTC year is already next year, which would
  // request an empty coverage report and drop the oldest picker option
  const etYear = etDateString().slice(0, 4);
  const [covYear, setCovYear] = useState(etYear);
  // last upload payload, kept only while its result reported duplicates —
  // fuels the explicit force-import path for identical-but-distinct rows
  const [dupUpload, setDupUpload] = useState(null);
  // per-row force selection: hash → checked. Default UNCHECKED — the
  // operator names exactly which skipped tuples were genuinely separate
  // purchases; forcing the whole set would re-import ordinary overlaps too.
  const [dupPicks, setDupPicks] = useState({});
  // on-demand FULL candidate lists (row id → candidates): the parked
  // slices show 20, and the real target can sit beyond them
  const [fullRefunds, setFullRefunds] = useState({});
  const [fullExpenseCands, setFullExpenseCands] = useState({});
  const [fullPayouts, setFullPayouts] = useState({});

  // offset pagination with APPEND semantics — the server caps limit at 500,
  // so growing a single limit stalls there; offset pages don't
  const loadRows = useCallback(
    (offset) => {
      if (offset > 0 && rowsPending.current) return;
      rowsPending.current = true;
      const seq = ++rowsSeq.current;
      setRowsLoading(true);
      if (offset === 0) {
        setRows([]);
        setHasMore(false);
      }
      setReadErrors((prev) => ({
        ...prev,
        rows: null,
      }));
      adminFetch(
        `/admin/tax/bank-import/transactions?limit=200&offset=${offset}${filter ? `&status=${filter}` : ""}`,
      )
        .then((d) => {
          if (seq !== rowsSeq.current) return;
          setRows((prev) =>
            offset === 0
              ? d.transactions || []
              : [...prev, ...(d.transactions || [])],
          );
          setHasMore(!!d.hasMore);
        })
        .catch((error) => {
          if (seq !== rowsSeq.current) return;
          if (offset === 0) setRows([]);
          setReadErrors((prev) => ({
            ...prev,
            rows: error.message,
          }));
        })
        .finally(() => {
          if (seq === rowsSeq.current) {
            rowsPending.current = false;
            setRowsLoading(false);
          }
        });
    },
    [filter],
  );
  const load = useCallback(() => {
    // expanded candidate caches are snapshots of a suggestion state that a
    // reload replaces — keeping them would pin stale targets (and hide
    // newly valid ones) with no load-all option left to refresh
    setFullRefunds({});
    setFullExpenseCands({});
    setFullPayouts({});
    adminFetch("/admin/tax/bank-import/status")
      .then((s) => {
        setCounts(s?.counts || {});
        setCountsReady(true);
        setReadErrors((prev) => ({
          ...prev,
          status: null,
        }));
      })
      .catch((error) => {
        setCountsReady(false);
        setReadErrors((prev) => ({
          ...prev,
          status: error.message,
        }));
      });
    loadRows(0);
    const seq = ++coverageSeq.current;
    adminFetch(`/admin/tax/bank-import/coverage?year=${covYear}`)
      .then((d) => {
        if (seq !== coverageSeq.current) return;
        setCoverage(d.months || []);
        setReadErrors((prev) => ({
          ...prev,
          coverage: null,
        }));
      })
      .catch((error) => {
        if (seq !== coverageSeq.current) return;
        setCoverage([]);
        setReadErrors((prev) => ({
          ...prev,
          coverage: error.message,
        }));
      });
  }, [loadRows, covYear]);
  useEffect(load, [load]);
  useEffect(() => {
    adminFetch("/admin/tax/expense-categories")
      .then((d) => {
        setCategories(d.categories || []);
        setReadErrors((prev) => ({
          ...prev,
          categories: null,
        }));
      })
      .catch((error) =>
        setReadErrors((prev) => ({
          ...prev,
          categories: error.message,
        })),
      );
  }, [categoryAttempt]);
  const act = (label, path, body) => {
    if (busyRef.current) return Promise.resolve();
    busyRef.current = true;
    setBusy(label);
    setNotice(null);
    return adminFetch(path, {
      method: "POST",
      body: JSON.stringify(body || {}),
    })
      .then((r) => {
        load();
        return r;
      })
      .catch((e) => {
        setNotice({
          error: true,
          text: e.message,
        });
        load();
      })
      .finally(() => {
        busyRef.current = false;
        setBusy("");
      });
  };
  const onFile = (e) => {
    if (busyRef.current) return;
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!accountLabel.trim()) {
      setNotice({
        error: true,
        text: "Set an account label before uploading",
      });
      return;
    }
    // a NEW ordinary upload voids any prior duplicate confirmation — if
    // this upload fails, a stale "Import skipped duplicates anyway" button
    // would force-import rows from the PREVIOUS statement. The token is
    // retained only across forceImportDuplicates retries.
    setDupUpload(null);
    const reader = new FileReader();
    reader.onload = () => {
      const payload = {
        accountLabel: accountLabel.trim(),
        accountType,
        filename: file.name,
        csv: String(reader.result || ""),
      };
      act("upload", "/admin/tax/bank-import/upload", payload).then((r) => {
        if (!r) return;
        // hashes scope a later force-import to EXACTLY these skipped rows
        // (on a re-post every previously imported row conflicts too), and
        // the server-issued token makes that confirmation replay-safe
        setDupUpload(
          r.duplicates > 0
            ? {
                ...payload,
                duplicateRows: r.duplicateRows || [],
                duplicatesTotal: r.duplicates,
                forceToken: r.forceToken,
              }
            : null,
        );
        setDupPicks({});
        setNotice({
          text:
            `Imported ${r.imported} of ${r.parsed} rows (${r.duplicates} already imported, ${r.skippedTotal ?? r.skipped.length} skipped)` +
            // skipped rows never reach staging or coverage — name each line
            // and reason so the operator can fix the statement and re-import
            // (the server returns a bounded sample plus the honest total)
            (r.skipped.length
              ? ` — skipped: ${r.skipped
                  .slice(0, 5)
                  .map((s) => `line ${s.line} (${s.reason})`)
                  .join(
                    "; ",
                  )}${(r.skippedTotal ?? r.skipped.length) > 5 ? ` and ${(r.skippedTotal ?? r.skipped.length) - 5} more` : ""}`
              : "") +
            (r.matching
              ? ` · matching linked ${r.matching.payoutsLinked} payouts + ${r.matching.expensesLinked} expenses${r.matching.moreRemaining ? " (more rows pending — click Run matching)" : ""}`
              : ` · ${r.matchingError || "matching not run"}`) +
            (r.duplicates > 0 && r.duplicateSamples?.length
              ? ` — skipped as re-uploads: ${r.duplicateSamples
                  .slice(0, 3)
                  .map(
                    (d) =>
                      `${d.txn_date} ${d.description.slice(0, 24)} $${d.amount}`,
                  )
                  .join("; ")}${r.duplicates > 3 ? "…" : ""}`
              : ""),
        });
      });
    };
    reader.readAsText(file);
  };

  // Re-post the same file with forceDuplicates: rows already present stay
  // deduped; ONLY the operator-checked identical rows import as additional
  // copies — never the whole skipped set.
  const forceImportDuplicates = () => {
    if (!dupUpload) return;
    const selected = (dupUpload.duplicateRows || [])
      .filter((d) => dupPicks[d.row_hash])
      .map((d) => d.row_hash);
    if (!selected.length) return;
    if (
      !window.confirm(
        `Import the ${selected.length} checked row${selected.length === 1 ? "" : "s"} as ADDITIONAL transactions? Only do this when they were genuinely separate purchases, not a re-upload of the same statement.`,
      )
    )
      return;
    const payload = {
      ...dupUpload,
      forceDuplicates: true,
      forceRowHashes: selected,
    };
    // dupUpload is kept until the request SUCCEEDS: it holds the only copy
    // of the forceToken, and the server's replay protection only works when
    // a failed/lost confirmation retries under the SAME token
    act("upload", "/admin/tax/bank-import/upload", payload).then((r) => {
      if (!r) return; // failed — token + selection retained, the button retries this confirmation
      setDupUpload(null);
      setDupPicks({});
      setNotice({
        text:
          `Force-imported ${r.forced} duplicate row${r.forced === 1 ? "" : "s"}` +
          (r.forceAlreadyPresent
            ? ` (${r.forceAlreadyPresent} already force-imported earlier — nothing re-added)`
            : "") +
          (r.forceFailed
            ? ` · ${r.forceFailed} could NOT be imported (ordinal space exhausted) — add manually via the Expenses tab`
            : ""),
      });
    });
  };
  return (
    <div>
      {Object.entries(readErrors)
        .filter(([, error]) => error)
        .map(([source, error]) => (
          <ActionFeedback
            key={source}
            error
            className="mb-3"
            onRetry={() =>
              source === "categories"
                ? setCategoryAttempt((value) => value + 1)
                : load()
            }
          >
            Could not load bank import {source}: {error}
          </ActionFeedback>
        ))}
      {rowsLoading && (
        <ActionFeedback>Loading bank transactions…</ActionFeedback>
      )}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <StatCard
          label="Needs Review"
          value={countsReady ? counts.unmatched || 0 : "\u2014"}
          color={"#52525B"}
        />
        <StatCard
          label="Matched"
          value={
            countsReady
              ? (counts.matched_expense || 0) + (counts.matched_payout || 0)
              : "\u2014"
          }
          color={"#18181B"}
        />
        <StatCard
          label="Created"
          value={countsReady ? counts.created_expense || 0 : "\u2014"}
          color={"#18181B"}
        />
        {/* applied refunds are completed review work too — without this
            card each refund made the totals stop reconciling with the
            number of imported rows */}
        <StatCard
          label="Refunds"
          value={countsReady ? counts.refund_applied || 0 : "\u2014"}
          color={"#18181B"}
        />
        <StatCard
          label="Ignored"
          value={countsReady ? counts.ignored || 0 : "\u2014"}
        />
      </div>

      <Card
        style={{
          padding: 16,
          marginBottom: 16,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Field label="Account label" className="min-w-0">
          <Input
            style={{
              width: 180,
            }}
            value={accountLabel}
            onChange={(e) => setAccountLabel(e.target.value)}
            placeholder="Account label (e.g. capone-card-1234)"
            title="Stamped on every imported row so checking and each card stay separate"
            disabled={!!busy}
          />
        </Field>
        <Field label="Account type" className="min-w-0">
          <Select
            value={accountType}
            onChange={(e) => setAccountType(e.target.value)}
            title="Card statements book created expenses as 'card'; bank statements as 'ach'"
            disabled={!!busy}
          >
            <option value="bank">Bank account</option>
            <option value="card">Credit card</option>
          </Select>
        </Field>
        <label
          className={buttonStyles({
            density: "comfortable",
            className:
              "relative cursor-pointer focus-within:ring-2 focus-within:ring-zinc-500",
          })}
        >
          {busy === "upload" ? "Importing…" : "Upload statement CSV"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            onChange={onFile}
            disabled={!!busy}
          />
        </label>
        <Button
          type="button"
          style={{}}
          disabled={!!busy}
          onClick={() =>
            act("match", "/admin/tax/bank-import/match").then((r) => {
              if (r)
                setNotice({
                  text: `Matching pass: ${r.matching.payoutsLinked} payouts + ${r.matching.expensesLinked} expenses linked, ${r.matching.ambiguous} ambiguous${r.matching.moreRemaining ? " — more rows pending, run again" : ""}`,
                });
            })
          }
          variant="secondary"
          className="min-w-11"
        >
          {busy === "match" ? "Matching…" : "Run matching"}
        </Button>
        <Button
          type="button"
          style={{}}
          disabled={!!busy}
          onClick={() => {
            // scoped to the rows on screen — a global oldest-first pass can
            // report "processed" while changing nothing the operator can see
            const visibleIds = rows
              .filter(
                (r) =>
                  r.status === "unmatched" &&
                  r.direction === "debit" &&
                  !r.suggestion?.categoryId &&
                  !r.suggestion?.ignore,
              )
              .map((r) => r.id)
              .slice(0, 50);
            if (!visibleIds.length) {
              setNotice({
                text: "No uncategorized unmatched debits on screen — load or filter to the rows you want suggestions for",
              });
              return;
            }
            act("suggest", "/admin/tax/bank-import/suggest", {
              limit: 20,
              ids: visibleIds,
            }).then((r) => {
              if (r)
                setNotice({
                  text: `AI suggested categories for ${r.processed} rows`,
                });
            });
          }}
          title="AI proposes an expense category for unmatched debits — nothing is created until you click Create"
          variant="secondary"
          className="min-w-11"
        >
          {busy === "suggest" ? "Suggesting…" : "Suggest categories (AI)"}
        </Button>
        <Field label="Status" className="min-w-0">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={!!busy}
          >
            <option value="">All statuses</option>
            <option value="unmatched">Needs review</option>
            <option value="matched_expense">Matched to expense</option>
            <option value="matched_payout">Stripe payout</option>
            <option value="created_expense">Created expense</option>
            <option value="refund_applied">Refund applied</option>
            <option value="ignored">Ignored</option>
          </Select>
        </Field>
        <Field label="Coverage year" className="min-w-0">
          <Select
            value={covYear}
            onChange={(e) => setCovYear(e.target.value)}
            title="Coverage year — switch when backfilling a prior tax year"
            disabled={!!busy}
          >
            {[0, 1, 2, 3].map((back) => {
              const y = String(Number(etYear) - back);
              return (
                <option key={y} value={y}>
                  Coverage {y}
                </option>
              );
            })}
          </Select>
        </Field>
      </Card>

      {notice && (
        <div
          role={notice.error ? "alert" : "status"}
          style={{
            border: `1px solid ${notice.error ? "#C8312F" : "#E4E4E7"}`,
            background: notice.error ? "#C8312F11" : "#FFFFFF",
            color: notice.error ? "#C8312F" : "#27272A",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 14,
            marginBottom: 16,
          }}
        >
          {notice.text}
          {/* rendered on error notices too — a failed force confirmation
              must retry under the SAME retained token and selection */}
          {dupUpload && (
            <div
              style={{
                marginTop: 8,
              }}
            >
              <div
                style={{
                  color: "#71717A",
                  marginBottom: 4,
                }}
              >
                Skipped as re-uploads — check ONLY the rows that were genuinely
                separate purchases, then import:
              </div>
              {(dupUpload.duplicateRows || []).map((d) => (
                <label
                  key={d.row_hash}
                  style={{
                    display: "block",
                    cursor: "pointer",
                    padding: "1px 0",
                  }}
                  className="ui-choice-label"
                >
                  <Checkbox
                    type="checkbox"
                    checked={!!dupPicks[d.row_hash]}
                    onChange={(e) =>
                      setDupPicks((p) => ({
                        ...p,
                        [d.row_hash]: e.target.checked,
                      }))
                    }
                    style={{
                      marginRight: 6,
                    }}
                    disabled={!!busy}
                  />
                  {d.txn_date} · {String(d.description).slice(0, 40)} · $
                  {d.amount} ({d.direction})
                </label>
              ))}
              {(dupUpload.duplicatesTotal || 0) >
                (dupUpload.duplicateRows || []).length && (
                <div
                  style={{
                    color: "#71717A",
                    marginTop: 4,
                  }}
                >
                  +{dupUpload.duplicatesTotal - dupUpload.duplicateRows.length}{" "}
                  more duplicates not shown — re-upload a smaller slice of the
                  statement to force those
                </div>
              )}
              <Button
                type="button"
                disabled={
                  !!busy || !!busy || !Object.values(dupPicks).some(Boolean)
                }
                style={{
                  marginTop: 6,
                }}
                onClick={forceImportDuplicates}
                title="Imports only the checked rows as additional transactions"
                variant="secondary"
                className="min-w-11"
              >
                Import selected duplicates
              </Button>
            </div>
          )}
        </div>
      )}

      {/* every month the API returned for the selected year — showing only
          the latest would hide earlier months' unexplained outflow */}
      {coverage.length > 0 && (
        <Card
          style={{
            padding: 16,
            marginBottom: 16,
          }}
        >
          {coverage.map((m, i) => (
            <div
              key={m.month}
              style={{
                marginBottom: i < coverage.length - 1 ? 10 : 0,
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                  marginBottom: 6,
                }}
              >
                {m.month} ledger coverage —{" "}
                <span
                  style={{
                    color: "#09090B",
                    fontWeight: 500,
                  }}
                >
                  {m.pct == null ? "—" : `${m.pct}%`}
                </span>{" "}
                of bank outflow is in the expenses ledger ·{" "}
                {fmtM(m.unexplained)} unexplained
              </div>
              <div
                style={{
                  height: 6,
                  background: "#E4E4E7",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${m.pct || 0}%`,
                    background: (m.pct || 0) >= 90 ? "#18181B" : "#52525B",
                  }}
                />
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card
        style={{
          overflowX: "auto",
        }}
      >
        <Table>
          <THead>
            <TR
              style={{
                color: "#71717A",
                textAlign: "left",
              }}
            >
              {[
                "Date",
                "Account",
                "Description",
                "Amount",
                "Status",
                "Suggestion",
                "",
              ].map((h) => (
                <TH key={h}>{h}</TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {!rowsLoading && !readErrors.rows && rows.length === 0 && (
              <TR>
                <TD
                  colSpan={7}
                  style={{
                    color: "#71717A",
                    textAlign: "center",
                  }}
                >
                  No imported transactions yet — upload a Capital One CSV export
                  to start.
                </TD>
              </TR>
            )}
            {rows.map((r) => (
              <TR
                key={r.id}
                style={{
                  borderBottom: "1px solid #E4E4E7",
                }}
              >
                <TD
                  style={{
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtD(r.txn_date)}
                </TD>
                <TD
                  className="whitespace-nowrap"
                  style={{
                    color: "#71717A",
                  }}
                >
                  {r.account_label}
                </TD>
                <TD
                  style={{
                    maxWidth: 320,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={r.description}
                >
                  {r.description}
                </TD>
                <TD
                  style={{
                    whiteSpace: "nowrap",
                    color: r.direction === "credit" ? "#18181B" : "#27272A",
                  }}
                >
                  {r.direction === "credit" ? "+" : "−"}
                  {fmtM(r.amount)}
                </TD>
                <TD>
                  <Badge
                    tone={
                      BANK_STATUS_COLORS[r.status] === "#C8312F"
                        ? "alert"
                        : "neutral"
                    }
                  >
                    {BANK_STATUS_LABELS[r.status] || r.status}
                  </Badge>
                </TD>
                <TD
                  style={{
                    color: "#71717A",
                    maxWidth: 260,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                  }}
                >
                  {/* a transfer-flagged CREDIT with candidates falls through
                      to the select — a vendor refund whose descriptor says
                      "transfer" still needs its Apply refund action (the
                      hint folds into the select placeholder) */}
                  {r.suggestion?.ignore &&
                  !(
                    r.direction === "credit" &&
                    (r.suggestion?.refundCandidates?.length ||
                      r.suggestion?.payoutCandidates?.length)
                  ) &&
                  !r.suggestion?.candidates?.length ? (
                    "internal transfer?"
                  ) : r.status === "unmatched" &&
                    (r.suggestion?.candidates?.length ||
                      /* after the SOLE candidate is unlinked, the parked list is
              empty but the on-demand endpoint is rejection-agnostic —
              keep the picker reachable as the load entry point */
                      (r.direction === "debit" &&
                        (fullExpenseCands[r.id] ||
                          r.suggestion?.rejectedExpenseIds?.length ||
                          r.suggestion?.lastUnlink?.expenseId))) ? (
                    <Field label="Match expense" className="min-w-0">
                      <Select
                        style={{
                          maxWidth: 240,
                        }}
                        value={linkPick[r.id] || ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "__more_candidates") {
                            // paged load-more — link-expense validates by
                            // plausibility rules, so every entry is actionable
                            const have = fullExpenseCands[r.id]?.list || [];
                            adminFetch(
                              `/admin/tax/bank-import/${r.id}/expense-candidates?offset=${have.length}`,
                            )
                              .then((d) =>
                                setFullExpenseCands((p) => ({
                                  ...p,
                                  [r.id]: {
                                    list: [...have, ...(d.candidates || [])],
                                    total: d.total ?? 0,
                                  },
                                })),
                              )
                              .catch((error) =>
                                setNotice({
                                  error: true,
                                  text: `Could not load matching candidates: ${error.message}. Choose the load-more option to retry.`,
                                }),
                              );
                            return;
                          }
                          setLinkPick((p) => ({
                            ...p,
                            [r.id]: v,
                          }));
                        }}
                        title="Existing ledger expenses with a matching amount — link instead of creating a duplicate"
                        disabled={!!busy}
                      >
                        <option value="">
                          {r.suggestion?.ignore ? "internal transfer? · " : ""}
                          {(fullExpenseCands[r.id]?.list?.length ??
                            r.suggestion?.candidates?.length ??
                            0) > 0
                            ? `${fullExpenseCands[r.id]?.list?.length ?? r.suggestion.candidates.length} possible existing match${(fullExpenseCands[r.id]?.list?.length ?? r.suggestion.candidates.length) > 1 ? "es" : ""}…`
                            : "link an existing expense…"}
                        </option>
                        {(
                          fullExpenseCands[r.id]?.list ||
                          r.suggestion?.candidates ||
                          []
                        ).map((c) => (
                          <option key={c.id} value={c.id}>
                            {(
                              c.vendor_name ||
                              c.description ||
                              "expense"
                            ).slice(0, 34)}
                            {c.amount != null ? ` · ${fmtM(c.amount)}` : ""} ·{" "}
                            {fmtD(c.expense_date)}
                          </option>
                        ))}
                        {(fullExpenseCands[r.id]
                          ? fullExpenseCands[r.id].list.length <
                            fullExpenseCands[r.id].total
                          : (r.suggestion?.candidatesTotal || 0) >
                              (r.suggestion?.candidates?.length || 0) ||
                            !r.suggestion?.candidates?.length) && (
                          <option value="__more_candidates">
                            {(fullExpenseCands[r.id]?.total ??
                              r.suggestion?.candidatesTotal ??
                              0) > 0
                              ? `+${(fullExpenseCands[r.id]?.total ?? r.suggestion.candidatesTotal) - (fullExpenseCands[r.id]?.list.length ?? (r.suggestion?.candidates?.length || 0))} more — load…`
                              : "load matching expenses…"}
                          </option>
                        )}
                      </Select>
                    </Field>
                  ) : r.status === "unmatched" &&
                    r.direction === "credit" &&
                    (r.suggestion?.refundCandidates?.length ||
                      r.suggestion?.payoutCandidates?.length ||
                      /* same reachability rule for credits: an unlinked payout
              leaves no parked candidates, so the picker renders on
              the rejection residue with load entries */
                      r.suggestion?.rejectedPayoutIds?.length ||
                      r.suggestion?.lastUnlink?.payoutId ||
                      fullPayouts[r.id] ||
                      fullRefunds[r.id]) ? (
                    /* BOTH action types can be parked at once (an unrelated
              same-amount payout must not hide a legitimate refund) —
              one select, values prefixed p:/r: so the button knows
              which route the pick belongs to */
                    <Field label="Match expense" className="min-w-0">
                      <Select
                        style={{
                          maxWidth: 240,
                        }}
                        value={linkPick[r.id] || ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "__more_refunds") {
                            // paged load-more — every entry is actionable
                            // through apply-refund's plausibility validation,
                            // and the option stays until ALL of `total` are
                            // loaded (a hard truncation would strand a valid
                            // off-page original)
                            const have = fullRefunds[r.id]?.list || [];
                            adminFetch(
                              `/admin/tax/bank-import/${r.id}/refund-candidates?offset=${have.length}`,
                            )
                              .then((d) =>
                                setFullRefunds((p) => ({
                                  ...p,
                                  [r.id]: {
                                    list: [...have, ...(d.candidates || [])],
                                    total: d.total ?? 0,
                                  },
                                })),
                              )
                              .catch((error) =>
                                setNotice({
                                  error: true,
                                  text: `Could not load matching candidates: ${error.message}. Choose the load-more option to retry.`,
                                }),
                              );
                            return;
                          }
                          if (v === "__more_payouts") {
                            adminFetch(
                              `/admin/tax/bank-import/${r.id}/payout-candidates`,
                            )
                              .then((d) =>
                                setFullPayouts((p) => ({
                                  ...p,
                                  [r.id]: d.candidates || [],
                                })),
                              )
                              .catch((error) =>
                                setNotice({
                                  error: true,
                                  text: `Could not load matching candidates: ${error.message}. Choose the load-more option to retry.`,
                                }),
                              );
                            return;
                          }
                          setLinkPick((p) => ({
                            ...p,
                            [r.id]: v,
                          }));
                        }}
                        title="What is this deposit? Pick the Stripe payout it is, or the original purchase it refunds (applying a refund reduces that expense)"
                        disabled={!!busy}
                      >
                        <option value="">
                          {[
                            r.suggestion?.ignore ? "internal transfer?" : null,
                            r.suggestion?.payoutCandidates?.length
                              ? `${r.suggestion.payoutCandidates.length} payout${r.suggestion.payoutCandidates.length > 1 ? "s" : ""}`
                              : null,
                            r.suggestion?.refundCandidates?.length
                              ? `${r.suggestion.refundCandidates.length} original purchase${r.suggestion.refundCandidates.length > 1 ? "s" : ""}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "link payout / refund"}
                          …
                        </option>
                        {!!(
                          r.suggestion?.payoutCandidates?.length ||
                          fullPayouts[r.id] ||
                          r.suggestion?.rejectedPayoutIds?.length ||
                          r.suggestion?.lastUnlink?.payoutId
                        ) && (
                          <optgroup label="Stripe payouts — link">
                            {(
                              fullPayouts[r.id] ||
                              r.suggestion?.payoutCandidates ||
                              []
                            ).map((c) => (
                              <option key={`p:${c.id}`} value={`p:${c.id}`}>
                                {fmtM(c.amount)} · arrived{" "}
                                {fmtD(c.arrival_date)}
                              </option>
                            ))}
                            {!fullPayouts[r.id] &&
                              ((r.suggestion?.payoutCandidatesTotal || 0) >
                                (r.suggestion?.payoutCandidates?.length || 0) ||
                                !r.suggestion?.payoutCandidates?.length) && (
                                <option value="__more_payouts">
                                  {(r.suggestion?.payoutCandidatesTotal || 0) >
                                  0
                                    ? `+${r.suggestion.payoutCandidatesTotal - (r.suggestion?.payoutCandidates?.length || 0)} more — load all…`
                                    : "load payouts…"}
                                </option>
                              )}
                          </optgroup>
                        )}
                        <optgroup label="Original purchases — apply refund">
                          {(
                            fullRefunds[r.id]?.list ||
                            r.suggestion?.refundCandidates ||
                            []
                          ).map((c) => (
                            <option key={`r:${c.id}`} value={`r:${c.id}`}>
                              {(
                                c.vendor_name ||
                                c.description ||
                                "expense"
                              ).slice(0, 34)}{" "}
                              · {fmtM(c.amount)} · {fmtD(c.expense_date)}
                            </option>
                          ))}
                          {(fullRefunds[r.id]
                            ? fullRefunds[r.id].list.length <
                              fullRefunds[r.id].total
                            : (r.suggestion?.refundCandidatesTotal || 0) >
                                (r.suggestion?.refundCandidates?.length || 0) ||
                              !r.suggestion?.refundCandidates?.length) && (
                            <option value="__more_refunds">
                              {(fullRefunds[r.id]?.total ??
                                r.suggestion?.refundCandidatesTotal ??
                                0) > 0
                                ? `+${(fullRefunds[r.id]?.total ?? r.suggestion.refundCandidatesTotal) - (fullRefunds[r.id]?.list.length ?? (r.suggestion?.refundCandidates?.length || 0))} more — load…`
                                : "load original purchases…"}
                            </option>
                          )}
                        </optgroup>
                      </Select>
                    </Field>
                  ) : (
                    r.suggestion?.categoryName || ""
                  )}
                </TD>
                <TD
                  style={{
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.status === "unmatched" &&
                    r.direction === "debit" &&
                    linkPick[r.id] && (
                      <Button
                        type="button"
                        disabled={!!busy}
                        style={{
                          marginRight: 6,
                        }}
                        onClick={() =>
                          act(
                            "link",
                            `/admin/tax/bank-import/${r.id}/link-expense`,
                            {
                              expenseId: linkPick[r.id],
                            },
                          ).then((res) => {
                            if (res)
                              setLinkPick((p) => {
                                const next = {
                                  ...p,
                                };
                                delete next[r.id];
                                return next;
                              });
                          })
                        }
                        variant="primary"
                        className="min-w-11"
                      >
                        Link
                      </Button>
                    )}
                  {r.status === "unmatched" &&
                    r.direction === "credit" &&
                    linkPick[r.id] && (
                      <Button
                        type="button"
                        disabled={!!busy}
                        style={{
                          marginRight: 6,
                        }}
                        onClick={() => {
                          // the pick's p:/r: prefix says which route it belongs
                          // to — both lists can be parked on one credit
                          const pick = String(linkPick[r.id] || "");
                          const isRefund = pick.startsWith("r:");
                          const id = pick.slice(2);
                          const path = isRefund
                            ? `/admin/tax/bank-import/${r.id}/apply-refund`
                            : `/admin/tax/bank-import/${r.id}/link-payout`;
                          const body = isRefund
                            ? {
                                expenseId: id,
                              }
                            : {
                                payoutId: id,
                              };
                          act(
                            isRefund ? "apply-refund" : "link-payout",
                            path,
                            body,
                          ).then((res) => {
                            if (res)
                              setLinkPick((p) => {
                                const next = {
                                  ...p,
                                };
                                delete next[r.id];
                                return next;
                              });
                          });
                        }}
                        variant="primary"
                        className="min-w-11"
                      >
                        {String(linkPick[r.id] || "").startsWith("r:")
                          ? "Apply refund"
                          : "Link payout"}
                      </Button>
                    )}
                  {/* transfer-flagged rows keep Create too — the flag is only a
                      suggestion, and a legit vendor can trip the heuristic.
                      The category selector lives HERE so it stays reachable
                      in every review state (transfer warning, parked
                      candidates). Refund credits go through Apply refund. */}
                  {r.status === "unmatched" &&
                    r.direction === "debit" &&
                    !linkPick[r.id] && (
                      <>
                        <Field label="Expense category" className="min-w-0">
                          <Select
                            style={{
                              maxWidth: 170,
                              marginRight: 6,
                            }}
                            value={catPick[r.id] || ""}
                            onChange={(e) =>
                              setCatPick((p) => ({
                                ...p,
                                [r.id]: e.target.value,
                              }))
                            }
                            title="Category — the AI suggestion is only a default; pick to override"
                            disabled={!!busy}
                          >
                            <option value="">
                              {r.suggestion?.categoryName
                                ? `AI: ${r.suggestion.categoryName}`
                                : "Category…"}
                            </option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Button
                          type="button"
                          disabled={!!busy}
                          style={{
                            marginRight: 6,
                          }}
                          onClick={() =>
                            // an operator-picked category overrides the AI
                            // suggestion (and skips the AI-verify note)
                            act(
                              "create",
                              `/admin/tax/bank-import/${r.id}/create-expense`,
                              catPick[r.id]
                                ? {
                                    categoryId: catPick[r.id],
                                  }
                                : {},
                            ).then((res) => {
                              if (res)
                                setCatPick((p) => {
                                  const next = {
                                    ...p,
                                  };
                                  delete next[r.id];
                                  return next;
                                });
                            })
                          }
                          variant="secondary"
                          className="min-w-11"
                        >
                          Create expense
                        </Button>
                      </>
                    )}
                  {r.status === "unmatched" && (
                    <Button
                      type="button"
                      disabled={!!busy}
                      style={{}}
                      onClick={() =>
                        act("ignore", `/admin/tax/bank-import/${r.id}/ignore`)
                      }
                      variant="secondary"
                      className="min-w-11"
                    >
                      Ignore
                    </Button>
                  )}
                  {/* released refunds are terminal — no reopen path (the
                      expense keeps its reduction; reopening could reduce a
                      second expense with the same credit) */}
                  {r.status === "ignored" &&
                    !r.suggestion?.releasedRefundOf && (
                      <Button
                        type="button"
                        disabled={!!busy}
                        style={{}}
                        onClick={() =>
                          act(
                            "unignore",
                            `/admin/tax/bank-import/${r.id}/unignore`,
                          )
                        }
                        variant="secondary"
                        className="min-w-11"
                      >
                        Undo
                      </Button>
                    )}
                  {(r.status === "matched_expense" ||
                    r.status === "matched_payout" ||
                    r.status === "refund_applied") && (
                    <Button
                      type="button"
                      disabled={!!busy}
                      style={{}}
                      title={
                        r.status === "refund_applied"
                          ? "Undo this refund — restores the adjusted expense and returns the credit to review"
                          : "Wrong match? Returns the row to Needs Review; the linked expense/payout itself is untouched"
                      }
                      onClick={() => {
                        if (
                          window.confirm(
                            r.status === "refund_applied"
                              ? "Undo this refund? The adjusted expense is restored."
                              : "Unlink this bank row from its matched ledger record?",
                          )
                        )
                          act(
                            "unlink",
                            `/admin/tax/bank-import/${r.id}/unlink`,
                          );
                      }}
                      variant="secondary"
                      className="min-w-11"
                    >
                      {r.status === "refund_applied" ? "Undo refund" : "Unlink"}
                    </Button>
                  )}
                  {r.status === "refund_applied" && (
                    <Button
                      type="button"
                      disabled={!!busy}
                      style={{
                        marginLeft: 6,
                      }}
                      title="Already fixed the expense by hand on the Expenses tab? Clears this refund association WITHOUT touching the expense — the escape hatch when Undo refuses because the expense changed"
                      onClick={() => {
                        if (
                          window.confirm(
                            "Release this refund WITHOUT restoring the expense? Only after you already corrected the expense manually on the Expenses tab.",
                          )
                        )
                          act(
                            "release",
                            `/admin/tax/bank-import/${r.id}/unlink`,
                            {
                              releaseOnly: true,
                            },
                          );
                      }}
                      variant="secondary"
                      className="min-w-11"
                    >
                      Release
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {hasMore && (
          <div
            style={{
              padding: 12,
              textAlign: "center",
            }}
          >
            <Button
              type="button"
              style={{}}
              onClick={() => loadRows(rows.length)}
              variant="secondary"
              className="min-w-11"
              disabled={!!busy || rowsLoading}
            >
              Load 200 more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
export default function TaxPage() {
  const isMobile = useIsMobile(640);
  const [activeTab, setActiveTab] = useState("overview");
  // GATE_BANK_IMPORT: the leaf only exists when the server says the gate is
  // on (status is the one bank-import endpoint that answers while dark).
  const [bankImportOn, setBankImportOn] = useState(false);
  const tabGroups = bankImportOn
    ? TAX_TAB_GROUPS.map((g) =>
        g.key === "expenses"
          ? {
              ...g,
              tabs: [...g.tabs, "bankimport"],
            }
          : g,
      )
    : TAX_TAB_GROUPS;
  const activeGroup =
    tabGroups.find((g) => g.tabs.includes(activeTab)) || tabGroups[0];
  const [dashboard, setDashboard] = useState(null);
  const [quickPnl, setQuickPnl] = useState(null);
  const [arSummary, setArSummary] = useState(null);
  const [dashboardError, setDashboardError] = useState(false);
  // The overview used to render nothing while /admin/tax/dashboard loaded
  // and stay blank forever when it failed; it now says which, with a retry.
  const loadDashboard = useCallback(() => {
    setDashboardError(false);
    adminFetch("/admin/tax/dashboard")
      .then(setDashboard)
      .catch(() => setDashboardError(true));
  }, []);
  useEffect(() => {
    adminFetch("/admin/tax/bank-import/status")
      .then((s) => setBankImportOn(!!s?.enabled))
      .catch(() => {});
    loadDashboard();
  }, [loadDashboard]);
  const quickPnlRead = useTaxRead("/admin/tax/pnl?period=mtd", setQuickPnl);
  const applyArSummary = useCallback((data) => setArSummary(data?.summary), []);
  const arRead = useTaxRead("/admin/tax/accounts-receivable", applyArSummary);
  const d = dashboard;
  return (
    <UiSurface
      density="comfortable"
      className="ui-workspace text-ui-body text-zinc-900"
    >
      {" "}
      <AdminCommandHeader
        title="Taxes"
        icon={Receipt}
        sections={tabGroups.map((g) =>
          g.tabs.includes("advisor") && d?.pendingAlerts?.high
            ? {
                key: g.key,
                label: `${g.label} (${d.pendingAlerts.high})`,
                Icon: g.Icon,
              }
            : {
                key: g.key,
                label: g.label,
                Icon: g.Icon,
              },
        )}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = tabGroups.find((x) => x.key === key);
          if (g) setActiveTab(g.tabs[0]);
        }}
        navGridClassName="grid-cols-2 md:grid-cols-4 xl:grid-cols-7"
        variant="workspace"
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
            const leaf = TAX_LEAF_BY_KEY[key];
            const active = activeTab === key;
            const LeafIcon = leaf.Icon;
            return (
              <Button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
                variant={active ? "primary" : "secondary"}
                aria-pressed={active}
                className="min-w-11"
              >
                <LeafIcon size={14} strokeWidth={1.9} />
                {leaf.label}
              </Button>
            );
          })}
        </div>
      )}
      {!d && activeTab === "overview" && (
        <div
          style={{
            padding: 48,
            textAlign: "center",
            color: dashboardError ? "#C8312F" : "#71717A",
            fontSize: 14,
          }}
        >
          {dashboardError ? (
            <>
              <div role="alert">Could not load the tax overview</div>
              <Button
                type="button"
                onClick={loadDashboard}
                style={{
                  marginTop: 12,
                }}
                variant="secondary"
                className="min-w-11"
              >
                Retry
              </Button>
            </>
          ) : (
            "Loading overview…"
          )}
        </div>
      )}
      {activeTab === "overview" && quickPnlRead.error && (
        <ActionFeedback error onRetry={quickPnlRead.retry}>
          Could not load the P&L summary.
        </ActionFeedback>
      )}
      {activeTab === "overview" && arRead.error && (
        <ActionFeedback error onRetry={arRead.retry}>
          Could not load the receivables summary.
        </ActionFeedback>
      )}
      {/* Dashboard stats */}
      {d && activeTab === "overview" && (
        <>
          {" "}
          <div
            style={{
              display: "flex",
              gap: 10,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            {" "}
            <StatCard
              label="Tax Collected YTD"
              value={fmtM(d.ytdTaxCollected)}
              color={d.ytdTaxCollected != null ? "#18181B" : "#71717A"}
              sub={d.ytdTaxCollected == null ? "Not recorded" : undefined}
            />{" "}
            <StatCard
              label="Expenses YTD"
              value={fmtM(d.expenses?.total)}
              color={"#52525B"}
              sub={`${d.expenses?.count || 0} records`}
            />{" "}
            <StatCard
              label="Equipment Book Value"
              value={fmtM(d.equipment?.bookValue)}
              color={"#18181B"}
              sub={`${d.equipment?.count || 0} assets`}
            />{" "}
            <StatCard
              label="Next Deadline"
              value={
                d.nextDeadlines?.[0]
                  ? daysUntil(d.nextDeadlines[0].dueDate) < 0
                    ? `${Math.abs(daysUntil(d.nextDeadlines[0].dueDate))}d OVERDUE`
                    : `${daysUntil(d.nextDeadlines[0].dueDate)}d`
                  : "—"
              }
              color={
                d.nextDeadlines?.[0] &&
                daysUntil(d.nextDeadlines[0].dueDate) <= 14
                  ? "#C8312F"
                  : "#18181B"
              }
              sub={d.nextDeadlines?.[0]?.title?.substring(0, 40)}
            />{" "}
          </div>
          {/* Latest advisor */}
          {d.latestReport && (
            <Button
              style={{
                padding: "14px 18px",
                marginBottom: 14,
                cursor: "pointer",
              }}
              onClick={() => setActiveTab("advisor")}
              variant="secondary"
              className="!block h-auto w-full text-left whitespace-normal"
              type="button"
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                {" "}
                <span
                  style={{
                    fontSize: 14,
                    color: "#18181B",
                    fontWeight: 500,
                  }}
                >
                  AI Tax Advisor
                </span>{" "}
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 16,
                    fontWeight: 500,
                    color:
                      {
                        A: "#18181B",
                        B: "#18181B",
                        C: "#52525B",
                      }[d.latestReport.grade] || "#71717A",
                  }}
                >
                  {d.latestReport.grade}
                </span>{" "}
                <span
                  style={{
                    fontSize: 14,
                    color: "#71717A",
                  }}
                >
                  {fmtD(d.latestReport.date)}
                </span>{" "}
              </div>{" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#27272A",
                  lineHeight: 1.5,
                }}
              >
                {d.latestReport.summary?.substring(0, 200)}
                {d.latestReport.summary?.length > 200 ? "..." : ""}
              </div>{" "}
            </Button>
          )}
          {/* Upcoming deadlines */}
          {d.nextDeadlines?.length > 0 && (
            <div
              style={{
                marginBottom: 14,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#09090B",
                  marginBottom: 8,
                }}
              >
                Upcoming Deadlines
              </div>
              {d.nextDeadlines.map((dl) => {
                const days = daysUntil(dl.dueDate);
                return (
                  <Card
                    key={dl.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      marginBottom: 3,
                    }}
                  >
                    {" "}
                    <Badge
                      tone={
                        STATUS_COLORS[dl.status] === "#C8312F"
                          ? "alert"
                          : "neutral"
                      }
                    >
                      {dl.status}
                    </Badge>{" "}
                    <span
                      style={{
                        fontSize: 14,
                        color: "#09090B",
                        flex: 1,
                      }}
                    >
                      {dl.title}
                    </span>{" "}
                    <span
                      style={{
                        fontSize: 14,
                        color: "#71717A",
                      }}
                    >
                      {fmtD(dl.dueDate)}
                    </span>{" "}
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 14,
                        fontWeight: 500,
                        color:
                          days <= 7
                            ? "#C8312F"
                            : days <= 30
                              ? "#52525B"
                              : "#71717A",
                      }}
                    >
                      {days}d
                    </span>{" "}
                  </Card>
                );
              })}
            </div>
          )}
          {/* Quick P&L + A/R + Tax Package row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr",
              gap: 10,
              marginBottom: 14,
            }}
          >
            {/* Quick P&L */}
            <Button
              onClick={() => setActiveTab("pnl")}
              style={{
                padding: "14px 18px",
                cursor: "pointer",
              }}
              variant="secondary"
              className="!block h-auto w-full text-left whitespace-normal"
              type="button"
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                  marginBottom: 8,
                }}
              >
                Quick P&L (MTD)
              </div>
              {quickPnl ? (
                <div
                  style={{
                    fontSize: 14,
                  }}
                >
                  {[
                    ["Revenue", quickPnl.revenue?.total, "#27272A"],
                    ["COGS", quickPnl.cogs?.total, "#27272A"],
                    [
                      "Gross Profit",
                      quickPnl.grossProfit,
                      quickPnl.grossProfit >= 0 ? "#18181B" : "#C8312F",
                    ],
                    ["OpEx", quickPnl.operatingExpenses?.total, "#27272A"],
                    [
                      "Net Income",
                      quickPnl.netIncome,
                      quickPnl.netIncome >= 0 ? "#18181B" : "#C8312F",
                    ],
                  ].map(([label, val, color]) => (
                    <div
                      key={label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "2px 0",
                      }}
                    >
                      {" "}
                      <span
                        style={{
                          color: "#71717A",
                        }}
                      >
                        {label}
                      </span>{" "}
                      <span
                        style={{
                          fontFamily: MONO,
                          color,
                          fontWeight: label === "Net Income" ? 700 : 400,
                        }}
                      >
                        {fmtM(val)}
                      </span>{" "}
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    color: "#71717A",
                    fontSize: 14,
                  }}
                >
                  No data yet
                </div>
              )}
            </Button>
            {/* Outstanding A/R */}
            <Button
              onClick={() => setActiveTab("ar")}
              style={{
                padding: "14px 18px",
                cursor: "pointer",
              }}
              variant="secondary"
              className="!block h-auto w-full text-left whitespace-normal"
              type="button"
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                  marginBottom: 8,
                }}
              >
                Outstanding A/R
              </div>
              {arSummary ? (
                <>
                  {" "}
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 22,
                      fontWeight: 500,
                      color: arSummary.total > 500 ? "#C8312F" : "#09090B",
                      marginBottom: 4,
                    }}
                  >
                    {fmtM(arSummary.total)}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 14,
                      color: "#71717A",
                    }}
                  >
                    {arSummary.count} unpaid invoice
                    {arSummary.count !== 1 ? "s" : ""}
                  </div>
                  {arSummary.over90 > 0 && (
                    <div
                      style={{
                        fontSize: 14,
                        color: "#C8312F",
                        marginTop: 4,
                      }}
                    >
                      {fmtM(arSummary.over90)} over 90 days
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* Not-yet-loaded / failed ≠ zero owed — never a green $0. */}
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 22,
                      fontWeight: 500,
                      color: "#71717A",
                    }}
                  >
                    —
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: "#71717A",
                    }}
                  >
                    Not loaded
                  </div>
                </>
              )}
            </Button>
            {/* Download Tax Package */}
            <Card
              style={{
                padding: "14px 18px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 8,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                }}
              >
                CPA Tax Package
              </div>{" "}
              <Button
                onClick={() => setActiveTab("exports")}
                type="button"
                variant="primary"
                className="min-w-11"
              >
                Download Tax Package
              </Button>{" "}
              <div
                style={{
                  fontSize: 14,
                  color: "#71717A",
                }}
              >
                ZIP with all CSVs + README
              </div>{" "}
            </Card>{" "}
          </div>{" "}
        </>
      )}
      {activeTab === "rates" && <TaxRatesTab />}
      {activeTab === "services" && <ServiceTaxabilityTab />}
      {activeTab === "exemptions" && <ExemptionsTab />}
      {activeTab === "equipment" && <EquipmentTab />}
      {activeTab === "expenses" && <ExpensesTab />}
      {activeTab === "bankimport" && <BankImportTab />}
      {activeTab === "mileage" && <MileageTab />}
      {activeTab === "revenue" && <RevenueTab />}
      {activeTab === "filings" && <FilingCalendarTab />}
      {activeTab === "advisor" && <AdvisorTab />}
      {activeTab === "pnl" && <PnlTab />}
      {activeTab === "exports" && <ExportsTab />}
      {activeTab === "ar" && <AccountsReceivableTab />}
    </UiSurface>
  );
}
