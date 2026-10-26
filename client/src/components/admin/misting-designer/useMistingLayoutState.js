// State for the misting layout designer: the drawn lines, the line in progress, the tool, and the manual
// edits laid over the automatic nozzle placement.
//
// Manual edits (delete, move, add) are an overlay on the CURRENT line geometry only. Any change to the
// lines re-runs auto-placement and clears the overlay (applyGeometry), keeping one snapshot so the
// notice's Undo can put the previous lines and edits back in a single step.
//
// A manual spray direction (aim) is one more manual edit: `aimed` for an automatic nozzle, `aim` on an added
// one. A line change that re-places the nozzles clears it with the rest, under the same notice and Undo.
//
// A bed line (a landscape bed edge) gets risers about every 8 ft instead of nozzles. Those risers are derived like the automatic
// nozzles, and moving or deleting one is the same kind of manual edit (`riserMoved`, `riserRemoved`): cleared with the rest,
// under the same notice and Undo, when the lines change.
//
// Risers, the pump and no-mist zones are not part of the lines. They live in useMistingLayoutExtras, are
// never cleared by a line change, and are merged into the object this hook returns.
import { useMemo, useRef, useState } from 'react';
import { MAP_HEIGHT, MAP_WIDTH, pxToFeet } from '../../tech/treatmentZoneSpray';
import { aimArrowLength, effectiveAim, headingFromVector, normalizeAim } from '../../../lib/mistingLayoutAim';
import { applyRiserEdits, nozzleLines, placeBedRisers } from '../../../lib/mistingLayoutBeds';
import { layoutForExport } from '../../../lib/mistingLayoutPersist';
import {
  applyNozzleEdits,
  computeTotals,
  nearestPointOnLines,
  placeNozzles,
} from '../../../lib/mistingLayoutGeometry';
import { fitsAfterZoom, scaleDraft, scaleEdits, scaleLines } from '../../../lib/mistingLayoutZoom';
import useMistingLayoutExtras from './useMistingLayoutExtras';

const LINE_HIT_CSS_PX = 12;
const VERTEX_HIT_CSS_PX = 14;

const NO_EDITS = Object.freeze({ removed: [], moved: {}, added: [], aimed: {}, riserRemoved: [], riserMoved: {} });
export const editCount = (e) => e.removed.length + Object.keys(e.moved).length + e.added.length + Object.keys(e.aimed || {}).length
  + (e.riserRemoved || []).length + Object.keys(e.riserMoved || {}).length;
