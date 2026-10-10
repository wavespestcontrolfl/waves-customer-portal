// Lawn visit photo shot list (lawn report rebuild P18, GATE_LAWN_SHOT_LIST).
// Pure helpers over shared/lawn-photo-shots.json, the same file the server
// reads (server/services/lawn-photo-shots.js). The admin Schedule lawn photo
// step uses these only while the server reports the shot list live; with the
// gate off the step keeps its original three slots and 3-photo cap.
// Nothing here blocks the technician: the minimum is a hint, never a rule.
import DEFINITION from "../../../shared/lawn-photo-shots.json";

export const SHOTS = DEFINITION.shots;
export const SHOT_CAP = DEFINITION.cap;
export const SHOT_MINIMUM = DEFINITION.minimum;
export const MAX_PHOTO_BYTES = DEFINITION.maxPhotoBytes;
export const MAX_TOTAL_BYTES = DEFINITION.maxTotalBytes;
const MINIMUM_SLOTS = DEFINITION.minimumSlots;
const BY_KEY = new Map(SHOTS.map((shot) => [shot.key, shot]));

export function shotLabel(key) {
  return BY_KEY.get(key)?.label || "";
}

// GATE_LAWN_PHOTO_LABEL_PICK: the customer wording of each shot ("Front yard",
// "Close-up", "Shaded area"...), the options of the "Shown to the customer as"
// chooser. The picked value is a shot key; the photo's own slot is the default.
export function pickOptions() {
  return SHOTS.map((shot) => ({ value: shot.key, label: shot.reportLabel }));
}

// The chooser's current value for a photo: its pick, else its slot.
export function pickedKey(photo) {
  return (photo?.labelKey && BY_KEY.has(photo.labelKey) ? photo.labelKey : photo?.zone) || "";
}

// Set (or clear, when it equals the slot) the pick on photo `index`.
export function setLabelPick(photos, index, key) {
  return photos.map((photo, i) => {
    if (i !== index) return photo;
    const { labelKey: _drop, ...rest } = photo;
    return key && key !== photo.zone && BY_KEY.has(key) ? { ...rest, labelKey: key } : rest;
  });
}

// A pick belongs to the slot it was made under: when a photo's slot changes
// (or a slot move clears another photo), its pick is dropped.
export function dropStalePicks(before, after) {
  return after.map((photo, i) => {
    if (!photo.labelKey || before[i]?.zone === photo.zone) return photo;
    const { labelKey: _drop, ...rest } = photo;
    return rest;
  });
}

function maxFor(key) {
  return BY_KEY.get(key)?.max || 1;
}

// Which of the four minimum slots the tagged photos do not cover yet, as the
// label a technician can act on ("Back overview or Side overview").
export function missingMinimumSlots(photos = []) {
  const have = new Set(photos.map((photo) => photo?.zone).filter(Boolean));
  return MINIMUM_SLOTS
    .filter((slot) => !slot.some((key) => have.has(key)))
    .map((slot) => slot.map(shotLabel).join(" or "));
}

// The soft-minimum hint, or null once the minimum is covered. A guide only:
// the Analyze button never reads this.
export function shotListHint(photos = []) {
  const missing = missingMinimumSlots(photos);
  if (!missing.length) return null;
  return `Aim for at least ${SHOT_MINIMUM} photos: front, back or side, canopy close-up, and blade and crown. Still needed: ${missing.join(", ")}. This is a guide only, and Analyze lawn works at any time.`;
}

// Tag photo `index` with shot `zone` (or clear it). Choosing the shot the
// photo already holds clears it. A shot allows `max` photos per visit (one,
// or two for a problem area): when the new tag would exceed it, the earliest
// other photo holding that shot is cleared, the same way picking Front on a
// second photo has always cleared the first.
export function assignShotZone(photos, index, zone) {
  const current = photos[index]?.zone || null;
  const next = current === zone ? null : zone;
  const clear = new Set();
  if (next) {
    const others = photos.map((photo, i) => (i !== index && photo.zone === next ? i : -1)).filter((i) => i >= 0);
    others.slice(0, Math.max(0, others.length - (maxFor(next) - 1))).forEach((i) => clear.add(i));
  }
  return photos.map((photo, i) => {
    if (i === index) return { ...photo, zone: next };
    if (clear.has(i)) return { ...photo, zone: null };
    return photo;
  });
}

