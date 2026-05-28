const fs = require('fs');
const os = require('os');
const path = require('path');

const factsSufficiency = require('../services/content/facts-sufficiency');

const TODAY = new Date().toISOString().slice(0, 10);

function makeFactsBank(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-suff-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, 'content-ops/facts-bank', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}
const OPTS = (root) => ({ astroRoot: root, astroSource: 'filesystem' });

function verifiedCity(id, county) {
  return `---
schema_version: 2
entity_type: city
entity_id: ${id}
county: ${county}
facts_bank_status: verified
generation_allowed: true
facts:
  - { id: c1, type: neighborhood, value: A, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
  - { id: c2, type: neighborhood, value: B, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
  - { id: c3, type: pest_pressure, value: C, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 180 }
disallowed_claim_patterns: ["x"]
internal_links: { quote: "/q/", calculator: "/pest-control-calculator/" }
---
`;
}
function verifiedCounty(id) {
  return `---
schema_version: 2
entity_type: county
entity_id: ${id}
facts_bank_status: verified
generation_allowed: true
facts:
  - { id: r1, type: regulation, value: R, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
  - { id: h1, type: home_type, value: H, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
  - { id: s1, type: seasonality, value: S, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
---
`;
}
function verifiedService(id) {
  return `---
schema_version: 2
entity_type: service
entity_id: ${id}
facts_bank_status: verified
generation_allowed: true
facts:
  - { id: t1, type: pest_pressure, value: A, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
  - { id: t2, type: seasonality, value: B, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
  - { id: t3, type: pest_pressure, value: C, visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
disallowed_claim_patterns: ["x"]
---
`;
}
function templateCity(id, county) {
  return `---
schema_version: 2
entity_type: city
entity_id: ${id}
county: ${county}
facts_bank_status: template
generation_allowed: false
facts: []
disallowed_claim_patterns: ["x"]
internal_links: {}
---
`;
}

describe('facts-sufficiency normalization', () => {
  test('city display name → slug', () => {
    expect(factsSufficiency.normalizeCityId('Lakewood Ranch')).toBe('lakewood-ranch');
    expect(factsSufficiency.normalizeCityId('Sarasota')).toBe('sarasota');
    expect(factsSufficiency.normalizeCityId('Port Charlotte')).toBe('port-charlotte');
    expect(factsSufficiency.normalizeCityId(null)).toBeNull();
  });

  test('service category → facts-bank id', () => {
    expect(factsSufficiency.normalizeServiceId('pest')).toBe('pest-control');
    expect(factsSufficiency.normalizeServiceId('lawn')).toBe('lawn-care');
    expect(factsSufficiency.normalizeServiceId('tree-shrub')).toBe('tree-shrub-care');
    expect(factsSufficiency.normalizeServiceId('pest-control')).toBe('pest-control'); // already an id
    expect(factsSufficiency.normalizeServiceId('nonsense')).toBeNull(); // fail closed
  });
});

describe('facts-sufficiency.check', () => {
  test('non-gated action is not applicable', async () => {
    const r = await factsSufficiency.check({ action_type: 'rewrite_title_meta', city: 'Sarasota', service: 'pest' });
    expect(r.applicable).toBe(false);
    expect(r.sufficient).toBe(true);
  });

  test('gated action with sufficient facts passes', async () => {
    const root = makeFactsBank({
      'cities/sarasota.md': verifiedCity('sarasota', 'sarasota-county'),
      'counties/sarasota-county.md': verifiedCounty('sarasota-county'),
      'services/pest-control.md': verifiedService('pest-control'),
    });
    const r = await factsSufficiency.check(
      { action_type: 'refresh_existing_page', city: 'Sarasota', service: 'pest' },
      OPTS(root),
    );
    expect(r.applicable).toBe(true);
    expect(r.sufficient).toBe(true);
    expect(r.city_id).toBe('sarasota');
    expect(r.service_id).toBe('pest-control');
  });

  test('gated action with template city is insufficient (fail closed)', async () => {
    const root = makeFactsBank({
      'cities/venice.md': templateCity('venice', 'sarasota-county'),
      'counties/sarasota-county.md': verifiedCounty('sarasota-county'),
      'services/pest-control.md': verifiedService('pest-control'),
    });
    const r = await factsSufficiency.check(
      { action_type: 'create_or_refresh_city_service_page', city: 'Venice', service: 'pest' },
      OPTS(root),
    );
    expect(r.applicable).toBe(true);
    expect(r.sufficient).toBe(false);
    expect(r.reason).toBe('facts_insufficient');
    expect(r.gap_codes.some((g) => g.includes('template'))).toBe(true);
  });

  test('unmappable service → not applicable (no city/service anchor)', async () => {
    const r = await factsSufficiency.check({ action_type: 'new_supporting_blog', city: 'Sarasota', service: 'specialty' });
    expect(r.applicable).toBe(false);
    expect(r.sufficient).toBe(true);
  });
});
