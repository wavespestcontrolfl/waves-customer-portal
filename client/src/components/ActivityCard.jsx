import {
  MeterSvg,
  PressureHistoryChart,
  TrendChip,
} from './report/GaugePrimitives';

/**
 * Customer-facing activity gauge for typed specialty reports (rodent,
 * wildlife, bed bug, cockroach, flea, termite). Renders in the slot where
 * recurring pest reports show PestPressureCard, reusing the same meter /
 * history / trend primitives under the service's own label.
 *
 * Data comes from the report API's `activity` field (built from the
 * completion-time typedReportSnapshot + service_activity_scores history).
 * Differences from Pest Pressure — by contract:
 * - wording, never a bare number, leads ("Moderate activity", not "3.0")
 * - no customer rating picker
 * - first visit shows "Baseline recorded today", never a trend claim
 */

const TREND_KEY_MAP = {
  improving: 'improving',
  stable: 'stable',
  worsening: 'increasing',
};

export default function ActivityCard({ data }) {
  if (!data || data.score === null || data.score === undefined) return null;

  const trendKey = data.isBaseline
    ? 'first_marker'
    : (TREND_KEY_MAP[data.trend] || 'stable');

  return (
    <section
      id="activity"
      data-section="activity"
      style={{
        background: '#FFFFFF',
        border: '1px solid #E7E2D7',
        borderRadius: 14,
        padding: 24,
        margin: '0 0 16px',
        fontFamily: "'Inter', system-ui, sans-serif",
        color: '#1B2C5B',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7280', fontWeight: 600 }}>
            {data.label}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {data.levelWord}
          </div>
          <div style={{ fontSize: 13, color: '#475569', marginTop: 4 }}>
            {data.isBaseline
              ? 'Baseline recorded today.'
              : (data.trendWord ? `Activity has ${data.trendWord}.` : null)}
          </div>
        </div>
        <TrendChip trend={trendKey} delta={null} />
      </header>
      <MeterSvg score={data.score} label={{ name: data.levelWord }} noun={data.label} />
      <PressureHistoryChart history={data.history} cadence={null} />
    </section>
  );
}
