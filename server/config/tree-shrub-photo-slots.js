/**
 * The Tree & Shrub Fast Complete sheet's five photo slots (the approved shot
 * guide). The sheet sends the slot key on each completion photo; the writer
 * stores it in service_photos.ai_tags as { slot } and the fast context reads
 * it back to show last visit's photo on the same slot. The server owns this
 * list: a key outside it is dropped, never stored.
 *
 * Keep in sync with PHOTO_SLOTS in
 * client/src/components/tech/FastCompleteTreeShrubSheet.jsx (a client test
 * pins the two lists together).
 */
const TREE_SHRUB_PHOTO_SLOT_KEYS = Object.freeze([
  'front_beds',
  'back_landscape',
  'whole_palm',
  'oldest_fronds',
  'leaf_close_up',
]);

const KEY_SET = new Set(TREE_SHRUB_PHOTO_SLOT_KEYS);

// The known slot key for a submitted value, or null for anything else.
function normalizeTreeShrubPhotoSlot(value) {
  return typeof value === 'string' && KEY_SET.has(value) ? value : null;
}

module.exports = { TREE_SHRUB_PHOTO_SLOT_KEYS, normalizeTreeShrubPhotoSlot };
