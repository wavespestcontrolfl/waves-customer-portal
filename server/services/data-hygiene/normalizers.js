const {
  normalizeEmail,
  normalizePhoneToE164,
  properCaseName,
  collapseWhitespace,
} = require('../../utils/contact-normalize');

const RULE_VERSION = '1';

const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  district_of_columbia: 'DC', 'district of columbia': 'DC',
};

const US_STATE_ABBREVIATIONS = new Set(Object.values(US_STATES));

const ZIP3_RANGES = {
  AK: [[995, 999]],
  AL: [[350, 369]],
  AR: [[716, 729]],
  AZ: [[850, 865]],
  CA: [[900, 961]],
  CO: [[800, 816]],
  CT: [[60, 69]],
  DC: [[200, 205]],
  DE: [[197, 199]],
  FL: [[320, 349]],
  GA: [[300, 319], [398, 399]],
  HI: [[967, 968]],
  IA: [[500, 528]],
  ID: [[832, 838]],
  IL: [[600, 629]],
  IN: [[460, 479]],
  KS: [[660, 679]],
  KY: [[400, 427]],
  LA: [[700, 714]],
  MA: [[10, 27]],
  MD: [[206, 219]],
  ME: [[39, 49]],
  MI: [[480, 499]],
  MN: [[550, 567]],
  MO: [[630, 658]],
  MS: [[386, 397]],
  MT: [[590, 599]],
  NC: [[270, 289]],
  ND: [[580, 588]],
  NE: [[680, 693]],
  NH: [[30, 38]],
  NJ: [[70, 89]],
  NM: [[870, 884]],
  NV: [[889, 898]],
  NY: [[5, 5], [100, 149]],
  OH: [[430, 459]],
  OK: [[730, 749]],
  OR: [[970, 979]],
  PA: [[150, 196]],
  RI: [[28, 29]],
  SC: [[290, 299]],
  SD: [[570, 577]],
  TN: [[370, 385]],
  TX: [[750, 799]],
  UT: [[840, 847]],
  VA: [[220, 246]],
  VT: [[50, 59]],
  WA: [[980, 994]],
  WI: [[530, 549]],
  WV: [[247, 268]],
  WY: [[820, 831]],
};

function proposal(field, currentValue, proposedValue, extra = {}) {
  return {
    rule_version: RULE_VERSION,
    field,
    current_value: currentValue,
    proposed_value: proposedValue,
    source: 'normalization',
    confidence: extra.confidence,
    tier: extra.tier,
    evidence: extra.evidence || {},
    rule_id: extra.rule_id,
  };
}

function emailLowercaseTrim(field, value) {
  if (value === null || value === undefined) return null;
  const current = String(value);
  if (!current.trim()) return null;

  const proposed = normalizeEmail(current);
  if (proposed === current) return null;

  const exclusions = emailAutoApplyExclusions(current, proposed);
  return proposal(field, current, proposed, {
    rule_id: 'email.lowercase_trim',
    confidence: exclusions.length ? 0.880 : 0.990,
    tier: 'high',
    evidence: {
      auto_apply_eligible: exclusions.length === 0,
      auto_apply_exclusions: exclusions,
    },
  });
}

function emailAutoApplyExclusions(current, proposed) {
  const exclusions = [];
  const shape = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  if (current.includes('"')) exclusions.push('quoted_local_part');
  if (!/^[\x00-\x7F]+$/.test(current)) exclusions.push('non_ascii');
  if (!shape.test(current.trim())) exclusions.push('malformed_original');
  if (!shape.test(proposed)) exclusions.push('malformed_proposed');
  return exclusions;
}

function phoneE164(field, value) {
  if (value === null || value === undefined) return null;
  const current = String(value).trim();
  if (!current) return null;

  const guard = nanpPhoneGuard(current);
  if (!guard.ok) return null;

  const proposed = normalizePhoneToE164(current);
  if (proposed !== guard.e164 || proposed === current) return null;

  return proposal(field, current, proposed, {
    rule_id: 'phone.e164',
    confidence: 0.990,
    tier: 'high',
    evidence: {
      digits_identical: true,
      input_digits: guard.digits,
      normalized_last10: guard.last10,
      auto_apply_eligible: true,
    },
  });
}

function nanpPhoneGuard(value) {
  const lower = value.toLowerCase();
  if (/(^|\s)(ext\.?|x)\s*\d+/.test(lower) || /[*#]/.test(value)) {
    return { ok: false, reason: 'extension_or_control_character' };
  }
  if (/[a-z]/i.test(value)) {
    return { ok: false, reason: 'vanity_or_alpha_phone' };
  }

  const digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+') && !digits.startsWith('1')) {
    return { ok: false, reason: 'non_nanp_country_code' };
  }

  if (digits.length === 10) {
    return { ok: true, digits, last10: digits, e164: `+1${digits}` };
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    const last10 = digits.slice(1);
    return { ok: true, digits, last10, e164: `+1${last10}` };
  }
  return { ok: false, reason: 'not_10_or_11_nanp_digits' };
}

