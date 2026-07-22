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
} from './PestReportV2';
import TracedTreatmentZoneMap from '../TracedTreatmentZoneMap';

export default function PestReportV2Section({ data, print = false, token = null, mode = 'live', tracedMap = null }) {
  if (!data) return null;
  return (
    // No inset: cards align edge-to-edge with the report's .sr-section cards — the
    // old maxWidth + side padding rendered this block 32px narrower than every other
    // glass card on the page, with extra dead space at both seams (owner 2026-07-09).
    <div style={{ marginTop: 20 }}>
      <PestStatusHero
        status={data.status}
        statusSummary={data.statusSummary}
        supportingMetric={data.supportingMetric}
        aiSummary={data.aiSummary}
        token={token}
        mode={mode}
        tracedMap={tracedMap}
      />
      {/* "Where we protected": the technician-traced spray map is COMBINED
          into the status hero above (owner 2026-07-21) — the schematic
          centerpiece renders only for visits without a trace. */}
      {!tracedMap && data.defense ? <PestProtectionMap defense={data.defense} print={print} /> : null}
      {data.primaryMove ? <PestPrimaryMove primaryMove={data.primaryMove} /> : null}
      {/* Bug files, seasonal outlook, and the WaveGuard receipt were removed from
          the composed section (owner 2026-07-09) — the components remain exported
          from PestReportV2 for any future re-mount. */}
    </div>
  );
}
