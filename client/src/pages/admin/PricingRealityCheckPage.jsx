import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { adminFetch } from "../../lib/adminFetch";

const D = {
  card: "#FFFFFF",
  border: "#E4E4E7",
  heading: "#09090B",
  text: "#27272A",
  muted: "#71717A",
  green: "#15803D",
  red: "#991B1B",
  amber: "#A16207",
  ink: "#18181B",
  softGreen: "#ECFDF3",
  softRed: "#FEF2F2",
};

const LOOKBACK_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
];

const GROUP_OPTIONS = [
  { key: "service_type", label: "Service type" },
  { key: "lawn_care_track", label: "Lawn-care track" },
  { key: "sqft_band", label: "Sqft band" },
  { key: "zone", label: "Zone" },
  { key: "technician", label: "Technician" },
  { key: "month", label: "Month" },
  { key: "billing_cohort", label: "Billing cohort" },
];

const ET_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const EMPTY_FILTERS = {
  serviceType: "",
  lawnCareTrack: "",
  sqftBand: "",
  zoneId: "",
  technicianId: "",
  month: "",
  billingCohort: "",
};

const cardStyle = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};

const labelStyle = {
  fontSize: 11,
  fontWeight: 700,
  color: D.muted,
  marginBottom: 6,
};

const selectStyle = {
  width: "100%",
  minHeight: 40,
  border: `1px solid ${D.border}`,
  borderRadius: 6,
  background: D.card,
  color: D.text,
  fontSize: 13,
  padding: "0 10px",
  boxSizing: "border-box",
};

function fmtNumber(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtMinutes(value) {
  return `${fmtNumber(value, 1)} min`;
}

function fmtPercent(value) {
  return `${fmtNumber(value, 1)}%`;
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtETDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = ET_DATE_FORMATTER.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function marginColor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return D.text;
  return n < 0 ? D.red : D.green;
}

function deltaColor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return D.text;
  return n > 0 ? D.red : D.green;
}

export function sortSegmentsWorstMarginFirst(segments = []) {
  return [...segments].sort(
    (a, b) => Number(a.totalDollarMarginImpact || 0) - Number(b.totalDollarMarginImpact || 0),
  );
}

export function buildPricingRealityQuery({ lookbackDays, groupBy, filters }) {
  const params = new URLSearchParams({
    lookbackDays: String(lookbackDays || 90),
    groupBy: groupBy || "service_type",
  });
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}

async function loadPricingReality({ lookbackDays, groupBy, filters }) {
  const query = buildPricingRealityQuery({ lookbackDays, groupBy, filters });
  const response = await adminFetch(`/admin/pricing-reality-check?${query}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Pricing audit failed (${response.status})`);
  }
  return response.json();
}

function FilterSelect({ label, value, onChange, options, placeholder = "All" }) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <div style={labelStyle}>{label}</div>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={selectStyle}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => {
          const id = typeof option === "string" ? option : option.id;
          const optionLabel = typeof option === "string" ? option : option.label;
          return (
            <option key={id} value={id}>
              {optionLabel}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function KpiCard({ label, value, tone }) {
  const color = tone === "good" ? D.green : tone === "bad" ? D.red : D.heading;
  return (
    <div style={{ ...cardStyle, padding: 16, minHeight: 86 }}>
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 600, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, color, fontWeight: 750, lineHeight: 1.1 }}>
        {value}
      </div>
    </div>
  );
}

function CoverageStrip({ coverage }) {
  const c = coverage || {};
  return (
    <div
      style={{
        ...cardStyle,
        padding: "10px 12px",
        display: "flex",
        gap: 14,
        flexWrap: "wrap",
        alignItems: "center",
        fontSize: 12,
        color: D.muted,
      }}
    >
      <span>Completed: <strong style={{ color: D.heading }}>{c.completedServiceCount || 0}</strong></span>
      <span>Included: <strong style={{ color: D.heading }}>{c.includedServiceCount || 0}</strong></span>
      <span>Missing quote: <strong style={{ color: D.amber }}>{c.excludedMissingQuoteCount || 0}</strong></span>
      <span>Missing actual: <strong style={{ color: D.amber }}>{c.excludedMissingActualCount || 0}</strong></span>
      <span>Invalid duration: <strong style={{ color: D.red }}>{c.excludedInvalidDurationCount || 0}</strong></span>
    </div>
  );
}

