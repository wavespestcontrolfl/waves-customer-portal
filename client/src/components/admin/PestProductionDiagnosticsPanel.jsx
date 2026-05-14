import React from "react";

const COLORS = {
  ink: "#0F172A",
  muted: "#64748B",
  line: "#E2E8F0",
  soft: "#F8FAFC",
  amber: "#A16207",
  red: "#B91C1C",
  green: "#166534",
  blue: "#0A7EC2",
};

const BREAKDOWN_LABELS = {
  baseStop: "Base stop",
  footprint: "Footprint",
  lot: "Lot",
  poolCage: "Pool cage",
  pool: "Pool deck",
  shrubs: "Shrubs",
  trees: "Trees",
  complexity: "Landscape",
  largeDriveway: "Large driveway",
  nearWater: "Near water",
  attachedGarage: "Attached garage",
  outbuildings: "Outbuildings",
};

const REASON_LABELS = {
  stories_estimated: "Stories estimated",
  pool_cage_size_inferred: "Pool cage size inferred",
  large_lot: "Large lot",
  very_large_lot: "Very large lot",
  large_pool_cage: "Large pool cage",
  oversized_pool_cage: "Oversized pool cage",
  complex_heavy_vegetation: "Complex heavy vegetation",
  multiple_outbuildings: "Multiple outbuildings",
  estimated_service_time_45_plus: "Estimated service time 45+ min",
  estimated_service_time_60_plus: "Estimated service time 60+ min",
  missing_home_sqft: "Missing home square footage",
  missing_lot_size: "Missing lot size",
};

function titleize(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatReason(reason) {
  return REASON_LABELS[reason] || titleize(reason);
}

function formatBreakdownValue(value) {
  const numeric = Number(value) || 0;
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric} min`;
}

function confidenceMeta(confidence) {
  if (confidence === "low") {
    return { label: "Review required", color: COLORS.red, bg: "#FEF2F2" };
  }
  if (confidence === "medium") {
    return { label: "Review recommended", color: COLORS.amber, bg: "#FEFCE8" };
  }
  return { label: "High", color: COLORS.green, bg: "#F0FDF4" };
}

export default function PestProductionDiagnosticsPanel({ diagnostics }) {
  if (!diagnostics) return null;

  const confidence = String(
    diagnostics.pricingConfidence || diagnostics.confidence || "high",
  ).toLowerCase();
  const confidenceStyle = confidenceMeta(confidence);
  const reasons = [
    ...new Set(
      diagnostics.reviewReasons || diagnostics.manualReviewReasons || [],
    ),
  ];
  const breakdown = Object.entries(diagnostics.breakdown || {}).filter(
    ([, value]) => Number(value) !== 0,
  );
  const poolCageSize = diagnostics.poolCageSize || "none";
  const poolCageSizeInferred =
    diagnostics.poolCageSizeInferred ||
    reasons.includes("pool_cage_size_inferred");
  const poolCageSource =
    diagnostics.poolCageSizeSource ||
    (poolCageSize === "none"
      ? "none"
      : poolCageSizeInferred
        ? "inferred"
        : "explicit");

  return (
    <div style={{ marginBottom: 24 }}>
      {" "}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
        }}
      >
        {" "}
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: COLORS.ink,
            textTransform: "uppercase",
            letterSpacing: 0.8,
          }}
        >
          Pest Production Diagnostics
        </div>{" "}
        <span
          style={{
            border: `1px solid ${COLORS.blue}33`,
            background: "#EFF6FF",
            color: COLORS.blue,
            borderRadius: 999,
            padding: "3px 8px",
            fontSize: 10,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            whiteSpace: "nowrap",
          }}
        >
          Shadow mode
        </span>{" "}
      </div>{" "}
      <div
        style={{
          border: `1px solid ${COLORS.line}`,
          background: COLORS.soft,
          borderRadius: 8,
          padding: 12,
        }}
      >
        {" "}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginBottom: 12,
          }}
        >
          {" "}
          <Metric
            label="Estimated service time"
            value={`${diagnostics.estimatedMinutes || 0} min`}
            strong
          />{" "}
          <Metric
            label="Pricing confidence"
            value={confidenceStyle.label}
            color={confidenceStyle.color}
            bg={confidenceStyle.bg}
          />{" "}
          <Metric label="Pricing mode" value="Shadow only" />{" "}
          <Metric
            label="Pool cage size"
            value={
              poolCageSize === "none"
                ? "None"
                : `${titleize(poolCageSize)} (${poolCageSource})`
            }
            color={poolCageSizeInferred ? COLORS.amber : COLORS.ink}
          />{" "}
        </div>
        {breakdown.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {" "}
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: COLORS.muted,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                marginBottom: 6,
              }}
            >
              Minute Breakdown
            </div>{" "}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                columnGap: 16,
                rowGap: 4,
                fontSize: 12,
                color: COLORS.muted,
              }}
            >
              {breakdown.map(([key, value]) => (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  {" "}
                  <span>{BREAKDOWN_LABELS[key] || titleize(key)}</span>{" "}
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color: COLORS.ink,
                    }}
                  >
                    {formatBreakdownValue(value)}
                  </span>{" "}
                </div>
              ))}
            </div>{" "}
          </div>
        )}
        {reasons.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {" "}
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: COLORS.muted,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                marginBottom: 6,
              }}
            >
              Review Reasons
            </div>{" "}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {reasons.map((reason) => (
                <span
                  key={reason}
                  style={{
                    border: `1px solid ${COLORS.amber}33`,
                    background: "#FEFCE8",
                    color: COLORS.amber,
                    borderRadius: 999,
                    padding: "3px 8px",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {formatReason(reason)}
                </span>
              ))}
            </div>{" "}
          </div>
        )}
        <div
          style={{
            marginTop: 12,
            fontSize: 11,
            color: COLORS.muted,
            lineHeight: 1.4,
          }}
        >
          These minutes are for calibration and manual review only. They do not
          drive the customer price yet.
        </div>{" "}
      </div>{" "}
    </div>
  );
}

function Metric({
  label,
  value,
  strong = false,
  color = COLORS.ink,
  bg = "#FFFFFF",
}) {
  return (
    <div
      style={{
        border: `1px solid ${COLORS.line}`,
        background: bg,
        borderRadius: 6,
        padding: "8px 10px",
        minWidth: 0,
      }}
    >
      {" "}
      <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 3 }}>
        {label}
      </div>{" "}
      <div
        style={{
          fontSize: strong ? 15 : 12,
          fontWeight: strong ? 800 : 700,
          color,
          fontFamily: strong ? "'JetBrains Mono', monospace" : undefined,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>{" "}
    </div>
  );
}
