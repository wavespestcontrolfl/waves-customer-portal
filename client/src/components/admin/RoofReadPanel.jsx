import React, { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Field, Input, Select } from "../ui";

// Staff-only roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19). The county aerial of the home, with the AI's
// likely rodent entry points drawn on it, and the technician's own count saved beside it. Every new read is a
// paid model call, so nothing here runs on its own: only the "Read the roof" tap posts. The parent shows this
// panel only while the server says the gate is on, and mounts it with a key so a new estimate, property,
// customer or lead starts from a blank panel.
//
// Owner ruling 2026-11-20 (choice 4A): the customer estimate shows only the points the technician confirmed. The AI's
// "yes" pins are faded suggestions here; tapping one confirms it, tapping the empty photo adds a point, and a point can
// be dragged, retyped, given a short note, or removed. "Save points" stores them with the PATCH (still a tap, never on load).

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export const ROOF_TYPES = [
  { key: "roof_returns_and_valleys", label: "Roof returns and valleys" },
  { key: "plumbing_vent_stacks", label: "Plumbing vent stacks" },
  { key: "roof_vents_or_turbines", label: "Roof vents or turbines" },
  { key: "chimney_or_flue", label: "Chimney or flue" },
  { key: "ac_or_utility_line_entry", label: "AC or utility line entry" },
  { key: "soffit_or_fascia_gaps", label: "Soffit or fascia gaps" },
  { key: "gable_vents", label: "Gable vents" },
  { key: "trees_touching_roof", label: "Trees touching the roof" },
  { key: "tile_eave_open_ends", label: "Tile eave open ends" },
];

// The types a confirmed point can carry (the server's TECH_PIN_TYPES), with the one letter a suggestion shows on the photo.
export const POINT_TYPES = [...ROOF_TYPES, { key: "other", label: "Other entry point" }];
const TYPE_LETTERS = {
  roof_returns_and_valleys: "R", plumbing_vent_stacks: "P", roof_vents_or_turbines: "V", chimney_or_flue: "C",
  ac_or_utility_line_entry: "A", soffit_or_fascia_gaps: "S", gable_vents: "G", trees_touching_roof: "T",
  tile_eave_open_ends: "E", other: "O",
};
const TYPE_LABELS = Object.fromEntries(POINT_TYPES.map((t) => [t.key, t.label]));
const MAX_POINTS = 20;
const MAX_NOTE = 40;
const NUDGE = 0.01;
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const TIER_LABELS = { low: "Low", med: "Medium", high: "High", unknown: "Could not be read" };
const LIKELY_LABELS = { yes: "Yes", no: "No", unsure: "Unsure" };
const MAX_TECH_COUNT = 500;

// A missing, blank or null coordinate is NaN, never 0.
const coordinate = (v) => (typeof v === "number" || (typeof v === "string" && v.trim()) ? Number(v) : NaN);

// The lookup doubts the address: the geocoder snapped the typed house number to another premise (marker on
// addressAudit, and on the record's _addressAudit), or the lookup raised an address verify flag
// (enriched.fieldVerifyFlags, field "address"). The map point may then be a neighbour's house.
export function roofAddressDoubtful(data) {
  const record = data?.propertyRecord || data?.rentcast || null;
  const flagged = Array.isArray(data?.enriched?.fieldVerifyFlags) && data.enriched.fieldVerifyFlags.some((f) => f?.field === "address");
  return !!(data?.addressAudit?.snappedRecord || record?._addressAudit?.snappedRecord || flagged);
}

// Where the lookup put the home: coordinates and county, or null when either is missing or the lookup doubts the address.
export function roofSpotFrom(data) {
  const record = data?.propertyRecord || data?.rentcast || null;
  if (roofAddressDoubtful(data)) return null;
  const lat = coordinate(data?.satellite?.lat ?? record?.latitude);
  const lng = coordinate(data?.satellite?.lng ?? record?.longitude);
  const county = record?._parcel?.county || record?.county || "";
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !String(county).trim()) return null;
  return { lat, lng, county: String(county) };
}

function roofFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

const READ_GATE_OFF = "Roof read is switched off on the server.";
const READ_ERRORS = { __proto__: null, reference_mismatch: "This estimate belongs to a different customer, so no read was made." };

