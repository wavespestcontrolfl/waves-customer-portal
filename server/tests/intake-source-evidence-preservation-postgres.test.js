/**
 * Real PostgreSQL proof for acquisition-evidence ownership across the three
 * public intake paths. The expressions exercised here are the route exports.
 * Opt in with a loopback INTAKE_SOURCE_EVIDENCE_TEST_DATABASE_URL.
 */
const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');

const { _test: webhookTest } = require('../routes/lead-webhook');
const { _test: propertyTest } = require('../routes/public-property-lookup');
const { _internals: quoteTest } = require('../routes/public-quote');
const { sourceEvidenceForLead, sourceEvidenceLabelSql } = require('../services/lead-source-evidence');

const connection = process.env.INTAKE_SOURCE_EVIDENCE_TEST_DATABASE_URL;
const describePg = connection ? describe : describe.skip;

const CALL_EVIDENCE = {
  kind: 'google_business', label: 'Google Business Profile', detail: 'Tracked call', basis: 'The inbound call used a tracked profile number.',
};
const WEB_FIRST = {
  kind: 'google_ads', label: 'Google Ads', detail: 'Paid search click', basis: 'The first browser visit carried a Google click identifier.',
};
const WEB_LATER = {
  kind: 'meta_ads', label: 'Meta Ads', detail: 'Meta-routed click', basis: 'A later browser visit carried a Meta click identifier.',
};

jest.setTimeout(30000);

describe('intake source-evidence wiring', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, `../routes/${file}`), 'utf8');

  test('stage objects omit null evidence and every call attach removes incoming evidence', () => {
    for (const file of ['lead-webhook.js', 'public-property-lookup.js', 'public-quote.js']) {
      const source = read(file);
      expect(source).toContain('...(sourceEvidence ? { source_evidence: sourceEvidence } : {})');
      expect(source).not.toMatch(/^\s*source_evidence:\s*sourceEvidence,?$/m);
    }
    expect(webhookTest.CALL_ATTACH_EXTRACTED_SQL).toContain("- 'source_evidence'");
    expect(propertyTest.CALL_ATTACH_EXTRACTED_SQL).toContain("- 'source_evidence'");
    expect(propertyTest.PROPERTY_COMPLETE_EXTRACTED_SQL).toContain("lead_type = 'quote_wizard'");
    expect(quoteTest.QUOTE_UPDATE_EXTRACTED_SQL).toContain("lead_type = 'quote_wizard'");
  });
});

