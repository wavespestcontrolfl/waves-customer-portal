// The phone a duplicate merge writes onto the row it retires (customer-dedupe executeMerge), in the
// same UPDATE that sets deleted_at (phone is NOT NULL). It tells a MERGED-AWAY row from an archived
// one: an admin archive sets deleted_at too, and an archived customer may still pay an open invoice.
// An undo restores the real phone.
const MERGE_RETIRED_PHONE_PREFIX = 'merged-';

function isMergeRetiredRow(row) {
  return Boolean(row?.deleted_at) && String(row?.phone || '').startsWith(MERGE_RETIRED_PHONE_PREFIX);
}

module.exports = { MERGE_RETIRED_PHONE_PREFIX, isMergeRetiredRow };
