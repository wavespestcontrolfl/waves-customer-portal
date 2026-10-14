// 20261014233000_lead_auto_reply_reply_call_or_text: the lead text offers CALL or
// TEXT (owner 2026-10-14). It must start from the body 20261006220000 wrote
// (the live body on 10-14) and keep the placeholder, the STOP line, GSM-7,
// one "Waves" and a single SMS segment.
const { _SWAPS: SWAPS } = require('../models/migrations/20261014233000_lead_auto_reply_reply_call_or_text');
const { _SWAPS: TIGHTEN } = require('../models/migrations/20261006220000_sms_template_tighten');

const placeholders = (body) => [...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('20261014233000_lead_auto_reply_reply_call_or_text', () => {
  const [[key, before, after]] = SWAPS;

  test('swaps only the lead auto-reply, from the 10-06 body', () => {
    expect(SWAPS).toHaveLength(1);
    expect(key).toBe('lead_auto_reply_biz');
    expect(before).toBe(new Map(TIGHTEN.map(([k, , a]) => [k, a])).get(key));
    expect(after).not.toBe(before);
  });

  test('offers CALL or TEXT and keeps placeholder, STOP line, GSM-7 and one "Waves"', () => {
    expect(after).toMatch(/^Hello \{first_name\}, Waves here\./);
    expect(after).toContain('Reply CALL');
    expect(after).toContain('or TEXT');
    expect(placeholders(after)).toEqual(placeholders(before));
    expect(after.endsWith('\n\nReply STOP to opt out.')).toBe(true);
    expect(after).toMatch(/^[\n\x20-\x7E]+$/);
    expect(after.match(/\bWaves\b/g)).toHaveLength(1);
  });

  test('fits one 160-character segment with an eight-letter first name', () => {
    expect(after.replace('{first_name}', 'Jennifer').length).toBeLessThanOrEqual(160);
  });
});

// The sender keeps the rendered lead text to one segment whatever name the
// form carried (Codex #6335 P1).
describe('renderLeadAutoReply keeps the lead text to one GSM-7 segment', () => {
  const { countSegments } = require('../services/messaging/segment-counter');
  const [[, , BODY]] = SWAPS;
  let renderLeadAutoReply;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/sms-template-renderer', () => ({
      renderSmsTemplate: jest.fn(async (_key, vars) => BODY.replace('{first_name}', vars.first_name)),
    }));
    ({ renderLeadAutoReply } = require('../services/lead-auto-reply'));
  });

  test.each([
    ['Sarah', 'Hello Sarah,'],
    ['Zoë', 'Hello Zoe,'],
    ['Bartholomew-Alexander', 'Hello there,'],
    ['', 'Hello there,'],
  ])('%p renders as %p in one GSM-7 segment', async (name, opener) => {
    const body = await renderLeadAutoReply(name, 'c-1');
    expect(body.startsWith(opener)).toBe(true);
    expect(countSegments(body)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
  });

  test('every render pins the base row, so the fallback cannot re-roll a variant', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    renderSmsTemplate.mockClear();
    await renderLeadAutoReply('Bartholomew-Alexander', 'c-1');
    expect(renderSmsTemplate).toHaveBeenCalledTimes(2);
    for (const call of renderSmsTemplate.mock.calls) expect(call[3]).toEqual({ noVariants: true });
  });
});