// Whether the photos already hold every photo `key` allows.
export function shotIsFull(photos, key) {
  return photos.filter((photo) => photo.zone === key).length >= maxFor(key);
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
export function decodedBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// How many of the picked files to decode at all (shot list on). Decoding is the
// expensive part (FileReader plus a canvas resize per photo), so the batch is cut
// to what could still be kept BEFORE any file is read: the visit's remaining room
// (cap minus photos held minus reads already in flight) and, for a shot's own
// Add button, that shot's remaining room. addPhotos still makes the final call
// on what is kept; this only avoids work on files that cannot be.
//
//   planFileReads(files, { held, inFlight, inFlightForShot, shot }) -> { toRead, skipped }
//
// `skipped` names each file left unread and why, in describeAddResult's style.
export function planFileReads(files, { held = [], inFlight = 0, inFlightForShot = 0, shot = null } = {}) {
  const capacity = Math.max(0, SHOT_CAP - held.length - inFlight);
  const shotRoom = shot ? Math.max(0, maxFor(shot) - held.filter((photo) => photo.zone === shot).length - inFlightForShot) : Infinity;
  const allowed = Math.min(capacity, shotRoom);
  const reason = shotRoom < capacity
    ? `was not read: ${shotLabel(shot)} takes ${maxFor(shot) === 1 ? "one photo" : `${maxFor(shot)} photos`} and has room for ${shotRoom}. Use "Add turf photos" for the rest.`
    : `was not read: a visit holds up to ${SHOT_CAP} photos and ${SHOT_CAP - capacity} are added or being read. Remove one first.`;
  return {
    toRead: files.slice(0, allowed),
    skipped: files.slice(allowed).map((file) => ({ name: file.name || "A photo", reason })),
  };
}

const LEGACY_CAP = 3;

// THE one decision for adding freshly read photos to the visit's list.
//
//   addPhotos(prev, incoming, { shot, shotList }) -> { photos, rejected, untagged }
//
// `prev` is the list as it stands now; `incoming` are the new photos in the
// order picked; `shot` is the shot whose Add button was tapped (or null).
// Pure: the component calls it with the latest list at the moment a read lands,
// so overlapping reads are decided one after the other against what is really
// held, in whatever order they finish.
//
// Shot list on, per photo in order: it is left out (listed in `rejected`, with
// the reason) if the visit already holds the 8-photo cap, if the photo is over
// the per-photo size limit, or if it would push the visit past the total size
// limit. A kept photo takes `shot` while that shot has room (a problem area
// takes two, every other shot one); a kept photo beyond the shot's room is added
// untagged and listed in `untagged`. Nothing is dropped silently.
//
// Shot list off: exactly the original behavior (3-photo cap, no tags, no size
// rule); `rejected` and `untagged` stay empty so that screen is unchanged.
export function addPhotos(prev, incoming, { shot = null, shotList = false } = {}) {
  if (!shotList) {
    const remaining = Math.max(0, LEGACY_CAP - prev.length);
    const added = incoming.slice(0, remaining).map((photo) => ({ ...photo, zone: null }));
    return { photos: [...prev, ...added].slice(0, LEGACY_CAP), rejected: [], untagged: [] };
  }
  const photos = [...prev];
  const rejected = [];
  const untagged = [];
  let total = photos.reduce((sum, photo) => sum + decodedBytes(photo.data), 0);
  for (const photo of incoming) {
    const name = photo.name || "A photo";
    const bytes = decodedBytes(photo.data);
    if (photos.length >= SHOT_CAP) {
      rejected.push({ name, reason: `was not added: a visit holds up to ${SHOT_CAP} photos. Remove one first.` });
    } else if (bytes > MAX_PHOTO_BYTES) {
      rejected.push({ name, reason: `is ${mb(bytes)}; each photo must be ${mb(MAX_PHOTO_BYTES)} or smaller. Retake it or choose a smaller one.` });
    } else if (total + bytes > MAX_TOTAL_BYTES) {
      rejected.push({ name, reason: `(${mb(bytes)}) was not added: one visit can carry ${mb(MAX_TOTAL_BYTES)} of photos and these already total ${mb(total)}. Remove a large photo or retake it smaller.` });
    } else {
      const tagged = shot && !shotIsFull(photos, shot);
      if (shot && !tagged) untagged.push({ name, reason: `was added without a shot tag: ${shotLabel(shot)} already has ${maxFor(shot) === 1 ? "its photo" : `its ${maxFor(shot)} photos`}. Pick its shot from the slot menu if it belongs somewhere else.` });
      photos.push({ ...photo, zone: tagged ? shot : null });
      total += bytes;
    }
  }
  return { photos, rejected, untagged };
}

// The message the technician sees for an addPhotos result ("" when all went in
// as asked). Derived from the result alone, so it is the same however often
// it is computed.
export function describeAddResult({ rejected = [], untagged = [] } = {}) {
  return [...rejected, ...untagged].map(({ name, reason }) => `${name} ${reason}`).join(" ");
}
