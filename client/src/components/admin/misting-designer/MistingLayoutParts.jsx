// Presentational parts of the misting layout designer: tools, controls, map canvas, notices, counts.
// The panels use the glass look (MistingLayoutGlass); the notices stay plain cards under the photo.
import { Button } from '../../ui';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { ZONE_KINDS, zoneKindDef } from '../../../lib/mistingLayoutExtras';
import {
  AimArrow,
  LineGraphic,
  NozzleGraphic,
  NozzleNumber,
  PumpGraphic,
  RiserGraphic,
  ZoneGraphic,
} from './MistingLayoutGraphics';
import { GLASS_SELECT, GlassButton, GlassPanel } from './MistingLayoutGlass';
import MistingSprayLayer from './MistingSprayLayer';

export const CONCEPT_LABEL = 'Concept layout — final placement at the design visit and install.';

const MODES = [
  { key: 'eave', label: 'Eave line' },
  { key: 'fence', label: 'Fence line' },
  { key: 'edit', label: 'Edit nozzles' },
  { key: 'add', label: 'Add nozzle' },
  { key: 'riser', label: 'Riser' },
  { key: 'pump', label: 'Pump' },
  { key: 'zone', label: 'No-mist zone' },
];

const HINTS = {
  edit: 'Tap a nozzle to delete it. Drag a nozzle to move it. Drag the tip of its arrow to aim it.',
  add: 'Tap a drawn line to add a nozzle.',
  riser: 'Tap the photo to add a riser. Tap a riser to delete it, or drag it to move it. A tap only deletes when it lands on a riser.',
  pump: 'Tap the photo to place the pump. Tap again to move it. There is one pump.',
  zone: 'Pick what the mist must avoid, then tap the photo to mark it. Tap inside a zone to delete it.',
};

export function toolHint(mode) {
  return HINTS[mode]
    || `Tap the photo to drop points along the ${mode === 'fence' ? 'fence' : 'eave'}. Tap the last point again, or press Finish line, to end it. Tap the first point to close a loop.`;
}

