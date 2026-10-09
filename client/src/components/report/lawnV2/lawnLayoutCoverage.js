// GATE_LAWN_REPORT_LAYOUT: what happens to every top-level mount of the standard page body for a lawn
// report (the children of <LawnLayoutSwitch> in ReportViewPage.jsx's ServiceReportV1). The layout must
// never lose content the standard page shows, so each mount is one of:
//   slot       printed by the layout: `key` is the entry of `slots` (and of LAYOUT_ORDER's sections) that does it
//   yourPart   its content moved into the "Your part" card (the re-entry sentence, the watering banner)
//   split      one block the layout prints as several sections (the lead card, the lawn section)
//   hidden     cut from the lawn web report on purpose (owner 2026-10-08/09 cut list: Visit Timeline)
//   declines   content only other lines carry; a payload that has it keeps the standard page (LAYOUT_DECLINES key)
//   unreachable the standard condition cannot hold for a lawn report that has reportV2 (isV2LeadLayout)
// lawnLayoutCoverage.test.js reads the standard body's source and fails when a mount is missing here
// (or listed here and gone), so a section added to the page cannot silently drop out of the lawn layout.

export const STANDARD_BODY_COVERAGE = Object.freeze({
  ServiceStatusCard: { how: 'slot', key: 'status' },
  LawnWateringBanner: { how: 'yourPart', note: 'printed once inside the Your part card' },
  LawnLeadCard: { how: 'split', note: 'next visit, Your part, what we did, score, what to expect, watching' },
  ReserviceReportCard: { how: 'slot', key: 'reservice' },
  PlanSummaryCard: { how: 'slot', key: 'plan' },
  NearYouCard: { how: 'slot', key: 'nearYou' },
  ReviewRequestCard: { how: 'slot', key: 'review', note: 'the bottom mount needs !reviewAskOnTop, false whenever reportV2 exists' },
  TodaysResultCard: { how: 'declines', key: 'typedReport' },
  PestCustomerConcern: { how: 'declines', key: 'customerConcernCard' },
  RecapVideoCard: { how: 'slot', key: 'recap' },
  ReentryReadinessCard: { how: 'yourPart', note: 'its sentence, pet advisory and timer-view event' },
  ServiceTimelineSection: { how: 'unreachable', note: 'needs !isV2LeadLayout' },
  TechNoteCard: { how: 'slot', key: 'techNote' },
  UpcomingVisitsCard: { how: 'slot', key: 'upcoming' },
  CrossSellCard: { how: 'slot', key: 'crossSell' },
  'host:div#visit-summary': { how: 'declines', key: 'pestReportV2', note: 'wrapper of the pest and mosquito dashboards' },
  PestReportV2Section: { how: 'declines', key: 'pestReportV2' },
  MosquitoReportV2Section: { how: 'declines', key: 'mosquitoReportV2' },
  TermiteReportV2Section: { how: 'declines', key: 'termiteReportV2' },
  CockroachReportV2Section: { how: 'declines', key: 'cockroachReportV2' },
  $recordedFindingsList: { how: 'slot', key: 'recordedFindings' },
  'host:div#service-timeline': { how: 'hidden', note: 'Visit Timeline, on the brief\'s cut list' },
  LawnVisitTimeline: { how: 'hidden', note: 'Visit Timeline, on the brief\'s cut list' },
  'host:section#visit-summary': { how: 'split', note: 'the Visit Summary paragraph (slot visitSummary) and the lawn section' },
  ReportText: { how: 'slot', key: 'visitSummary' },
  LawnReportV2Section: { how: 'split', note: 'photos, findings, water, rain, mowing, program line, score, trends' },
  LawnAssessmentCard: { how: 'unreachable', note: 'needs !data.reportV2' },
  LawnMowingHeight: { how: 'unreachable', note: 'needs !data.reportV2' },
  TreeShrubReportV2Section: { how: 'unreachable', note: 'tree & shrub line only' },
  RecommendationsSection: { how: 'slot', key: 'recommendations' },
  AppliedProductsSection: { how: 'slot', key: 'products' },
  ReferralCard: { how: 'slot', key: 'referral' },
  $tracedMapMount: { how: 'slot', key: 'tracedMap' },
  TypedFindingsCard: { how: 'declines', key: 'typedReport' },
  LawnProtocolCard: { how: 'unreachable', note: 'needs !data.reportV2' },
  PressureTrendCard: { how: 'declines', key: 'pressureTrend' },
  ActivityCard: { how: 'declines', key: 'activity' },
  PestPressureCard: { how: 'declines', key: 'pestPressure' },
  TypedVisitTimelineCard: { how: 'declines', key: 'typedVisitTimeline' },
  CompanionSectionHeader: { how: 'declines', key: 'companionReports' },
  MarkedPhotosSection: { how: 'slot', key: 'markedPhotos' },
  StationMapCard: { how: 'declines', key: 'stationMap' },
  LawnProgramOverviewCard: { how: 'unreachable', note: 'needs !data.reportV2' },
  'host:div#map': { how: 'unreachable', note: 'needs !isV2LeadLayout (the traced map is $tracedMapMount)' },
  ServiceCoverageCard: { how: 'unreachable', note: 'needs !isV2LeadLayout (the traced map is $tracedMapMount)' },
  ServiceHighlightsSection: { how: 'slot', key: 'highlights' },
  'host:section#photos': { how: 'unreachable', note: 'needs !data.reportV2' },
});
