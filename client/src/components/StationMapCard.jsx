import { useEffect, useRef, useState } from 'react';
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

function stationStatusMeta(status, programMeta, plan = false, initialSetup = false) {
  const base = STATION_STATUS_META[status] || STATION_ON_FILE_META;
  if (plan && PLAN_STATUS_LABELS[status]) return { ...base, label: PLAN_STATUS_LABELS[status] };
  if (status === 'activity') return { ...base, label: programMeta.activityLegend };
  if (status === 'ok' && programMeta === STATION_CARD_PROGRAM_META.rodent) {
    return { ...base, label: 'Checked — no consumption' };
  }
  if (status === 'ok' && programMeta === STATION_CARD_PROGRAM_META.trapping) {
    // On a declared trap SETUP the pins went out on this visit — "Checked —
    // no capture" would claim a check that never happened, and contradict
    // the same report's "Traps set" finding (codex P1 on #3159).
    return { ...base, label: initialSetup ? 'Set this visit' : 'Checked — no capture' };
  }
  return base;
}

function stationSummaryLine(summary, programMeta, initialSetup = false, countVerified = true) {
  if (!summary || !summary.total) return null;
  // On a declared setup whose count the report disputes, the pin LABELS stay
  // setup-correct but this line says nothing — it is the only place the map
  // restates the number, and restating a number that disagrees with the
  // typed finding is the contradiction being avoided (codex P2 round 9).
  if (initialSetup && !countVerified) return null;
  const parts = [];
  // Same rule as the pin label: traps placed today were SET, not inspected.
  // Counts the ACCESSIBLE pins, not every pin — `checked` excludes
  // inaccessible ones, which is the same exclusion the closeout's
  // traps_checked autofill applies. Using `total` here made the map say
  // "8 traps set this visit · 1 not accessible" beside a typed
  // "Traps set: 7" (codex P2 on #3159).
  if (initialSetup) {
    const set = summary.checked;
    parts.push(`${set} trap${set === 1 ? '' : 's'} set this visit`);
  } else if (summary.checked > 0) {
    parts.push(`${summary.checked} of ${summary.total} station${summary.total === 1 ? '' : 's'} inspected`);
  } else {
    parts.push(`${summary.total} station${summary.total === 1 ? '' : 's'} on file`);
  }
  if (summary.activity > 0) parts.push(`${summary.activity} ${programMeta.activitySummary}`);
  if (summary.serviced > 0) parts.push(`${summary.serviced} serviced`);
  if (summary.inaccessible > 0) parts.push(`${summary.inaccessible} not accessible`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Trap-pin rendering (rodent trapping programs, GATE_RODENT_REPORT_REFRESH).
// Numbered pins draw as top-down snap traps so the map reads as what it is —
// trap placements, not abstract dots (owner ask 2026-07-27). States mirror
// the legend: armed bar open = checked/no capture, bar sprung over a rat
// silhouette = capture recorded. A purely decorative rat scurries to a trap
// every few seconds and the trap fires — live report views only, and every
// animation (including the rat itself) is disabled under
// prefers-reduced-motion. PDF/static renders never mount this card.
// ---------------------------------------------------------------------------

// Small top-down rat silhouette, drawn facing +x, ~22 units long.
function RatGlyph({ fill = '#334155', opacity = 1 }) {
  return (
    <g aria-hidden="true" opacity={opacity}>
      {/* tail */}
      <path d="M -8 0 C -14 2, -16 -3, -21 -1" fill="none" stroke={fill} strokeWidth={1.4} strokeLinecap="round" />
      {/* body */}
      <ellipse cx={0} cy={0} rx={8} ry={4} fill={fill} />
      {/* head + ears */}
      <circle cx={8.5} cy={0} r={3} fill={fill} />
      <circle cx={7} cy={-3} r={1.4} fill={fill} />
      <circle cx={7} cy={3} r={1.4} fill={fill} />
      {/* nose */}
      <path d="M 11 0 L 13 0" stroke={fill} strokeWidth={1.2} strokeLinecap="round" />
    </g>
  );
}

// One snap-trap pin, centered on the station point. `sprung` lays the kill
// bar over the base (with the caught-rat silhouette when `caught`); armed
// traps hold the bar swung open past the hinge. `firing` re-fires the bar
// and pops a brief flash ring (the ambient-rat cycle).
function TrapPin({ station, meta, index, sprung, caught, firing, animate }) {
  const snapped = sprung || firing;
  return (
    <g
      className={animate ? 'trap-pin trap-pin-pop' : 'trap-pin'}
      style={animate ? { '--trap-i': index } : undefined}
    >
      {/* wooden base */}
      <rect x={-14} y={-9} width={28} height={18} rx={3} fill="#B45309" stroke="#7C2D12" strokeWidth={1.2} />
      <rect x={-14} y={-9} width={28} height={18} rx={3} fill="none" stroke="#FDE68A" strokeWidth={0.6} opacity={0.5} />
      {/* caught rat renders under the sprung bar */}
      {caught && (
        <g transform="translate(0.5, 1)">
          <RatGlyph fill="#1F2937" />
        </g>
      )}
      {/* trigger pedal (hidden once the trap is sprung over it) */}
      {!snapped && <rect x={-3} y={1} width={6} height={5} rx={1.2} fill="#EAB308" stroke="#A16207" strokeWidth={0.8} />}
      {/* spring coils at the hinge */}
      <circle cx={-6.5} cy={-6.5} r={1.6} fill="none" stroke="#64748B" strokeWidth={1.1} />
      <circle cx={6.5} cy={-6.5} r={1.6} fill="none" stroke="#64748B" strokeWidth={1.1} />
      {/* kill bar — hinge at y=-7; drawn in sprung position, armed = scaleY(-1) */}
      <g transform="translate(0,-7)">
        <g className={`trap-bar${snapped ? ' trap-bar-snapped' : ''}`}>
          {/* white underlay keeps the bar readable over dark roofs/canopy */}
          <path
            d="M -10 0 L -10 12 M 10 0 L 10 12 M -10 12 L 10 12"
            fill="none"
            stroke="#fff"
            strokeWidth={4.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
          />
          <path
            d="M -10 0 L -10 12 M 10 0 L 10 12 M -10 12 L 10 12"
            fill="none"
            stroke="#64748B"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </g>
      {/* snap flash ring — remounts (fresh animation) on each firing */}
      {firing && animate && <circle className="trap-flash" cx={0} cy={0} r={6} fill="none" stroke="#F87171" strokeWidth={2} />}
      {/* number badge — the pin number stays the map's index into the legend */}
      <g transform="translate(13,-13)">
        <circle r={8.5} fill={meta.color} stroke="#fff" strokeWidth={2} />
        <text y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">{station.number}</text>
      </g>
    </g>
  );
}

// Decorative rat that scurries from the nearest map edge to the target trap.
// Two-step transform (place at the edge, then transition to the trap) so CSS
// animates the run; the parent clears it after the trap fires.
function ScurryingRat({ from, to }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    node.style.transition = 'none';
    node.style.transform = `translate(${from.x}px, ${from.y}px) ${from.flip ? 'scale(-1,1)' : ''}`;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      node.style.transition = 'transform 2.3s cubic-bezier(0.45, 0.05, 0.6, 0.95)';
      node.style.transform = `translate(${to.x}px, ${to.y}px) ${from.flip ? 'scale(-1,1)' : ''}`;
    }));
    return () => cancelAnimationFrame(raf);
  }, [from.x, from.y, from.flip, to.x, to.y]);
  return (
    <g ref={ref} className="trap-rat" aria-hidden="true">
      <RatGlyph fill="#475569" />
    </g>
  );
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Only ARMED traps (checked, no capture) may star in the ambient cycle — a
// rat running to an inaccessible, unchecked, or already-sprung pin would
// visually contradict that trap's persisted legend status (codex P2 #3004).
export function eligibleTrapIndices(stations = []) {
  return stations
    .map((station, index) => (station.status === 'ok' ? index : -1))
    .filter((index) => index >= 0);
}

