// Tree & Shrub Report V2 — single composed section, driven by the `reportV2`
// payload key for a tree_shrub visit (server/services/service-report/
// tree-shrub-report-v2.js). Drop-in: render <TreeShrubReportV2Section
// data={data.reportV2} /> and it renders the visual dashboard, or nothing when the
// payload is absent (flag off / not a tree-shrub visit).
//
// Visual ENHANCEMENT layer above the existing report — it does NOT re-render the
// legacy sections the report already owns (Re-entry / readiness, Products Applied +
// "why selected", Ask Waves, Report Tools). The "What Waves did today" treatment
// card stays on the payload for the standalone preview but is intentionally omitted
// here so it doesn't double the legacy Products section.

import {
  PrintContext,
  TreeShrubSnapshotHero,
  TreeShrubInsightCards,
  TreeShrubVisualDiagnosisBars,
  PlantGroupStatusCards,
  LandscapeWaterContextCard,
  TreeShrubPhotoCards,
  TreeShrubTrends,
} from './TreeShrubReportV2';

export default function TreeShrubReportV2Section({ data, print = false }) {
  if (!data) return null;
  return (
    <PrintContext.Provider value={print}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 16px 32px' }}>
        {data.snapshot ? <TreeShrubSnapshotHero snapshot={data.snapshot} /> : null}
        {data.insights?.length ? <TreeShrubInsightCards insights={data.insights} /> : null}
        {data.diagnosis?.length ? <TreeShrubVisualDiagnosisBars categories={data.diagnosis} /> : null}
        {data.plantGroups?.length ? <PlantGroupStatusCards plantGroups={data.plantGroups} /> : null}
        {(data.photos?.length || data.photoSummary) ? <TreeShrubPhotoCards photos={data.photos} summary={data.photoSummary} /> : null}
        {data.water ? <LandscapeWaterContextCard water={data.water} /> : null}
        {data.trends ? <TreeShrubTrends trends={data.trends} /> : null}
      </div>
    </PrintContext.Provider>
  );
}
