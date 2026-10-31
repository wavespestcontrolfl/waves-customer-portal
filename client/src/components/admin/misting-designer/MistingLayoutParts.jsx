// Presentational parts of the misting layout designer: tool bar, map canvas, notices, counts, legend.
// Everything but the map is the admin's normal UI, outside the photo; the drawing itself is plain.
import { Button, Checkbox } from '../../ui';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { MISTING_LEGEND_KEYS } from '../../../lib/mistingLayoutCounts';
import { pumpLoad, pumpLoadLine, pumpNotice } from '../../../lib/mistingLayoutLimits';
import { PUMP_CHECKS, ZONE_KINDS, pumpChecksOf, zoneKindDef } from '../../../lib/mistingLayoutExtras';
import {
  AimArrow,
  LineGraphic,
  NozzleGraphic,
  NozzleNumber,
  PumpGraphic,
  RiserGraphic,
  ZoneGraphic,
} from './MistingLayoutGraphics';
import MistingSprayLayer from './MistingSprayLayer';

export const CONCEPT_LABEL = 'Concept layout — final placement at the design visit and install.';

const MODES = [
  { key: 'eave', label: 'Eave line' },
  { key: 'fence', label: 'Fence line' },
  { key: 'bed', label: 'Bed line' },
  { key: 'edit', label: 'Edit nozzles' },
  { key: 'add', label: 'Add nozzle' },
  { key: 'riser', label: 'Riser' },
  { key: 'pump', label: 'Pump' },
  { key: 'zone', label: 'No-mist zone' },
];

const HINTS = {
  edit: 'Tap a nozzle to delete it. Drag a nozzle to move it. Drag the tip of its arrow to aim it.',
  add: 'Tap a drawn line to add a nozzle.',
  riser: 'Tap the photo to add a riser. Tap a riser to delete it, or drag it to move it. A tap only deletes when it lands on a riser. Risers along a bed line can be moved or deleted too.',
  pump: 'Tap the photo to place the pump. Tap again to move it. There is one pump.',
  zone: 'Pick what the mist must avoid, then tap the photo to mark it. Tap inside a zone to delete it.',
};

export function toolHint(mode) {
  if (mode === 'bed') {
    return 'Tap the photo to drop points along the edge of a landscape bed. Risers go along it about every 10 ft, with one at each end. Tap the last point again, or press Finish line, to end it.';
  }
  return HINTS[mode]
    || `Tap the photo to drop points along the ${mode === 'fence' ? 'fence' : 'eave'}. Tap the last point again, or press Finish line, to end it. Tap the first point to close a loop.`;
}

