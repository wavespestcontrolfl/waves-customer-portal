/**
 * estimate.engage_* template seeds (PR 3 of the engagement-drip lane) —
 * pins the contract between three parties that must agree:
 *   - the ENGINE's rule seeds (migration 20260714000050) reference exactly
 *     these template keys;
 *   - the TEMPLATE seeds (migration 20260715200000) render cleanly with the
 *     variables the engine's payload actually provides;
 *   - the COPY PACKS (estimate-followup-copy.js) fill every category slot
 *     the templates reference, for every v1 category (pest / lawn / bundle).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const templateSeed = require('../models/migrations/20260715200000_seed_estimate_engage_email_templates');
const engineSeed = require('../models/migrations/20260714000050_estimate_engagement_engine');
const { _private: copyPrivate } = require('../services/estimate-followup-copy');

const TEMPLATES = templateSeed._TEMPLATES;
const byKey = new Map(TEMPLATES.map((t) => [t.key, t]));

// The engine payload's guaranteed variables (estimateEmailPayload + the
// followupEmailVars extra the engine passes for engage sends).
function payloadFor(pack, extra = {}) {
  return {
    first_name: 'Taylor',
    estimate_url: 'https://portal.wavespestcontrol.com/estimate/example-token',
    service_summary: 'Quarterly Pest Control',
    property_address: '123 Gulf Breeze Ln',
    price_summary: '',
    company_phone: '(941) 297-5749',
    service_label: pack.label,
    category_headline: pack.headline,
    category_hook: pack.hook,
    category_benefit: pack.benefit,
    category_question: pack.question,
    ...extra,
  };
}

describe('estimate.engage_* seeds — engine contract', () => {
  test('every engine rule template_key has a seeded template, and nothing extra', () => {
    const ruleKeys = engineSeed._RULE_SEEDS.map((r) => r.template_key).sort();
    const seededKeys = TEMPLATES.map((t) => t.key).sort();
    expect(seededKeys).toEqual(ruleKeys);
  });

  test('subjects are static (no variables) and ≤60 chars', () => {
    for (const t of TEMPLATES) {
      expect(t.subject.length).toBeLessThanOrEqual(60);
      expect(t.subject).not.toMatch(/\{\{/);
    }
  });

  test('every template CTA rides estimate_url and every template signs off', () => {
    for (const t of TEMPLATES) {
      const cta = t.blocks.filter((b) => b.type === 'cta');
      expect(cta).toHaveLength(1);
      expect(cta[0].url_variable).toBe('estimate_url');
      expect(cta[0].label).toBeTruthy();
      expect(t.blocks.some((b) => b.type === 'signature')).toBe(true);
    }
  });

  test('no template restates monthly/annual totals (residential recurring rule)', () => {
    for (const t of TEMPLATES) {
      const text = t.blocks.map((b) => b.content || '').join(' ');
      expect(text).not.toMatch(/\{\{price_summary\}\}/);
      expect(text).not.toMatch(/\$\d/);
      expect(text).not.toMatch(/per visit/i); // owner rule: "per application" never "per visit"
    }
  });

  test('expiring variants require expires_date; the rest never reference it', () => {
    for (const t of TEMPLATES) {
      const text = t.blocks.map((b) => b.content || '').join(' ');
      if (t.key === 'estimate.engage_expiring' || t.key === 'estimate.engage_expiring_unseen') {
        expect(t.required).toContain('expires_date');
        expect(text).toMatch(/\{\{expires_date\}\}/);
      } else {
        expect(text).not.toMatch(/\{\{expires_date\}\}/);
      }
    }
  });
});

describe('estimate.engage_* seeds — render QA across the v1 category packs', () => {
  const V1_PACKS = ['pest', 'lawn', 'bundle'];

  for (const t of TEMPLATES) {
    for (const packKey of V1_PACKS) {
      test(`${t.key} renders cleanly with the ${packKey} pack`, () => {
        const pack = copyPrivate.PACKS[packKey];
        const rendered = EmailTemplates.renderTemplate({
          template: { id: `tmpl-${t.key}`, template_key: t.key },
          version: { id: `ver-${t.key}`, subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' },
          payload: payloadFor(pack, { expires_date: 'August 1' }),
        });
        expect(rendered.validation.ok).toBe(true);
        expect(rendered.missingPayload).toEqual([]);
        expect(rendered.text).not.toMatch(/\{\{|\}\}/);
        expect(rendered.html).not.toMatch(/\{\{|\}\}/);
        expect(rendered.text).toContain('Taylor');
        expect(rendered.text).toContain(pack.label);
        expect(rendered.text).toContain(pack.benefit);
      });
    }
  }

  test('truth scope holds through the render: pest/lawn carry recurring terms, bundle stays terms-neutral', () => {
    const t = byKey.get('estimate.engage_gone_quiet');
    const render = (pack) => EmailTemplates.renderTemplate({
      template: { id: 'tmpl', template_key: t.key },
      version: { id: 'ver', subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' },
      payload: payloadFor(pack),
    }).text;
    expect(render(copyPrivate.PACKS.pest)).toContain(copyPrivate.RECURRING_TERMS_BENEFIT);
    expect(render(copyPrivate.PACKS.lawn)).toContain(copyPrivate.RECURRING_TERMS_BENEFIT);
    expect(render(copyPrivate.PACKS.bundle)).toContain(copyPrivate.NEUTRAL_BENEFIT);
    expect(render(copyPrivate.PACKS.bundle)).not.toContain('90-day');
  });

  test('compliance language: no "safe", no fixed re-entry minutes, no invented stats', () => {
    for (const t of TEMPLATES) {
      const text = [t.subject, t.preview, ...t.blocks.map((b) => b.content || b.label || '')].join(' ');
      expect(text).not.toMatch(/\bsafe\b/i);
      expect(text).not.toMatch(/\d+\s*(minutes|mins)\b/i);
      expect(text).not.toMatch(/\d+%/);
    }
  });
});
