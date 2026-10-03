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

// Append freshly read photos to the list. The first one carries `zone` (the shot
// whose Add button was tapped) only if it is kept and that shot still has room
// in `prev`, so a race between two reads can never leave two photos on a
// one-photo shot. `enforceSize` also drops photos that no longer fit the size
// rule against what `prev` holds now.
export function appendTaggedPhotos(prev, incoming, zone, cap, { enforceSize = false } = {}) {
  const kept = enforceSize ? fitPhotosToSizeLimit(prev, incoming).accepted : incoming;
  const next = [...prev];
  kept.forEach((photo) => {
    const tag = photo === incoming[0] && zone && !shotIsFull(next, zone) ? zone : null;
    next.push({ ...photo, zone: tag });
  });
  return next.slice(0, cap);
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
export function decodedBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// Which of the freshly read photos fit the size rule (each within the per-photo
// limit, all of them together within the total), and a message naming every
// photo that was left out so the technician can retake or remove it. `held` are
// the photos already in the list.
export function fitPhotosToSizeLimit(held, incoming) {
  let total = held.reduce((sum, photo) => sum + decodedBytes(photo.data), 0);
  const accepted = [];
  const problems = [];
  for (const photo of incoming) {
    const bytes = decodedBytes(photo.data);
    const name = photo.name || "A photo";
    if (bytes > MAX_PHOTO_BYTES) {
      problems.push(`${name} is ${mb(bytes)}; each photo must be ${mb(MAX_PHOTO_BYTES)} or smaller. Retake it or choose a smaller one.`);
    } else if (total + bytes > MAX_TOTAL_BYTES) {
      problems.push(`${name} (${mb(bytes)}) was not added: one visit can carry ${mb(MAX_TOTAL_BYTES)} of photos and these already total ${mb(total)}. Remove a large photo or retake it smaller.`);
    } else {
      accepted.push(photo);
      total += bytes;
    }
  }
  return { accepted, message: problems.join(" ") };
}