// Cycles the ambient rat: pick the next armed trap round-robin, run the rat
// to it (~2.3s), fire the trap, clear. Returns null when idle/disabled.
function useAmbientRatCycle(enabled, eligibleIndices) {
  const [run, setRun] = useState(null); // { stationIdx, phase: 'run' | 'snap' }
  const eligibleKey = eligibleIndices.join(',');
  useEffect(() => {
    if (!enabled || !eligibleIndices.length || prefersReducedMotion()) return undefined;
    let cursor = 0;
    const timers = new Set();
    const later = (fn, ms) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
    };
    const cycle = () => {
      const stationIdx = eligibleIndices[cursor % eligibleIndices.length];
      cursor += 1;
      setRun({ stationIdx, phase: 'run' });
      later(() => setRun({ stationIdx, phase: 'snap' }), 2300);
      later(() => setRun(null), 3400);
    };
    later(cycle, 1600);
    const interval = setInterval(cycle, 10000);
    return () => {
      clearInterval(interval);
      timers.forEach(clearTimeout);
    };
    // eligibleKey is the value identity of eligibleIndices (a fresh array
    // each render) — depending on the array itself would re-arm every render.
  }, [enabled, eligibleKey]);
  return run;
}

// Bait-station pin animation (termite program, GATE_TERMITE_BAIT_PINS): the
// numbered circle pins pop in staggered, and any pin with recorded termite
// activity carries a slow pulsing halo so the red state reads at a glance
// (owner ask 2026-08-15 — the bait animation is the termite report's map
// treatment; the spray trace never renders on bait lanes). Live report views
// only; disabled wholesale under prefers-reduced-motion.
const STATION_PIN_STYLES = `
  .station-pin { transform-box: fill-box; transform-origin: center; }
  .station-pin-pop { animation: station-pop 0.45s cubic-bezier(0.2, 1.4, 0.4, 1) backwards; animation-delay: calc(var(--pin-i, 0) * 0.1s); }
  @keyframes station-pop { from { transform: scale(0); } to { transform: scale(1); } }
  .station-pulse { animation: station-pulse 2.8s ease-out infinite; animation-delay: calc(var(--pin-i, 0) * 0.1s + 0.45s); }
  @keyframes station-pulse { 0% { r: 12px; opacity: 0.7; } 70% { r: 24px; opacity: 0; } 100% { r: 24px; opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .station-pin-pop, .station-pulse { animation: none; }
    .station-pulse { display: none; }
  }
`;