describePg('intake source evidence SQL (PostgreSQL 16)', () => {
  let db;

  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error('INTAKE_SOURCE_EVIDENCE_TEST_DATABASE_URL must point to loopback PostgreSQL');
    }
    db = knexFactory({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    const version = Number((await db.raw("SELECT current_setting('server_version_num')::int AS version")).rows[0].version);
    if (version < 160000 || version >= 170000) throw new Error(`Expected PostgreSQL 16, got ${version}`);
  });

  afterAll(async () => { if (db) await db.destroy(); });

  async function evaluate(sql, incoming, existing = {}, leadType = null) {
    const leadTypeSelect = leadType == null ? '' : ', ?::text AS lead_type';
    const { rows } = await db.raw(
      `SELECT ${sql} AS out FROM (SELECT ?::jsonb AS extracted_data${leadTypeSelect}) AS leads`,
      [JSON.stringify(incoming), JSON.stringify(existing), ...(leadType == null ? [] : [leadType])],
    );
    return rows[0].out;
  }

  async function sortedSourceLabel(row) {
    const expression = sourceEvidenceLabelSql(db).toSQL();
    const { rows } = await db.raw(
      `SELECT ${expression.sql} AS label
       FROM (SELECT
         ?::jsonb AS extracted_data,
         ?::text AS gclid, ?::text AS wbraid, ?::text AS gbraid,
         ?::text AS fbclid, ?::text AS fbc,
         ?::text AS lead_type, ?::text AS first_contact_channel,
         ?::text AS twilio_call_sid, ?::text AS heard_about
       ) AS leads
       LEFT JOIN (SELECT
         ?::text AS source_type, ?::text AS channel, ?::text AS name
       ) AS lead_sources ON TRUE`,
      [
        ...expression.bindings,
        JSON.stringify(row.extracted_data || {}),
        row.gclid || null, row.wbraid || null, row.gbraid || null,
        row.fbclid || null, row.fbc || null,
        row.lead_type || null, row.first_contact_channel || null,
        row.twilio_call_sid || null, row.heard_about || null,
        row.source_type || null, row.source_channel || null, row.source_name || null,
      ],
    );
    return rows[0].label;
  }

  const callAttach = (sql, existing, incomingEvidence) => evaluate(sql, {
    stage: 'web_attached', typed_address: '123 Palm Ave', source_evidence: incomingEvidence,
  }, existing);

  const propertyComplete = (existing, leadType, incomingEvidence) => evaluate(
    propertyTest.PROPERTY_COMPLETE_EXTRACTED_SQL,
    { stage: 'property_lookup_complete', enriched: { homeSqFt: 1800 }, ...(incomingEvidence ? { source_evidence: incomingEvidence } : {}) },
    existing,
    leadType,
  );

  const quoteUpdate = (existing, leadType, incomingEvidence) => evaluate(
    quoteTest.QUOTE_UPDATE_EXTRACTED_SQL,
    { stage: 'quote_calculated', monthly: 49, ...(incomingEvidence ? { source_evidence: incomingEvidence } : {}) },
    existing,
    leadType,
  );

  const quoteSnapshot = (existing, incomingEvidence, marker = {}) => evaluate(
    quoteTest.QUOTE_SNAPSHOT_EXTRACTED_SQL,
    { stage: 'quote_calculated', monthly: 59, ...marker, ...(incomingEvidence ? { source_evidence: incomingEvidence } : {}) },
    existing,
  );

  test.each([
    ['lead webhook attach', webhookTest.CALL_ATTACH_EXTRACTED_SQL],
    ['property token attach', propertyTest.CALL_ATTACH_EXTRACTED_SQL],
  ])('%s preserves known call evidence and never fills unknown call evidence', async (_name, sql) => {
    const known = await callAttach(sql, { call_provenance: { call_id: 'call-1' }, source_evidence: CALL_EVIDENCE }, WEB_FIRST);
    expect(known).toMatchObject({
      call_provenance: { call_id: 'call-1' }, stage: 'web_attached', source_evidence: CALL_EVIDENCE,
    });

    const unknown = await callAttach(sql, { call_provenance: { call_id: 'call-2' } }, WEB_FIRST);
    expect(unknown).toMatchObject({ call_provenance: { call_id: 'call-2' }, stage: 'web_attached' });
    expect(unknown).not.toHaveProperty('source_evidence');
  });

  test('property completion and quote calculation keep known and unknown call origins unchanged', async () => {
    let known = { call_provenance: { call_id: 'call-known' }, source_evidence: CALL_EVIDENCE };
    known = await propertyComplete(known, 'inbound_call', WEB_FIRST);
    known = await quoteUpdate(known, 'inbound_call', WEB_LATER);
    expect(known).toMatchObject({
      call_provenance: { call_id: 'call-known' }, stage: 'quote_calculated', source_evidence: CALL_EVIDENCE,
    });

    let unknown = { call_provenance: { call_id: 'call-unknown' } };
    unknown = await propertyComplete(unknown, 'voicemail', WEB_FIRST);
    unknown = await quoteUpdate(unknown, 'voicemail', WEB_LATER);
    expect(unknown).toMatchObject({ call_provenance: { call_id: 'call-unknown' }, stage: 'quote_calculated' });
    expect(unknown).not.toHaveProperty('source_evidence');
  });

  test('web lookup through calculate and differing or missing retries keeps the first valid evidence', async () => {
    // The lookup-start insert captured Google. Completion sees later Meta,
    // calculate sees Meta again, and a missing retry follows; Google wins all.
    let snapshot = { stage: 'property_lookup_started', timeline: 'soon', source_evidence: WEB_FIRST };
    snapshot = await propertyComplete(snapshot, 'quote_wizard', WEB_LATER);
    expect(snapshot.source_evidence).toEqual(WEB_FIRST);

    snapshot = await quoteUpdate(snapshot, 'quote_wizard', WEB_LATER);
    expect(snapshot.source_evidence).toEqual(WEB_FIRST);
    snapshot = await quoteUpdate(snapshot, 'quote_wizard', null);
    expect(snapshot.source_evidence).toEqual(WEB_FIRST);

    snapshot = await quoteSnapshot(snapshot, WEB_LATER, { duplicate_of_lead_id: 'lead-root' });
    expect(snapshot).toMatchObject({ source_evidence: WEB_FIRST, duplicate_of_lead_id: 'lead-root' });
    snapshot = await quoteSnapshot(snapshot, null);
    expect(snapshot.source_evidence).toEqual(WEB_FIRST);
  });

  test('a web lead fills evidence only when the stored value is missing or invalid', async () => {
    const filledAtLookup = await propertyComplete({ stage: 'property_lookup_started' }, 'quote_wizard', WEB_FIRST);
    expect(filledAtLookup.source_evidence).toEqual(WEB_FIRST);

    const filledAtCalculate = await quoteUpdate({ stage: 'property_lookup_complete' }, 'quote_wizard', WEB_FIRST);
    expect(filledAtCalculate.source_evidence).toEqual(WEB_FIRST);

    const invalid = { kind: 'google_ads', label: 'Google Ads', basis: '   ' };
    const repaired = await quoteSnapshot({ source_evidence: invalid }, WEB_FIRST);
    expect(repaired.source_evidence).toEqual(WEB_FIRST);

    const stillMissing = await quoteUpdate({}, 'quote_wizard', null);
    expect(stillMissing).not.toHaveProperty('source_evidence');
  });

  test.each([
    ['GBP call without SID plus later Google click', {
      lead_type: 'inbound_call', first_contact_channel: 'call',
      source_type: 'gbp', source_name: 'GBP — Sarasota', gclid: 'later-google',
    }],
    ['shared phone line plus later Meta click', {
      lead_type: 'voicemail', first_contact_channel: 'phone',
      source_type: 'main_site', source_name: 'Main Site', fbclid: 'later-meta',
    }],
    ['older shared-line call with blank first-contact channel', {
      lead_type: 'voicemail', first_contact_channel: null,
      source_type: 'main_site', source_name: 'Main Site', gclid: 'later-google',
    }],
    ['Google paid call plus later Meta click', {
      lead_type: 'inbound_call', first_contact_channel: 'inbound_call',
      source_type: 'google_ads', source_channel: 'paid', source_name: 'Google Ads call line', fbc: 'later-meta',
    }],
    ['older call type with blank first-contact channel plus later Google click', {
      lead_type: 'inbound_call', first_contact_channel: null, gclid: 'later-google',
    }],
    ['web-first lead with a later CallSid and original Google click', {
      lead_type: 'inbound_call', first_contact_channel: 'form',
      twilio_call_sid: 'CA0123456789abcdef0123456789abcdef', gclid: 'web-google',
    }],
    ['proved paid Meta call placement', {
      lead_type: 'inbound_call', first_contact_channel: 'call',
      twilio_call_sid: 'CA0123456789abcdef0123456789abcdef',
      source_type: 'facebook', source_channel: 'paid', source_name: 'Facebook Ads call line',
    }],
    ['generic historical Facebook call without placement proof', {
      lead_type: 'inbound_call', first_contact_channel: 'call',
      source_type: 'facebook', source_channel: 'paid', source_name: 'Facebook Ads call line',
    }],
  ])('display and pre-pagination sort agree for %s', async (_name, row) => {
    expect(await sortedSourceLabel(row)).toBe(sourceEvidenceForLead(row).label.toLowerCase());
  });
});
