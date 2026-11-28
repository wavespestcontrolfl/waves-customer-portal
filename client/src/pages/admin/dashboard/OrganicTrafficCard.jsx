import { Link } from "react-router-dom";
import { UiSurface } from "../../../components/ui";
import { EmptyState, fmtInt } from "../../../components/dashboard/charts";

// Organic Search & Website Traffic card (GSC + GA4, trailing 30d vs prior 30d).
function DeltaTag({ delta }) {
  if (delta == null || !Number.isFinite(Number(delta))) return null;
  const n = Number(delta);
  const sign = n > 0 ? "+" : "";
  const cls = n < -15 ? "text-alert-fg" : n > 0 ? "text-emerald-700" : "text-ink-secondary";
  return <span className={`ml-1.5 text-ui-caption font-medium u-nums ${cls}`}>{sign}{n}% vs prior 30d</span>;
}

function GscBlock({ gsc }) {
  if (!gsc || gsc.error) return <EmptyState>Search Console data unavailable</EmptyState>;
  if (gsc.empty) return <EmptyState>No Search Console data synced yet</EmptyState>;
  return (
    <div className="rounded-md border border-hairline border-zinc-200 bg-surface-primary px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ui-caption font-medium text-ink-secondary">Google Search Console (30d)</span>
        {gsc.latestDate && <span className="text-ui-caption text-ink-secondary u-nums">thru {gsc.latestDate}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline flex-wrap">
        <span className="text-22 font-semibold text-ink-primary u-nums">{fmtInt(gsc.clicks)} clicks</span>
        <DeltaTag delta={gsc.clicksDeltaPct} />
      </div>
      <div className="mt-1 text-ui-caption text-ink-secondary u-nums">
        {fmtInt(gsc.impressions)} impressions · avg pos {gsc.avgPosition != null ? gsc.avgPosition : "—"}
        {gsc.nonbrandClicks > 0 ? ` · ${fmtInt(gsc.nonbrandClicks)} non-brand` : ""}
      </div>
    </div>
  );
}

function Ga4Block({ ga4 }) {
  if (!ga4 || ga4.error) return <EmptyState>GA4 website traffic unavailable</EmptyState>;
  if (ga4.empty) return <EmptyState>No GA4 traffic synced yet</EmptyState>;
  return (
    <div className="rounded-md border border-hairline border-zinc-200 bg-surface-primary px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ui-caption font-medium text-ink-secondary">Website Traffic · GA4 (30d)</span>
        {ga4.latestDate && <span className="text-ui-caption text-ink-secondary u-nums">thru {ga4.latestDate}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline flex-wrap">
        <span className="text-22 font-semibold text-ink-primary u-nums">{fmtInt(ga4.sessions)} sessions</span>
        <DeltaTag delta={ga4.sessionsDeltaPct} />
      </div>
      <div className="mt-1 text-ui-caption text-ink-secondary u-nums">
        {fmtInt(ga4.users)} users · {fmtInt(ga4.conversions)} conversions · {fmtInt(ga4.pageviews)} views
      </div>
    </div>
  );
}

export default function OrganicTrafficCard({ data }) {
  if (!data) return <EmptyState>No organic search data available</EmptyState>;
  return (
    <UiSurface>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <GscBlock gsc={data.gsc} />
        <Ga4Block ga4={data.ga4} />
      </div>
      <div className="mt-2.5 flex justify-end">
        <Link to="/admin/seo" className="text-ui-caption font-medium text-ink-secondary hover:text-ink-primary underline-offset-2 hover:underline">
          Open SEO &amp; search hub →
        </Link>
      </div>
    </UiSurface>
  );
}
