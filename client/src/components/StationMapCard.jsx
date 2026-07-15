import { COLORS as B } from '../theme-brand';

// Bait station map (station-map-v1) — numbered station pins over the live
// satellite image. Extracted verbatim from ReportViewPage so the customer
// report and the My Plan service rows render the identical map from the
// identical data contract. Two variants:
//   'report' (default) — per-visit card on the live service report; colors
//     reflect THAT visit's per-station checks. Markup/copy unchanged from
//     the ratified report wording (report page CSS vars + sr-section).
//   'plan' — current-state embed inside a My Plan service row; colors
//     reflect each station's most recent check. Portal inline colors (the
//     row provides the card chrome) and current-state copy.
// Copy rule (both variants): this card states NUMBERS only;
// activity/consumption claims (including the zero state) belong to the
// typed report's ratified wording. Rodent copy follows the owner wording
// rules: exterior bait consumption language, never anything implying
// interior infestation.
export const STATION_CARD_PROGRAM_META = {
  termite: {
    title: 'Bait station map',
    intro: 'Numbered pins show where your termite bait stations sit around the home. Colors reflect this visit.',
    ariaLabel: 'Termite bait station locations marked on a satellite view of the property',
    activityLegend: 'Termite activity observed',
    activitySummary: 'with termite activity',
  },
  rodent: {
    title: 'Rodent bait station map',
    intro: 'Numbered pins show where the exterior rodent bait stations sit around the home. Colors reflect this visit.',
    ariaLabel: 'Exterior rodent bait station locations marked on a satellite view of the property',
    activityLegend: 'Bait consumption observed',
    activitySummary: 'with bait consumption',
  },
  // Trapping copy states factual capture/removal counts only — never
  // absence or elimination claims (BANNED_CUSTOMER_COPY), and no
  // exterior-pressure phrasing (that rule is scoped to bait stations;
  // traps legitimately sit interior too).
  trapping: {
    title: 'Rodent trap map',
    intro: 'Numbered pins show where the traps in your rodent program are placed. Colors reflect this visit.',
    ariaLabel: 'Rodent trap locations marked on a satellite view of the property',
    activityLegend: 'Capture recorded',
    activitySummary: 'with captures recorded',
  },
};
const STATION_STATUS_META = {
  ok: { color: '#10B981', label: 'Checked — no activity' },
  activity: { color: '#DC2626', label: 'Termite activity observed' },
  serviced: { color: '#F59E0B', label: 'Serviced this visit' },
  inaccessible: { color: '#9CA3AF', label: 'Not accessible this visit' },
};
const STATION_ON_FILE_META = { color: '#64748B', label: 'On file (not checked this visit)' };
// Current-state variant labels: the plan embed aggregates the LATEST check
// per station, so "this visit" framing would be wrong there — a station
// serviced weeks ago must not read as serviced on the current visit
// (codex P3). 'ok'/'activity' labels are already visit-neutral.
const PLAN_ON_FILE_META = { color: '#64748B', label: 'On file (not yet checked)' };
const PLAN_STATUS_LABELS = {
  serviced: 'Serviced at last check',
  inaccessible: 'Not accessible at last check',
};
const PLAN_INTRO_SUFFIX = 'Colors reflect the most recent check.';

function stationStatusMeta(status, programMeta, plan = false) {
  const base = STATION_STATUS_META[status] || STATION_ON_FILE_META;
  if (plan && PLAN_STATUS_LABELS[status]) return { ...base, label: PLAN_STATUS_LABELS[status] };
  if (status === 'activity') return { ...base, label: programMeta.activityLegend };
  if (status === 'ok' && programMeta === STATION_CARD_PROGRAM_META.rodent) {
    return { ...base, label: 'Checked — no consumption' };
  }
  if (status === 'ok' && programMeta === STATION_CARD_PROGRAM_META.trapping) {
    return { ...base, label: 'Checked — no capture' };
  }
  return base;
}