function ZoneKindPicker({ zoneKind, setZoneKind }) {
  const def = zoneKindDef(zoneKind);
  return (
    <div className="mt-2 grid gap-1 text-14">
      <label htmlFor="misting-zone-kind">No-mist kind</label>
      <select
        id="misting-zone-kind"
        value={zoneKind}
        onChange={(e) => setZoneKind(e.target.value)}
        className={GLASS_SELECT}
      >
        {ZONE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
      </select>
      <span>{def.radiusFt} ft radius</span>
    </div>
  );
}

// What the Edit nozzles tool knows about the arrow last touched: its nozzle, heading, and Reset aim.
function AimStatus({ layout }) {
  const nozzle = layout.aimedNozzle;
  const aim = nozzle ? layout.aims.get(nozzle.key) : null;
  return (
    <div aria-live="polite" data-testid="layout-aim-status" className="mt-2 flex flex-wrap items-center gap-2 text-14">
      {nozzle && aim ? (
        <>
          <span>
            Nozzle {layout.numbers.get(nozzle.key)} aims {Math.round(aim.heading)}° ({aim.manual ? 'set by hand' : 'automatic'})
          </span>
          <GlassButton onClick={() => layout.resetAim(nozzle)} disabled={!aim.manual}>Reset aim</GlassButton>
        </>
      ) : null}
    </div>
  );
}

/** The drawing tools, one pressed at a time: a column down the photo's left edge (a row under it on a phone). */
export function ToolPalette({ layout }) {
  const { mode, chooseMode } = layout;
  return (
    <GlassPanel className="lg:w-[172px]">
      <div role="group" aria-label="Drawing tool" className="flex flex-wrap gap-2 lg:flex-col lg:gap-1.5">
        {MODES.map((m) => (
          <GlassButton key={m.key} aria-pressed={mode === m.key} className="lg:min-h-10" onClick={() => chooseMode(m.key)}>
            {m.label}
          </GlassButton>
        ))}
      </div>
      {mode === 'zone' && <ZoneKindPicker zoneKind={layout.zoneKind} setZoneKind={layout.setZoneKind} />}
      {mode === 'edit' && layout.directions && <AimStatus layout={layout} />}
    </GlassPanel>
  );
}

/** What the tool in use does, under the photo: the photo is for tracing, so the words stay off it. */
export function ToolHint({ layout }) {
  return (
    <>
      <p className="mt-2 text-14 text-zinc-600">{toolHint(layout.mode)} Undo and Clear change the lines only.</p>
      {layout.mode === 'add' && layout.addMiss && (
        <p role="status" className="text-14 text-amber-800">Tap on a drawn line to add a nozzle</p>
      )}
    </>
  );
}

/** The always-visible strip: view switches, then the line and extras actions. */
export function ControlPanel({ layout, editsPresent, panelsShown, onTogglePanels }) {
  const { canFinish, finishDraft, undo, clearAll, hasContent, directions, spray, reducedMotion } = layout;
  return (
    <GlassPanel className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Preview controls" className="flex flex-wrap gap-2">
        <GlassButton
          aria-pressed={spray && !reducedMotion}
          disabled={reducedMotion}
          title={reducedMotion ? 'Motion is turned down on this device' : undefined}
          onClick={() => layout.setSpray(!spray)}
        >
          Spray
        </GlassButton>
        <GlassButton aria-pressed={directions} onClick={() => layout.setDirections(!directions)}>Directions</GlassButton>
        <GlassButton aria-pressed={panelsShown} onClick={onTogglePanels}>Panels</GlassButton>
      </div>
      <div role="group" aria-label="Lines" className="flex flex-wrap gap-2">
        <GlassButton onClick={() => finishDraft()} disabled={!canFinish}>Finish line</GlassButton>
        <GlassButton onClick={undo} disabled={!hasContent}>Undo</GlassButton>
        <GlassButton onClick={clearAll} disabled={!hasContent && !editsPresent}>Clear</GlassButton>
      </div>
      <div role="group" aria-label="Risers, zones and pump" className="flex flex-wrap gap-2">
        <GlassButton onClick={layout.clearExtras} disabled={!layout.hasExtras}>Clear risers, zones and pump</GlassButton>
      </div>
    </GlassPanel>
  );
}

const CROSSHAIR_FOR = { edit: 'pointer', add: 'pointer' };

export function MapCanvas({ frameRef, handlers, layout, mapUrl, address, map }) {
  const { mode, allLines, draft, nozzles, risers, pump, zones, flags, aims, numbers, directions, spray, reducedMotion } = layout;
  const animate = spray && !reducedMotion;
  return (
    <div className="relative w-full overflow-hidden rounded-xs bg-zinc-100" style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}>
      <div
        ref={frameRef}
        data-testid="layout-map"
        {...handlers}
        className="absolute inset-0 select-none"
        style={{ touchAction: 'none', cursor: CROSSHAIR_FOR[mode] || 'crosshair' }}
      >
        <img
          src={mapUrl}
          alt={`Satellite view of ${address || 'the property'}`}
          draggable={false}
          className="absolute inset-0 w-full h-full block"
        />
        <MistingSprayLayer
          nozzles={nozzles}
          aims={aims}
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

export function CountsPanel({ layout, note, riserNote }) {
  const { totals, risers, pump, zones, flags, nearWaterCount } = layout;
  const warnings = zoneWarnings(flags);
  return (
    <GlassPanel aria-live="polite" data-testid="layout-counts" className="text-14">
      <div className="font-medium">
        Nozzles: {totals.count} <span className="font-normal">(eave {totals.eaveCount}, fence {totals.fenceCount})</span>
      </div>
      <div>Near water: {nearWaterCount}</div>
      <div>
        Line: {Math.round(totals.linearFt)} ft <span>(eave {Math.round(totals.eaveFt)} ft, fence {Math.round(totals.fenceFt)} ft)</span>
      </div>
      <div className="font-medium">Risers: {risers.length}</div>
      <div>Pump: {pump ? 'placed' : 'not placed'}</div>
      <div>No-mist zones: {zones.length}</div>
      {warnings.map((w) => (
        <div key={w} data-testid="layout-zone-warning" className="mt-1 font-medium text-red-200">{`Warning: ${w}`}</div>
      ))}
      {note ? <div role="status" className="mt-1 text-amber-200">{note}</div> : null}
      {riserNote ? <div role="status" className="mt-1 text-amber-200">{riserNote}</div> : null}
    </GlassPanel>
  );
}
