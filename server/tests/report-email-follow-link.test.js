// Owner 2026-11-01 (social audit "follow link"): one Follow line in the visit
// report email, behind GATE_REPORT_EMAIL_FOLLOW_LINK. Gate off = unchanged.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-signed-map-images';
const { buildServiceReportV1Email } = require('../services/service-report/email-delivery');
const { renderTemplate } = require('../services/email-template-library');
const { followUsLine } = require('../services/email-template');
const { reportEmailFollowLinkLive } = require('../config/feature-gates');

const LEAD = 'Follow Waves for local pest and lawn tips:';
const FB = 'https://facebook.com/wavespestcontrol';
const IG = 'https://instagram.com/wavespestcontrol';
const TT = 'https://tiktok.com/@wavespestcontrol';

const count = (haystack, needle) => haystack.split(needle).length - 1;
const report = () => buildServiceReportV1Email({
  data: { customerName: 'Taylor', serviceDate: '2026-11-02', serviceType: 'Quarterly Pest Control Service', technicianName: 'Alex', findings: [], applications: [], advisory: {}, metrics: [] },
  reportUrl: 'https://portal.wavespestcontrol.com/report/abc',
});

describe('report email follow line', () => {
  afterEach(() => { delete process.env.GATE_REPORT_EMAIL_FOLLOW_LINK; });

  test('the gate is strict true and dark by default', () => {
    expect(reportEmailFollowLinkLive()).toBe(false);
    process.env.GATE_REPORT_EMAIL_FOLLOW_LINK = '1';
    expect(reportEmailFollowLinkLive()).toBe(false);
    process.env.GATE_REPORT_EMAIL_FOLLOW_LINK = 'true';
    expect(reportEmailFollowLinkLive()).toBe(true);
  });

  test('the line links only the confirmed profiles', () => {
    const line = followUsLine();
    expect(line.html.match(/href="[^"]+"/g)).toEqual([`href="${FB}"`, `href="${IG}"`, `href="${TT}"`]);
    expect(line.text.split('\n')).toEqual([LEAD, `Facebook: ${FB}`, `Instagram: ${IG}`, `TikTok: ${TT}`]);
    expect(line.html).not.toMatch(/youtube|x\.com/i);
  });

  describe('legacy fallback email', () => {
    test('gate off: no follow line in either part', () => {
      const { html, text } = report();
      expect(html).not.toContain(LEAD);
      expect(text).not.toContain(LEAD);
      expect(html).not.toContain('tiktok.com/@wavespestcontrol" class="dm-link"');
    });

    test('gate off output is identical to the output with the gate never set', () => {
      const a = report();
      process.env.GATE_REPORT_EMAIL_FOLLOW_LINK = 'false';
      expect(report()).toEqual(a);
    });

    test('gate on: the line appears once per part, before the footer and the signature', () => {
      process.env.GATE_REPORT_EMAIL_FOLLOW_LINK = 'true';
      const { html, text } = report();
      expect(count(html, LEAD)).toBe(1);
      expect(count(text, LEAD)).toBe(1);
      for (const url of [FB, IG, TT]) {
        expect(html).toContain(`href="${url}" target="_blank"`);
        expect(text).toContain(url);
      }
      // Above the universal Waves footer (its social icon row) in HTML.
      expect(html.indexOf(LEAD)).toBeLessThan(html.indexOf('app-email/social/facebook.png'));
      // Plain text: signature line stays last.
      expect(text.trimEnd().endsWith('Waves Pest Control')).toBe(true);
      expect(text.indexOf(LEAD)).toBeLessThan(text.lastIndexOf('Waves Pest Control'));
    });
  });

  describe('template library render', () => {
    const template = { template_key: 'service.report_ready', name: 'Service Report Ready', mode: 'service', required_variables: '[]' };
    const version = {
      subject: 'Your Waves report is ready',
      blocks: [
        { type: 'paragraph', content: 'Hi {{first_name}}, your report is ready.' },
        { type: 'small_note', content: 'Questions? Reply here.' },
      ],
    };
    const render = (extra = {}) => renderTemplate({ template, version, payload: { first_name: 'Taylor' }, ...extra });

    test('no bodyAppend: output is unchanged', () => {
      const base = render();
      expect(render({ bodyAppend: null })).toEqual(base);
      expect(base.html).not.toContain(LEAD);
      expect(base.text).not.toContain(LEAD);
    });

    test('bodyAppend: one line after the body, above the footer, in html and text', () => {
      const out = render({ bodyAppend: followUsLine() });
      expect(count(out.html, LEAD)).toBe(1);
      expect(count(out.text, LEAD)).toBe(1);
      expect(out.html.indexOf('Questions? Reply here.')).toBeLessThan(out.html.indexOf(LEAD));
      expect(out.html.indexOf(LEAD)).toBeLessThan(out.html.indexOf('app-email/social/facebook.png'));
      expect(out.text.indexOf('Questions? Reply here.')).toBeLessThan(out.text.indexOf(LEAD));
      expect(out.text).toContain(TT);
    });

    test('bodyAppend with a stored text body lands after it', () => {
      const out = renderTemplate({ template, version: { ...version, text_body: 'Hi {{first_name}}.' }, payload: { first_name: 'Taylor' }, bodyAppend: followUsLine() });
      expect(out.text.startsWith('Hi Taylor.')).toBe(true);
      expect(out.text.indexOf('Hi Taylor.')).toBeLessThan(out.text.indexOf(LEAD));
    });
  });
});