const PROBLEM_COPY = {
  no_image: "No county photo for this spot, so nothing was read. No charge.",
  model_failed: "The photo was found but the read failed. Try again in a minute.",
  in_progress: "Another read of this roof is still running. Wait a few seconds, then tap Try again.",
};

function techFlagsFrom(read) {
  const saved = read?.tech_final_flags || {};
  return Object.fromEntries(ROOF_TYPES.map(({ key }) => [key, saved[key] === "yes"]));
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round4 = (n) => Math.round(n * 10000) / 10000;

// The AI's "yes" pins, as suggestions. x and y are fractions from the top-left of the picture. A suggestion's key,
// "<entry type>:<index into that type's AI pins>", is what a confirmed point stores as its source.
function suggestionsFrom(read) {
  return ROOF_TYPES.flatMap((t) => {
    const entry = read?.flags?.[t.key];
    if (entry?.likely !== "yes") return [];
    return (entry.pins || []).map((p, i) => ({ key: `${t.key}:${i}`, type: t.key, x: p.x, y: p.y }));
  });
}

// The technician's saved points, each with a local id so a point can be dragged and edited. Ids never leave the panel.
function pointsFrom(read, nextId) {
  return (Array.isArray(read?.tech_pins) ? read.tech_pins : []).map((p) => ({
    id: nextId(), x: p.x, y: p.y, type: TYPE_LABELS[p.type] ? p.type : "other", note: p.note || "", source: typeof p.source === "string" ? p.source : null,
  }));
}

const pointText = (p) => `${TYPE_LABELS[p.type]}${p.note.trim() ? `, ${p.note.trim()}` : ""}`;

const PIN_BASE = "absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 p-0 rounded-full text-11 leading-4 text-center focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1";

// The county crop with the AI's suggestions (faded, with the type letter) and the technician's confirmed points
// (solid, numbered) on it. The photo is a click target for adding a point; every point is a button.
function RoofImage({ url, imageKey, imageState, onImageLoad, onImageError, onRetry, suggestions, points, selectedId, editable, frameRef, onAdd, onConfirm, onSelect, onMove, onNudge, onRemove }) {
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const letters = [...new Set(suggestions.map((s) => s.type))];

  function addAt(e) {
    if (!editable || e.target.closest("[data-roof-point]")) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    onAdd(clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height));
  }
  function down(e, id) {
    suppressClick.current = false;
    if (!editable || (e.button != null && e.button > 0)) return;
    drag.current = { id, sx: e.clientX, sy: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    d.moved = true;
    onMove(d.id, clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height));
  }
  function up() {
    if (drag.current?.moved) suppressClick.current = true;
    drag.current = null;
  }
  function key(e, id) {
    if (!editable) return;
    const arrow = ARROWS[e.key];
    if (arrow) {
      e.preventDefault();
      onNudge(id, arrow[0] * NUDGE, arrow[1] * NUDGE);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove(id);
    } else if (e.key === "Escape") {
      onSelect(null);
    }
  }

  return (
    <div>
      <div
        ref={frameRef}
        className={`relative w-full max-w-md aspect-square bg-zinc-100 border-hairline border-zinc-200 rounded-xs overflow-hidden ${editable ? "cursor-crosshair" : ""}`}
        data-testid="roof-read-image"
        onClick={addAt}
      >
        <img
          key={imageKey}
          ref={(el) => { if (el && el.complete && el.naturalWidth > 0) onImageLoad(); }}
          src={url}
          alt="County aerial photo of the roof"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
          draggable={false}
          onLoad={onImageLoad}
          onError={onImageError}
        />
        {suggestions.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid="roof-read-pin"
            data-roof-point="suggestion"
            data-type={s.type}
            title={`${TYPE_LABELS[s.type]} (suggested by the AI). Tap to confirm.`}
            aria-label={`Suggested point: ${TYPE_LABELS[s.type]}. Confirm it`}
            disabled={!editable}
            onClick={(e) => { e.stopPropagation(); onConfirm(s); }}
            className={`${PIN_BASE} bg-white/70 text-zinc-900 border border-dashed border-zinc-900 opacity-70`}
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}
          >
            {TYPE_LETTERS[s.type]}
          </button>
        ))}
        {points.map((p, i) => (
          <button
            key={p.id}
            type="button"
            data-testid="roof-read-point"
            data-roof-point="confirmed"
            data-n={i + 1}
            data-type={p.type}
            aria-label={`Point ${i + 1}: ${pointText(p)}`}
            aria-pressed={selectedId === p.id}
            title={pointText(p)}
            disabled={!editable}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClick.current) { suppressClick.current = false; return; }
              onSelect(selectedId === p.id ? null : p.id);
            }}
            onPointerDown={(e) => down(e, p.id)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={(e) => key(e, p.id)}
            className={`${PIN_BASE} touch-none bg-zinc-900 text-white border-2 border-white ${selectedId === p.id ? "ring-2 ring-zinc-900 ring-offset-1" : ""}`}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          >
            {i + 1}
          </button>
        ))}
      </div>
      {letters.length > 0 && (
        <p className="text-14 text-zinc-600 mt-2" data-testid="roof-read-legend">
          Faded letters are the AI's suggestions: {letters.map((t) => `${TYPE_LETTERS[t]} ${TYPE_LABELS[t]}`).join(" · ")}
        </p>
      )}
      {imageState === "loading" && <p className="text-14 text-zinc-600" role="status" data-testid="roof-read-image-loading">Loading the roof photo…</p>}
      {imageState === "error" && (
        <div className="flex items-center gap-3" data-testid="roof-read-image-error">
          <p className="text-14 text-zinc-600" role="alert">The roof photo did not load.</p>
          <Button variant="secondary" size="sm" onClick={onRetry} data-testid="roof-read-image-retry">Try again</Button>
        </div>
      )}
    </div>
  );
}

