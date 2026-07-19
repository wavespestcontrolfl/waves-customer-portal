import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Calculator,
  ClipboardList,
  Gauge,
  Percent,
  Scale,
  SlidersHorizontal,
} from "lucide-react";
import PricingLogicPanel from "../../components/admin/PricingLogicPanel";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import PricingRealityCheckPage from "./PricingRealityCheckPage";

const ROBOTO = "'Roboto', Arial, sans-serif";

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
  heading: "#09090B",
  input: "#FFFFFF",
};

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const PRICING_SECTIONS = [
  { key: "margins", label: "Margins", Icon: Percent },
  { key: "calibration", label: "Calibration", Icon: Gauge },
  { key: "specs", label: "Service Specs", Icon: ClipboardList },
  { key: "logic", label: "Logic Rules", Icon: SlidersHorizontal },
  { key: "reality", label: "Audit", Icon: Scale },
];

function sectionFromSearchParams(searchParams) {
  const section = searchParams.get("section");
  return PRICING_SECTIONS.some((item) => item.key === section)
    ? section
    : "margins";
}

function scrollToPricingSection(key) {
  const scroll = () => {
    document
      .getElementById(`pricing-${key}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(scroll);
  } else {
    scroll();
  }
}

const af = (p, o = {}) =>
  fetch(`${API_BASE}${p}`, {
    ...o,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...o.headers,
    },
  }).then((r) => r.json());

function adminRawFetch(p, o = {}) {
  return fetch(`${API_BASE}${p}`, {
    ...o,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      ...o.headers,
    },
  });
}

function isoDateOffset(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ── Margin Calculator ──
export function MarginCalculator() {
  const [lotSqFt, setLotSqFt] = useState(10000);
  const [homeSqFt, setHomeSqFt] = useState(2000);
  const [lawnSqFt, setLawnSqFt] = useState(5000);
  const [bedArea, setBedArea] = useState(1500);
  const [tier, setTier] = useState("gold");
  const [margins, setMargins] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchMargins = async () => {
    setLoading(true);
    try {
      const data = await af("/admin/pricing-config/margin-check", {
        method: "POST",
        body: JSON.stringify({
          lotSqFt,
          homeSqFt,
          lawnSqFt,
          bedArea,
          waveguardTier: tier,
        }),
      });
      setMargins(data);
    } catch {
      setMargins(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchMargins();
  }, []);

  const marginColor = (m) => {
    if (m >= 0.45) return D.green;
    if (m >= 0.35) return D.amber;
    return D.red;
  };

  const marginLabel = (m) => {
    if (m >= 0.45) return "Healthy";
    if (m >= 0.35) return "Acceptable";
    return "Below Floor";
  };

  const costSourceLabel = (source) => {
    if (source === "inventory_cost_per_unit") return "Inventory";
    if (source === "inventory_best_price_unit_size") return "Inventory";
    return "Fallback";
  };

  const inputStyle = {
    padding: "8px 10px",
    background: D.input,
    border: `1px solid ${D.border}`,
    borderRadius: 6,
    color: D.heading,
    fontSize: 14,
    width: 90,
    textAlign: "right",
    fontFamily: ROBOTO,
    outline: "none",
  };

  return (
    <div
      style={{
        background: D.card,
        borderRadius: 12,
        border: `1px solid ${D.border}`,
        padding: 20,
        marginBottom: 20,
      }}
    >
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
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 500,
            color: D.heading,
            fontFamily: ROBOTO,
            letterSpacing: "0.02em",
          }}
        >
          Margin Calculator
        </h2>{" "}
        <button
          onClick={fetchMargins}
          disabled={loading}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            background: D.teal,
            color: D.white,
          }}
        >
          {loading ? "Calculating..." : "Calculate"}
        </button>{" "}
      </div>{" "}
      <div
        style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}
      >
        {" "}
        <label style={{ fontSize: 12, color: D.muted }}>
          Lot SqFt
          <input
            type="number"
            value={lotSqFt}
            onChange={(e) => setLotSqFt(Number(e.target.value))}
            style={inputStyle}
          />{" "}
        </label>{" "}
        <label style={{ fontSize: 12, color: D.muted }}>
          Home SqFt
          <input
            type="number"
            value={homeSqFt}
            onChange={(e) => setHomeSqFt(Number(e.target.value))}
            style={inputStyle}
          />{" "}
        </label>{" "}
        <label style={{ fontSize: 12, color: D.muted }}>
          Lawn SqFt
          <input
            type="number"
            value={lawnSqFt}
            onChange={(e) => setLawnSqFt(Number(e.target.value))}
            style={inputStyle}
          />{" "}
        </label>{" "}
        <label style={{ fontSize: 12, color: D.muted }}>
          Bed Area
          <input
            type="number"
            value={bedArea}
            onChange={(e) => setBedArea(Number(e.target.value))}
            style={inputStyle}
          />{" "}
        </label>{" "}
        <label style={{ fontSize: 12, color: D.muted }}>
          WaveGuard
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            style={{ ...inputStyle, width: 110, textAlign: "left" }}
          >
            {" "}
            <option value="bronze">Bronze</option>{" "}
            <option value="silver">Silver</option>{" "}
            <option value="gold">Gold</option>{" "}
            <option value="platinum">Platinum</option>{" "}
          </select>{" "}
        </label>{" "}
      </div>
      {/* The server labels margins by the ENGINE-derived tier for the bundle
          it actually priced. If a min_services retune makes that diverge
          from the selection, say so — never let the operator read gold
          margins under a silver label. */}
      {margins?.waveguardTier && (
        <div
          style={{
            fontSize: 12,
            fontFamily: ROBOTO,
            color: margins.waveguardTierMismatch ? D.amber : D.muted,
            marginBottom: 12,
          }}
        >
          {margins.waveguardTierMismatch
            ? `Engine priced this bundle as ${margins.waveguardTier.toUpperCase()} (requested ${String(margins.waveguardTierRequested || tier).toUpperCase()}) — tier thresholds are out of line with the engine; margins below are ${margins.waveguardTier.toUpperCase()} margins.`
            : `Margins priced at ${margins.waveguardTier.toUpperCase()} tier discounts.`}
        </div>
      )}
      {margins?.services && (
        <div style={{ overflowX: "auto" }}>
          {" "}
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            {" "}
            <thead>
              {" "}
              <tr>
                {" "}
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "left",
                    color: D.muted,
                    borderBottom: `2px solid ${D.border}`,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Service
                </th>{" "}
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "right",
                    color: D.muted,
                    borderBottom: `2px solid ${D.border}`,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Annual Price
                </th>{" "}
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "right",
                    color: D.muted,
                    borderBottom: `2px solid ${D.border}`,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Est. Cost
                </th>{" "}
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "left",
                    color: D.muted,
                    borderBottom: `2px solid ${D.border}`,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Cost Source
                </th>{" "}
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "right",
                    color: D.muted,
                    borderBottom: `2px solid ${D.border}`,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  After Discount
                </th>{" "}
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "right",
                    color: D.muted,
                    borderBottom: `2px solid ${D.border}`,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Margin
                </th>{" "}
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "center",
                    color: D.muted,
                    borderBottom: `2px solid ${D.border}`,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Status
                </th>{" "}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {margins.services.map((s) => (
                <tr
                  key={s.service}
                  style={{ borderBottom: `1px solid ${D.border}22` }}
                >
                  {" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      color: D.text,
                      fontWeight: 600,
                      fontSize: 12,
                      textTransform: "capitalize",
                    }}
                  >
                    {s.service.replace(/_/g, " ")}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      fontFamily: ROBOTO,
                      fontSize: 13,
                    }}
                  >
                    ${s.annual?.toLocaleString() || "—"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      fontFamily: ROBOTO,
                      fontSize: 13,
                      color: D.muted,
                    }}
                  >
                    ${s.estimatedCost?.toLocaleString() || "—"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      color:
                        s.materialCostSource === "fallback" ? D.amber : D.green,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {costSourceLabel(s.materialCostSource)}
                    {s.materialPerVisit != null
                      ? ` · $${Number(s.materialPerVisit).toFixed(2)}/visit`
                      : ""}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      fontFamily: ROBOTO,
                      fontSize: 13,
                    }}
                  >
                    ${s.afterDiscount?.toLocaleString() || "—"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      fontFamily: ROBOTO,
                      fontSize: 13,
                      fontWeight: 700,
                      color: marginColor(s.margin),
                    }}
                  >
                    {s.margin != null ? `${(s.margin * 100).toFixed(1)}%` : "—"}
                  </td>{" "}
                  <td style={{ padding: "8px 10px", textAlign: "center" }}>
                    {s.margin != null && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontWeight: 600,
                          background: `${marginColor(s.margin)}18`,
                          color: marginColor(s.margin),
                        }}
                      >
                        {marginLabel(s.margin)}
                      </span>
                    )}
                  </td>{" "}
                </tr>
              ))}
            </tbody>{" "}
          </table>{" "}
        </div>
      )}
      {margins?.error && (
        <div style={{ color: D.red, fontSize: 12, padding: 10 }}>
          {margins.error}
        </div>
      )}
    </div>
  );
}

function SpecServicesPanel() {
  const SPEC_SERVICES = [
    {
      key: "rodentPlugging",
      fn: "calculatePluggingPrice",
      name: "Rodent Plugging",
      desc: "Entry-point sealing tiered by 1–5 / 6–15 / 16+ pts. $95 standalone, $45 add-on. 65% margin target.",
    },
    {
      key: "termiteFoam",
      fn: "calculateFoamPrice",
      name: "Termite Foam",
      desc: "Termidor Foam spot treatment per app point + cans (~$30/can). $125 min. 15% bundle discount with liquid barrier.",
    },
    {
      key: "stingingV2",
      fn: "calculateStingingPrice",
      name: "Stinging Insect",
      desc: "Multiplier stack: nest type × location × urgency / after-hours. Mins: $95 / $125 / $175.",
    },
    {
      key: "exclusionV2",
      fn: "calculateExclusionPrice",
      name: "Exclusion (Full)",
      desc: "sqft tiers $395 / $595 / $895 / $1,295. Tile roof 1.4×, 2-story 1.3×. multiVisit flag at >4hr.",
    },
    {
      key: "rodentGuaranteeCombo",
      fn: "calculateRodentGuaranteeCombo",
      name: "Rodent Guarantee Combo",
      desc: "Exclusion + Bait Stations + 12/24-mo guarantee. 10% bundle discount, 15–25% guarantee premium. Min $695 / $995. Auto-applies postExclusion modifier on bait stations (~28% off standalone, $55/mo floor).",
    },
  ];
  return (
    <div
      style={{
        background: D.card,
        borderRadius: 12,
        border: `1px solid ${D.border}`,
        padding: 20,
        marginBottom: 20,
      }}
    >
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        {" "}
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 500,
            color: D.heading,
            fontFamily: ROBOTO,
            letterSpacing: "0.02em",
          }}
        >
          Missing-Services Pricing Spec
        </h2>{" "}
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "3px 10px",
            borderRadius: 12,
            background: D.green + "22",
            color: D.green,
            border: `1px solid ${D.green}55`,
          }}
        >
          Linked to Estimator Engine
        </span>{" "}
      </div>{" "}
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 14 }}>
        These five services are wired into{" "}
        <code style={{ fontFamily: ROBOTO }}>generateEstimate()</code>via the{" "}
        <code style={{ fontFamily: ROBOTO }}>services.&lt;key&gt;</code>input.
        Spec doc:{" "}
        <code style={{ fontFamily: ROBOTO }}>
          missing-services-pricing-spec.md
        </code>
        .
      </div>{" "}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
        {SPEC_SERVICES.map((s) => (
          <div
            key={s.key}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 14,
              padding: 12,
              background: D.bg,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
            }}
          >
            {" "}
            <div>
              {" "}
              <div style={{ fontSize: 13, fontWeight: 700, color: D.heading }}>
                {s.name}
              </div>{" "}
              <div
                style={{
                  fontSize: 11,
                  color: D.muted,
                  fontFamily: ROBOTO,
                  marginTop: 2,
                }}
              >
                services.{s.key}
              </div>{" "}
              <div
                style={{
                  fontSize: 10,
                  color: D.teal,
                  fontFamily: ROBOTO,
                  marginTop: 2,
                }}
              >
                {s.fn}()
              </div>{" "}
            </div>{" "}
            <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>
              {s.desc}
            </div>{" "}
          </div>
        ))}
      </div>{" "}
    </div>
  );
}

function fmtMin(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.0 min";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)} min`;
}

function PestCalibrationPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [startDate, setStartDate] = useState(() => isoDateOffset(90));
  const [endDate, setEndDate] = useState(() => isoDateOffset(0));
  const [limit, setLimit] = useState("150");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({
        startDate,
        endDate,
        limit,
      });
      setData(
        await af(`/admin/pricing-config/pest-calibration?${qs.toString()}`),
      );
    } catch (err) {
      setError(err.message || "Failed to load pest calibration");
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = async () => {
    setDownloading(true);
    setError("");
    try {
      const qs = new URLSearchParams({
        startDate,
        endDate,
        limit: "10000",
        format: "csv",
      });
      const response = await adminRawFetch(
        `/admin/pricing-config/pest-calibration?${qs.toString()}`,
      );
      if (!response.ok)
        throw new Error(`CSV export failed (${response.status})`);
      const text = await response.text();
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `pest-production-calibration-${startDate}-to-${endDate}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || "Failed to export pest calibration CSV");
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const summary = data?.summary || {};
  const records = data?.records || [];
  const poolRows = summary.byPoolCageSize || [];
  const lotRows = summary.byLotBand || [];
  const sampleHealth = data?.sampleHealth || {};
  const reviewQueue = summary.reviewQueue || [];

  return (
    <div
      style={{
        background: D.card,
        borderRadius: 12,
        border: `1px solid ${D.border}`,
        padding: 20,
        marginBottom: 20,
      }}
    >
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        {" "}
        <div>
          {" "}
          <h2
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 700,
              color: D.heading,
              fontFamily: ROBOTO,
            }}
          >
            Pest Production Calibration
          </h2>{" "}
          <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>
            Shadow estimator minutes compared with completed job timers from
            accepted estimates.
          </div>{" "}
        </div>{" "}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          {" "}
          <label
            style={{
              display: "grid",
              gap: 3,
              fontSize: 10,
              color: D.muted,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            Start
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{
                padding: "7px 8px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                fontSize: 12,
                color: D.heading,
              }}
            />{" "}
          </label>{" "}
          <label
            style={{
              display: "grid",
              gap: 3,
              fontSize: 10,
              color: D.muted,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            End
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{
                padding: "7px 8px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                fontSize: 12,
                color: D.heading,
              }}
            />{" "}
          </label>{" "}
          <label
            style={{
              display: "grid",
              gap: 3,
              fontSize: 10,
              color: D.muted,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            Rows
            <select
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              style={{
                padding: "7px 8px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                fontSize: 12,
                color: D.heading,
                background: D.input,
              }}
            >
              {" "}
              <option value="50">50</option> <option value="150">150</option>{" "}
              <option value="500">500</option>{" "}
            </select>{" "}
          </label>{" "}
          <button
            onClick={load}
            disabled={loading}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: `1px solid ${D.border}`,
              cursor: loading ? "default" : "pointer",
              background: D.input,
              color: D.heading,
              fontSize: 12,
              fontWeight: 600,
              alignSelf: "end",
            }}
          >
            {loading ? "Syncing..." : "Sync"}
          </button>{" "}
          <button
            onClick={downloadCsv}
            disabled={downloading || loading || data?.sync?.unavailable}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              cursor: downloading || loading ? "default" : "pointer",
              background: D.heading,
              color: D.white,
              fontSize: 12,
              fontWeight: 700,
              alignSelf: "end",
              opacity:
                downloading || loading || data?.sync?.unavailable ? 0.55 : 1,
            }}
          >
            {downloading ? "Exporting..." : "Export CSV"}
          </button>{" "}
        </div>{" "}
      </div>
      {error && (
        <div style={{ color: D.red, fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {data?.sync?.unavailable && (
        <div style={{ color: D.amber, fontSize: 12, marginBottom: 12 }}>
          Calibration table is not migrated yet. Run database migrations before
          collecting samples.
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        {[
          { label: "Samples", value: summary.count || 0, color: D.heading },
          {
            label: "Avg miss",
            value: fmtMin(summary.avgDelta || 0),
            color: Math.abs(summary.avgDelta || 0) >= 8 ? D.amber : D.green,
          },
          {
            label: "Avg abs miss",
            value: fmtMin(summary.avgAbsDelta || 0),
            color: (summary.avgAbsDelta || 0) >= 12 ? D.amber : D.heading,
          },
          {
            label: "15+ min outliers",
            value: summary.outlierCount || 0,
            color: (summary.outlierCount || 0) > 0 ? D.red : D.green,
          },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              background: D.bg,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              padding: 12,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: card.color,
                fontFamily: ROBOTO,
              }}
            >
              {card.value}
            </div>{" "}
            <div
              style={{
                fontSize: 10,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginTop: 3,
              }}
            >
              {card.label}
            </div>{" "}
          </div>
        ))}
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        {[
          {
            label: "Jobs synced",
            value: sampleHealth.jobsEvaluated || 0,
            color: D.heading,
          },
          {
            label: "Materialized",
            value: sampleHealth.materializedCount || 0,
            color: D.green,
          },
          {
            label: "Fallback matched",
            value: sampleHealth.fallbackMatchedCount || 0,
            color: D.heading,
          },
          {
            label: "No est. link",
            value: sampleHealth.missingEstimateLinkCount || 0,
            color:
              (sampleHealth.missingEstimateLinkCount || 0) > 0
                ? D.amber
                : D.muted,
          },
          {
            label: "No timer",
            value: sampleHealth.missingTimerCount || 0,
            color:
              (sampleHealth.missingTimerCount || 0) > 0 ? D.amber : D.muted,
          },
          {
            label: "No diagnostics",
            value: sampleHealth.missingDiagnosticsCount || 0,
            color:
              (sampleHealth.missingDiagnosticsCount || 0) > 0 ? D.red : D.muted,
          },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              background: D.bg,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              padding: 10,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: card.color,
                fontFamily: ROBOTO,
              }}
            >
              {card.value}
            </div>{" "}
            <div
              style={{
                fontSize: 10,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginTop: 3,
              }}
            >
              {card.label}
            </div>{" "}
          </div>
        ))}
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 14,
          marginBottom: 16,
        }}
      >
        {" "}
        <CalibrationGroup title="By Pool Cage Size" rows={poolRows} />{" "}
        <CalibrationGroup title="By Lot Band" rows={lotRows} />{" "}
      </div>
      {reviewQueue.length > 0 && (
        <div
          style={{
            background: D.bg,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
          }}
        >
          {" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 8,
            }}
          >
            {" "}
            <div style={{ fontSize: 12, fontWeight: 700, color: D.heading }}>
              Needs Calibration Review
            </div>{" "}
            <div style={{ fontSize: 11, color: D.muted }}>
              {summary.reviewQueueCount || reviewQueue.length} flagged
            </div>{" "}
          </div>{" "}
          <div style={{ overflowX: "auto" }}>
            {" "}
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              {" "}
              <thead>
                {" "}
                <tr>
                  {["Date", "Customer", "Delta", "Pool", "Lot", "Why"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          textAlign:
                            h === "Customer" || h === "Why" ? "left" : "right",
                          padding: "7px 8px",
                          borderBottom: `1px solid ${D.border}`,
                          color: D.muted,
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>{" "}
              </thead>{" "}
              <tbody>
                {reviewQueue.slice(0, 8).map((row) => {
                  const why = Array.isArray(row.calibration_review_reasons)
                    ? row.calibration_review_reasons.join(", ")
                    : "";
                  return (
                    <tr
                      key={`review-${row.id || row.scheduled_service_id}`}
                      style={{ borderBottom: `1px solid ${D.border}66` }}
                    >
                      {" "}
                      <td
                        style={{
                          padding: "7px 8px",
                          textAlign: "right",
                          color: D.text,
                        }}
                      >
                        {String(row.service_date || "").slice(0, 10) || "-"}
                      </td>{" "}
                      <td
                        style={{
                          padding: "7px 8px",
                          color: D.heading,
                          fontWeight: 600,
                        }}
                      >
                        {row.customer_name || row.address_line1 || "Unknown"}
                      </td>{" "}
                      <td
                        style={{
                          padding: "7px 8px",
                          textAlign: "right",
                          color: D.red,
                          fontWeight: 700,
                        }}
                      >
                        {fmtMin(row.delta_minutes || 0)}
                      </td>{" "}
                      <td
                        style={{
                          padding: "7px 8px",
                          textAlign: "right",
                          color: D.text,
                        }}
                      >
                        {row.pool_cage_size || "-"}
                      </td>{" "}
                      <td
                        style={{
                          padding: "7px 8px",
                          textAlign: "right",
                          color: D.text,
                        }}
                      >
                        {row.lot_sqft
                          ? Number(row.lot_sqft).toLocaleString()
                          : "-"}
                      </td>{" "}
                      <td style={{ padding: "7px 8px", color: D.muted }}>
                        {why || "-"}
                      </td>{" "}
                    </tr>
                  );
                })}
              </tbody>{" "}
            </table>{" "}
          </div>{" "}
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        {" "}
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
        >
          {" "}
          <thead>
            {" "}
            <tr>
              {[
                "Date",
                "Customer",
                "Pool",
                "Lot",
                "Pred",
                "Actual",
                "Delta",
                "Confidence",
                "Reasons",
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: h === "Customer" ? "left" : "right",
                    padding: "8px 10px",
                    borderBottom: `1px solid ${D.border}`,
                    color: D.muted,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>{" "}
          </thead>{" "}
          <tbody>
            {records.slice(0, 50).map((row) => {
              const delta = Number(row.delta_minutes || 0);
              const reasons = Array.isArray(row.review_reasons)
                ? row.review_reasons.join(", ")
                : "";
              return (
                <tr
                  key={row.id || row.scheduled_service_id}
                  style={{ borderBottom: `1px solid ${D.border}66` }}
                >
                  {" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color: D.text,
                    }}
                  >
                    {String(row.service_date || "").slice(0, 10) || "-"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      color: D.heading,
                      fontWeight: 600,
                    }}
                  >
                    {row.customer_name || row.address_line1 || "Unknown"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color: D.text,
                    }}
                  >
                    {row.pool_cage_size || "-"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color: D.text,
                    }}
                  >
                    {row.lot_sqft ? Number(row.lot_sqft).toLocaleString() : "-"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color: D.text,
                    }}
                  >
                    {Number(row.predicted_minutes || 0).toFixed(1)}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color: D.text,
                    }}
                  >
                    {Number(row.actual_minutes || 0).toFixed(1)}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color:
                        Math.abs(delta) >= 15
                          ? D.red
                          : Math.abs(delta) >= 8
                            ? D.amber
                            : D.green,
                      fontWeight: 700,
                    }}
                  >
                    {fmtMin(delta)}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color: D.muted,
                    }}
                  >
                    {row.pricing_confidence || "-"}
                  </td>{" "}
                  <td
                    style={{
                      padding: "8px 10px",
                      textAlign: "right",
                      color: D.muted,
                      maxWidth: 220,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={reasons}
                  >
                    {reasons || "-"}
                  </td>{" "}
                </tr>
              );
            })}
            {!loading && records.length === 0 && (
              <tr>
                {" "}
                <td
                  colSpan="9"
                  style={{ padding: 18, textAlign: "center", color: D.muted }}
                >
                  No calibration samples yet. Completed pest jobs need an
                  accepted estimate link and a completed job timer.
                </td>{" "}
              </tr>
            )}
          </tbody>{" "}
        </table>{" "}
      </div>{" "}
    </div>
  );
}

function CalibrationGroup({ title, rows }) {
  return (
    <div
      style={{
        background: D.bg,
        border: `1px solid ${D.border}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      {" "}
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: D.heading,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {(rows || []).slice(0, 6).map((row) => (
        <div
          key={row.key}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 60px 78px 78px",
            gap: 8,
            padding: "5px 0",
            borderTop: `1px solid ${D.border}88`,
            alignItems: "center",
          }}
        >
          {" "}
          <span
            style={{ color: D.text, fontSize: 12, textTransform: "capitalize" }}
          >
            {row.key}
          </span>{" "}
          <span style={{ color: D.muted, fontSize: 12, textAlign: "right" }}>
            {row.count}
          </span>{" "}
          <span style={{ color: D.text, fontSize: 12, textAlign: "right" }}>
            {fmtMin(row.avgDelta)}
          </span>{" "}
          <span style={{ color: D.muted, fontSize: 12, textAlign: "right" }}>
            {fmtMin(row.avgAbsDelta)}
          </span>{" "}
        </div>
      ))}
      {(!rows || rows.length === 0) && (
        <div style={{ color: D.muted, fontSize: 12 }}>No samples yet.</div>
      )}
    </div>
  );
}

