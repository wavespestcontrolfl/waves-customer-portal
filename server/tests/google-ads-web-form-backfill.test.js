// Renders the 20260827000001 backfill UPDATE (no database) and asserts the
// evidence / precedence predicate the migration promises.
const knex = require('knex')({ client: 'pg' });
const { buildBackfillQuery } = require('../models/migrations/20260827000001_google_ads_web_form_lead_source');

describe('google_ads web-form backfill predicate', () => {
  const sql = buildBackfillQuery(knex, 'ROW', { hasFunnelLeadId: true, hasCustomerUtm: true }).toString();

  test('scopes to non-deleted WEB leads that are NULL-source or on another google_ads row; lead_source_id only', () => {
    expect(sql).toMatch(/^update "leads" set "lead_source_id" = 'ROW' where/);
    expect(sql).toContain('"deleted_at" is null');
    expect(sql).toContain('"first_contact_channel" in (\'form\', \'website_quote\', \'web\')');
    expect(sql).toContain('("lead_source_id" is null or "lead_source_id" in (select "id" from "lead_sources" where "source_type" = \'google_ads\' and not "id" = \'ROW\'))');
    expect(sql).not.toContain('updated_at');
  });

  test('explicit lead-level evidence for another source disqualifies every arm', () => {
    expect(sql).toContain("COALESCE(extracted_data->'attribution'->'leadSource'->>'source', 'google_ads') = 'google_ads'");
    expect(sql).toContain("COALESCE(NULLIF(LOWER(BTRIM(extracted_data->'utm'->>'source')), ''), 'google') = 'google'");
    expect(sql).toContain('not exists (select * from "ad_service_attribution" as "a2" where a2.lead_id = leads.id and not "a2"."lead_source" = \'google_ads\')');
  });

  test('the legacy GBP tuple (google / organic / gbp) is excluded — GBP is not paid search', () => {
    expect(sql).toContain("NOT (LOWER(BTRIM(COALESCE(extracted_data->'utm'->>'source', ''))) = 'google' AND LOWER(BTRIM(COALESCE(extracted_data->'utm'->>'medium', ''))) = 'organic' AND LOWER(BTRIM(COALESCE(extracted_data->'utm'->>'campaign', ''))) = 'gbp')");
  });

  test('evidence arms: trimmed click ids, own classification, quote-wizard utm, funnel row, gated customer fallback', () => {
    expect(sql).toContain("NULLIF(BTRIM(gclid), '') IS NOT NULL");
    expect(sql).toContain("NULLIF(BTRIM(wbraid), '') IS NOT NULL");
    expect(sql).toContain("NULLIF(BTRIM(gbraid), '') IS NOT NULL");
    expect(sql).toContain("extracted_data->'attribution'->'leadSource'->>'source' = 'google_ads'");
    expect(sql).toContain("LOWER(COALESCE(extracted_data->'utm'->>'source', '')) = 'google' AND LOWER(COALESCE(extracted_data->'utm'->>'medium', '')) = 'cpc'");
    expect(sql).toContain('exists (select * from "ad_service_attribution" as "a" where a.lead_id = leads.id and "a"."lead_source" = \'google_ads\')');
    // customer fallback only when BOTH lead-level attribution locations are absent
    expect(sql).toContain("(extracted_data->'attribution' IS NULL and extracted_data->'utm' IS NULL and exists (select * from \"customers\" as \"c\"");
  });

  test('funnel / customer arms are omitted when their tables or columns are missing', () => {
    const bare = buildBackfillQuery(knex, 'ROW', { hasFunnelLeadId: false, hasCustomerUtm: false }).toString();
    expect(bare).not.toContain('ad_service_attribution');
    expect(bare).not.toContain('customers');
  });
});
