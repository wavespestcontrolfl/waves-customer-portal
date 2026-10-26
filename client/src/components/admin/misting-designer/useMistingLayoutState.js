// State for the misting layout designer: the drawn lines, the line in progress, the tool, and the manual
// edits laid over the automatic nozzle placement.
//
// Manual edits (delete, move, add) are an overlay on the CURRENT line geometry only. Any change to the
// lines re-runs auto-placement and clears the overlay (applyGeometry), keeping one snapshot so the
// notice's Undo can put the previous lines and edits back in a single step.
//
// Risers, the pump and no-mist zones are not part of the lines. They live in useMistingLayoutExtras, are
// never cleared by a line change, and are merged into the object this hook returns.
import { useMemo, useRef, useState } from 'react';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import {
  applyNozzleEdits,
  computeTotals,
  nearestPointOnLines,
  placeNozzles,
} from '../../../lib/mistingLayoutGeometry';
import useMistingLayoutExtras from './useMistingLayoutExtras';

const LINE_HIT_CSS_PX = 12;
const VERTEX_HIT_CSS_PX = 14;

const NO_EDITS = Object.freeze({ removed: [], moved: {}, added: [] });
export const editCount = (e) => e.removed.length + Object.keys(e.moved).length + e.added.length;
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
  : { ...edits, moved: withoutKey(edits.moved, n.key), removed: [...edits.removed, n.key] });

function moveIn(edits, n, to) {
  if (!n.manual) {
    // Re-insert the key so the most recently moved nozzle is last (it is the first one a tap selects).
    return { ...edits, moved: { ...withoutKey(edits.moved, n.key), [n.key]: to } };
  }
  const current = edits.added.find((a) => a.key === n.key);
  if (!current) return edits;
  return { ...edits, added: [...edits.added.filter((a) => a.key !== n.key), { ...current, ...to }] };
}

export default function useMistingLayoutState(mapState) {
  const [lines, setLines] = useState([]);
  const [draft, setDraft] = useState(null); // { id, kind, points }
  const [mode, setMode] = useState('eave');
  const [edits, setEdits] = useState(NO_EDITS);
  const [addMiss, setAddMiss] = useState(false); // last Add nozzle tap was off every line
  const [notice, setNotice] = useState(null); // { count, snapshot: { lines, draft, edits } }
  const idRef = useRef(0);
  const nextId = (prefix) => {
    idRef.current += 1;
    return `${prefix}${idRef.current}`;
  };

  // ── Derived layout ─────────────────────────────────────────────────────────
  const ready = mapState.status === 'ready';
  const allLines = useMemo(() => (hasPoints(draft) ? [...lines, draft] : lines), [lines, draft]);
  const placed = useMemo(
    () => (ready ? placeNozzles(allLines, { lat: mapState.center.lat, zoom: mapState.zoom }) : null),
    [ready, allLines, mapState],
  );
  const nozzles = useMemo(() => (placed ? applyNozzleEdits(placed.nozzles, edits) : []), [placed, edits]);
  const totals = useMemo(() => computeTotals(placed ? placed.lines : [], nozzles), [placed, nozzles]);
  const extras = useMistingLayoutExtras(mapState, nozzles);

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
    const kind = mode === 'fence' ? 'fence' : 'eave';
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

  const addNozzleOnLine = (p, scale) => {
    const hit = nearestPointOnLines(allLines, p, LINE_HIT_CSS_PX * scale);
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
  };
}
