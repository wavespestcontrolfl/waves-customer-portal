jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
const { buildVersion, UPDATES } = require('../models/migrations/20260907000090_app_onboarding_email_versions');
const { TEMPLATE: APP_V4 } = require('../models/migrations/20260708000011_app_intro_email_v4_track_reminders');
const { renderTemplate } = require('../services/email-template-library');

function render(key, version, payload) {
  return renderTemplate({
    template: { template_key: key, mode: 'service', send_stream: 'service_operational', allowed_variables: [], required_variables: ['first_name'] },
    version,
    payload: { first_name: 'Fixture', ...payload },
  });
}

describe('app education content contracts', () => {
  test.each([true, false])('tracker CTA has a live destination with or without token: %s', hasTrack => {
    const active = { subject: 'Old subject', blocks: APP_V4.blocks };
    const next = buildVersion('app_intro', active);
    const rendered = render('app_intro', next, {
      track_url: hasTrack ? `https://portal.wavespestcontrol.com/track/${'a'.repeat(64)}` : '',
      customer_portal_url: hasTrack ? '' : 'https://portal.wavespestcontrol.com/login',
      app_store_url: 'https://apps.apple.com/us/app/waves-pest-control/id6782775654',
      play_store_url: 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal',
    });
    expect(rendered.html).toContain(hasTrack ? 'Track your technician' : 'Open the Waves app');
    expect(rendered.html).not.toContain(hasTrack ? 'Open the Waves app' : 'Track your technician');
    expect(rendered.text).toContain('#follow-your-technician');
    expect(rendered.text).toContain('Already have the app?');
    expect(rendered.text).toContain('Get it on Google Play');
    expect(rendered.text).not.toMatch(/moves a visit|gets a quote|makes sense of a charge|Refer.*earn/i);
    expect(JSON.parse(next.blocks).filter(b => b.type === 'image' && !['app_store_url', 'play_store_url'].includes(b.url_variable))).toHaveLength(0);
    expect(active.blocks).toEqual(APP_V4.blocks);
  });

  test.each([true, false])('first-report guidance and link vanish together on later reports: %s', first => {
    const next = buildVersion('service.report_ready', {
      subject: 'Report ready', blocks: [
        { type: 'paragraph', content: 'Hi {{first_name}}' },
        { type: 'paragraph', content: '{{inspection_credit_note}}' },
        { type: 'cta', label: 'View full report', url_variable: 'report_url' },
      ],
    });
    const rendered = render('service.report_ready', next, {
      report_url: 'https://portal.wavespestcontrol.com/report/fixture', inspection_credit_note: 'Inspection credit details retained.',
      ...(first ? UPDATES['service.report_ready'].fixture : {}),
    });
    expect(rendered.html).toContain('View full report');
    expect(rendered.text).toContain('Inspection credit details retained.');
    expect(rendered.text.includes('This is your first Waves report')).toBe(first);
    expect(rendered.text.includes('#read-your-service-report')).toBe(first);
    expect(rendered.html.includes('How to read your report')).toBe(first);
    if (first) expect(rendered.html).toMatch(/<a class="dm-link"[^>]+>How to read your report<\/a>/);
    expect(rendered.html).not.toContain('{{');
  });

  test('acceptance terms, staff copy and explicit plaintext survive the additive pointer', () => {
    const next = buildVersion('estimate.accepted_onboarding', {
      subject: 'Staff subject', preview_text: 'Staff preview', text_body: 'Staff text {{acceptance_note}}',
      blocks: [
        { type: 'paragraph', content: 'Hi {{first_name}}' },
        { type: 'paragraph', content: '{{acceptance_note}}' },
        { type: 'paragraph', content: 'Staff directions.' },
        { type: 'cta', label: 'View my account', url_variable: 'customer_portal_url' },
      ],
    });
    const rendered = render('estimate.accepted_onboarding', next, { acceptance_note: 'Accepted terms fixture.', customer_portal_url: 'https://portal.wavespestcontrol.com/login' });
    expect(rendered.subject).toBe('Staff subject');
    expect(rendered.html).toContain('Staff directions.');
    expect(rendered.html).toContain('Accepted terms fixture.');
    expect(rendered.text).toContain('Staff text Accepted terms fixture.');
    expect(rendered.text).toContain('#start-here-sign-in');
  });

  test('an edited old tour paragraph requires review even when its headings survive', () => {
    const blocks = structuredClone(APP_V4.blocks);
    const paragraph = blocks.find(b => b.type === 'paragraph');
    paragraph.content += ' Staff changed this existing paragraph.';
    const { assertOriginalTour } = require('../models/migrations/20260907000089_app_onboarding_tour_preflight');
    expect(() => assertOriginalTour(blocks)).toThrow('edited app tour block');
    expect(() => assertOriginalTour(APP_V4.blocks)).not.toThrow();
  });

  test('unrecognized active copy and custom plaintext require review instead of being overwritten', () => {
    expect(() => buildVersion('welcome.new_recurring', { blocks: [] })).toThrow('missing welcome first visit anchor');
    expect(() => buildVersion('app_intro', { blocks: APP_V4.blocks, text_body: 'Staff authored plaintext' })).toThrow('custom plaintext');
  });
});
