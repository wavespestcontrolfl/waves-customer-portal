// Termite Report V2 — section composer.
//
// Card order (owner 2026-08-29 — exceptions first, complete record second):
//   1. Today's result (headline · body · three metrics)
//   2. Bait station map (satellite, numbered navy pins, live web only)
//   3. Station details — ONE card: exceptions ("Needs attention") first,
//      normals collapsed behind "View all stations"
//   4. What happens next (the tech's required next-step commitment)
//   5. Your one move (tech's top recommendation)
//   6. Your termite protection (program · same-line next visit · warranty)
// The typed findings card (activity signs, bait/station issues and actions,
// conducive conditions, recommendations) still renders below the dashboard
// from ReportViewPage, minus the fields the hero already carries.
import { StationMapCard } from '../../StationMapCard';
import {
  TermiteStatusHero,
  TermiteStationRecord,
  TermiteWhatsNext,
  TermiteNextStep,
  TermiteProtection,
} from './TermiteReportV2';

export default function TermiteReportV2Section({
  data,
  print = false,
  token = null,
  mode = 'live',
  stationMap = null,
  stationPins = false,
  nextVisitLabel = null,
  bondLines = [],
  // Tech-reviewed narrative, cleaned by the page (cleanVisitSummary) — the
  // dashboard is the report's one summary surface.
  narrative = null,
  // Activity gauge payload (score / trend / isBaseline) — the hero prints
  // its cross-visit trend sentence; the reading itself is the hero status.
  activityTrend = null,
}) {
  if (!data) return null;
  return (
    <div style={{ marginTop: 20 }} data-print={print ? 'true' : undefined} data-mode={mode} data-token={token || undefined}>
      <TermiteStatusHero
        status={data.status}
        statusSummary={data.statusSummary}
        metrics={data.metrics}
        narrative={narrative}
        activityTrend={activityTrend}
        visitSequence={data.visitSequence}
      />
      {/* Live web only — pdf/static have no satellite basemap to pin against
          (provider ToS), same rule as the standalone StationMapCard mount.
          The wrapper carries the 20px card rhythm: the report's .sr-section
          has no bottom margin of its own (the page grid spaces top-level
          cards), so an unwrapped map sat flush against the card below. */}
      {mode === 'live' && (
        <div style={{ marginBottom: 20 }}>
          <StationMapCard stationMap={stationMap} stationPins={stationPins} />
        </div>
      )}
      <TermiteStationRecord stationMap={stationMap} />
      <TermiteWhatsNext nextStep={data.nextStep} />
      <TermiteNextStep primaryMove={data.primaryMove} />
      <TermiteProtection nextVisitLabel={nextVisitLabel} bondLines={bondLines} />
    </div>
  );
}
