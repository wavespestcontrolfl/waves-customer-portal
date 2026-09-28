'use strict';

/**
 * Corrects three product facts seeded by
 * 20260928050000_email_division_fact_register.js (already pushed/frozen —
 * waves-db: never edit an applied migration, supersede it).
 *
 * The seeded Taurus SC, bifenthrin and Gentrol entries cited retailer
 * product pages and carried numbers neither the product label nor the
 * manufacturer states ("visible 1–2 weeks", "up to 90 days", "about 30 days
 * outdoors", "7–14 days", "30–90 days", adult sterilisation). A register
 * whose job is to stop unsupported claims reaching customers cannot hold
 * them itself. Each entry is rewritten to the exact label / manufacturer
 * wording, with the source documents that carry it:
 *
 *   - Taurus SC: Control Solutions product page (non-repellent, spread
 *     through the colony; no time-to-control stated) + UF/IFAS LH059
 *     (fipronil eliminates fire ant colonies slowly, four or more weeks).
 *   - Talstar P: product label (rain not predicted for 24 hours; no
 *     application during rain; people and pets off until the spray has
 *     dried; residual stated only for house flies and fleas).
 *   - Gentrol IGR: specimen label (exposed cockroaches become adults
 *     incapable of reproducing) + manufacturer page (120 days of control).
 *
 * Only a row that still carries the seeded text is rewritten (matched on a
 * marker phrase unique to it). A row a person has since edited, or one this
 * migration already corrected, is left alone — so it is idempotent and
 * never overwrites a human correction. The audit row is written in this
 * migration's own transaction (trx + critical), same as 20260928060000.
 */
const SOURCE = 'email-division-fact-register';
const STAMP = '20260928061000_email_division_fact_register_label_corrections';
const ACTION = 'knowledge_base.fact_corrected';
const VERIFIED_ON = '2026-09-28';

const CORRECTIONS = [
  {
    slug: 'fact-taurus-sc-non-repellent',
    seededMarker: '1 to 2 weeks',
    title: 'Taurus SC (fipronil 9.1%): non-repellent, spread through the colony',
    sourceUrl: 'https://www.controlsolutionsinc.com/csi-pest/products/taurus-sc',
    sourceUrls: [
      'https://www.controlsolutionsinc.com/csi-pest/products/taurus-sc',
      'https://edis.ifas.ufl.edu/lh059',
    ],
    quote: 'Taurus SC is a non-repellent insecticide that is undetectable to target pests, allowing them to touch, ingest and spread the insecticide throughout the entire colony.',
    content: 'Taurus SC (9.1% fipronil) is a non-repellent. The manufacturer states it is "undetectable to target pests, allowing them to touch, ingest and spread the insecticide throughout the entire colony." It works through the colony rather than killing on contact, so ants may remain visible after a treatment. The manufacturer states no time-to-control. For timing, University of Florida IFAS (LH059, Managing Imported Fire Ants in Urban Areas) says fipronil eliminates fire ant colonies slowly, requiring four or more weeks. Do not state a number of days or weeks of visible activity, or a number of days to full control, for a perimeter treatment: neither the label nor the manufacturer gives one.',
  },
  {
    slug: 'fact-bifenthrin-talstar-p-residual',
    seededMarker: 'about 30 days',
    title: 'Bifenthrin (Talstar P) label: rain, re-entry and stated residual',
    sourceUrl: 'https://mda.maryland.gov/plants-pests/Documents/Talstar%20P%20Professional%2004-17-13R%20Label.pdf',
    sourceUrls: [
      'https://mda.maryland.gov/plants-pests/Documents/Talstar%20P%20Professional%2004-17-13R%20Label.pdf',
    ],
    quote: 'Applying this product in calm weather when rain is not predicted for the next 24 hours will help to ensure that wind or rain does not blow or wash pesticide off the treatment area. Do not allow people or pets on treated surfaces until the spray has dried.',
    content: 'The Talstar P Professional label (bifenthrin 7.9%) says: apply "in calm weather when rain is not predicted for the next 24 hours"; "Do not make applications during rain"; "Do not allow people or pets on treated surfaces until the spray has dried." The only residual durations the label states are "up to 1 month residual control of house flies" and "Kills fleas for up to 3 months." The label gives no general outdoor perimeter residual, so copy must not state a number of days of residual for ants, spiders or other pests.',
  },
  {
    slug: 'fact-gentrol-igr-hydroprene',
    seededMarker: '7 to 14 days',
    title: 'Gentrol IGR (hydroprene): exposed roaches become adults that cannot reproduce',
    sourceUrl: 'https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/specimen/gentrol-igr-concentrate-specimen-label.pdf',
    sourceUrls: [
      'https://www.zoecon.com/-/media/project/oneweb/zoecon/files/product-labels/specimen/gentrol-igr-concentrate-specimen-label.pdf',
      'https://www.zoecon.com/all-products/gentrol/gentrol-igr-concentrate',
    ],
    quote: 'Cockroaches and bedbugs exposed to the GENTROL IGR will become adults incapable of reproducing.',
    content: 'Gentrol IGR Concentrate (hydroprene) is an insect growth regulator, a synthetic juvenile hormone look-alike that disrupts normal growth and development. The label states: "Cockroaches and bedbugs exposed to the GENTROL IGR will become adults incapable of reproducing" and "the cycle of an infestation ends." The manufacturer product page states "120 days of control." Neither source states how long until results are visible, and neither says the product makes already-mature adults sterile, so copy must not state a number of days to results or claim it sterilises adults.',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const hasAuditLog = await knex.schema.hasTable('audit_log');

  for (const fix of CORRECTIONS) {
    const row = await knex('knowledge_base')
      .where({ slug: fix.slug, source: SOURCE })
      .first('id', 'content', 'version');
    if (!row) continue; // the seed is not present in this environment
    // Already corrected, or edited by a person since the seed: leave it.
    if (!String(row.content || '').includes(fix.seededMarker)) continue;

    await knex('knowledge_base').where({ id: row.id }).update({
      title: fix.title,
      content: fix.content,
      summary: fix.quote,
      metadata: JSON.stringify({
        source_url: fix.sourceUrl,
        source_urls: fix.sourceUrls,
        quote: fix.quote,
        verified_on: VERIFIED_ON,
        corrected_by: STAMP,
        correction: 'seeded text cited a retailer page; replaced with label and manufacturer wording',
      }),
      version: Number(row.version || 1) + 1,
      last_verified_at: new Date(`${VERIFIED_ON}T00:00:00Z`),
      verified_by: SOURCE,
      updated_at: new Date(),
    });

    if (hasAuditLog) {
      await require('../../services/audit-log').recordAuditEvent({
        actor_type: 'migration',
        actor_id: null,
        action: ACTION,
        resource_type: 'knowledge_base',
        resource_id: row.id,
        metadata: { slug: fix.slug, migration: STAMP, source: SOURCE },
        trx: knex,
        critical: true,
      });
    }
  }
};

// Documented no-op: the seeded text this replaced was wrong, so there is
// nothing correct to restore, and a person may have edited the row since.
exports.down = async function down() {};

module.exports._internals = { CORRECTIONS };
