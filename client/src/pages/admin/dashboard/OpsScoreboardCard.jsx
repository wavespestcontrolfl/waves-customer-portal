import { UiSurface } from "../../../components/ui";
import { EmptyState, fmtInt } from "../../../components/dashboard/charts";

// Weekly Ops Scoreboard — surfaces the read-only operational metrics already
// computed by /api/admin/dashboard/ops-scoreboard: voicemail / missed-call
// share, drive minutes per stop, self-serve & AI booking share, and AI route
// adherence.
function pctText(share) {
  if (share == null || !Number.isFinite(Number(share))) return "—";
  return `${Math.round(Number(share) * 100)}%`;
}

function MetricCell({ label, value, sub, alert = false }) {
  return (
    <div className="rounded-md border border-hairline border-zinc-200 bg-surface-primary px-3 py-2.5">
      <div className="text-ui-caption font-medium text-ink-secondary">{label}</div>
      <div className={`mt-1 text-20 font-semibold u-nums ${alert ? "text-alert-fg" : "text-ink-primary"}`}>
        {value}
      </div>
      <div className="mt-0.5 text-ui-caption text-ink-secondary">{sub}</div>
    </div>
  );
}

function voicemailMetrics(aiCalls) {
  if (!aiCalls || aiCalls.error) return { value: "—", sub: "call data unavailable", alert: false };
  const total = (aiCalls.aiHandled || 0) + (aiCalls.transferred || 0) + (aiCalls.humanAnswered || 0) + (aiCalls.voicemail || 0);
  if (total === 0) return { value: "—", sub: "no inbound calls", alert: false };
  const vmPct = Math.round(((aiCalls.voicemail || 0) / total) * 100);
  return {
    value: `${vmPct}%`,
    sub: `${fmtInt(aiCalls.voicemail || 0)} VM · ${fmtInt(aiCalls.aiHandled || 0)} AI · ${fmtInt(aiCalls.humanAnswered || 0)} staff`,
    alert: vmPct >= 20,
  };
}

function driveMetrics(drive) {
  if (!drive || drive.error) return { value: "—", sub: "drive data unavailable" };
  const val = drive.share != null ? `${(Math.round(drive.share * 10) / 10).toFixed(1)}m` : "—";
  const miles = drive.vanDrivingMiles > 0 ? ` · ${fmtInt(Math.round(drive.vanDrivingMiles))} van mi` : "";
  return {
    value: val,
    sub: `${fmtInt(drive.timedStops || 0)}/${fmtInt(drive.completedStops || 0)} timed stops${miles}`,
  };
}

function bookingMetrics(bookings) {
  if (!bookings || bookings.error) return { value: "—", sub: "booking data unavailable" };
  const pending = bookings.aiPendingReview > 0 ? ` · ${fmtInt(bookings.aiPendingReview)} pending` : "";
  return {
    value: pctText(bookings.share),
    sub: `${fmtInt(bookings.ai || 0)} AI · ${fmtInt(bookings.customerSelfServe || 0)} self · ${fmtInt(bookings.staff || 0)} staff${pending}`,
  };
}

function routeMetrics(routes) {
  if (!routes || routes.error) return { value: "—", sub: "route data unavailable" };
  return {
    value: pctText(routes.share),
    sub: routes.denominator > 0
      ? `${fmtInt(routes.daysFollowed || 0)}/${fmtInt(routes.denominator)} tech-days followed`
      : "no scored route days",
  };
}

export default function OpsScoreboardCard({ data }) {
  if (!data) return <EmptyState>No weekly ops data available</EmptyState>;
  const vm = voicemailMetrics(data.aiCallShare);
  const drive = driveMetrics(data.driveMinutesPerStop);
  const bookings = bookingMetrics(data.bookingsWithoutStaff);
  const routes = routeMetrics(data.aiRouteDays);
  const picker = data.customerPickerConversion;

  return (
    <UiSurface>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCell label="Voicemail Rate" value={vm.value} sub={vm.sub} alert={vm.alert} />
        <MetricCell label="Drive / Stop" value={drive.value} sub={drive.sub} />
        <MetricCell label="Self-Serve & AI Bookings" value={bookings.value} sub={bookings.sub} />
        <MetricCell label="AI Route Adherence" value={routes.value} sub={routes.sub} />
      </div>
      {picker && !picker.error && picker.denominator > 0 && (
        <div className="mt-2.5 text-ui-caption text-ink-secondary u-nums">
          Online time-picker conversion: <span className="font-medium text-ink-primary">{pctText(picker.share)}</span>{" "}
          ({fmtInt(picker.numerator)}/{fmtInt(picker.denominator)} estimates booked after selecting a slot)
        </div>
      )}
    </UiSurface>
  );
}
