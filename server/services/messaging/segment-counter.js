/**
 * SMS encoding detector + segment counter.
 *
 * Per Twilio docs:
 *   - GSM-7 encoding: 160 chars per segment standalone, 153 chars per
 *     segment when concatenated (the 7 missing bytes are the UDH header).
 *   - GSM-7 extension chars (^ { } \ [ ] ~ | € and a few others) take
 *     2 GSM-7 character slots each.
 *   - UCS-2 encoding (any non-GSM character — emoji, smart quotes, é,
 *     anything non-Latin-1-ish): 70 chars per segment standalone, 67
 *     chars per segment when concatenated.
 *   - The 7-bit / 16-bit boundary is per MESSAGE — a single emoji forces
 *     the entire body into UCS-2.
 *
 * This is the application-side counter we run BEFORE handing the body
 * to Twilio. We use it to:
 *   - reject customer/lead SMS that exceed the policy maxSegments
 *   - log segment count + encoding to message_audit_log
 *   - surface "your draft would send as N segments" feedback to operators
 *     when they manually compose in the Comms inbox
 */

// GSM 03.38 default alphabet — 128 codepoints addressable in 7 bits
const GSM_BASIC = new Set([
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r',
  'Å', 'å', 'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ',
  ' ', '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
  '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
  '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à',
]);

// GSM extension table — escape + extension char takes 2 slots each
const GSM_EXTENSION = new Set(['{', '}', '[', ']', '~', '|', '\\', '^', '€', '\f']);

// SMS character/segment limits per Twilio's documented behavior
const GSM_SINGLE_LIMIT = 160;
const GSM_CONCAT_LIMIT = 153;
const UCS2_SINGLE_LIMIT = 70;
const UCS2_CONCAT_LIMIT = 67;

/**
 * Detect whether a body fits in GSM-7 (true) or must use UCS-2 (false).
 *
 * @param {string} body
 * @returns {{ encoding: 'GSM_7' | 'UCS_2', extensionChars: number }}
 */
function detectEncoding(body) {
  if (body == null) return { encoding: 'GSM_7', extensionChars: 0 };
  let extensionChars = 0;
  for (const ch of body) {
    if (GSM_EXTENSION.has(ch)) {
      extensionChars++;
      continue;
    }
    if (!GSM_BASIC.has(ch)) {
      // Any non-GSM character forces UCS-2 encoding for the whole message
      return { encoding: 'UCS_2', extensionChars };
    }
  }
  return { encoding: 'GSM_7', extensionChars };
}

/**
 * Compute segment count for a given body.
 *
 * @param {string} body
 * @returns {{ encoding: 'GSM_7' | 'UCS_2', characterCount: number, gsmSlotCount: number, segmentCount: number, perSegmentLimit: number }}
 */
function countSegments(body) {
  if (body == null || body === '') {
    return {
      encoding: 'GSM_7',
      characterCount: 0,
      gsmSlotCount: 0,
      segmentCount: 0,
      perSegmentLimit: GSM_SINGLE_LIMIT,
    };
  }

  // Use Array.from to count code points correctly — emoji + surrogate pairs
  // are a single user-perceived character, but in UTF-16 strings they span
  // two `string.length` units. Iterating with Array.from gives us the
  // visible-character count.
  const chars = Array.from(body);
  const characterCount = chars.length;
  const { encoding, extensionChars } = detectEncoding(body);

  if (encoding === 'GSM_7') {
    // Each extension char takes 2 slots
    const gsmSlotCount = characterCount + extensionChars;
    if (gsmSlotCount <= GSM_SINGLE_LIMIT) {
      return {
        encoding,
        characterCount,
        gsmSlotCount,
        segmentCount: 1,
        perSegmentLimit: GSM_SINGLE_LIMIT,
      };
    }
    return {
      encoding,
      characterCount,
      gsmSlotCount,
      segmentCount: Math.ceil(gsmSlotCount / GSM_CONCAT_LIMIT),
      perSegmentLimit: GSM_CONCAT_LIMIT,
    };
  }

  // UCS-2 path. Each emoji that uses a surrogate pair counts as 2 UCS-2
  // code units (Twilio bills by UCS-2 code unit, not user-perceived char).
  // body.length already returns UTF-16 code unit count, which matches.
  const ucs2Units = body.length;
  if (ucs2Units <= UCS2_SINGLE_LIMIT) {
    return {
      encoding,
      characterCount,
      gsmSlotCount: 0,
      segmentCount: 1,
      perSegmentLimit: UCS2_SINGLE_LIMIT,
      ucs2CodeUnits: ucs2Units,
    };
  }
  return {
    encoding,
    characterCount,
    gsmSlotCount: 0,
    segmentCount: Math.ceil(ucs2Units / UCS2_CONCAT_LIMIT),
    perSegmentLimit: UCS2_CONCAT_LIMIT,
    ucs2CodeUnits: ucs2Units,
  };
}

/**
 * Validator entry — wraps countSegments with the policy maxSegments check.
 *
 * @param {import('../policy').SendCustomerMessageInput} input
 * @param {Object} policy
 * @returns {{ ok: boolean, code?: string, reason?: string, segmentCount: number, encoding: string }}
 */
function validateSegmentCount(input, policy) {
  const { segmentCount, encoding } = countSegments(input.body);
  if (segmentCount > policy.maxSegments) {
    return {
      ok: false,
      code: 'SEGMENT_LIMIT_EXCEEDED',
      reason: `Body would send as ${segmentCount} segments (encoding: ${encoding}); policy max is ${policy.maxSegments} for purpose "${input.purpose}"`,
      segmentCount,
      encoding,
    };
  }
  return { ok: true, segmentCount, encoding };
}

module.exports = {
  detectEncoding,
  countSegments,
  validateSegmentCount,
  // Exposed for tests
  _internals: {
    GSM_SINGLE_LIMIT,
    GSM_CONCAT_LIMIT,
    UCS2_SINGLE_LIMIT,
    UCS2_CONCAT_LIMIT,
    GSM_BASIC,
    GSM_EXTENSION,
  },
};
