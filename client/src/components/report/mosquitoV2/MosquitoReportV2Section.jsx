// Mosquito Report V2 — single composed section, driven by the `mosquitoReportV2`
// payload key (server/services/service-report/mosquito-report-v2.js). Drop-in:
// render <MosquitoReportV2Section data={data.mosquitoReportV2} /> and it renders
// the yard-usability dashboard, or nothing when the payload is absent (flag off /
// not a mosquito visit).
//
// Like the pest V2 section, this is a visual ENHANCEMENT layer that sits ABOVE
// the existing report. It does NOT re-render sections the legacy report already
// owns (Products Applied + "why selected", Re-entry / readiness, Ask Waves,
// photos, Report Tools). The hero's supporting metric is the at-a-glance version
// of the pressure reading. The composed order tells the mosquito story:
// how you're protected → where we treated / what can breed → your one move →
// the weather-driven outlook (kept here, unlike pest, because weather IS the
// mosquito story).

import {
  MosquitoStatusHero,
  MosquitoHabitatMap,
  MosquitoNextStep,
  MosquitoOutlook,
} from './MosquitoReportV2';

export default function MosquitoReportV2Section({ data, print = false, token = null, mode = 'live' }) {
  if (!data) return null;
  return (
    // No inset: cards align edge-to-edge with the report's .sr-section cards
    // (same seam decision as the pest section, owner 2026-07-09).
    <div style={{ marginTop: 20 }}>
      <MosquitoStatusHero
        status={data.status}
        statusSummary={data.statusSummary}
        supportingMetric={data.supportingMetric}
        aiSummary={data.aiSummary}
        token={token}
        mode={mode}
      />
      {data.habitat ? <MosquitoHabitatMap habitat={data.habitat} print={print} /> : null}
      {data.primaryMove ? <MosquitoNextStep primaryMove={data.primaryMove} /> : null}
      {data.outlook ? <MosquitoOutlook outlook={data.outlook} /> : null}
    </div>
  );
}
