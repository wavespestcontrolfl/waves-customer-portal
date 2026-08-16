/**
 * Deterministic ZIP → state derivation (codex #3413 r21): the standard
 * USPS 3-digit prefix allocation. Used by the contact-correction lane to
 * derive a cross-state move's state when the customer stated street +
 * city + ZIP but no state — without it the stored state survives and the
 * record becomes a hybrid ("Savannah, FL 31401").
 *
 * Specific-prefix overrides (201 VA, 398–399 GA, 733/885 TX) are listed
 * before the broad ranges and win by order. Military (APO/FPO) and
 * territory prefixes are omitted — an unresolvable prefix returns null
 * and the caller fails the group closed.
 */

const ZIP_PREFIX_RANGES = [
  // Overrides first — order wins.
  [201, 201, 'VA'],
  [398, 399, 'GA'],
  [733, 733, 'TX'],
  [885, 885, 'TX'],
  // Broad allocation.
  [5, 5, 'NY'],
  [10, 27, 'MA'],
  [28, 29, 'RI'],
  [30, 38, 'NH'],
  [39, 49, 'ME'],
  [50, 59, 'VT'],
  [60, 69, 'CT'],
  [70, 89, 'NJ'],
  [100, 149, 'NY'],
  [150, 196, 'PA'],
  [197, 199, 'DE'],
  [200, 205, 'DC'],
  [206, 219, 'MD'],
  [220, 246, 'VA'],
  [247, 268, 'WV'],
  [270, 289, 'NC'],
  [290, 299, 'SC'],
  [300, 319, 'GA'],
  [320, 349, 'FL'],
  [350, 369, 'AL'],
  [370, 385, 'TN'],
  [386, 397, 'MS'],
  [400, 427, 'KY'],
  [430, 459, 'OH'],
  [460, 479, 'IN'],
  [480, 499, 'MI'],
  [500, 528, 'IA'],
  [530, 549, 'WI'],
  [550, 567, 'MN'],
  [570, 577, 'SD'],
  [580, 588, 'ND'],
  [590, 599, 'MT'],
  [600, 629, 'IL'],
  [630, 658, 'MO'],
  [660, 679, 'KS'],
  [680, 693, 'NE'],
  [700, 714, 'LA'],
  [716, 729, 'AR'],
  [730, 749, 'OK'],
  [750, 799, 'TX'],
  [800, 816, 'CO'],
  [820, 831, 'WY'],
  [832, 838, 'ID'],
  [840, 847, 'UT'],
  [850, 865, 'AZ'],
  [870, 884, 'NM'],
  [889, 898, 'NV'],
  [900, 961, 'CA'],
  [967, 968, 'HI'],
  [970, 979, 'OR'],
  [980, 994, 'WA'],
  [995, 999, 'AK'],
];

function stateForZip(zip) {
  const digits = String(zip || '').replace(/\D/g, '');
  if (digits.length < 5) return null;
  const prefix = Number(digits.slice(0, 3));
  for (const [lo, hi, state] of ZIP_PREFIX_RANGES) {
    if (prefix >= lo && prefix <= hi) return state;
  }
  return null;
}

module.exports = { stateForZip };