// False once the component unmounts, so a late server answer never sets state on a panel that is gone.
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

const IDLE = { busy: false, msg: "", err: "" };
const countText = (n) => (n == null ? "" : String(n));

// The result line beside a save button: "Saved." or the error.
function SaveNote({ state, statusTestId, errorTestId }) {
  return (
    <>
      {state.msg && <span className="text-14 text-zinc-600" role="status" data-testid={statusTestId}>{state.msg}</span>}
      {state.err && <span className="text-14 text-zinc-600" role="alert" data-testid={errorTestId}>{state.err}</span>}
    </>
  );
}

// What the server holds for the points, the checkbox and the address the points were saved for.
const savedFrom = (read) => ({ pins: read.tech_pins ?? null, hidden: !!read.hide_on_estimate, address: read.points_address ?? null });

// The photo and the technician's confirmed points. It mounts with each loaded read (the panel hides it while a read
// runs), so its state starts from what the server holds. `saved` is the server's last answer for the points and the
// checkbox: the baseline a save is checked against, set at load and by each points save. A count save never touches it.
function RoofPointsEditor({ read, imageUrl, spot, address, estimateId, onReadAgain }) {
  const pointId = useRef(0);
  const nextId = () => { pointId.current += 1; return `pt${pointId.current}`; };
  const frameRef = useRef(null);
  const mounted = useMounted();
  const [saved, setSaved] = useState(() => savedFrom(read));
  const [points, setPoints] = useState(() => pointsFrom(read, nextId));
  const [selectedId, setSelectedId] = useState(null);
  const [showOnEstimate, setShowOnEstimate] = useState(() => !read.hide_on_estimate);
  // True only after staff click the checkbox here: an untouched checkbox is never sent, so a save from this panel never
  // reverses a hide choice another tab made.
  const [hideEdited, setHideEdited] = useState(false);
  const [pointsEdited, setPointsEdited] = useState(false);
  const [pointsState, setPointsState] = useState(IDLE);
  // The county photo: points are placed on it, so nothing can be added until it has loaded.
  const [imageState, setImageState] = useState("loading");
  const [imageTry, setImageTry] = useState(0);

  // A read whose AI answer did not work (tier unknown) is never reopened and the server refuses points on it.
  const readUsable = read.tier !== "unknown";
  const locked = !estimateId || pointsState.busy;
  const editable = !locked && imageState === "loaded" && readUsable;
  const atMax = points.length >= MAX_POINTS;
  // A suggestion stays hidden while any point, saved or not, names it as its source, even after the point moved or changed type.
  const suggestions = suggestionsFrom(read).filter((sg) => !points.some((p) => p.source === sg.key));
  // A list saved before the server recorded the home's address with it. The customer estimate shows points only with
  // their address, so Save points sends this list again as it stands, with the address of this lookup.
  const unconfirmed = Boolean(saved.pins?.length) && !saved.address;
  // Whether the checkbox differs from what the server holds: only then is hide_on_estimate sent.
  const hideChanged = hideEdited && !showOnEstimate !== saved.hidden;
  const selected = points.find((p) => p.id === selectedId) || null;

  const clearNote = () => setPointsState((st) => (st.busy ? st : IDLE));
  const edited = (fn) => { fn(); setPointsEdited(true); clearNote(); };
  function addPoint(x, y, type = "other", source = null) {
    if (!editable || atMax) return;
    const id = nextId();
    edited(() => {
      setPoints((list) => (list.length >= MAX_POINTS ? list : [...list, { id, x: round4(x), y: round4(y), type, note: "", source }]));
      setSelectedId(id);
    });
  }
  const confirmSuggestion = (sg) => addPoint(sg.x, sg.y, sg.type, sg.key);
  function changePoint(id, patch) {
    if (!editable) return;
    edited(() => setPoints((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p))));
  }
  const movePoint = (id, x, y) => changePoint(id, { x: round4(clamp01(x)), y: round4(clamp01(y)) });
  const nudgePoint = (id, dx, dy) => {
    const p = points.find((q) => q.id === id);
    if (p) movePoint(id, p.x + dx, p.y + dy);
    setSelectedId(id);
  };
  function removePoint(id) {
    if (!editable) return;
    edited(() => {
      setPoints((list) => list.filter((p) => p.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    });
  }

  async function savePoints() {
    if (locked) return;
    const sendPoints = pointsEdited || unconfirmed;
    if (!sendPoints && !hideChanged) {
      setPointsState({ ...IDLE, err: "Change a point or the checkbox first." });
      return;
    }
    if (sendPoints && (!spot || !String(address || "").trim())) {
      setPointsState({ ...IDLE, err: "The map point is missing. Look up the address again." });
      return;
    }
    setPointsState({ ...IDLE, busy: true });
    try {
      const r = await roofFetch(`/admin/roof-entry-read/${encodeURIComponent(read.id)}/tech-count`, {
        method: "PATCH",
        // Only what changed in this panel goes, so a stale tab cannot overwrite points another tab saved.
        body: JSON.stringify({
          ...(sendPoints ? {
            pins: points.map((p) => ({
              x: round4(p.x), y: round4(p.y), type: p.type, note: p.note.trim() || null, ...(p.source ? { source: p.source } : {}),
            })),
            crop: { lat: spot.lat, lng: spot.lng },
            // The address comes from the same lookup as the map point. The server saves it with the points, and the
            // customer estimate shows the points only while the estimate has this address.
            address: String(address).trim(),
            // The list these edits started from: the server refuses the save (409) if another window changed it since.
            expected_pins: saved.pins,
          } : {}),
          ...(hideChanged ? { hide_on_estimate: !showOnEstimate } : {}),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!r.ok || !body?.read) {
        // The edits stay on screen; a 409 offers "Read the roof again" to load the other window's points.
        setPointsState({ ...IDLE, err: body?.error || "Could not save the points. Try again.", conflict: r.status === 409 });
        return;
      }
      // What the server holds now, then clear the edited markers.
      setSaved(savedFrom(body.read));
      setPoints(pointsFrom(body.read, nextId));
      setSelectedId(null);
      setShowOnEstimate(!body.read.hide_on_estimate);
      setHideEdited(false);
      setPointsEdited(false);
      setPointsState({ ...IDLE, msg: "Points saved." });
    } catch {
      if (mounted.current) setPointsState({ ...IDLE, err: "Could not reach the server. Try again." });
    }
  }

  return (
    <>
      <RoofImage
        url={imageUrl}
        imageKey={`${imageUrl}|${imageTry}`}
        imageState={imageState}
        onImageLoad={() => setImageState("loaded")}
        onImageError={() => setImageState("error")}
        onRetry={() => { setImageState("loading"); setImageTry((n) => n + 1); }}
        suggestions={suggestions}
        points={points}
        selectedId={selectedId}
        editable={editable}
        frameRef={frameRef}
        onAdd={(x, y) => addPoint(x, y)}
        onConfirm={confirmSuggestion}
        onSelect={setSelectedId}
        onMove={movePoint}
        onNudge={nudgePoint}
        onRemove={removePoint}
      />
      <div className="space-y-2" data-testid="roof-read-points">
        <p className="text-14 text-zinc-400 font-medium">Points the tech confirmed</p>
        {!readUsable && (
          <p className="text-14 text-zinc-600" role="alert" data-testid="roof-read-points-unusable">
            This roof read did not work. Read the roof again before adding points.
          </p>
        )}
        {(!readUsable || pointsState.conflict) && (
          <Button variant="secondary" size="sm" onClick={onReadAgain} data-testid="roof-read-again">
            Read the roof again
          </Button>
        )}
        <p className="text-14 text-zinc-600">
          Tap a faded letter to confirm it, or tap the photo to add a point. Drag a point to move it, or select it and press the arrow keys.
          The customer estimate shows only the points confirmed here.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => addPoint(0.5, 0.5)} disabled={!editable || atMax} data-testid="roof-read-add-point">
            Add a point
          </Button>
          <span className="text-14 text-zinc-600" data-testid="roof-read-point-count">{points.length} of {MAX_POINTS} points</span>
          {atMax && <span className="text-14 text-zinc-600" data-testid="roof-read-point-max">That is the most. Remove a point to add another.</span>}
        </div>
        {points.length > 0 && (
          <ol className="text-14 text-zinc-900 space-y-1" data-testid="roof-read-point-list">
            {points.map((p, i) => (
              <li key={p.id} data-testid={`roof-read-point-row-${i + 1}`}>{i + 1}. {pointText(p)}</li>
            ))}
          </ol>
        )}
        {selected && (
          <div className="p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 space-y-2" data-testid="roof-read-point-editor">
            <p className="text-14 text-zinc-400 font-medium">Point {points.indexOf(selected) + 1}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field label="Type" id="roof-read-point-type" className="mb-0">
                <Select value={selected.type} disabled={!editable} onChange={(e) => changePoint(selected.id, { type: e.target.value })}>
                  {POINT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </Select>
              </Field>
              <Field label="Note" id="roof-read-point-note" className="mb-0">
                <Input value={selected.note} maxLength={MAX_NOTE} placeholder="front left" disabled={!editable} onChange={(e) => changePoint(selected.id, { note: e.target.value.slice(0, MAX_NOTE) })} />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => removePoint(selected.id)} disabled={!editable} data-testid="roof-read-point-remove">Remove</Button>
              <Button variant="secondary" size="sm" onClick={() => setSelectedId(null)} data-testid="roof-read-point-done">Done</Button>
            </div>
          </div>
        )}
        <Checkbox
          id="roof-read-show-on-estimate"
          label="Show these points on the customer estimate"
          checked={showOnEstimate}
          disabled={locked}
          onChange={() => { setShowOnEstimate((v) => !v); setHideEdited(true); clearNote(); }}
        />
        {unconfirmed && (
          <p className="text-14 text-zinc-600" data-testid="roof-read-points-unconfirmed">
            These points were saved before the home's address was recorded, so the customer estimate does not show them. Check them
            against the photo, then press Save points to confirm them for this address.
          </p>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="secondary" size="sm" onClick={savePoints} loading={pointsState.busy} disabled={locked} data-testid="roof-read-points-save">
            Save points
          </Button>
          {!estimateId && (
            <span className="text-14 text-zinc-600" data-testid="roof-read-points-save-first">Save the estimate first to record the tech's points.</span>
          )}
          <SaveNote state={pointsState} statusTestId="roof-read-points-status" errorTestId="roof-read-points-error" />
        </div>
      </div>
    </>
  );
}

// The technician's count and "Tech saw it" flags. Like the points editor it mounts with each loaded read; `saved` is the
// server's last answer for the count and flags, set at load and by each count save. A points save never touches it.
function TechCountForm({ read, estimateId }) {
  const mounted = useMounted();
  const [saved, setSaved] = useState(() => ({ tech_final_count: read.tech_final_count, tech_final_flags: read.tech_final_flags }));
  const [count, setCount] = useState(() => countText(read.tech_final_count));
  const [techFlags, setTechFlags] = useState(() => techFlagsFrom(read));
  // What the tech changed since the read was loaded or last saved. Only edited fields are sent.
  const [touched, setTouched] = useState({});
  const [countEdited, setCountEdited] = useState(false);
  const [saveState, setSaveState] = useState(IDLE);
  const locked = saveState.busy || !estimateId;

  async function saveTech() {
    if (locked) return;
    const trimmed = countEdited ? count.trim() : "";
    if (trimmed !== "" && !(/^\d+$/.test(trimmed) && Number(trimmed) <= MAX_TECH_COUNT)) {
      setSaveState({ ...IDLE, err: `Count must be a whole number from 0 to ${MAX_TECH_COUNT}.` });
      return;
    }
    const touchedKeys = ROOF_TYPES.map((t) => t.key).filter((key) => touched[key]);
    if (trimmed === "" && !touchedKeys.length) {
      setSaveState({ ...IDLE, err: "Change the count or an entry point first." });
      return;
    }
    // The server merges the flags into the saved ones and writes the count only when sent, so only edited fields go.
    const payload = {};
    if (trimmed !== "") payload.count = Number(trimmed);
    if (touchedKeys.length) payload.flags = Object.fromEntries(touchedKeys.map((key) => [key, techFlags[key] ? "yes" : "no"]));
    setSaveState({ ...IDLE, busy: true });
    try {
      const r = await roofFetch(`/admin/roof-entry-read/${encodeURIComponent(read.id)}/tech-count`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!r.ok || !body?.read) {
        setSaveState({ ...IDLE, err: body?.error || "Could not save the count. Try again." });
        return;
      }
      // What the server holds now, then clear the edited markers.
      setSaved({ tech_final_count: body.read.tech_final_count, tech_final_flags: body.read.tech_final_flags });
      setCount(countText(body.read.tech_final_count));
      setTechFlags(techFlagsFrom(body.read));
      setTouched({});
      setCountEdited(false);
      setSaveState({ ...IDLE, msg: "Saved." });
    } catch {
      if (mounted.current) setSaveState({ ...IDLE, err: "Could not reach the server. Try again." });
    }
  }

  return (
    <>
      <div className="space-y-2" data-testid="roof-read-flags">
        <div className="grid grid-cols-[1fr_4.5rem_5rem_5rem] gap-2 text-14 text-zinc-400 font-medium">
          <span>Entry point</span><span>AI read</span><span>Tech saved</span><span>Tech saw it</span>
        </div>
        {ROOF_TYPES.map(({ key, label }) => {
          const likely = read.flags?.[key]?.likely;
          return (
            <div key={key} className="grid grid-cols-[1fr_4.5rem_5rem_5rem] gap-2 items-center text-14 text-zinc-900" data-testid={`roof-read-row-${key}`}>
              <span>{label}</span>
              <span data-testid={`roof-read-ai-${key}`}>{LIKELY_LABELS[likely] || "Not read"}</span>
              <span data-testid={`roof-read-saved-${key}`}>{LIKELY_LABELS[saved.tech_final_flags?.[key]] || "None"}</span>
              <Checkbox
                id={`roof-read-tech-${key}`}
                aria-label={`Tech saw: ${label}`}
                checked={!!techFlags[key]}
                disabled={locked}
                onChange={() => {
                  setTechFlags((f) => ({ ...f, [key]: !f[key] }));
                  setTouched((t) => ({ ...t, [key]: true }));
                }}
              />
            </div>
          );
        })}
      </div>
      <Field label="Entry points the tech counted" id="roof-read-tech-count" className="mb-2">
        <Input type="number" inputMode="numeric" min="0" max={String(MAX_TECH_COUNT)} step="1" value={count} disabled={locked} onChange={(e) => { setCount(e.target.value); setCountEdited(true); }} />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={saveTech} loading={saveState.busy} disabled={locked} data-testid="roof-read-save">
          Save the tech's count
        </Button>
        {!estimateId && (
          <span className="text-14 text-zinc-600" data-testid="roof-read-save-first">Save the estimate first to record the tech's count.</span>
        )}
        <SaveNote state={saveState} />
      </div>
      <p className="text-14 text-zinc-600" data-testid="roof-read-saved">
        {saved.tech_final_count == null && !saved.tech_final_flags
          ? "No tech count saved yet."
          : `Saved tech count: ${saved.tech_final_count == null ? "none" : saved.tech_final_count}.`}
      </p>
    </>
  );
}

export default function RoofReadPanel({ spot, address, addressDoubt = false, estimateId = null, customerId = null }) {
  const [phase, setPhase] = useState("idle");
  const [problem, setProblem] = useState("");
  const [result, setResult] = useState(null);
  const mounted = useMounted();

  async function readRoof() {
    if (phase === "loading" || !spot || addressDoubt) return;
    setPhase("loading");
    setProblem("");
    try {
      const r = await roofFetch("/admin/roof-entry-read", {
        method: "POST",
        body: JSON.stringify({
          lat: spot.lat,
          lng: spot.lng,
          county: spot.county,
          ...(estimateId ? { estimate_id: estimateId } : {}),
          ...(customerId ? { customer_id: customerId } : {}),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!r.ok && r.status !== 202) {
        // Only the gate answers { enabled: false } (a 404); other refusals carry an error code or message.
        setPhase("error");
        setProblem(body.enabled === false ? READ_GATE_OFF : READ_ERRORS[body.error] || body.error || "The roof read failed. Try again.");
        return;
      }
      if (body.status === "ok" && body.read && body.image_url) {
        // The points editor and the count form mount fresh with this read, so their state starts from what it holds.
        setResult(body);
        setPhase("ok");
        return;
      }
      setPhase(body.status in PROBLEM_COPY ? body.status : "error");
      setProblem(PROBLEM_COPY[body.status] || "The roof read failed. Try again.");
    } catch {
      if (!mounted.current) return;
      setPhase("error");
      setProblem("Could not reach the server. Try again.");
    }
  }

  const read = phase === "ok" ? result?.read : null;

  return (
    <div className="space-y-3" data-testid="roof-read-panel">
      <p className="text-14 text-zinc-400 font-medium">Roof read</p>
      <p className="text-14 text-zinc-600">
        Staff only. Reads the county aerial photo for likely rodent entry points. Each new read is a paid model call, and a read of this roof
        from the last 90 days is reused at no cost. The AI read stays with staff. The points you save, with their notes, show on the
        customer estimate from its next send, unless you clear "Show these points on the customer estimate".
      </p>
      {addressDoubt && (
        <p className="text-14 text-zinc-600" data-testid="roof-read-snapped">
          The map point may be a neighbour's house. Fix the address first.
        </p>
      )}
      {!spot && !addressDoubt && (
        <p className="text-14 text-zinc-600" data-testid="roof-read-no-spot">
          Look up the address first. The read needs the home's map point and county.
        </p>
      )}
      {spot && !addressDoubt && phase !== "ok" && (
        <div>
          <Button variant="secondary" size="sm" onClick={readRoof} loading={phase === "loading"} disabled={phase === "loading"} data-testid="roof-read-button">
            {phase === "idle" ? "Read the roof" : phase === "loading" ? "Reading" : "Try again"}
          </Button>
        </div>
      )}
      {problem && phase !== "ok" && phase !== "loading" && (
        <p className="text-14 text-zinc-600" role="status" data-testid={`roof-read-${phase}`}>{problem}</p>
      )}
      {read && (
        <div className="space-y-4" data-testid="roof-read-result">
          <RoofPointsEditor read={read} imageUrl={result.image_url} spot={spot} address={address} estimateId={estimateId} onReadAgain={readRoof} />
          <p className="text-14 text-zinc-600">
            {String(read.county).replace(/^./, (c) => c.toUpperCase())} County aerial, {read.image_year}.
            {result.cached ? " Reused from an earlier read." : ""}
          </p>
          <p className="text-14 text-zinc-900" data-testid="roof-read-tier">
            Entry-point tier: <span className="font-medium">{TIER_LABELS[read.tier] || read.tier}</span>
          </p>
          <TechCountForm read={read} estimateId={estimateId} />
        </div>
      )}
    </div>
  );
}
