/**
 * Public lead webhook — the neighbor page's "Which home had the sign?" answer.
 *
 * The Astro /neighbor/ page (yard-sign and door-hanger QR destination) posts an
 * optional `sign_host` so the office can give the sign host the $25 thank-you
 * credit. The answer is staff-only:
 *  - normalized (printable, whitespace collapsed, capped) by buildLeadWebhookIntake;
 *  - stored on the lead (extracted_data.sign_host) and on the Customer 360 note;
 *  - kept when the AI triage replaces extracted_data;
 *  - never folded into `message` or the prose the AI triage and the Lead
 *    Response Agent read, because those write the customer's first text
 *    (the agent's get_lead_details tool strips it too — see
 *    lead-response-tools-lead-details.test.js).
 */

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { _test } = require('../routes/lead-webhook');

const { buildLeadWebhookIntake, normalizeSignHost, SIGN_HOST_MAX_LENGTH } = _test;

const neighborBody = (extra = {}) => ({
  name: 'Pat Neighbor',
  phone: '(941) 555-0123',
  address: '4516 Greenbrook Dr, Bradenton, FL 34203',
  interest: 'pest',
  specific_service: 'general_pest',
  frequency: 'ongoing',
  service_interest: 'Recurring Pest Control',
  source: 'astro-neighbor',
  ...extra,
});

describe('normalizeSignHost', () => {
  test('trims, collapses whitespace and drops control characters', () => {
    expect(normalizeSignHost('  the blue house \n at  4512\tGreenbrook ')).toBe('the blue house at 4512 Greenbrook');
    expect(normalizeSignHost('a\u0000b\u007fc')).toBe('a b c');
  });

  test('non-strings and blank answers normalize to empty', () => {
    expect(normalizeSignHost(undefined)).toBe('');
    expect(normalizeSignHost(null)).toBe('');
    expect(normalizeSignHost(42)).toBe('');
    expect(normalizeSignHost(['4512 Greenbrook'])).toBe('');
    expect(normalizeSignHost('   ')).toBe('');
  });

  test('caps the length without leaving a trailing space', () => {
    const out = normalizeSignHost(`${'x'.repeat(SIGN_HOST_MAX_LENGTH - 1)} yyyy`);
    expect(out.length).toBeLessThanOrEqual(SIGN_HOST_MAX_LENGTH);
    expect(out).toBe(out.trim());
  });

  // A lone surrogate is invalid JSON text to Postgres, so the jsonb write of
  // extracted_data (and with it the lead row) would fail.
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test('the cap never splits an emoji at the boundary', () => {
    const out = normalizeSignHost(`${'x'.repeat(SIGN_HOST_MAX_LENGTH - 1)}🏠🏠`);
    expect(out).toBe(`${'x'.repeat(SIGN_HOST_MAX_LENGTH - 1)}🏠`);
    expect(Array.from(out)).toHaveLength(SIGN_HOST_MAX_LENGTH);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  test('unpaired surrogates from the client become spaces', () => {
    expect(normalizeSignHost('blue \uD83C house')).toBe('blue house');
    expect(normalizeSignHost('a\uDFE0b')).toBe('a b');
    expect(normalizeSignHost('the 🏠 at 4512')).toBe('the 🏠 at 4512');
    expect(normalizeSignHost(`x${'🏠'.slice(0, 1)}`)).not.toMatch(LONE_SURROGATE);
  });
});

describe('buildLeadWebhookIntake', () => {
  test('carries the normalized sign host', () => {
    const intake = buildLeadWebhookIntake(neighborBody({ sign_host: ' the blue house  at 4512 Greenbrook ' }));
    expect(intake.signHost).toBe('the blue house at 4512 Greenbrook');
  });

  test('an absent sign host is empty, and no other field is mistaken for it', () => {
    expect(buildLeadWebhookIntake(neighborBody()).signHost).toBe('');
    expect(buildLeadWebhookIntake(neighborBody({ notes: 'blue house', message: 'hi' })).signHost).toBe('');
  });

  test('the sign host never becomes the prose message', () => {
    const intake = buildLeadWebhookIntake(neighborBody({ sign_host: 'the blue house at 4512 Greenbrook' }));
    expect(intake.message).toBe('');
    expect(intake.serviceInterest).toBe('Recurring Pest Control');
  });

  test('the sign host does not change the parsed name, phone or address', () => {
    const withHost = buildLeadWebhookIntake(neighborBody({ sign_host: '4512 Greenbrook Dr' }));
    const without = buildLeadWebhookIntake(neighborBody());
    expect(withHost.firstName).toBe(without.firstName);
    expect(withHost.lastName).toBe(without.lastName);
    expect(withHost.rawPhone).toBe(without.rawPhone);
    expect(withHost.fullAddress).toBe(without.fullAddress);
  });
});

describe('route wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/lead-webhook.js'), 'utf8');

  test('the lead record stores the sign host in extracted_data', () => {
    const stage = src.slice(src.indexOf('const webhookStageBase = {'));
    const block = stage.slice(0, stage.indexOf('\n    };'));
    expect(block).toMatch(/\.\.\.\(signHost \? \{ sign_host: signHost \} : \{\}\),/);
  });

  test('the AI triage extracted_data replace keeps the sign host', () => {
    const triage = src.slice(src.indexOf('if (triageResult.extractedData) {'));
    const block = triage.slice(0, triage.indexOf('if (Object.keys(updates).length > 0)'));
    // The attached call-lead branch MERGES (keeps every key); the replace
    // branch must carry sign_host forward like additional_properties/timeline.
    expect(block).toMatch(/COALESCE\(extracted_data, '\{\}'::jsonb\) \|\| \?::jsonb/);
    expect(block).toMatch(/db\.raw\(TRIAGE_REPLACE_EXTRACTED_SQL, /);
    const sql = require('../routes/lead-webhook')._test.TRIAGE_REPLACE_EXTRACTED_SQL;
    expect(sql).toContain("'sign_host', COALESCE(extracted_data, '{}'::jsonb)->'sign_host'");
    expect(sql.endsWith(')) || ?::jsonb')).toBe(true);
  });

  test('both Customer 360 notes carry the sign-host line', () => {
    const existing = src.slice(src.indexOf("subject: 'Form submission (existing customer)'"));
    expect(existing.slice(0, existing.indexOf('metadata:'))).toMatch(/\(signHostNote \? `\\n\$\{signHostNote\}` : ''\)/);

    const created = src.slice(src.indexOf('subject: `New lead from ${leadSource.detail || leadSource.source}`'));
    // First in the body: Customer 360 previews body[0..200].
    expect(created.slice(0, created.indexOf('metadata:'))).toMatch(/body: `\$\{signHostNote \? `\$\{signHostNote\}\. ` : ''\}Form: /);
  });

  test('the triage and Lead Response Agent prose never include the sign host', () => {
    const triage = src.slice(src.indexOf('// Fire-and-forget AI triage'), src.indexOf('// Fire-and-forget Lead Response Agent'));
    const agent = src.slice(src.indexOf('// Fire-and-forget Lead Response Agent'));
    const agentCall = agent.slice(0, agent.indexOf('const processLead'));
    for (const block of [triage, agentCall]) {
      expect(block).toMatch(/const messageText = /);
      expect(block).not.toMatch(/signHost/);
    }
  });
});
