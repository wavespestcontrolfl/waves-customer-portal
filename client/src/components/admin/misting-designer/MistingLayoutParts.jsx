// Presentational parts of the misting layout designer: tool bar, map canvas, notices, counts.
import { Button } from '../../ui';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { ZONE_KINDS, zoneKindDef } from '../../../lib/mistingLayoutExtras';
import {
  LineGraphic,
  NozzleGraphic,
  PumpGraphic,
  RiserGraphic,
  ZoneGraphic,
} from './MistingLayoutGraphics';

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
  edit: 'Tap a nozzle to delete it. Drag a nozzle to move it.',
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

export function Toolbar({ layout, editsPresent }) {
  const { mode, chooseMode, canFinish, finishDraft, undo, clearAll, hasContent } = layout;
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
        <span className="text-14 text-zinc-600">Undo and Clear above change the lines only.</span>
      </div>
    </>
  );
}

const CROSSHAIR_FOR = { edit: 'pointer', add: 'pointer' };

export function MapCanvas({ frameRef, handlers, layout, mapUrl, address }) {
  const { mode, allLines, draft, nozzles, risers, pump, zones, flags } = layout;
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
        {nozzles.map((n) => <NozzleGraphic key={n.key} nozzle={n} flagged={flags.nozzleKeys.has(n.key)} />)}
        {risers.map((r) => <RiserGraphic key={r.key} riser={r} flagged={flags.riserKeys.has(r.key)} />)}
        {pump && <PumpGraphic pump={pump} />}
      </svg>
      <div className="absolute left-2 top-2 right-2 pointer-events-none">
        <span className="inline-block px-2 py-1 rounded-xs bg-black/70 text-white text-14">{CONCEPT_LABEL}</span>
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
  const { totals, risers, pump, zones, flags } = layout;
  const warnings = zoneWarnings(flags);
  return (
    <div aria-live="polite" data-testid="layout-counts" className="mt-3 text-14 text-zinc-900">
      <div className="font-medium">
        Nozzles: {totals.count} <span className="font-normal text-zinc-600">(eave {totals.eaveCount}, fence {totals.fenceCount})</span>
      </div>
      <div className="text-zinc-600">
        Line: {Math.round(totals.linearFt)} ft <span>(eave {Math.round(totals.eaveFt)} ft, fence {Math.round(totals.fenceFt)} ft)</span>
      </div>
      <div className="font-medium">Risers: {risers.length}</div>
      <div className="text-zinc-600">Pump: {pump ? 'placed' : 'not placed'}</div>
      <div className="text-zinc-600">No-mist zones: {zones.length}</div>
      {warnings.map((w) => (
        <div key={w} data-testid="layout-zone-warning" className="mt-1 text-alert-fg font-medium">{`Warning: ${w}`}</div>
      ))}
      {note ? <div role="status" className="mt-1 text-amber-800">{note}</div> : null}
      {riserNote ? <div role="status" className="mt-1 text-amber-800">{riserNote}</div> : null}
    </div>
  );
}
