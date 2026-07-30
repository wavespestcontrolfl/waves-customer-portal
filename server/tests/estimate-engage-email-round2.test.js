/**
 * Engage email round 2 (migration 20260724100000) — pins the owner's
 * 2026-07-24 direction:
 *   - van photo ONLY on the two flagship never-viewed emails; the why-Waves
 *     checklist survives on all 7;
 *   - the report tour rides ALL 7 templates (truth-scoped per category);
 *   - the hot-second-visit rule sends the strong accept email and the
 *     multi-view rule sends the questions email (guarded swap, both ways).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceLines: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const EmailTemplates = require('../services/email-template-library');
const videoRound = require('../models/migrations/20260723300000_engage_video_modules');
const round2 = require('../models/migrations/20260724100000_engage_email_round2');
const { inferEstimateServiceLines } = require('../services/estimate-service-lines');
const { followupEmailVars, _private: copyPrivate } = require('../services/estimate-followup-copy');

const TEMPLATES = round2._TEMPLATES;
const byKey = new Map(TEMPLATES.map((t) => [t.key, t]));
const ALL_KEYS = TEMPLATES.map((t) => t.key).sort();
const FLAGSHIPS = ['estimate.engage_unopened', 'estimate.engage_expiring_unseen'];

function lanes(...keys) {
  inferEstimateServiceLines.mockReturnValue(keys.map((key) => ({ key })));
}

function renderWith(t, packKey) {
  lanes(packKey);
  const payload = {
    first_name: 'Taylor',
    estimate_url: 'https://portal.wavespestcontrol.com/estimate/example-token',
    estimate_accept_url: 'https://portal.wavespestcontrol.com/estimate/example-token?intent=accept',
    company_phone: '(941) 297-5749',
    expires_date: 'August 1',
    ...followupEmailVars({ id: 'e1' }),
  };
  return EmailTemplates.renderTemplate({
    template: { id: `t-${t.key}`, template_key: t.key },
    version: { id: `v-${t.key}`, subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' },
    payload,
  });
}

describe('round-2 placements', () => {
  test('report tour on all 7; van photo on exactly the flagships', () => {
    expect([...round2._private.WITH_REPORT].sort()).toEqual(ALL_KEYS);
    expect([...round2._private.WITH_VAN].sort()).toEqual([...FLAGSHIPS].sort());
  });

  test('why-Waves checklist survives everywhere the module lived', () => {
    for (const t of TEMPLATES) {
      expect(t.blocks.some((b) => b.type === 'heading' && b.content === 'Why folks choose Waves')).toBe(true);
      const list = t.blocks.find((b) => b.type === 'list');
      expect(list).toBeTruthy();
      expect(list.items.join(' ')).toContain('Family-owned and local');
    }
  });

  test('video variables land in optional on all 7', () => {
    for (const t of TEMPLATES) {
      for (const v of ['report_video_preview', 'report_video_url', 'report_video_caption']) {
        expect(t.optional).toContain(v);
        expect(t.required || []).not.toContain(v);
      }
      expect(t.fixture.report_video_preview).toMatch(/waves-pest-tour-preview\.gif$/);
    }
  });

  test('rule swap is exactly the hot/multi-view exchange, guarded on seeded values', () => {
    expect(round2._private.RULE_SWAP).toEqual([
      { rule_key: 'return_visit_hot', from: 'estimate.engage_return_visit', to: 'estimate.engage_high_intent' },
      { rule_key: 'multi_view_high_intent', from: 'estimate.engage_high_intent', to: 'estimate.engage_return_visit' },
    ]);
  });

  test('the chain input (video-round export) is left unmutated for down()', () => {
    const vanCount = videoRound._TEMPLATES.filter((t) => (t.blocks || []).some(
      (b) => b?.type === 'image' && /why-waves-van-/.test(b.src || ''),
    )).length;
    expect(vanCount).toBe(7); // v1 design intact: van everywhere pre-round2
    const reportCount = videoRound._TEMPLATES.filter((t) => (t.blocks || []).some(
      (b) => b?.src === '{{report_video_preview}}',
    )).length;
    expect(reportCount).toBe(4);
  });
});

describe('round-2 render QA', () => {
  beforeEach(() => jest.clearAllMocks());

  for (const key of ['estimate.engage_return_visit', 'estimate.engage_high_intent', 'estimate.engage_expiring']) {
    test(`${key} renders the pest report tour (newly added)`, () => {
      const rendered = renderWith(byKey.get(key), 'pest');
      expect(rendered.validation.ok).toBe(true);
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.html).not.toMatch(/\{\{|\}\}/);
      expect(rendered.html).toContain('/app-email/videos/waves-pest-tour-preview.gif');
      expect(rendered.html).not.toContain('why-waves-van');
    });
  }

  test('a no-video category still drops the module cleanly on the new placements', () => {
    const rendered = renderWith(byKey.get('estimate.engage_expiring'), 'termite');
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.html).not.toMatch(/\{\{|\}\}/);
    expect(rendered.html).not.toContain('/app-email/videos/waves-');
  });

  test('flagships keep the van photo', () => {
    for (const key of FLAGSHIPS) {
      const rendered = renderWith(byKey.get(key), 'pest');
      expect(rendered.html).toContain('why-waves-van-home.jpg');
    }
  });
});
