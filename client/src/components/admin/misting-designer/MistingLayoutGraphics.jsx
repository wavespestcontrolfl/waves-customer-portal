// Map drawing for the misting layout designer: lines, nozzles, risers, the pump and no-mist zones.
// SVG in map pixels. A flagged nozzle or riser (inside a no-mist zone) gets a red dashed ring AND a
// "!" mark, so the warning does not rely on color alone. A numbered nozzle is blue; it turns amber when
// it is flagged or stands near water, and its arrow turns amber with it.
import { aimVector } from '../../../lib/mistingLayoutAim';
import { MIST_ARROW, MIST_ARROW_NEAR_WATER, MIST_TRACE_STROKES } from '../../../lib/mistingLayoutMistDraw';

export const COPPER = '#b87333';
const WARN = '#dc2626';
const NOZZLE_BLUE = '#0b6fb8';
const AMBER = '#f59e0b';
const AMBER_DARK = '#92400e';
const ARROW_HEAD = 10;
const NOZZLE_R = 14;
const ARROW_FROM = NOZZLE_R + 3; // an arrow starts just outside its dot, so it never hides the number

const pointList = (points) => points.map((p) => `${p.x},${p.y}`).join(' ');

// A traced line is the Treatment Zone Mapper's layered blue glow (wide soft blue, white core, strong blue on top);
// a fence is dashed on the top stroke only, so the glow stays whole.
// A bed line (a landscape bed edge, risers along it) is not a mist trace: a thin dashed copper line with a white halo.
export function LineGraphic({ line }) {
  if (line.kind === 'bed') {
    return (
      <g data-testid="layout-line-bed">
        <polyline points={pointList(line.points)} fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="7" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={pointList(line.points)} fill="none" stroke={COPPER} strokeWidth="3.5" strokeDasharray="10 7" strokeLinejoin="round" />
      </g>
    );
  }
  return (
    <g data-testid={`layout-line-${line.kind}`}>
      {MIST_TRACE_STROKES.map((stroke, i) => (
        <polyline
          key={stroke.width}
          points={pointList(line.points)}
          fill="none"
          stroke={stroke.color}
          strokeWidth={stroke.width}
          strokeDasharray={line.kind === 'fence' && i === MIST_TRACE_STROKES.length - 1 ? '18 12' : undefined}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

function WarnMark({ x, y }) {
  return (
    <g aria-hidden="true">
      <circle cx={x} cy={y} r="18" fill="none" stroke={WARN} strokeWidth="4" strokeDasharray="6 4" />
      <text x={x + 18} y={y - 14} fontSize="26" fontWeight="700" fill={WARN} stroke="#fff" strokeWidth="4" paintOrder="stroke">!</text>
    </g>
  );
}

// The nozzle's spray direction: a short arrow ending at the tip. In Edit nozzles the tip is the drag handle,
// so it gets a ring (a solid one while it is the nozzle Reset aim acts on). The map draws every arrow after every
// nozzle dot, so a neighbour's dot never hides one (a nozzle aimed along its line points at the next dot), and every number
// after the arrows, so an arrow never hides a number.
export function AimArrow({ nozzle, aim, editing, selected }) {
  const v = aimVector(aim.heading);
  const color = aim.nearWater ? MIST_ARROW_NEAR_WATER : MIST_ARROW;
  const shaft = aim.lengthPx - ARROW_HEAD;
  const ex = nozzle.x + v.x * shaft;
  const ey = nozzle.y + v.y * shaft;
  const sx = nozzle.x + v.x * ARROW_FROM;
  const sy = nozzle.y + v.y * ARROW_FROM;
  // The arrow runs along the heading; the handle ring sits on its tip (aim.tip), which only leaves the arrow's end where
  // the nozzle is too near the photo's edge for the arrow to fit (lib/mistingLayoutAim aimHandle).
  const end = { x: nozzle.x + v.x * aim.lengthPx, y: nozzle.y + v.y * aim.lengthPx };
  const tip = aim.tip;
  const head = `${end.x},${end.y} ${ex - v.y * 7},${ey + v.x * 7} ${ex + v.y * 7},${ey - v.x * 7}`;
  return (
    <g data-testid="layout-aim" data-heading={aim.heading} data-manual={aim.manual ? 'true' : 'false'} data-near-water={aim.nearWater ? 'true' : 'false'}>
      <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#000" strokeOpacity="0.55" strokeWidth="6.5" strokeLinecap="round" />
      <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={color} strokeWidth="3.5" strokeLinecap="round" />
      <polygon points={head} fill={color} stroke="#000" strokeOpacity="0.55" strokeWidth="2.5" strokeLinejoin="round" />
      {editing && (
        <circle
          cx={tip.x}
          cy={tip.y}
          r={selected ? 14 : 12}
          fill="none"
          stroke="#fff"
          strokeWidth={selected ? 3 : 2}
          strokeDasharray={selected ? undefined : '3 3'}
        />
      )}
    </g>
  );
}

const isAmber = (flagged, aim) => flagged || Boolean(aim && aim.nearWater);

export function NozzleGraphic({ nozzle, flagged, aim }) {
  const amber = isAmber(flagged, aim);
  return (
    <g>
      <circle
        data-testid="layout-nozzle"
        data-kind={nozzle.kind}
        data-flagged={flagged ? 'true' : 'false'}
        data-near-water={aim && aim.nearWater ? 'true' : 'false'}
        cx={nozzle.x}
        cy={nozzle.y}
        r={NOZZLE_R}
        fill={amber ? AMBER : NOZZLE_BLUE}
        stroke={amber ? AMBER_DARK : '#fff'}
        strokeWidth="3.5"
      />
      {flagged && <WarnMark x={nozzle.x} y={nozzle.y} />}
    </g>
  );
}

// The walking-order number, drawn after the arrows so an arrow never hides it.
export function NozzleNumber({ nozzle, number, flagged, aim }) {
  if (!number) return null;
  return (
    <text
      x={nozzle.x}
      y={nozzle.y + 1}
      fontSize={number > 99 ? 12 : 16}
      fontWeight="700"
      textAnchor="middle"
      dominantBaseline="central"
      fill={isAmber(flagged, aim) ? '#111' : '#fff'}
      aria-hidden="true"
    >
      {number}
    </text>
  );
}

export function RiserGraphic({ riser, flagged }) {
  return (
    <g>
      <circle data-testid="layout-riser" data-flagged={flagged ? 'true' : 'false'} cx={riser.x} cy={riser.y} r="12" fill={COPPER} stroke="#fff" strokeWidth="4" />
      <circle cx={riser.x} cy={riser.y} r="4" fill="#fff" />
      {flagged && <WarnMark x={riser.x} y={riser.y} />}
    </g>
  );
}

function MapLabel({ x, y, children }) {
  return (
    <text x={x} y={y} fontSize="26" fontWeight="600" textAnchor="middle" fill="#000" stroke="#fff" strokeWidth="5" paintOrder="stroke">
      {children}
    </text>
  );
}

// The pump is drawn as its cabinet (Pynamite's Cube Pro): a tan box with a darker lid line.
export const CABINET = { body: '#d8c59b', lid: '#9a7f46', edge: '#6b5428' };

export function PumpGraphic({ pump }) {
  return (
    <g data-testid="layout-pump">
      <rect x={pump.x - 17} y={pump.y - 14} width="34" height="28" rx="2" fill={CABINET.body} stroke="#fff" strokeWidth="4" />
      <rect x={pump.x - 17} y={pump.y - 14} width="34" height="9" rx="2" fill={CABINET.lid} />
      <rect x={pump.x - 17} y={pump.y - 14} width="34" height="28" rx="2" fill="none" stroke={CABINET.edge} strokeWidth="1.5" />
      <MapLabel x={pump.x} y={pump.y + 40}>Pump</MapLabel>
    </g>
  );
}

export function ZoneGraphic({ zone, label }) {
  return (
    <g data-testid="layout-zone" data-kind={zone.kind}>
      <circle cx={zone.x} cy={zone.y} r={zone.radiusPx} fill={WARN} fillOpacity="0.22" stroke={WARN} strokeWidth="4" strokeDasharray="14 8" />
      <MapLabel x={zone.x} y={zone.y + 9}>{`No mist: ${label}`}</MapLabel>
    </g>
  );
}