const TRAP_PIN_STYLES = `
  .trap-pin { transform-box: fill-box; transform-origin: center; }
  .trap-pin-pop { animation: trap-pop 0.45s cubic-bezier(0.2, 1.4, 0.4, 1) backwards; animation-delay: calc(var(--trap-i, 0) * 0.1s); }
  @keyframes trap-pop { from { transform: scale(0); } to { transform: scale(1); } }
  .trap-bar { transform: scaleY(-1); transition: transform 0.9s ease; }
  .trap-bar-snapped { transform: scaleY(1); transition: transform 0.09s cubic-bezier(0.9, 0, 1, 1); }
  .trap-flash { animation: trap-flash 0.55s ease-out forwards; }
  @keyframes trap-flash { from { r: 6; opacity: 0.9; } to { r: 22; opacity: 0; } }
  .trap-rat { animation: rat-scurry 0.22s linear infinite; }
  @keyframes rat-scurry { 0%, 100% { opacity: 1; } 50% { opacity: 0.88; } }
  .trap-rat-gone { opacity: 0; transition: opacity 0.25s ease-out; }
  @media (prefers-reduced-motion: reduce) {
    .trap-pin-pop, .trap-flash, .trap-rat { animation: none; }
    .trap-bar, .trap-bar-snapped { transition: none; }
    .trap-rat { display: none; }
  }
`;