function ZoneKindPicker({ zoneKind, setZoneKind }) {
  const def = zoneKindDef(zoneKind);
  return (
    <div className="flex items-center gap-2 mb-3 text-14 text-zinc-900">
      <label htmlFor="misting-zone-kind">No-mist kind</label>
      <select
        id="misting-zone-kind"
        value={zoneKind}
        onChange={(e) => setZoneKind(e.target.value)}
        className="min-h-11 px-2 rounded-xs border-hairline border-zinc-300 bg-white text-14"
      >
        {ZONE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
      </select>
      <span className="text-zinc-600">{def.radiusFt} ft radius</span>
    </div>
  );
}

// What the Edit nozzles tool knows about the arrow last touched: its nozzle, heading, and Reset aim.
function AimStatus({ layout }) {
  const nozzle = layout.aimedNozzle;
  const aim = nozzle ? layout.aims.get(nozzle.key) : null;
  return (
    <div aria-live="polite" data-testid="layout-aim-status" className="flex flex-wrap items-center gap-2 mb-3 text-14 text-zinc-900">
      {nozzle && aim ? (
        <>
          <span>
            Nozzle {layout.numbers.get(nozzle.key)} aims {Math.round(aim.heading)}° ({aim.manual ? 'set by hand' : 'automatic'})
          </span>
          <Button variant="secondary" onClick={() => layout.resetAim(nozzle)} disabled={!aim.manual}>Reset aim</Button>
        </>
      ) : null}
    </div>
  );
}

// − and + step the photo's zoom, like the Treatment Zone Mapper's: out as far as MIN_TRACE_ZOOM, in as far as the
// closest photo there is. + is off, with its reason beside it, when a point would leave the photo.
function ZoomControl({ zoom }) {
  const { level, canOut, canIn, busy, reason, onStep } = zoom;
  return (
    <div role="group" aria-label="Map zoom" className="flex flex-wrap items-center gap-2 mb-3">
      <Button variant="secondary" aria-label="Zoom out" disabled={!canOut || busy} onClick={() => onStep(-1)}>−</Button>
      <span data-testid="layout-zoom" className="text-14 text-zinc-900">Zoom {level}</span>
      <Button variant="secondary" aria-label="Zoom in" disabled={!canIn || busy} onClick={() => onStep(1)}>+</Button>
      {reason ? <span data-testid="layout-zoom-note" className="text-14 text-zinc-600">{reason}</span> : null}
    </div>
  );
}

export function Toolbar({ layout, editsPresent, zoom }) {
  const { mode, chooseMode, canFinish, finishDraft, undo, clearAll, hasContent, directions, spray, reducedMotion } = layout;
  return (
    <>
      <div role="group" aria-label="Drawing tool" className="flex flex-wrap gap-2 mb-3">
        {MODES.map((m) => (
          <Button
            key={m.key}
            variant={mode === m.key ? 'primary' : 'secondary'}
            aria-pressed={mode === m.key}
            onClick={() => chooseMode(m.key)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      {mode === 'zone' && <ZoneKindPicker zoneKind={layout.zoneKind} setZoneKind={layout.setZoneKind} />}
      {mode === 'edit' && directions && <AimStatus layout={layout} />}
      <div role="group" aria-label="Lines" className="flex flex-wrap gap-2 mb-3">
        <Button variant="secondary" onClick={() => finishDraft()} disabled={!canFinish}>
          Finish line
        </Button>
        <Button variant="secondary" onClick={undo} disabled={!hasContent}>Undo</Button>
        <Button variant="secondary" onClick={clearAll} disabled={!hasContent && !editsPresent}>
          Clear
        </Button>
      </div>
      <div role="group" aria-label="Risers, zones and pump" className="flex flex-wrap items-center gap-2 mb-3">
        <Button variant="secondary" onClick={layout.clearExtras} disabled={!layout.hasExtras}>
          Clear risers, zones and pump
        </Button>
        <span className="text-14 text-zinc-600">Undo and Clear change the lines only.</span>
      </div>
      {zoom && <ZoomControl zoom={zoom} />}
      <div role="group" aria-label="Preview controls" className="flex flex-wrap items-center gap-2 mb-3">
        <Button
          variant={spray && !reducedMotion ? 'primary' : 'secondary'}
          aria-pressed={spray && !reducedMotion}
          disabled={reducedMotion}
          title={reducedMotion ? 'Motion is turned down on this device' : undefined}
          onClick={() => layout.setSpray(!spray)}
        >
          Spray
        </Button>
        <Button variant={directions ? 'primary' : 'secondary'} aria-pressed={directions} onClick={() => layout.setDirections(!directions)}>
          Directions
        </Button>
      </div>
    </>
  );
}

const CROSSHAIR_FOR = { edit: 'pointer', add: 'pointer' };

export function MapCanvas({ frameRef, handlers, layout, mapUrl, address, map }) {
  const { mode, allLines, draft, nozzles, risers, pump, zones, flags, aims, numbers, directions, spray, reducedMotion } = layout;
  const animate = spray && !reducedMotion;
  return (
    <div
      ref={frameRef}
      data-testid="layout-map"
      {...handlers}
      className="relative w-full overflow-hidden rounded-xs border-hairline border-zinc-300 bg-zinc-100 select-none"
      style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}`, touchAction: 'none', cursor: CROSSHAIR_FOR[mode] || 'crosshair' }}
    >
      <img
        src={mapUrl}
        alt={`Satellite view of ${address || 'the property'}`}
        draggable={false}
        className="absolute inset-0 w-full h-full block"
      />
      <MistingSprayLayer
        nozzles={layout.sprayers}
        aims={layout.sprayAims}
        lat={map.lat}
        zoom={map.zoom}
        animate={animate}
        wedges={directions && !animate}
      />
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        aria-hidden="true"
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: 'none' }}
      >
        {zones.map((z) => <ZoneGraphic key={z.key} zone={z} label={zoneKindDef(z.kind).label} />)}
        {allLines.filter((l) => l.points.length > 1).map((l) => <LineGraphic key={l.id} line={l} />)}
        {draft && draft.points.map((p, i) => (
          <circle key={`d${i}`} cx={p.x} cy={p.y} r="5" fill="#fff" stroke="#000" strokeWidth="2" />
        ))}
        {nozzles.map((n) => (
          <NozzleGraphic key={n.key} nozzle={n} aim={aims.get(n.key)} flagged={flags.nozzleKeys.has(n.key)} />
        ))}
        {directions && nozzles.map((n) => (aims.has(n.key) ? (
          <AimArrow
            key={n.key}
            nozzle={n}
            aim={aims.get(n.key)}
            editing={mode === 'edit'}
            selected={Boolean(layout.aimedNozzle) && layout.aimedNozzle.key === n.key}
          />
        ) : null))}
        {nozzles.map((n) => (
          <NozzleNumber
            key={n.key}
            nozzle={n}
            number={numbers.get(n.key)}
            aim={aims.get(n.key)}
            flagged={flags.nozzleKeys.has(n.key)}
          />
        ))}
        {risers.map((r) => <RiserGraphic key={r.key} riser={r} flagged={flags.riserKeys.has(r.key)} />)}
        {pump && <PumpGraphic pump={pump} />}
      </svg>
    </div>
  );
}

export function EditsClearedNotice({ notice, onRestore, onDismiss }) {
  return (
    <div role="status" data-testid="layout-edits-cleared" className="mt-3 px-3 py-2 rounded-xs border-hairline border-zinc-300 bg-zinc-50 text-14 text-zinc-900 flex flex-wrap items-center gap-2">
      <span>
        Changing the lines re-places the nozzles. Your {notice.count} manual {notice.count === 1 ? 'edit was' : 'edits were'} cleared.
      </span>
      <Button variant="secondary" aria-label="Undo and restore the previous lines and edits" onClick={onRestore}>Undo</Button>
      <button type="button" aria-label="Dismiss notice" className="text-zinc-600 px-2 min-h-11" onClick={onDismiss}>×</button>
    </div>
  );
}

export function ExtrasClearedNotice({ notice, onRestore, onDismiss }) {
  return (
    <div role="status" data-testid="layout-extras-cleared" className="mt-3 px-3 py-2 rounded-xs border-hairline border-zinc-300 bg-zinc-50 text-14 text-zinc-900 flex flex-wrap items-center gap-2">
      <span>Cleared {notice.count} {notice.count === 1 ? 'item' : 'items'} (risers, zones and pump).</span>
      <Button variant="secondary" aria-label="Undo and restore the cleared risers, zones and pump" onClick={onRestore}>Undo</Button>
      <button type="button" aria-label="Dismiss cleared notice" className="text-zinc-600 px-2 min-h-11" onClick={onDismiss}>×</button>
    </div>
  );
}

export function limitNote(count, limits) {
  const max = Number(limits?.maxNozzles);
  const min = Number(limits?.minNozzles);
  if (Number.isFinite(max) && count > max) return `The estimator accepts up to ${max} nozzles. Remove some before using this count.`;
  if (Number.isFinite(min) && count > 0 && count < min) return `The estimator accepts at least ${min} nozzles. A lower count makes the estimate invalid and sends it to manual review, so add nozzles before using this count.`;
  return null;
}

export function riserLimitNote(count, limits) {
  const max = Number(limits?.maxRisers);
  if (Number.isFinite(max) && count > max) return `The estimator accepts up to ${max} risers. Remove some before using this count.`;
  return null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Visible warning lines for nozzles and risers inside a no-mist zone. Empty when there are none. */
export function zoneWarnings(flags) {
  const out = [];
  const nozzles = flags.nozzleKeys.size;
  const risers = flags.riserKeys.size;
  if (nozzles > 0) out.push(`${plural(nozzles, 'nozzle', 'nozzles')} inside a no-mist zone: aim away or remove`);
  if (risers > 0) out.push(`${plural(risers, 'riser', 'risers')} inside a no-mist zone: move or remove`);
  return out;
}

// Pynamite's manual lists these for the pump spot. Staff confirm all four before a layout can be saved; moving the pump
// clears them. Shown only once the pump is placed, outside the photo.
export function PumpChecklist({ layout }) {
  const { pump, checkPump } = layout;
  if (!pump) return null;
  const checks = pumpChecksOf(pump);
  return (
    <fieldset data-testid="layout-pump-checklist" className="mt-3 border-0 p-0 m-0 min-w-0">
      <legend className="text-14 font-medium text-zinc-900 mb-1 p-0">Pump spot (Pynamite manual)</legend>
      <div className="flex flex-col gap-1.5">
        {PUMP_CHECKS.map(({ key, label }) => (
          <Checkbox
            key={key}
            id={`misting-pump-check-${key}`}
            label={label}
            checked={checks[key]}
            onChange={(e) => checkPump(key, e.target.checked)}
          />
        ))}
      </div>
    </fieldset>
  );
}

export function CountsPanel({ layout, note, riserNote }) {
  const { totals, risers, pump, zones, flags, nearWaterCount, pumpToLineFt } = layout;
  const warnings = zoneWarnings(flags);
  const load = pumpLoad(totals.count, risers.length);
  const loadNotice = pumpNotice(load);
  return (
    <div aria-live="polite" data-testid="layout-counts" className="text-14 text-zinc-900">
      <div className="font-medium">
        Nozzles: {totals.count} <span className="font-normal text-zinc-600">(eave {totals.eaveCount}, fence {totals.fenceCount})</span>
      </div>
      <div className="text-zinc-600">Near water: {nearWaterCount}</div>
      <div className="text-zinc-600">
        Line: {Math.round(totals.linearFt)} ft <span>(eave {Math.round(totals.eaveFt)} ft, fence {Math.round(totals.fenceFt)} ft)</span>
      </div>
      <div className="font-medium">Risers: {risers.length}</div>
      <div className="text-zinc-600">{pumpLoadLine(load)}</div>
      <div className="text-zinc-600">Pump: {pump ? 'placed' : 'not placed'}</div>
      {pumpToLineFt !== null && <div className="text-zinc-600">Pump to nearest line: {Math.round(pumpToLineFt)} ft</div>}
      <div className="text-zinc-600">No-mist zones: {zones.length}</div>
      {warnings.map((w) => (
        <div key={w} data-testid="layout-zone-warning" className="mt-1 text-alert-fg font-medium">{`Warning: ${w}`}</div>
      ))}
      {loadNotice ? (
        <div
          role="status"
          data-testid="layout-pump-notice"
          data-level={loadNotice.level}
          className={`mt-1 font-medium ${loadNotice.level === 'red' ? 'text-alert-fg' : 'text-amber-800'}`}
        >
          {loadNotice.text}
        </div>
      ) : null}
      {note ? <div role="status" className="mt-1 text-amber-800">{note}</div> : null}
      {riserNote ? <div role="status" className="mt-1 text-amber-800">{riserNote}</div> : null}
    </div>
  );
}

// What each mark on the map means. The photo carries no legend of its own.
const SWATCH = {
  nozzle: { background: '#0b6fb8', border: '2px solid #fff', borderRadius: '50%' },
  near: { background: '#f59e0b', border: '2px solid #92400e', borderRadius: '50%' },
  arrow: { background: '#7dd3fc', borderRadius: 2, height: 4, width: 18, border: 0, alignSelf: 'center' },
  riser: { background: '#b87333', border: '2px solid #fff', borderRadius: '50%' },
  pump: { background: '#d8c59b', border: '2px solid #9a7f46', borderTopWidth: 4, borderRadius: 2 },
  bed: { background: '#b87333', borderRadius: 2, height: 3, width: 16, border: 0, alignSelf: 'center' },
  zone: { background: 'rgba(220,38,38,0.35)', border: '2px dashed #dc2626', borderRadius: '50%' },
};

export function MistingLegend() {
  return (
    <ul data-testid="layout-legend" aria-label="Legend" className="grid gap-1 text-14 text-zinc-600 m-0 p-0 list-none">
      {MISTING_LEGEND_KEYS.map((k) => (
        <li key={k.key} className="flex items-center gap-2">
          <i aria-hidden="true" className="inline-block shrink-0" style={{ boxSizing: 'content-box', width: 10, height: 10, ...SWATCH[k.key] }} />
          {k.label}
        </li>
      ))}
    </ul>
  );
}
