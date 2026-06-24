// Pest Report V2 — single composed section, driven by the `pestReportV2` payload
// key (server/services/service-report/pest-report-v2.js). Drop-in:
// render <PestReportV2Section data={data.pestReportV2} /> and it renders the
// protection-first dashboard, or nothing when the payload is absent (flag off /
// not a pest visit).
//
// This is a visual ENHANCEMENT layer that sits ABOVE the existing report. It does
// NOT re-render sections the legacy report already owns and keeps (Products
// Applied + "why selected", Re-entry / readiness, the pest-pressure chart, Ask
// Waves, photos, Report Tools). The hero's supporting metric is the at-a-glance
// version of the pressure reading; the full interactive pressure chart stays below.

import {
  PestStatusHero,
  PestProtectionMap,
  PestPrimaryMove,
  PestReceipt,
  PestBugFiles,
  PestSeasonForecast,
} from './PestReportV2';

export default function PestReportV2Section({ data, print = false, token = null, mode = 'live' }) {
  if (!data) return null;
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 16px 24px' }}>
      <PestStatusHero
        status={data.status}
        statusSummary={data.statusSummary}
        supportingMetric={data.supportingMetric}
        aiSummary={data.aiSummary}
        token={token}
        mode={mode}
      />
      {/* "Where we protected" — the branded coverage centerpiece, right after the
          status so the report reads: how you're doing → where we treated → next. */}
      {data.defense ? <PestProtectionMap defense={data.defense} print={print} /> : null}
      {data.primaryMove ? <PestPrimaryMove primaryMove={data.primaryMove} /> : null}
      {data.bugFiles?.length ? <PestBugFiles bugFiles={data.bugFiles} print={print} /> : null}
      {data.forecast ? <PestSeasonForecast forecast={data.forecast} /> : null}
      {data.pressureReceipt ? <PestReceipt receipt={data.pressureReceipt} /> : null}
    </div>
  );
}