function SegmentTable({ segments }) {
  const rows = sortSegmentsWorstMarginFirst(segments);
  return (
    <section style={{ ...cardStyle, overflow: "hidden" }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}` }}>
        <h2 style={{ margin: 0, fontSize: 16, color: D.heading }}>Segment variance</h2>
        <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
          Margin impact is (quoted minutes - actual minutes) / 60 * $35. Negative means actual labor exceeded quoted labor.
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["Segment", "Services", "Avg quoted", "Avg actual", "Avg delta", "Weighted variance", "Margin impact", "Avg margin", "Outliers"].map((header) => (
                <th
                  key={header}
                  style={{
                    padding: "10px 12px",
                    textAlign: header === "Segment" ? "left" : "right",
                    color: D.muted,
                    fontSize: 11,
                    borderBottom: `1px solid ${D.border}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={{ borderBottom: `1px solid ${D.border}80` }}>
                <td style={{ padding: "10px 12px", color: D.heading, fontWeight: 650 }}>{row.label}</td>
                <td style={{ padding: "10px 12px", textAlign: "right" }}>{row.serviceCount}</td>
                <td style={{ padding: "10px 12px", textAlign: "right" }}>{fmtMinutes(row.avgQuotedMinutes)}</td>
                <td style={{ padding: "10px 12px", textAlign: "right" }}>{fmtMinutes(row.avgActualMinutes)}</td>
                <td style={{ padding: "10px 12px", textAlign: "right", color: deltaColor(row.avgVarianceMinutes), fontWeight: 700 }}>
                  {fmtMinutes(row.avgVarianceMinutes)}
                </td>
                <td style={{ padding: "10px 12px", textAlign: "right" }}>{fmtPercent(row.weightedPercentVariance)}</td>
                <td style={{ padding: "10px 12px", textAlign: "right", color: marginColor(row.totalDollarMarginImpact), fontWeight: 750 }}>
                  {fmtMoney(row.totalDollarMarginImpact)}
                </td>
                <td style={{ padding: "10px 12px", textAlign: "right", color: marginColor(row.avgDollarMarginImpact) }}>
                  {fmtMoney(row.avgDollarMarginImpact)}
                </td>
                <td style={{ padding: "10px 12px", textAlign: "right" }}>{row.outlierCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function customerLink(row) {
  if (!row.customerId) return null;
  return `/admin/customers?customerId=${encodeURIComponent(row.customerId)}`;
}

function OutliersTable({ outliers }) {
  return (
    <section style={{ ...cardStyle, overflow: "hidden" }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${D.border}` }}>
        <h2 style={{ margin: 0, fontSize: 16, color: D.heading }}>Outlier services</h2>
        <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
          Sorted by absolute z-score across the selected window and filters.
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["Service date", "Service", "Customer/property", "Service type", "Lawn track", "Sqft band", "Zone", "Technician", "Quoted", "Actual", "Delta", "Variance", "Margin impact", "Z-score", "Billing"].map((header) => (
                <th
                  key={header}
                  style={{
                    padding: "10px 12px",
                    textAlign: ["Service", "Customer/property", "Service type", "Lawn track", "Sqft band", "Zone", "Technician", "Billing"].includes(header) ? "left" : "right",
                    color: D.muted,
                    fontSize: 11,
                    borderBottom: `1px solid ${D.border}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {outliers.map((row) => {
              const link = customerLink(row);
              return (
                <tr key={row.serviceId} style={{ borderBottom: `1px solid ${D.border}80` }}>
                  <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                    {fmtETDate(row.completedAt)}
                  </td>
                  <td style={{ padding: "10px 12px", fontWeight: 650, color: D.heading }}>
                    <a href={`/admin/dispatch?serviceId=${encodeURIComponent(row.serviceId)}`} style={{ color: D.heading }}>
                      {row.serviceId}
                    </a>
                  </td>
                  <td style={{ padding: "10px 12px", minWidth: 180 }}>
                    {link ? (
                      <a href={link} style={{ color: D.heading, fontWeight: 650 }}>
                        {row.customerName || row.propertyLabel || row.customerId}
                      </a>
                    ) : (
                      <span>{row.propertyLabel || "-"}</span>
                    )}
                  </td>
                  <td style={{ padding: "10px 12px" }}>{row.serviceType || "-"}</td>
                  <td style={{ padding: "10px 12px" }}>{row.lawnCareTrack || "-"}</td>
                  <td style={{ padding: "10px 12px" }}>{row.sqftBand || "-"}</td>
                  <td style={{ padding: "10px 12px" }}>{row.zone || "-"}</td>
                  <td style={{ padding: "10px 12px" }}>{row.technician || "-"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>{fmtMinutes(row.quotedMinutes)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>{fmtMinutes(row.actualMinutes)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: deltaColor(row.varianceMinutes), fontWeight: 700 }}>
                    {fmtMinutes(row.varianceMinutes)}
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>{fmtPercent(row.percentVariance)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: marginColor(row.dollarMarginImpact), fontWeight: 750 }}>
                    {fmtMoney(row.dollarMarginImpact)}
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>{fmtNumber(row.zScore, 2)}</td>
                  <td style={{ padding: "10px 12px" }}>{row.billingCohort || "-"}</td>
                </tr>
              );
            })}
            {!outliers.length && (
              <tr>
                <td colSpan={15} style={{ padding: 18, color: D.muted, textAlign: "center" }}>
                  No outlier services for the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PricingRealityCheckPage() {
  const [lookbackDays, setLookbackDays] = useState("90");
  const [groupBy, setGroupBy] = useState("service_type");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await loadPricingReality({ lookbackDays, groupBy, filters });
      setData(payload);
    } catch (err) {
      setError(err.message || "Failed to load pricing audit");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [lookbackDays, groupBy, filters]);

  const summary = data?.summary || {};
  const coverage = data?.coverage || {};
  const available = data?.availableFilters || {};
  const segments = useMemo(() => sortSegmentsWorstMarginFirst(data?.segments || []), [data?.segments]);
  const emptyIncluded = !loading && !error && Number(coverage.includedServiceCount || 0) === 0;
  const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  return (
    <div style={{ maxWidth: 1320, margin: "0 auto", color: D.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, color: D.heading, fontWeight: 760 }}>Audit</h1>
          <div style={{ marginTop: 5, color: D.muted, fontSize: 13 }}>
            Read-only comparison of quoted pricing minutes vs Bouncie actual on-site minutes.
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, padding: "5px 8px", borderRadius: 6, background: D.softGreen, color: D.green, fontSize: 12, fontWeight: 700 }}>
            <ShieldCheck size={14} strokeWidth={2} />
            Read-only. No pricing engine writes.
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          style={{ minHeight: 40, display: "inline-flex", alignItems: "center", gap: 8, border: `1px solid ${D.border}`, borderRadius: 6, background: D.card, color: D.heading, padding: "0 12px", fontSize: 13, fontWeight: 650, cursor: loading ? "wait" : "pointer" }}
        >
          <RefreshCw size={15} strokeWidth={2} />
          Refresh
        </button>
      </div>

      <div style={{ ...cardStyle, padding: 14, marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
          <FilterSelect label="Lookback" value={lookbackDays} onChange={setLookbackDays} options={LOOKBACK_OPTIONS.map((o) => ({ id: o.value, label: o.label }))} placeholder="Lookback" />
          <FilterSelect label="Service type" value={filters.serviceType} onChange={(value) => setFilter("serviceType", value)} options={available.serviceTypes || []} />
          <FilterSelect label="Lawn-care track" value={filters.lawnCareTrack} onChange={(value) => setFilter("lawnCareTrack", value)} options={available.lawnCareTracks || []} />
          <FilterSelect label="Sqft band" value={filters.sqftBand} onChange={(value) => setFilter("sqftBand", value)} options={available.sqftBands || []} />
          <FilterSelect label="Zone" value={filters.zoneId} onChange={(value) => setFilter("zoneId", value)} options={available.zones || []} />
          <FilterSelect label="Technician" value={filters.technicianId} onChange={(value) => setFilter("technicianId", value)} options={available.technicians || []} />
          <FilterSelect label="Month" value={filters.month} onChange={(value) => setFilter("month", value)} options={available.months || []} />
          <FilterSelect label="Billing cohort" value={filters.billingCohort} onChange={(value) => setFilter("billingCohort", value)} options={available.billingCohorts || []} />
        </div>
        <div style={labelStyle}>Segment by</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {GROUP_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setGroupBy(option.key)}
              style={{ minHeight: 36, border: `1px solid ${groupBy === option.key ? D.ink : D.border}`, borderRadius: 6, background: groupBy === option.key ? D.ink : D.card, color: groupBy === option.key ? "#FFFFFF" : D.text, padding: "0 11px", fontSize: 13, fontWeight: 650, cursor: "pointer" }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ ...cardStyle, background: D.softRed, borderColor: "#FCA5A5", color: D.red, padding: 14, marginBottom: 14, display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 650 }}>
          <AlertTriangle size={16} strokeWidth={2} />
          {error}
        </div>
      )}

      {loading && <div style={{ ...cardStyle, padding: 28, textAlign: "center", color: D.muted }}>Loading pricing variance...</div>}

      {!loading && data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
            <KpiCard label="Included services" value={summary.serviceCount || 0} />
            <KpiCard label="Average quoted minutes" value={fmtMinutes(summary.avgQuotedMinutes)} />
            <KpiCard label="Average actual minutes" value={fmtMinutes(summary.avgActualMinutes)} />
            <KpiCard label="Weighted percent variance" value={fmtPercent(summary.weightedPercentVariance)} tone={Number(summary.weightedPercentVariance || 0) > 0 ? "bad" : "good"} />
            <KpiCard label="Total dollar margin impact" value={fmtMoney(summary.totalDollarMarginImpact)} tone={Number(summary.totalDollarMarginImpact || 0) < 0 ? "bad" : "good"} />
            <KpiCard label="Outlier count" value={summary.outlierCount || 0} />
          </div>

          <div style={{ marginBottom: 14 }}><CoverageStrip coverage={coverage} /></div>

          {emptyIncluded ? (
            <div style={{ ...cardStyle, padding: 28, textAlign: "center", color: D.muted }}>
              No completed services with both quoted and actual minutes were found for this window.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              <SegmentTable segments={segments} />
              <OutliersTable outliers={data.outliers || []} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
