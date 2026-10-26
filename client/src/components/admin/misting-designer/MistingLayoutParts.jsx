// Presentational parts of the misting layout designer: tool bar, map drawing, edits-cleared notice, counts.
import { Button } from '../../ui';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';

export const CONCEPT_LABEL = 'Concept layout — final placement at the design visit and install.';

const MODES = [
  { key: 'eave', label: 'Eave line' },
  { key: 'fence', label: 'Fence line' },
  { key: 'edit', label: 'Edit nozzles' },
  { key: 'add', label: 'Add nozzle' },
];

const HINTS = {
  edit: 'Tap a nozzle to delete it. Drag a nozzle to move it.',
  add: 'Tap a drawn line to add a nozzle.',
};

export function toolHint(mode) {
  return HINTS[mode]
    || `Tap the photo to drop points along the ${mode === 'fence' ? 'fence' : 'eave'}. Tap the last point again, or press Finish line, to end it. Tap the first point to close a loop.`;
}

export function Toolbar({ layout, editsPresent }) {
  const { mode, chooseMode, canFinish, finishDraft, undo, clearAll, hasContent } = layout;
  return (
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
      <Button variant="secondary" onClick={() => finishDraft()} disabled={!canFinish}>
        Finish line
      </Button>
      <Button variant="secondary" onClick={undo} disabled={!hasContent}>Undo</Button>
      <Button variant="secondary" onClick={clearAll} disabled={!hasContent && !editsPresent}>
        Clear
      </Button>
    </div>
  );
}

const pointList = (points) => points.map((p) => `${p.x},${p.y}`).join(' ');

function LineGraphic({ line }) {
  return (
    <g data-testid={`layout-line-${line.kind}`}>
      <polyline points={pointList(line.points)} fill="none" stroke="#000" strokeOpacity="0.7" strokeWidth="11" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={pointList(line.points)} fill="none" stroke="#fff" strokeWidth="5" strokeDasharray={line.kind === 'fence' ? '18 12' : undefined} strokeLinejoin="round" />
    </g>
  );
}

function NozzleGraphic({ nozzle }) {
  const fence = nozzle.kind === 'fence';
  return (
    <circle
      data-testid="layout-nozzle"
      data-kind={nozzle.kind}
      cx={nozzle.x}
      cy={nozzle.y}
      r="11"
      fill={fence ? '#fff' : '#000'}
      stroke={fence ? '#000' : '#fff'}
      strokeWidth="3.5"
    />
  );
}

export function MapCanvas({ frameRef, handlers, layout, mapUrl, address }) {
  const { mode, allLines, draft, nozzles } = layout;
  return (
    <div
      ref={frameRef}
      data-testid="layout-map"
      {...handlers}
      className="relative w-full overflow-hidden rounded-xs border-hairline border-zinc-300 bg-zinc-100 select-none"
      style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}`, touchAction: 'none', cursor: mode === 'edit' || mode === 'add' ? 'pointer' : 'crosshair' }}
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
        {allLines.filter((l) => l.points.length > 1).map((l) => <LineGraphic key={l.id} line={l} />)}
        {draft && draft.points.map((p, i) => (
          <circle key={`d${i}`} cx={p.x} cy={p.y} r="5" fill="#fff" stroke="#000" strokeWidth="2" />
        ))}
        {nozzles.map((n) => <NozzleGraphic key={n.key} nozzle={n} />)}
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

export function limitNote(count, limits) {
  const max = Number(limits?.maxNozzles);
  const min = Number(limits?.minNozzles);
  if (Number.isFinite(max) && count > max) return `The estimator accepts up to ${max} nozzles. Remove some before using this count.`;
  if (Number.isFinite(min) && count > 0 && count < min) return `The estimator accepts at least ${min} nozzles. A lower count makes the estimate invalid and sends it to manual review, so add nozzles before using this count.`;
  return null;
}

export function CountsPanel({ totals, note }) {
  return (
    <div aria-live="polite" data-testid="layout-counts" className="mt-3 text-14 text-zinc-900">
      <div className="font-medium">
        Nozzles: {totals.count} <span className="font-normal text-zinc-600">(eave {totals.eaveCount}, fence {totals.fenceCount})</span>
      </div>
      <div className="text-zinc-600">
        Line: {Math.round(totals.linearFt)} ft <span>(eave {Math.round(totals.eaveFt)} ft, fence {Math.round(totals.fenceFt)} ft)</span>
      </div>
      {note ? <div role="status" className="mt-1 text-amber-800">{note}</div> : null}
    </div>
  );
}