function stationSummaryLine(summary, programMeta) {
  if (!summary || !summary.total) return null;
  const parts = [];
  if (summary.checked > 0) {
    parts.push(`${summary.checked} of ${summary.total} station${summary.total === 1 ? '' : 's'} inspected`);
  } else {
    parts.push(`${summary.total} station${summary.total === 1 ? '' : 's'} on file`);
  }
  if (summary.activity > 0) parts.push(`${summary.activity} ${programMeta.activitySummary}`);
  if (summary.serviced > 0) parts.push(`${summary.serviced} serviced`);
  if (summary.inaccessible > 0) parts.push(`${summary.inaccessible} not accessible`);
  return parts.join(' · ');
}

export function StationMapCard({ stationMap, sectionId = 'station-map', variant = 'report', hideTitle = false }) {
  const stations = Array.isArray(stationMap?.stations) ? stationMap.stations : [];
  if (!stationMap?.available || !stations.length || !stationMap.image?.url) return null;
  const plan = variant === 'plan';
  const programMeta = STATION_CARD_PROGRAM_META[stationMap.program] || STATION_CARD_PROGRAM_META.termite;
  const onFileMeta = plan ? PLAN_ON_FILE_META : STATION_ON_FILE_META;
  const intro = plan
    ? programMeta.intro.replace('Colors reflect this visit.', PLAN_INTRO_SUFFIX)
    : programMeta.intro;
  const width = stationMap.image.width || 640;
  const height = stationMap.image.height || 340;
  const legendKeys = [];
  stations.forEach((station) => {
    const key = STATION_STATUS_META[station.status] ? station.status : 'on_file';
    if (!legendKeys.includes(key)) legendKeys.push(key);
  });
  const legend = legendKeys.map((key) => (key === 'on_file'
    ? { key, ...onFileMeta }
    : { key, ...stationStatusMeta(key, programMeta, plan) }));
  const summaryLine = stationSummaryLine(stationMap.summary, programMeta);
  const mutedColor = plan ? '#475569' : 'var(--muted)';
  const lineColor = plan ? '#E7E2D7' : 'var(--line)';
  const Wrapper = plan ? 'div' : 'section';
  const wrapperProps = plan
    ? { id: sectionId, 'data-section': 'station-map' }
    : { 'data-glass': 'card', className: 'sr-section', id: sectionId, 'data-section': 'station-map' };
  return (
    <Wrapper {...wrapperProps}>
      {hideTitle ? null : plan ? (
        <div style={{ fontSize: 15, fontWeight: 850, color: B.glassNavy, margin: '0 0 6px' }}>{programMeta.title}</div>
      ) : (
        <h2>{programMeta.title}</h2>
      )}
      <p style={{ fontSize: plan ? 14 : 15, color: mutedColor, lineHeight: 1.5, margin: '0 0 12px' }}>
        {intro}
      </p>
      <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: `1px solid ${lineColor}` }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={programMeta.ariaLabel}
          style={{ display: 'block', width: '100%' }}
        >
          <image href={stationMap.image.url} x="0" y="0" width={width} height={height} preserveAspectRatio="xMidYMid slice" />
          {stations.map((station) => {
            const meta = STATION_STATUS_META[station.status]
              ? stationStatusMeta(station.status, programMeta, plan)
              : onFileMeta;
            const cx = station.cx * width;
            const cy = station.cy * height;
            return (
              <g key={station.id}>
                <title>
                  {`Station ${station.number}${station.label ? ` — ${station.label}` : ''}: ${meta.label}`}
                </title>
                <circle cx={cx} cy={cy} r={12} fill={meta.color} stroke="#fff" strokeWidth={2.5} />
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff">
                  {station.number}
                </text>
              </g>
            );
          })}
        </svg>
        {stationMap.attributionText && (
          <div style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.9)', pointerEvents: 'none' }}>
            {stationMap.attributionText}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
        {legend.map((entry) => (
          <span key={entry.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, color: mutedColor }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: entry.color, flexShrink: 0 }} />
            {entry.label}
          </span>
        ))}
      </div>
      {summaryLine && (
        <p style={{ fontSize: 14, color: mutedColor, margin: '10px 0 0' }}>{summaryLine}</p>
      )}
    </Wrapper>
  );
}
