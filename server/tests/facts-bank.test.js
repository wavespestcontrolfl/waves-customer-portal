const fs = require('fs');
const os = require('os');
const path = require('path');

const loader = require('../services/content-astro/facts-bank-loader');
const auditor = require('../services/content-astro/facts-bank-auditor');

// Build a temporary facts-bank tree and return the astro root path.
function makeFactsBank(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-bank-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, 'content-ops/facts-bank', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

const OPTS = (root) => ({ astroRoot: root, astroSource: 'filesystem' });

// A fully-verified city fixture with the minimum facts to pass sufficiency.
// last_verified is set near "now" so TTL never expires during the test.
const TODAY = new Date().toISOString().slice(0, 10);

function verifiedCity(id = 'testville', county = 'test-county') {
  return `---
schema_version: 2
entity_type: city
entity_id: ${id}
display_name: "Testville, FL"
county: ${county}
facts_bank_status: verified
generation_allowed: true
facts:
  - id: city_${id}_n1
    type: neighborhood
    value: "North End"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
  - id: city_${id}_n2
    type: neighborhood
    value: "South End"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
  - id: city_${id}_p1
    type: pest_pressure
    value: "ghost ants common"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 180
  - id: city_${id}_ops
    type: operations
    value: "internal route note"
    visibility: internal_only
    prompt_use_allowed: false
    public_copy_allowed: false
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 30
disallowed_claim_patterns:
  - "Do not overclaim."
internal_links:
  quote: "/q/"
  calculator: "/pest-control-calculator/"
---
`;
}

function verifiedCounty(id = 'test-county') {
  return `---
schema_version: 2
entity_type: county
entity_id: ${id}
display_name: "Test County"
facts_bank_status: verified
generation_allowed: true
facts:
  - id: county_${id}_reg1
    type: regulation
    value: "Fertilizer blackout June-Sept"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
  - id: county_${id}_home1
    type: home_type
    value: "slab-on-grade dominant"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
  - id: county_${id}_season1
    type: seasonality
    value: "rainy season Jun-Oct"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
---
`;
}

function verifiedService(id = 'pest-control') {
  return `---
schema_version: 2
entity_type: service
entity_id: ${id}
display_name: "Pest Control"
facts_bank_status: verified
generation_allowed: true
facts:
  - id: service_${id}_t1
    type: pest_pressure
    value: "initial visit 60-90 min"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
  - id: service_${id}_t2
    type: seasonality
    value: "summer ghost ant migration"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
  - id: service_${id}_t3
    type: pest_pressure
    value: "quarterly exterior residual"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: ${TODAY}
    ttl_days: 365
disallowed_claim_patterns:
  - "Do not guarantee elimination."
---
`;
}

function templateCity(id = 'emptytown', county = 'test-county') {
  return `---
schema_version: 2
entity_type: city
entity_id: ${id}
display_name: "Emptytown, FL"
county: ${county}
facts_bank_status: template
generation_allowed: false
facts: []
disallowed_claim_patterns:
  - "Do not generate for template."
internal_links: {}
---
`;
}

describe('facts-bank-loader', () => {
  test('usableFacts excludes internal_only facts from both prompt and copy', () => {
    const root = makeFactsBank({ 'cities/testville.md': verifiedCity() });
    return loader.loadCity('testville', OPTS(root)).then((file) => {
      const prompt = loader.usableFacts(file, { purpose: 'prompt' });
      const copy = loader.usableFacts(file, { purpose: 'copy' });
      expect(prompt.some((f) => f.type === 'operations')).toBe(false);
      expect(copy.some((f) => f.type === 'operations')).toBe(false);
      // 3 public facts are prompt+copy usable; the operations fact is excluded.
      expect(prompt).toHaveLength(3);
      expect(copy).toHaveLength(3);
    });
  });

  test('expired facts are excluded', () => {
    const stale = `---
schema_version: 2
entity_type: city
entity_id: stale
facts_bank_status: verified
generation_allowed: true
facts:
  - id: city_stale_old
    type: neighborhood
    value: "Old Town"
    visibility: public
    prompt_use_allowed: true
    public_copy_allowed: true
    evidence_strength: verified
    last_verified: 2000-01-01
    ttl_days: 30
---
`;
    const root = makeFactsBank({ 'cities/stale.md': stale });
    return loader.loadCity('stale', OPTS(root)).then((file) => {
      expect(loader.usableFacts(file, { purpose: 'copy' })).toHaveLength(0);
    });
  });

  test('unverified facts are excluded from copy and prompt', () => {
    const file = {
      facts: [
        { id: 'v', type: 'neighborhood', visibility: 'public', prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: 'verified', last_verified: TODAY, ttl_days: 365 },
        { id: 'u', type: 'neighborhood', visibility: 'public', prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: 'unverified', last_verified: TODAY, ttl_days: 365 },
      ],
    };
    expect(loader.usableFacts(file, { purpose: 'copy' }).map((f) => f.id)).toEqual(['v']);
    expect(loader.usableFacts(file, { purpose: 'prompt' }).map((f) => f.id)).toEqual(['v']);
  });

  test('context gating filters facts whose allowed_contexts excludes the context', () => {
    const file = {
      facts: [
        { id: 'a', type: 'neighborhood', visibility: 'public', prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: 'verified', last_verified: TODAY, ttl_days: 365, allowed_contexts: ['service_area'] },
        { id: 'b', type: 'neighborhood', visibility: 'public', prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: 'verified', last_verified: TODAY, ttl_days: 365, allowed_contexts: [] },
      ],
    };
    const inContext = loader.usableFacts(file, { purpose: 'copy', context: 'pest_pressure' });
    // 'a' excluded (context mismatch), 'b' included (no contexts = agnostic).
    expect(inContext.map((f) => f.id)).toEqual(['b']);
  });

  test('returns null for missing file and parse_error for invalid schema', async () => {
    const root = makeFactsBank({ 'cities/testville.md': verifiedCity() });
    expect(await loader.loadCity('does-not-exist', OPTS(root))).toBeNull();

    const root2 = makeFactsBank({ 'cities/broken.md': 'no frontmatter here' });
    const broken = await loader.loadCity('broken', OPTS(root2));
    expect(broken.ok).toBe(false);
    expect(broken.parse_error).toBeTruthy();
  });
});

describe('facts-bank-auditor', () => {
  test('full verified combo is sufficient with disposition optimize', async () => {
    const root = makeFactsBank({
      'cities/testville.md': verifiedCity('testville', 'test-county'),
      'counties/test-county.md': verifiedCounty('test-county'),
      'services/pest-control.md': verifiedService('pest-control'),
    });
    const r = await auditor.auditCombination({ city: 'testville', service: 'pest-control' }, OPTS(root));
    expect(r.sufficient).toBe(true);
    expect(r.disposition_hint).toBe('optimize');
    expect(r.gap_codes).toHaveLength(0);
  });

  test('template city blocks the combination (fail closed)', async () => {
    const root = makeFactsBank({
      'cities/emptytown.md': templateCity('emptytown', 'test-county'),
      'counties/test-county.md': verifiedCounty('test-county'),
      'services/pest-control.md': verifiedService('pest-control'),
    });
    const r = await auditor.auditCombination({ city: 'emptytown', service: 'pest-control' }, OPTS(root));
    expect(r.sufficient).toBe(false);
    expect(r.disposition_hint).toBe('facts_insufficient');
    expect(r.gap_codes.some((g) => g.includes('city_file_template'))).toBe(true);
  });

  test('county home_type supplement satisfies city home_type requirement', async () => {
    // The verified city fixture has NO home_type fact of its own; the county
    // provides one. The combination should still be sufficient.
    const root = makeFactsBank({
      'cities/testville.md': verifiedCity('testville', 'test-county'),
      'counties/test-county.md': verifiedCounty('test-county'),
      'services/pest-control.md': verifiedService('pest-control'),
    });
    const cityFile = await loader.loadCity('testville', OPTS(root));
    const cityAlone = auditor.auditEntity('city', cityFile);
    // City alone is missing home_type.
    expect(cityAlone.gap_codes.some((g) => g.includes('homeType'))).toBe(true);
    // But the combination (with county supplement) clears it.
    const combo = await auditor.auditCombination({ city: 'testville', service: 'pest-control' }, OPTS(root));
    expect(combo.gap_codes.some((g) => g.includes('homeType'))).toBe(false);
  });

  test('classifyFile flags template, draft, and invalid schema', () => {
    expect(auditor.classifyFile(null).status).toBe('missing');
    expect(auditor.classifyFile({ ok: false, parse_error: 'bad', entity_type: 'city' }).status).toBe('invalid_schema');
    expect(auditor.classifyFile({ ok: true, schema_version: 2, entity_type: 'city', facts_bank_status: 'template', generation_allowed: false, facts: [] }).status).toBe('template');
  });
});