export function StationMapCard({ stationMap, sectionId = 'station-map', variant = 'report', hideTitle = false, trapPins = false, animate = false, stationPins = false }) {
  const stations = Array.isArray(stationMap?.stations) ? stationMap.stations : [];
  const useTrapPins = trapPins && stationMap?.program === 'trapping' && variant !== 'plan';
  // Animated circle pins are scoped to the TERMITE bait-station program on the
  // per-visit report card. The 'plan' embed aggregates checks across visits, so
  // a pop-in there would suggest this-visit motion the data doesn't carry; the
  // rodent programs keep their own treatments (static circles / trap pins).
  const useStationPinAnim = stationPins && stationMap?.program === 'termite' && variant !== 'plan' && !useTrapPins;
  // A declared trap SETUP is a per-VISIT fact, so it never applies to the
  // 'plan' variant (that embed aggregates the latest check across visits).
  const initialSetup = variant !== 'plan' && stationMap?.initialSetup === true;
  // Hook runs unconditionally (Rules of Hooks) — it self-disables when the
  // card won't render, animation is off, no trap is armed, or reduced
  // motion is requested.
  //
  // A SETUP map is excluded outright (codex P2 round 15): its pins carry
  // the same 'ok' status an armed trap does, but the setup labels relabel
  // that status "Set this visit" — nothing has been checked yet — so a rat
  // scurrying in and springing one contradicts the stage the report just
  // declared.
  const ratRun = useAmbientRatCycle(
    useTrapPins && animate && !initialSetup && !!stationMap?.available && !!stationMap?.image?.url,
    eligibleTrapIndices(stations),
  );
  if (!stationMap?.available || !stations.length || !stationMap.image?.url) return null;
  const plan = variant === 'plan';
  const programMeta = STATION_CARD_PROGRAM_META[stationMap.program] || STATION_CARD_PROGRAM_META.termite;
  const onFileMeta = plan ? PLAN_ON_FILE_META : STATION_ON_FILE_META;
  // Absent (older payloads) means "no dispute recorded" — only an explicit
  // false suppresses the count line.
  const setupCountVerified = stationMap.setupCountVerified !== false;
  const intro = plan
    ? programMeta.intro.replace('Colors reflect this visit.', PLAN_INTRO_SUFFIX)
    : (initialSetup
      ? 'Numbered pins show where the traps went out on this visit. We check them and adjust placements from here.'
      : programMeta.intro);
  const width = stationMap.image.width || 640;
  const height = stationMap.image.height || 340;
  const legendKeys = [];
  stations.forEach((station) => {
    const key = STATION_STATUS_META[station.status] ? station.status : 'on_file';
    if (!legendKeys.includes(key)) legendKeys.push(key);
  });
  const legend = legendKeys.map((key) => (key === 'on_file'
    ? { key, ...onFileMeta }
    : { key, ...stationStatusMeta(key, programMeta, plan, initialSetup) }));
  const summaryLine = stationSummaryLine(stationMap.summary, programMeta, initialSetup, setupCountVerified);
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
          {useTrapPins && <style>{TRAP_PIN_STYLES}</style>}
          {useStationPinAnim && <style>{STATION_PIN_STYLES}</style>}
          {stations.map((station, index) => {
            const meta = STATION_STATUS_META[station.status]
              ? stationStatusMeta(station.status, programMeta, plan, initialSetup)
              : onFileMeta;
            const cx = station.cx * width;
            const cy = station.cy * height;
            if (useTrapPins) {
              const caught = station.status === 'activity';
              const firing = !!(ratRun && ratRun.phase === 'snap' && ratRun.stationIdx === index);
              return (
                <g key={station.id} transform={`translate(${cx}, ${cy})`}>
                  <title>
                    {`Trap ${station.number}${station.label ? ` — ${station.label}` : ''}: ${meta.label}`}
                  </title>
                  <TrapPin
                    station={station}
                    meta={meta}
                    index={index}
                    sprung={caught}
                    caught={caught}
                    firing={firing}
                    animate={animate}
                  />
                </g>
              );
            }
            return (
              <g
                key={station.id}
                className={useStationPinAnim ? 'station-pin station-pin-pop' : undefined}
                style={useStationPinAnim ? { '--pin-i': index } : undefined}
              >
                <title>
                  {`Station ${station.number}${station.label ? ` — ${station.label}` : ''}: ${meta.label}`}
                </title>
                {/* pulsing halo on activity pins — decorative restatement of the
                    legend color, so it carries no label of its own */}
                {useStationPinAnim && station.status === 'activity' && (
                  <circle className="station-pulse" cx={cx} cy={cy} r={12} fill="none" stroke={meta.color} strokeWidth={2} aria-hidden="true" />
                )}
                <circle cx={cx} cy={cy} r={12} fill={meta.color} stroke="#fff" strokeWidth={2.5} />
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff">
                  {station.number}
                </text>
              </g>
            );
          })}
          {/* decorative scurrying rat — runs from the nearest side edge to
              the target trap, which then fires. aria-hidden, reduced-motion
              hidden, and gone entirely when animation is off. */}
          {useTrapPins && ratRun && ratRun.phase === 'run' && stations[ratRun.stationIdx] && (() => {
            const target = stations[ratRun.stationIdx];
            const tx = target.cx * width;
            const ty = target.cy * height;
            const fromLeft = tx < width / 2;
            return (
              <ScurryingRat
                from={{ x: fromLeft ? -30 : width + 30, y: ty + 6, flip: !fromLeft }}
                to={{ x: tx + (fromLeft ? -16 : 16), y: ty + 6 }}
              />
            );
          })()}
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
