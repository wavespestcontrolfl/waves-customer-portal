// Lawn Report V2 — single composed section, driven by the `reportV2` payload key
// (server/services/service-report/lawn-report-v2.js). Drop-in: render
// <LawnReportV2Section data={data.reportV2} /> and it renders the visual dashboard,
// or nothing when reportV2 is absent (flag off / not a lawn visit).
//
// This is the visual ENHANCEMENT layer that sits ABOVE the existing report. It does
// NOT re-render sections the legacy V1 report already owns and must keep:
//   What Waves did today + areas · Weather call · Re-entry / readiness · Products
//   Applied + "why selected" · Visit Timeline · Ask Waves Q&A · photos · Report Tools
//   (PDF/Share/Print) · Portal Login.
// So the V2 "treatment" card is intentionally omitted here (legacy "What Waves did
// today" + "Products Applied" own that); the snapshot's "Today's focus" covers the
// at-a-glance version. `treatment` stays on the payload for the standalone preview.

import {
  PrintContext,
  LawnSnapshotHero,
  LawnFollowUpCard,
  LawnInsightCards,
  LawnPhotoStrip,
  LawnProgressionSlider,
  VisualDiagnosisCards,
  WaterIntakeBar,
  RainLast7DaysChart,
  MowingHeightGauge,
  LawnTrends,
} from './LawnReportV2';

export default function LawnReportV2Section({ data, print = false }) {
  if (!data) return null;
  return (
    <PrintContext.Provider value={print}>
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 16px 32px' }}>
      {data.snapshot ? <LawnSnapshotHero snapshot={data.snapshot} /> : null}
      {data.followUp?.scheduled ? <LawnFollowUpCard followUp={data.followUp} /> : null}
      {data.insights?.length ? <LawnInsightCards insights={data.insights} /> : null}
      {(data.photos?.length || data.photoSummary) ? <LawnPhotoStrip photos={data.photos} summary={data.photoSummary} /> : null}
      {data.progression?.length >= 2 ? <LawnProgressionSlider frames={data.progression} note={data.progressionNote} /> : null}
      {data.diagnosis?.length ? <VisualDiagnosisCards categories={data.diagnosis} /> : null}
      {data.water ? <WaterIntakeBar water={data.water} aftercare={data.aftercare} /> : null}
      {data.rain7d?.length ? <RainLast7DaysChart days={data.rain7d} /> : null}
      {data.mowing ? <MowingHeightGauge mowing={data.mowing} /> : null}
      {data.trends ? <LawnTrends trends={data.trends} /> : null}
    </div>
    </PrintContext.Provider>
  );
}
