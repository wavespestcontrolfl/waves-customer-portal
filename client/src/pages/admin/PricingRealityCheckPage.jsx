import { useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { adminFetch } from "../../lib/adminFetch";
import {
  UiSurface,
  Card,
  Field,
  Select,
  Button,
  Badge,
  ActionFeedback,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  cn,
} from "../../components/ui";

const LOOKBACK_OPTIONS = [
  {
    value: "30",
    label: "30 days",
  },
  {
    value: "90",
    label: "90 days",
  },
  {
    value: "365",
    label: "365 days",
  },
];
const GROUP_OPTIONS = [
  {
    key: "service_type",
    label: "Service type",
  },
  {
    key: "lawn_care_track",
    label: "Lawn-care track",
  },
  {
    key: "sqft_band",
    label: "Sqft band",
  },
  {
    key: "zone",
    label: "Zone",
  },
  {
    key: "technician",
    label: "Technician",
  },
  {
    key: "month",
    label: "Month",
  },
  {
    key: "billing_cohort",
    label: "Billing cohort",
  },
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
  if (!Number.isFinite(n) || n === 0) return "text-zinc-900";
  return n < 0 ? "text-alert-fg" : "text-zinc-900";
}
function deltaColor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "text-zinc-900";
  return n > 0 ? "text-alert-fg" : "text-zinc-900";
}
export function sortSegmentsWorstMarginFirst(segments = []) {
  return [...segments].sort(
    (a, b) =>
      Number(a.totalDollarMarginImpact || 0) -
      Number(b.totalDollarMarginImpact || 0),
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
  const query = buildPricingRealityQuery({
    lookbackDays,
    groupBy,
    filters,
  });
  const response = await adminFetch(`/admin/pricing-reality-check?${query}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Pricing audit failed (${response.status})`);
  }
  return response.json();
}
function FilterSelect({
  label,
  value,
  onChange,
  options,
  placeholder = "All",
}) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((option) => {
          const id = typeof option === "string" ? option : option.id;
          const optionLabel =
            typeof option === "string" ? option : option.label;
          return (
            <option key={id} value={id}>
              {optionLabel}
            </option>
          );
        })}
      </Select>
    </Field>
  );
}
function KpiCard({ label, value, tone }) {
  const color = tone === "bad" ? "text-alert-fg" : "text-zinc-900";
  return (
    <Card className="p-4 min-h-[86px]">
      <div className="text-ui-body text-ink-secondary font-medium mb-[8px]">
        {label}
      </div>
      <div className={cn("text-[24px] font-medium", color)}>{value}</div>
    </Card>
  );
}
function CoverageStrip({ coverage }) {
  const c = coverage || {};
  return (
    <Card className="p-5 mb-3 flex gap-[14px] flex-wrap items-center text-ui-body text-ink-secondary">
      <span>
        Completed:{" "}
        <strong className="text-zinc-900">
          {c.completedServiceCount || 0}
        </strong>
      </span>
      <span>
        Included:{" "}
        <strong className="text-zinc-900">{c.includedServiceCount || 0}</strong>
      </span>
      <span>
        Missing quote:{" "}
        <strong className="text-zinc-900">
          {c.excludedMissingQuoteCount || 0}
        </strong>
      </span>
      <span>
        Missing actual:{" "}
        <strong className="text-zinc-900">
          {c.excludedMissingActualCount || 0}
        </strong>
      </span>
      <span>
        Invalid duration:{" "}
        <strong className="text-alert-fg">
          {c.excludedInvalidDurationCount || 0}
        </strong>
      </span>
    </Card>
  );
}
function SegmentTable({ segments }) {
  const rows = sortSegmentsWorstMarginFirst(segments);
  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b-hairline border-zinc-200">
        <h2 className="m-0 text-18 font-medium text-zinc-900">
          Segment variance
        </h2>
        <div className="text-ui-body text-ink-secondary mt-[4px]">
          Margin impact is (quoted minutes - actual minutes) / 60 * $35.
          Negative means actual labor exceeded quoted labor.
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table layout="records">
          <THead>
            <TR>
              {[
                "Segment",
                "Services",
                "Avg quoted",
                "Avg actual",
                "Avg delta",
                "Weighted variance",
                "Margin impact",
                "Avg margin",
                "Outliers",
              ].map((header) => (
                <TH
                  key={header}
                  className="text-ink-secondary text-ui-body border-b border-hairline border-zinc-200 whitespace-nowrap"
                >
                  {header}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.key}>
                <TD data-label="Segment" className="text-zinc-900 font-medium">
                  {row.label}
                </TD>
                <TD data-label="Services" align="right">
                  {row.serviceCount}
                </TD>
                <TD data-label="Avg quoted" align="right">
                  {fmtMinutes(row.avgQuotedMinutes)}
                </TD>
                <TD data-label="Avg actual" align="right">
                  {fmtMinutes(row.avgActualMinutes)}
                </TD>
                <TD
                  data-label="Avg delta"
                  align="right"
                  className={cn(
                    "font-medium",
                    deltaColor(row.avgVarianceMinutes),
                  )}
                >
                  {fmtMinutes(row.avgVarianceMinutes)}
                </TD>
                <TD data-label="Weighted variance" align="right">
                  {fmtPercent(row.weightedPercentVariance)}
                </TD>
                <TD
                  data-label="Margin impact"
                  align="right"
                  className={cn(
                    "font-medium",
                    marginColor(row.totalDollarMarginImpact),
                  )}
                >
                  {fmtMoney(row.totalDollarMarginImpact)}
                </TD>
                <TD
                  data-label="Avg margin"
                  align="right"
                  className={cn(
                    "font-medium",
                    marginColor(row.avgDollarMarginImpact),
                  )}
                >
                  {fmtMoney(row.avgDollarMarginImpact)}
                </TD>
                <TD data-label="Outliers" align="right">
                  {row.outlierCount}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </Card>
  );
}
function customerLink(row) {
  if (!row.customerId) return null;
  return `/admin/customers?customerId=${encodeURIComponent(row.customerId)}`;
}
function OutliersTable({ outliers }) {
  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b-hairline border-zinc-200">
        <h2 className="m-0 text-18 font-medium text-zinc-900">
          Outlier services
        </h2>
        <div className="text-ui-body text-ink-secondary mt-[4px]">
          Sorted by absolute z-score across the selected window and filters.
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table layout="records">
          <THead>
            <TR>
              {[
                "Service date",
                "Service",
                "Customer/property",
                "Service type",
                "Lawn track",
                "Sqft band",
                "Zone",
                "Technician",
                "Quoted",
                "Actual",
                "Delta",
                "Variance",
                "Margin impact",
                "Z-score",
                "Billing",
              ].map((header) => (
                <TH
                  key={header}
                  className="text-ink-secondary text-ui-body border-b border-hairline border-zinc-200 whitespace-nowrap"
                >
                  {header}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {outliers.map((row) => {
              const link = customerLink(row);
              return (
                <TR key={row.serviceId}>
                  <TD
                    data-label="Service date"
                    className="text-right whitespace-nowrap"
                  >
                    {fmtETDate(row.completedAt)}
                  </TD>
                  <TD
                    data-label="Service"
                    className="font-medium text-zinc-900"
                  >
                    <a
                      href={`/admin/dispatch?serviceId=${encodeURIComponent(row.serviceId)}`}
                      className="inline-flex min-h-11 items-center break-all text-zinc-900 underline u-focus-ring"
                    >
                      {row.serviceId}
                    </a>
                  </TD>
                  <TD data-label="Customer/property" className="break-words">
                    {link ? (
                      <a
                        href={link}
                        className="inline-flex min-h-11 items-center break-words text-zinc-900 underline u-focus-ring"
                      >
                        {row.customerName ||
                          row.propertyLabel ||
                          row.customerId}
                      </a>
                    ) : (
                      <span>{row.propertyLabel || "-"}</span>
                    )}
                  </TD>
                  <TD data-label="Service type">{row.serviceType || "-"}</TD>
                  <TD data-label="Lawn track">{row.lawnCareTrack || "-"}</TD>
                  <TD data-label="Sqft band">{row.sqftBand || "-"}</TD>
                  <TD data-label="Zone">{row.zone || "-"}</TD>
                  <TD data-label="Technician">{row.technician || "-"}</TD>
                  <TD data-label="Quoted" align="right">
                    {fmtMinutes(row.quotedMinutes)}
                  </TD>
                  <TD data-label="Actual" align="right">
                    {fmtMinutes(row.actualMinutes)}
                  </TD>
                  <TD
                    data-label="Delta"
                    align="right"
                    className={cn(
                      "font-medium",
                      deltaColor(row.varianceMinutes),
                    )}
                  >
                    {fmtMinutes(row.varianceMinutes)}
                  </TD>
                  <TD data-label="Variance" align="right">
                    {fmtPercent(row.percentVariance)}
                  </TD>
                  <TD
                    data-label="Margin impact"
                    align="right"
                    className={cn(
                      "font-medium",
                      marginColor(row.dollarMarginImpact),
                    )}
                  >
                    {fmtMoney(row.dollarMarginImpact)}
                  </TD>
                  <TD data-label="Z-score" align="right">
                    {fmtNumber(row.zScore, 2)}
                  </TD>
                  <TD data-label="Billing">{row.billingCohort || "-"}</TD>
                </TR>
              );
            })}
            {!outliers.length && (
              <TR>
                <TD
                  colSpan={15}
                  className="p-[18px] text-ink-secondary text-center"
                >
                  No outlier services for the selected filters.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </div>
    </Card>
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
      const payload = await loadPricingReality({
        lookbackDays,
        groupBy,
        filters,
      });
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
  const segments = useMemo(
    () => sortSegmentsWorstMarginFirst(data?.segments || []),
    [data?.segments],
  );
  const emptyIncluded =
    !loading && !error && Number(coverage.includedServiceCount || 0) === 0;
  const setFilter = (key, value) =>
    setFilters((current) => ({
      ...current,
      [key]: value,
    }));
  return (
    <UiSurface
      density="comfortable"
      className="max-w-[1320px] mx-auto text-zinc-900"
    >
      <div className="flex justify-between items-start gap-[16px] mb-[18px] flex-wrap">
        <div>
          <h1 className="m-0 text-22 text-zinc-900 font-medium">
            Audit
          </h1>
          <div className="mt-[5px] text-ink-secondary text-ui-body">
            Read-only comparison of quoted pricing minutes vs Bouncie actual
            on-site minutes.
          </div>
          <Badge tone="neutral" className="mt-3">
            <ShieldCheck size={14} strokeWidth={2} />
            Read-only. No pricing engine writes.
          </Badge>
        </div>
        <Button
          type="button"
          onClick={refresh}
          disabled={loading}
          variant="secondary"
        >
          <RefreshCw size={15} strokeWidth={2} />
          Refresh
        </Button>
      </div>

      <Card className="p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <FilterSelect
            label="Lookback"
            value={lookbackDays}
            onChange={setLookbackDays}
            options={LOOKBACK_OPTIONS.map((o) => ({
              id: o.value,
              label: o.label,
            }))}
            placeholder="Lookback"
          />
          <FilterSelect
            label="Service type"
            value={filters.serviceType}
            onChange={(value) => setFilter("serviceType", value)}
            options={available.serviceTypes || []}
          />
          <FilterSelect
            label="Lawn-care track"
            value={filters.lawnCareTrack}
            onChange={(value) => setFilter("lawnCareTrack", value)}
            options={available.lawnCareTracks || []}
          />
          <FilterSelect
            label="Sqft band"
            value={filters.sqftBand}
            onChange={(value) => setFilter("sqftBand", value)}
            options={available.sqftBands || []}
          />
          <FilterSelect
            label="Zone"
            value={filters.zoneId}
            onChange={(value) => setFilter("zoneId", value)}
            options={available.zones || []}
          />
          <FilterSelect
            label="Technician"
            value={filters.technicianId}
            onChange={(value) => setFilter("technicianId", value)}
            options={available.technicians || []}
          />
          <FilterSelect
            label="Month"
            value={filters.month}
            onChange={(value) => setFilter("month", value)}
            options={available.months || []}
          />
          <FilterSelect
            label="Billing cohort"
            value={filters.billingCohort}
            onChange={(value) => setFilter("billingCohort", value)}
            options={available.billingCohorts || []}
          />
        </div>
        <div className="text-ui-body font-medium mb-2">Segment by</div>
        <div className="flex flex-wrap gap-[6px]">
          {GROUP_OPTIONS.map((option) => (
            <Button
              key={option.key}
              type="button"
              onClick={() => setGroupBy(option.key)}
              variant={groupBy === option.key ? "primary" : "secondary"}
              aria-pressed={groupBy === option.key}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </Card>

      {error && (
        <ActionFeedback error className="mb-4">
          {error}
        </ActionFeedback>
      )}
      {loading && (
        <ActionFeedback className="p-6">
          Loading pricing variance...
        </ActionFeedback>
      )}

      {!loading && data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
            <KpiCard
              label="Included services"
              value={summary.serviceCount || 0}
            />
            <KpiCard
              label="Average quoted minutes"
              value={fmtMinutes(summary.avgQuotedMinutes)}
            />
            <KpiCard
              label="Average actual minutes"
              value={fmtMinutes(summary.avgActualMinutes)}
            />
            <KpiCard
              label="Weighted percent variance"
              value={fmtPercent(summary.weightedPercentVariance)}
              tone={
                Number(summary.weightedPercentVariance || 0) > 0
                  ? "bad"
                  : "good"
              }
            />
            <KpiCard
              label="Total dollar margin impact"
              value={fmtMoney(summary.totalDollarMarginImpact)}
              tone={
                Number(summary.totalDollarMarginImpact || 0) < 0
                  ? "bad"
                  : "good"
              }
            />
            <KpiCard label="Outlier count" value={summary.outlierCount || 0} />
          </div>

          <div className="mb-[14px]">
            <CoverageStrip coverage={coverage} />
          </div>

          {emptyIncluded ? (
            <Card className="p-5 mb-3 p-[28px] text-center text-ink-secondary">
              No completed services with both quoted and actual minutes were
              found for this window.
            </Card>
          ) : (
            <div className="grid gap-[14px]">
              <SegmentTable segments={segments} />
              <OutliersTable outliers={data.outliers || []} />
            </div>
          )}
        </>
      )}
    </UiSurface>
  );
}
