// Tolerant parser for LLM responses that are supposed to be a single JSON
// object. Strips markdown fences and any leading/trailing prose, then parses
// the outermost {...} block. Returns null (never throws) when no object can
// be recovered — callers decide their own fallback.
function parseLooseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const clean = text.replace(/```json|```/g, '').trim();
  const candidates = [clean];
  const match = clean.match(/\{[\s\S]*\}/);
  if (match && match[0] !== clean) candidates.push(match[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

module.exports = { parseLooseJson };
