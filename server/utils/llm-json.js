// Tolerant parser for LLM responses that are supposed to be a single JSON
// object. Strips markdown fences and any leading/trailing prose, then parses
// the outermost {...} block. Returns null (never throws) when no object can
// be recovered — callers decide their own fallback.
function parseLooseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const clean = text.replace(/```json|```/g, '').trim();
  const asObject = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  try {
    // Valid JSON that isn't an object (array, scalar) is a contract
    // violation, not prose to dig through — return null, don't fish inside.
    return asObject(JSON.parse(clean));
  } catch {
    // Not valid JSON as a whole — recover the outermost {...} from prose.
  }
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return asObject(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

module.exports = { parseLooseJson };
