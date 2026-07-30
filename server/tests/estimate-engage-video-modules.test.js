/**
 * Engage video modules (migration 20260723300000) — pins the marketing-video
 * republish of the estimate.engage_* templates:
 *   - placement plan: report tour on the 3 protocol-carrying templates plus
 *     gone_quiet; app tour replacing the reschedule still on the 3
 *     APP_MODULE templates; nothing else touched;
 *   - the transform never mutates the 20260715200000 seed export (down()
 *     republishes it verbatim);
 *   - render QA through the REAL copy packs: video categories render the
 *     clickable preview, no-video categories drop the module cleanly —
 *     never a broken image or a leftover {{placeholder}}.
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
const seed = require('../models/migrations/20260715200000_seed_estimate_engage_email_templates');
const videoMigration = require('../models/migrations/20260723300000_engage_video_modules');
const { inferEstimateServiceLines } = require('../services/estimate-service-lines');
const { followupEmailVars, _private: copyPrivate } = require('../services/estimate-followup-copy');

const TEMPLATES = videoMigration._TEMPLATES;
const byKey = new Map(TEMPLATES.map((t) => [t.key, t]));

const REPORT_KEYS = [
  'estimate.engage_unopened',
  'estimate.engage_return_after_dark',
  'estimate.engage_gone_quiet',
  'estimate.engage_expiring_unseen',
];
const APP_KEYS = [
  'estimate.engage_unopened',
  'estimate.engage_high_intent',
  'estimate.engage_expiring_unseen',
];
const APP_POSTER = 'https://portal.wavespestcontrol.com/app-email/videos/waves-app-tour-poster.jpg';
const APP_MP4 = 'https://portal.wavespestcontrol.com/app-email/videos/waves-app-tour.mp4';

function lanes(...keys) {
  inferEstimateServiceLines.mockReturnValue(keys.map((key) => ({ key })));
}

function payloadFor(packKey, extra = {}) {
  if (packKey === 'bundle') lanes('pest', 'lawn');
  else lanes(packKey);
  const pack = copyPrivate.PACKS[packKey];
  return {
    first_name: 'Taylor',
    estimate_url: 'https://portal.wavespestcontrol.com/estimate/example-token',
    estimate_accept_url: 'https://portal.wavespestcontrol.com/estimate/example-token?intent=accept',
    company_phone: '(941) 297-5749',
    ...followupEmailVars({ id: 'e1' }),
    expires_date: 'August 1',
    ...extra,
  };
}

function renderWith(t, packKey) {
  return EmailTemplates.renderTemplate({
    template: { id: `tmpl-${t.key}`, template_key: t.key },
    version: { id: `ver-${t.key}`, subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' },
    payload: payloadFor(packKey),
  });
}

describe('placement plan', () => {
  test('report tour rides exactly the long-form touches; app tour exactly the old APP_MODULE set', () => {
    expect(videoMigration._private.WITH_REPORT.sort()).toEqual([...REPORT_KEYS].sort());
    expect(videoMigration._private.WITH_APP.sort()).toEqual([...APP_KEYS].sort());
  });

  test('report preview block: variable src + href, alt text, email width', () => {
    for (const key of REPORT_KEYS) {
      const t = byKey.get(key);
      const img = t.blocks.find((b) => b.src === '{{report_video_preview}}');
      expect(img).toBeTruthy();
      expect(img.href).toBe('{{report_video_url}}');
      expect(img.alt).toBeTruthy();
      expect(img.width).toBe(520);
      const at = t.blocks.indexOf(img);
      expect(t.blocks[at + 1]).toEqual({ type: 'small_note', content: '{{report_video_caption}}' });
    }
  });

  test('app tour replaces the reschedule still — poster + mp4 link, no stale June captures', () => {
    for (const t of TEMPLATES) {
      const hasPoster = t.blocks.some((b) => b.src === APP_POSTER);
      expect(hasPoster).toBe(APP_KEYS.includes(t.key));
      // The still only ever lived in APP_MODULE — the swap leaves zero.
      expect(t.blocks.some((b) => (b.src || '').endsWith('/app-reschedule-slots.png'))).toBe(false);
      if (hasPoster) {
        const img = t.blocks.find((b) => b.src === APP_POSTER);
        expect(img.href).toBe(APP_MP4);
        expect(img.alt).toBeTruthy();
      }
      for (const img of t.blocks.filter((b) => b.type === 'image')) {
        expect(img.src).toMatch(/^(https:\/\/portal\.wavespestcontrol\.com\/app-email\/|\{\{report_video_preview\}\})/);
        expect(img.src).not.toMatch(/app-(report|visits|home|track|tracking|reminders|reschedule|waves-ai)\.png$/);
      }
    }
  });

  test('video variables land in optional (never required) on touched templates only', () => {
    const touched = new Set([...REPORT_KEYS, ...APP_KEYS]);
    for (const t of TEMPLATES) {
      const hasVars = videoMigration._private.VIDEO_VARIABLES.every((v) => (t.optional || []).includes(v));
      expect(hasVars).toBe(touched.has(t.key));
      for (const v of videoMigration._private.VIDEO_VARIABLES) {
        expect(t.required || []).not.toContain(v);
      }
    }
  });

  test('touched templates carry the video fixture so admin previews render the module', () => {
    for (const key of REPORT_KEYS) {
      expect(byKey.get(key).fixture.report_video_preview).toMatch(/waves-pest-tour-preview\.gif$/);
    }
  });

  test('the transform leaves the 20260715200000 seed export untouched (down() depends on it)', () => {
    for (const t of seed._TEMPLATES) {
      const text = JSON.stringify(t);
      expect(text).not.toContain('report_video');
      expect(text).not.toContain('/videos/');
    }
  });
});

describe('render QA', () => {
  beforeEach(() => jest.clearAllMocks());

  for (const packKey of ['pest', 'lawn', 'tree_shrub']) {
    test(`unopened renders the ${packKey} report tour as a clickable preview`, () => {
      const rendered = renderWith(byKey.get('estimate.engage_unopened'), packKey);
      expect(rendered.validation.ok).toBe(true);
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.html).not.toMatch(/\{\{|\}\}/);
      const slug = copyPrivate.PACKS[packKey].video.slug;
      expect(rendered.html).toContain(`/app-email/videos/waves-${slug}-tour-preview.gif`);
      expect(rendered.html).toContain(`/app-email/videos/waves-${slug}-tour.mp4`);
      expect(rendered.text).toContain('Tap to watch');
    });
  }

  test('a no-video category drops the report module cleanly (no broken image, no leftovers)', () => {
    const rendered = renderWith(byKey.get('estimate.engage_gone_quiet'), 'mosquito');
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.html).not.toMatch(/\{\{|\}\}/);
    expect(rendered.html).not.toContain('/app-email/videos/waves-');
    expect(rendered.text).not.toContain('Tap to watch');
  });

  test('the app tour renders on high_intent for every category (static asset)', () => {
    for (const packKey of ['pest', 'termite']) {
      const rendered = renderWith(byKey.get('estimate.engage_high_intent'), packKey);
      expect(rendered.validation.ok).toBe(true);
      expect(rendered.html).toContain(APP_POSTER);
      expect(rendered.html).toContain(APP_MP4);
      expect(rendered.html).not.toMatch(/\{\{|\}\}/);
    }
  });

  test('compliance sweep over the new blocks (no "safe", no minute claims, no invented numbers)', () => {
    for (const t of TEMPLATES) {
      const text = t.blocks.map(
        (b) => [b.content, b.label, b.alt, ...(b.items || [])].filter(Boolean).join(' '),
      ).join(' ');
      expect(text).not.toMatch(/\bsafe\b/i);
      expect(text).not.toMatch(/\d+\s*(minutes|mins)\b/i);
      expect(text).not.toMatch(/\d+%/);
      expect(text).not.toMatch(/per visit/i);
    }
  });
});
