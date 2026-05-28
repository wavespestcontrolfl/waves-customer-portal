/**
 * Facts-pack injection (content-brief-builder._loadFactsPack) + claims_ledger
 * capture (brief-driven-tools emit_draft). Uses a temp facts-bank so it runs
 * without a DB or the Astro repo.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentBriefBuilder } = require('../services/content/content-brief-builder');
const briefTools = require('../services/content/agents/brief-driven-tools');

const TODAY = new Date().toISOString().slice(0, 10);

function makeFactsBank(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-pack-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, 'content-ops/facts-bank', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

function cityFile() {
  return `---
schema_version: 2
entity_type: city
entity_id: sarasota
county: sarasota-county
facts_bank_status: verified
generation_allowed: true
facts:
  - { id: city_sarasota_pub_01, type: neighborhood, value: "Laurel Park", visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
  - { id: city_sarasota_internal_01, type: operations, value: "route note", visibility: internal_only, prompt_use_allowed: false, public_copy_allowed: false, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 30 }
  - { id: city_sarasota_promptonly_01, type: differentiation, value: "positioning note", visibility: public, prompt_use_allowed: true, public_copy_allowed: false, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
disallowed_claim_patterns: ["Do not claim same-day availability"]
internal_links: { quote: "/q/", calculator: "/pest-control-calculator/" }
---
`;
}
function serviceFile() {
  return `---
schema_version: 2
entity_type: service
entity_id: pest-control
facts_bank_status: verified
generation_allowed: true
facts:
  - { id: svc_pest_01, type: pest_pressure, value: "ghost ants", visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
disallowed_claim_patterns: ["Do not guarantee elimination"]
---
`;
}
function countyFile() {
  return `---
schema_version: 2
entity_type: county
entity_id: sarasota-county
facts_bank_status: verified
generation_allowed: true
facts:
  - { id: cty_reg_01, type: regulation, value: "blackout Jun-Sep", visibility: public, prompt_use_allowed: true, public_copy_allowed: true, evidence_strength: verified, last_verified: ${TODAY}, ttl_days: 365 }
---
`;
}

describe('content-brief-builder._loadFactsPack', () => {
  const builder = new ContentBriefBuilder();
  let root;
  const savedEnv = {};

  beforeAll(() => {
    root = makeFactsBank({
      'cities/sarasota.md': cityFile(),
      'services/pest-control.md': serviceFile(),
      'counties/sarasota-county.md': countyFile(),
    });
    for (const k of ['ASTRO_REPO_DIR', 'CONTENT_REGISTRY_ASTRO_SOURCE']) savedEnv[k] = process.env[k];
    process.env.ASTRO_REPO_DIR = root;
    process.env.CONTENT_REGISTRY_ASTRO_SOURCE = 'filesystem';
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('assembles a facts pack for a facts-gated city × service action', async () => {
    const pack = await builder._loadFactsPack(
      { city: 'Sarasota', service: 'pest' },
      { action_type: 'refresh_existing_page' },
    );
    expect(pack).not.toBeNull();
    expect(pack.city.id).toBe('sarasota');
    expect(pack.service.id).toBe('pest-control');
    expect(pack.county.id).toBe('sarasota-county');
    // Only prompt-usable facts: the internal_only ops fact is excluded.
    const cityIds = pack.city.facts.map((f) => f.id);
    expect(cityIds).toContain('city_sarasota_pub_01');
    expect(cityIds).not.toContain('city_sarasota_internal_01');
    // Citeable pack is copy-safe only: a prompt-only (public_copy_allowed:false)
    // fact must NOT be handed to the agent to cite (it would fail the validator).
    expect(cityIds).not.toContain('city_sarasota_promptonly_01');
    // Disallowed patterns merged from all three files.
    expect(pack.disallowed_claim_patterns).toEqual(
      expect.arrayContaining(['Do not claim same-day availability', 'Do not guarantee elimination']),
    );
  });

  test('returns null for a non-facts-gated action', async () => {
    const pack = await builder._loadFactsPack(
      { city: 'Sarasota', service: 'pest' },
      { action_type: 'rewrite_title_meta' },
    );
    expect(pack).toBeNull();
  });

  test('returns null when city/service cannot be mapped', async () => {
    const pack = await builder._loadFactsPack(
      { city: 'Sarasota', service: 'specialty' },
      { action_type: 'refresh_existing_page' },
    );
    expect(pack).toBeNull();
  });
});

describe('emit_draft captures claims_ledger', () => {
  test('claims_ledger is stored on the session draft', async () => {
    const sessionId = 'test-session-1';
    const ledger = [{ claim: 'Ghost ants are common', factIds: ['svc_pest_01'] }];
    await briefTools.executeBriefTool('emit_draft', {
      frontmatter: { title: 'X' },
      body: 'Ghost ants are common in Sarasota.',
      claims_ledger: ledger,
    }, { sessionId });
    const draft = briefTools.getDraft(sessionId);
    expect(draft.claims_ledger).toEqual(ledger);
    briefTools.clearDraft(sessionId);
  });
});
