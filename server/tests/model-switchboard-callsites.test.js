// Drift guard between the switchboard's lane catalog and the call sites it
// describes. Each lane declares how its source reads a model (a registry tier,
// a ROUTES key, a TEXT_POLICIES leg, or a `process.env.PIN || …` read); this
// test opens the named files and checks that the declared identifiers are
// really there. A service that moves to a different tier, renames its pin
// env, or drops a fallback fails here instead of silently mis-informing the
// Models tab. (Live-vs-restart is not scanned — see the lane's `live` flag.)
const fs = require('fs');
const path = require('path');

const { LANES } = require('../services/model-switchboard');

const SERVER_ROOT = path.join(__dirname, '..');

function resolveFile(entry) {
  const rel = entry.trim();
  const base = /^(routes|config|services)\//.test(rel) ? rel : `services/${rel}`;
  return path.join(SERVER_ROOT, base);
}

function readLaneSources(lane) {
  return lane.file.split(',').map((f) => {
    const abs = resolveFile(f);
    if (!fs.existsSync(abs)) throw new Error(`${lane.id}: source file not found: ${abs}`);
    return fs.readFileSync(abs, 'utf8');
  });
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Patterns any ONE of the lane's files must match for a ref. `isFallback`
// relaxes the DEEP-tier policy fallback: those lanes reach it through
// createDeepMessage (llm/deep.js owns the OpenAI leg), not by naming the policy.
function patternsFor(ref, isFallback) {
  switch (ref.kind) {
    case 'tier':
      return [new RegExp(`\\b${esc(ref.key)}\\b`)];
    case 'route':
      return [new RegExp(`ROUTES\\.${esc(ref.key)}\\b`)];
    case 'policy': {
      const direct = new RegExp(`TEXT_POLICIES\\.${esc(ref.key)}\\b`);
      if (isFallback && ref.key === 'deepAnalysis') return [direct, /createDeepMessage|llm\/deep/];
      return [direct];
    }
    case 'env': {
      const pin = new RegExp(`process\\.env\\.${esc(ref.env)}\\b`);
      if (ref.literal !== undefined) return [pin, new RegExp(esc(ref.literal))];
      return [pin, ...patternsFor(ref.ref, isFallback)];
    }
    default:
      return [];
  }
}

function missing(sources, ref, isFallback) {
  if (ref.kind === 'switch') {
    // The provider env must be read, and every leg must be attributable.
    const out = [];
    const pin = new RegExp(`process\\.env\\.${esc(ref.env)}\\b`);
    if (!sources.some((src) => pin.test(src))) out.push(String(pin));
    for (const [prov, leg] of Object.entries(ref.legs)) out.push(...missing(sources, leg, isFallback).map((m) => `${prov} leg: ${m}`));
    return out;
  }
  // Env refs need BOTH the pin and (literal | base ref); the others need any
  // one pattern. Represent that as "every group must match some file".
  const groups = ref.kind === 'env'
    ? [[patternsFor(ref, isFallback)[0]], patternsFor(ref, isFallback).slice(1)]
    : [patternsFor(ref, isFallback)];
  return groups
    .filter((group) => !group.some((re) => sources.some((src) => re.test(src))))
    .map((group) => group.map(String).join(' | '));
}

describe('model-switchboard lane catalog matches the call sites', () => {
  it.each(LANES.map((lane) => [lane.id, lane]))('%s', (_id, lane) => {
    const sources = readLaneSources(lane);
    const problems = [];
    for (const m of missing(sources, lane.primary, false)) problems.push(`primary: no file matches ${m}`);
    if (lane.fallback) for (const m of missing(sources, lane.fallback, true)) problems.push(`fallback: no file matches ${m}`);
    if (lane.retry) for (const m of missing(sources, lane.retry, true)) problems.push(`retry: no file matches ${m}`);
    for (const ref of lane.also || []) for (const m of missing(sources, ref, false)) problems.push(`also: no file matches ${m}`);
    expect(problems).toEqual([]);
  });
});