const prefersReducedMotion = () => {
  try { return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
};
const hasPoints = (draft) => Boolean(draft && draft.points.length > 0);
const geometryKey = (lines, draft) => JSON.stringify([lines, hasPoints(draft) ? draft : null]);
const within = (a, b, radius) => Math.hypot(a.x - b.x, a.y - b.y) <= radius;

function withoutKey(object, key) {
  const { [key]: _removed, ...rest } = object;
  return rest;
}

// Pure edit-overlay updates.
const deleteFrom = (edits, n) => (n.manual
  ? { ...edits, added: edits.added.filter((a) => a.key !== n.key) }
  : {
    ...edits,
    moved: withoutKey(edits.moved, n.key),
    aimed: withoutKey(edits.aimed || {}, n.key),
    removed: [...edits.removed, n.key],
  });

// A manual aim lives on the added nozzle itself, or in `aimed` for an automatic one.
function aimIn(edits, n, aim) {
  if (n.manual) {
    return { ...edits, added: edits.added.map((a) => (a.key === n.key ? { ...a, aim } : a)) };
  }
  return { ...edits, aimed: { ...(edits.aimed || {}), [n.key]: aim } };
}

function clearAimIn(edits, n) {
  if (n.manual) {
    return { ...edits, added: edits.added.map((a) => { const { aim: _aim, ...rest } = a; return a.key === n.key ? rest : a; }) };
  }
  return { ...edits, aimed: withoutKey(edits.aimed || {}, n.key) };
}

function moveIn(edits, n, to) {
  if (!n.manual) {
    // Re-insert the key so the most recently moved nozzle is last (it is the first one a tap selects).
    return { ...edits, moved: { ...withoutKey(edits.moved, n.key), [n.key]: to } };
  }
  const current = edits.added.find((a) => a.key === n.key);
  if (!current) return edits;
  return { ...edits, added: [...edits.added.filter((a) => a.key !== n.key), { ...current, ...to }] };
}

// `initial` is a reopened saved layout (lib/mistingLayoutPersist restoreLayout): its lines, the edit overlay
// that reproduces the saved nozzles, the risers, pump and zones, and the id counters to continue from.
export default function useMistingLayoutState(mapState, initial = null) {
  const [lines, setLines] = useState(initial ? initial.lines : []);
  const [draft, setDraft] = useState(null); // { id, kind, points }
  const [mode, setMode] = useState('eave');
  const [edits, setEdits] = useState(initial ? initial.edits : NO_EDITS);
  const [addMiss, setAddMiss] = useState(false); // last Add nozzle tap was off every line
  const [notice, setNotice] = useState(null); // { count, snapshot: { lines, draft, edits } }
  const [directions, setDirections] = useState(true); // aim arrows on the map
  const [reducedMotion] = useState(prefersReducedMotion);
  const [spray, setSpray] = useState(() => !prefersReducedMotion()); // animated mist; off for reduced motion
  const [zoomBusy, setZoomBusy] = useState(false); // a photo at another zoom is loading: taps wait for it
  const [aimKey, setAimKey] = useState(null); // the nozzle whose aim was last touched (Reset aim acts on it)
  const idRef = useRef(initial ? initial.idCounter : 0);
  const nextId = (prefix) => {
    idRef.current += 1;
    return `${prefix}${idRef.current}`;
  };

  // ── Derived layout ─────────────────────────────────────────────────────────
  const ready = mapState.status === 'ready';
  const allLines = useMemo(() => (hasPoints(draft) ? [...lines, draft] : lines), [lines, draft]);
  const placed = useMemo(
    () => (ready ? placeNozzles(nozzleLines(allLines), { lat: mapState.center.lat, zoom: mapState.zoom }) : null),
    [ready, allLines, mapState],
  );
  // The risers along the bed lines, less the ones staff deleted and with the ones they moved where they put them.
  const autoBedRisers = useMemo(
    () => (ready ? placeBedRisers(allLines, { lat: mapState.center.lat, zoom: mapState.zoom }) : []),
    [ready, allLines, mapState],
  );
  const bedRisers = useMemo(() => applyRiserEdits(autoBedRisers, edits), [autoBedRisers, edits]);
  const nozzles = useMemo(() => (placed ? applyNozzleEdits(placed.nozzles, edits) : []), [placed, edits]);
  const totals = useMemo(() => computeTotals(placed ? placed.lines : [], nozzles), [placed, nozzles]);
  const extras = useMistingLayoutExtras(mapState, nozzles, bedRisers, initial ? initial.extras : null);
  // Walking-order numbers, the same ones the saved sketch prints, by nozzle key.
  const numbers = useMemo(
    () => new Map(layoutForExport(allLines, nozzles).nozzles.map((n) => [n.key, n.number])),
    [allLines, nozzles],
  );
  // The aim each nozzle is drawn with: its manual aim, else the default for where it stands, and its arrow's length.
  const aims = useMemo(() => {
    if (!ready) return new Map();
    const map = { lat: mapState.center.lat, zoom: mapState.zoom };
    return new Map(nozzles.map((n) => {
      const aim = effectiveAim(n, allLines, extras.zones, map);
      return [n.key, { ...aim, tipPx: aimArrowLength(n, aim.heading, nozzles) }];
    }));
  }, [ready, mapState, nozzles, allLines, extras.zones]);
  // Each riser carries a nozzle, so it sprays too: the same default aim (away from the house, along its line near water).
  const riserAims = useMemo(() => {
    if (!ready) return new Map();
    const map = { lat: mapState.center.lat, zoom: mapState.zoom };
    return new Map(extras.risers.map((r) => [r.key, effectiveAim(r, allLines, extras.zones, map)]));
  }, [ready, mapState, extras.risers, allLines, extras.zones]);
  // Everything that sprays, and the aim of each: the nozzles and the risers.
  const sprayers = useMemo(() => [...nozzles, ...extras.risers], [nozzles, extras.risers]);
  const sprayAims = useMemo(() => new Map([...aims, ...riserAims]), [aims, riserAims]);
  // How far the pump is from the nearest drawn line (eave, fence or bed), in feet.
  const pumpToLineFt = useMemo(() => {
    if (!ready || !extras.pump) return null;
    const hit = nearestPointOnLines(allLines, extras.pump, Infinity);
    return hit ? pxToFeet(hit.distance, mapState.center.lat, mapState.zoom) : null;
  }, [ready, mapState, extras.pump, allLines]);
  const nearWaterCount = useMemo(() => [...aims.values()].filter((a) => a.nearWater).length, [aims]);
  const aimedNozzle = aimKey ? nozzles.find((n) => n.key === aimKey) || null : null;

  // ── Zoom ───────────────────────────────────────────────────────────────────
  // A zoom in is refused while any point would leave the frame; `zoomInFits` says whether it would.
  const zoomInFits = useMemo(
    () => fitsAfterZoom({ lines, draft, edits, extras: { risers: extras.risers, pump: extras.pump, zones: extras.zones } }, 1),
    [lines, draft, edits, extras.risers, extras.pump, extras.zones],
  );

  // The photo changed zoom by `delta`: scale everything staff placed so it stays on the same ground (lib/mistingLayoutZoom).
  // The notice's restore point is at the old scale, so it goes.
  const rescale = (delta) => {
    setLines((prev) => scaleLines(prev, delta));
    setDraft((prev) => scaleDraft(prev, delta));
    setEdits((prev) => scaleEdits(prev, delta));
    setNotice(null);
    extras.rescaleExtras(delta);
  };

  // ── Changes to the lines ───────────────────────────────────────────────────
  // The one door for them. A change that alters the geometry re-places the nozzles, so it clears
  // the manual edits and leaves a notice with a one-step Undo.
  const applyGeometry = (nextLines, nextDraft) => {
    if (geometryKey(nextLines, nextDraft) !== geometryKey(lines, draft) && editCount(edits) > 0) {
      setNotice({ count: editCount(edits), snapshot: { lines, draft, edits } });
      setEdits(NO_EDITS);
    }
    setLines(nextLines);
    setDraft(nextDraft);
  };

  const restoreSnapshot = () => {
    if (!notice) return;
    setLines(notice.snapshot.lines);
    setDraft(notice.snapshot.draft);
    setEdits(notice.snapshot.edits);
    setNotice(null);
  };

  const finishDraft = (extraPoint) => {
    if (!draft) return;
    const points = extraPoint ? [...draft.points, extraPoint] : draft.points;
    applyGeometry(points.length >= 2 ? [...lines, { ...draft, points }] : lines, null);
  };

  // A tap in a drawing tool: a point, or the end of the line (last point again), or a closed loop (first point).
  const addDraftPoint = (p, scale) => {
    const kind = mode === 'fence' || mode === 'bed' ? mode : 'eave';
    // Switching tools finishes the draft, so a draft here is always of this tool's kind.
    const current = draft && draft.kind === kind ? draft : { id: nextId('L'), kind, points: [] };
    const pts = current.points;
    const radius = VERTEX_HIT_CSS_PX * scale;
    if (pts.length >= 2 && within(pts[pts.length - 1], p, radius)) return finishDraft();
    if (pts.length >= 3 && within(pts[0], p, radius)) return finishDraft({ x: pts[0].x, y: pts[0].y });
    if (pts.length > 0 && within(pts[pts.length - 1], p, radius)) return undefined;
    return applyGeometry(lines, { ...current, points: [...pts, { x: p.x, y: p.y }] });
  };

  const undo = () => {
    if (hasPoints(draft)) {
      const points = draft.points.slice(0, -1);
      applyGeometry(lines, points.length ? { ...draft, points } : null);
    } else if (lines.length > 0) {
      applyGeometry(lines.slice(0, -1), null);
    }
  };

  const clearAll = () => {
    applyGeometry([], null);
    setEdits(NO_EDITS);
  };

  const chooseMode = (next) => {
    if (next !== mode) finishDraft();
    setAddMiss(false);
    setAimKey(null);
    setMode(next);
  };

  // ── Manual edits ───────────────────────────────────────────────────────────
  // A manual edit starts a new overlay state, so an old restore point no longer applies.
  const editOverlay = (update) => {
    setNotice(null);
    setEdits(update);
  };

  const deleteNozzle = (n) => editOverlay((prev) => deleteFrom(prev, n));

  const moveNozzle = (n, p) => {
    const to = { x: Math.max(0, Math.min(MAP_WIDTH, p.x)), y: Math.max(0, Math.min(MAP_HEIGHT, p.y)) };
    editOverlay((prev) => moveIn(prev, n, to));
  };

  // Turn a nozzle to face the map point `p` (dragging its arrow tip). A tip dropped on the nozzle has no direction.
  const aimNozzleToward = (n, p) => {
    setAimKey(n.key);
    const aim = headingFromVector(p.x - n.x, p.y - n.y);
    if (aim !== null) editOverlay((prev) => aimIn(prev, n, normalizeAim(aim)));
  };

  const resetAim = (n) => editOverlay((prev) => clearAimIn(prev, n));

  // A bed riser is moved or deleted through the edit overlay; a manual one through the extras.
  const moveRiserTo = (riser, p) => {
    if (riser.source !== 'bed') { extras.moveRiserTo(riser, p); return; }
    const to = { x: Math.max(0, Math.min(MAP_WIDTH, p.x)), y: Math.max(0, Math.min(MAP_HEIGHT, p.y)) };
    editOverlay((prev) => ({ ...prev, riserMoved: { ...withoutKey(prev.riserMoved || {}, riser.key), [riser.key]: to } }));
  };
  const deleteRiserOf = (riser) => {
    if (riser.source !== 'bed') { extras.deleteRiserOf(riser); return; }
    editOverlay((prev) => ({
      ...prev,
      riserMoved: withoutKey(prev.riserMoved || {}, riser.key),
      riserRemoved: [...(prev.riserRemoved || []), riser.key],
    }));
  };

  const addNozzleOnLine = (p, scale) => {
    const hit = nearestPointOnLines(nozzleLines(allLines), p, LINE_HIT_CSS_PX * scale);
    setAddMiss(!hit);
    if (!hit) return;
    const key = nextId('m');
    editOverlay((prev) => ({
      ...prev,
      added: [...prev.added, {
        key,
        manual: true,
        x: hit.x,
        y: hit.y,
        kind: hit.kind,
        lineId: hit.lineId,
        lineIndex: hit.lineIndex,
        segmentIndex: hit.segmentIndex,
        vertexIndex: null,
        corner: false,
      }],
    }));
  };

  return {
    ...extras,
    ready,
    mode,
    chooseMode,
    lines,
    draft,
    allLines,
    nozzles,
    totals,
    edits,
    addMiss,
    notice,
    dismissNotice: () => setNotice(null),
    restoreSnapshot,
    hasContent: lines.length > 0 || hasPoints(draft),
    canFinish: Boolean(draft) && draft.points.length >= 2,
    finishDraft,
    addDraftPoint,
    undo,
    clearAll,
    deleteNozzle,
    moveNozzle,
    addNozzleOnLine,
    moveRiserTo,
    deleteRiserOf,
    numbers,
    aims,
    sprayers,
    sprayAims,
    pumpToLineFt,
    nearWaterCount,
    directions,
    setDirections,
    spray,
    setSpray,
    reducedMotion,
    aimedNozzle,
    selectAim: (n) => setAimKey(n.key),
    aimNozzleToward,
    resetAim,
    zoomBusy,
    setZoomBusy,
    zoomInFits,
    rescale,
  };
}