export default function PricingLogicPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = sectionFromSearchParams(searchParams);
  const [activeSection, setActiveSection] = useState(requestedSection);
  const focusedService = searchParams.get("service");
  const focus = searchParams.get("focus");
  const serviceLabel = focusedService ? focusedService.replace(/_/g, " ") : "";

  useEffect(() => {
    setActiveSection(requestedSection);
    if (requestedSection === "margins") return;
    scrollToPricingSection(requestedSection);
  }, [requestedSection]);

  const handleSectionChange = (key) => {
    setActiveSection(key);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("section", key);
    setSearchParams(nextParams, { replace: true });
    scrollToPricingSection(key);
  };

  return (
    <div style={{ padding: "0 0 60px", fontFamily: ROBOTO }}>
      {" "}
      <div style={{ maxWidth: 1300, margin: "0 auto" }}>
        {" "}
        <AdminCommandHeader
          title="Pricing"
          icon={Calculator}
          sections={PRICING_SECTIONS}
          activeKey={activeSection}
          onSectionChange={handleSectionChange}
          navGridClassName="grid-cols-2 md:grid-cols-5"
        />
        {focus === "margin" && (
          <div
            style={{
              background: `${D.amber}14`,
              border: `1px solid ${D.amber}44`,
              borderRadius: 10,
              padding: 14,
              marginBottom: 16,
              color: D.text,
              fontSize: 13,
            }}
          >
            Review margin rules{serviceLabel ? ` for ${serviceLabel}` : ""}. The
            estimate audit flagged this service below the pricing floor.
          </div>
        )}
        <section id="pricing-margins">
          {" "}
          <MarginCalculator />{" "}
        </section>{" "}
        <section id="pricing-calibration">
          {" "}
          <PestCalibrationPanel />{" "}
        </section>{" "}
        <section id="pricing-specs">
          {" "}
          <SpecServicesPanel />{" "}
        </section>{" "}
        <section id="pricing-logic">
          {" "}
          <PricingLogicPanel />{" "}
        </section>{" "}
        <section id="pricing-reality">
          {" "}
          {activeSection === "reality" && <PricingRealityCheckPage />}{" "}
        </section>{" "}
      </div>{" "}
    </div>
  );
}