function nameWhitespaceTrim(field, value) {
  if (value === null || value === undefined) return null;
  const current = String(value);
  if (!current) return null;

  const proposed = collapseWhitespace(current);
  if (proposed === current) return null;
  if (!proposed) return null;

  return proposal(field, current, proposed, {
    rule_id: 'name.whitespace_trim',
    confidence: 0.995,
    tier: 'high',
    evidence: { auto_apply_eligible: true },
  });
}

function nameProperCase(field, value) {
  if (value === null || value === undefined) return null;
  const current = String(value);
  const compact = collapseWhitespace(current);
  if (!compact || compact !== current) return null;
  if (!/^[A-Za-z' -]+$/.test(compact)) return null;

  const proposed = properCaseName(compact);
  if (!proposed || proposed === current) return null;

  return proposal(field, current, proposed, {
    rule_id: field === 'first_name' ? 'name.proper_case_first' : 'name.proper_case_last',
    confidence: 0.840,
    tier: 'medium',
    evidence: {
      auto_apply_eligible: false,
      reason: 'proper_case_is_proposal_only',
    },
  });
}

function zipZeroPad(value, stateValue) {
  if (value === null || value === undefined) return null;
  const current = String(value).trim();
  if (!/^\d{4}$/.test(current)) return null;

  const state = normalizeUsState(stateValue);
  if (!state) return null;
  const proposed = `0${current}`;
  if (!zipMatchesState(proposed, state)) return null;

  return proposal('zip', String(value), proposed, {
    rule_id: 'zip.zero_pad_5',
    confidence: 0.990,
    tier: 'high',
    evidence: {
      normalized_state: state,
      zip3: proposed.slice(0, 3),
      auto_apply_eligible: true,
    },
  });
}

function stateNormalize(value) {
  if (value === null || value === undefined) return null;
  const current = String(value).trim();
  if (!current) return null;

  const proposed = normalizeUsState(current);
  if (!proposed || proposed === String(value)) return null;

  return proposal('state', String(value), proposed, {
    rule_id: 'state.normalize_to_us_2letter',
    confidence: 0.990,
    tier: 'high',
    evidence: { auto_apply_eligible: true },
  });
}

function normalizeUsState(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;

  const upper = normalized.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && US_STATE_ABBREVIATIONS.has(upper)) return upper;

  const key = normalized.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  return US_STATES[key] || null;
}

function zipMatchesState(zip, state) {
  if (!/^\d{5}$/.test(zip)) return false;
  const ranges = ZIP3_RANGES[state];
  if (!ranges) return false;
  const zip3 = Number(zip.slice(0, 3));
  return ranges.some(([min, max]) => zip3 >= min && zip3 <= max);
}

function normalizationCandidatesForCustomer(row) {
  const candidates = [];
  add(candidates, nameWhitespaceTrim('first_name', row.first_name));
  add(candidates, nameWhitespaceTrim('last_name', row.last_name));
  add(candidates, nameProperCase('first_name', row.first_name));
  add(candidates, nameProperCase('last_name', row.last_name));
  add(candidates, emailLowercaseTrim('email', row.email));
  add(candidates, phoneE164('phone', row.phone));
  add(candidates, stateNormalize(row.state));
  add(candidates, zipZeroPad(row.zip, row.state));
  return attachTarget(candidates, {
    resource_type: 'customer',
    resource_id: row.id,
    scope_type: 'customer',
    scope_id: row.id,
  });
}

function normalizationCandidatesForCustomerAccount(row) {
  const candidates = [];
  add(candidates, nameWhitespaceTrim('first_name', row.first_name));
  add(candidates, nameWhitespaceTrim('last_name', row.last_name));
  add(candidates, nameProperCase('first_name', row.first_name));
  add(candidates, nameProperCase('last_name', row.last_name));
  add(candidates, emailLowercaseTrim('email', row.email));
  add(candidates, phoneE164('phone', row.phone));
  return attachTarget(candidates, {
    resource_type: 'customer_account',
    resource_id: row.id,
    scope_type: 'customer_account',
    scope_id: row.id,
  });
}

function attachTarget(candidates, target) {
  return candidates.map((candidate) => ({ ...target, ...candidate }));
}

function add(candidates, candidate) {
  if (candidate) candidates.push(candidate);
}

module.exports = {
  RULE_VERSION,
  normalizeUsState,
  zipMatchesState,
  normalizationCandidatesForCustomer,
  normalizationCandidatesForCustomerAccount,
  _private: {
    emailAutoApplyExclusions,
    nanpPhoneGuard,
  },
};
