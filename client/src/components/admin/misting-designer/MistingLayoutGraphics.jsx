// Map drawing for the misting layout designer: lines, nozzles, risers, the pump and no-mist zones.
// SVG in map pixels. A flagged nozzle or riser (inside a no-mist zone) gets a red dashed ring AND a
// "!" mark, so the warning does not rely on color alone.

export const COPPER = '#b87333';
const WARN = '#dc2626';

const pointList = (points) => points.map((p) => `${p.x},${p.y}`).join(' ');

export function LineGraphic({ line }) {
  return (
    <g data-testid={`layout-line-${line.kind}`}>
      <polyline points={pointList(line.points)} fill="none" stroke="#000" strokeOpacity="0.7" strokeWidth="11" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={pointList(line.points)} fill="none" stroke="#fff" strokeWidth="5" strokeDasharray={line.kind === 'fence' ? '18 12' : undefined} strokeLinejoin="round" />
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

export function NozzleGraphic({ nozzle, flagged }) {
  const fence = nozzle.kind === 'fence';
  return (
    <g>
      <circle
        data-testid="layout-nozzle"
        data-kind={nozzle.kind}
        data-flagged={flagged ? 'true' : 'false'}
        cx={nozzle.x}
        cy={nozzle.y}
        r="11"
        fill={fence ? '#fff' : '#000'}
        stroke={fence ? '#000' : '#fff'}
        strokeWidth="3.5"
      />
      {flagged && <WarnMark x={nozzle.x} y={nozzle.y} />}
    </g>
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

export function PumpGraphic({ pump }) {
  return (
    <g data-testid="layout-pump">
      <rect x={pump.x - 12} y={pump.y - 12} width="24" height="24" fill="#1d4ed8" stroke="#fff" strokeWidth="4" />
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
