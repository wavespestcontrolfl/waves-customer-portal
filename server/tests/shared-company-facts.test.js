/**
 * One owner-approved COMPANY FACTS list reaches every channel (texting agent, voice agent, Gmail auto-draft).
 * The voice base prompt and the email draft prompt both render sms-company-facts.COMPANY_FACTS; neither keeps a copy,
 * so an approved fact (or a retirement) changes all three together.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { COMPANY_FACTS, renderCompanyFactsSection } = require('../services/sms-company-facts');
const { SYSTEM_PROMPT, buildBasePrompt } = require('../services/voice-agent/relay-conversation');

const SECTION = renderCompanyFactsSection().replace(/\n$/, '');

describe('voice agent prompt', () => {
  test.each([[false], [true]])('base prompt (context %s) carries the whole COMPANY FACTS section, line for line', (ctx) => {
    const prompt = buildBasePrompt(ctx);
    expect(prompt).toContain(SECTION);
    for (const fact of COMPANY_FACTS) expect(prompt).toContain(`- ${fact}`);
  });

  test('the section sits before the capture_lead close and is framed for speech', () => {
    expect(SYSTEM_PROMPT.indexOf(SECTION)).toBeGreaterThan(-1);
    expect(SYSTEM_PROMPT.indexOf(SECTION)).toBeLessThan(SYSTEM_PROMPT.indexOf('Before you end the call'));
    expect(SYSTEM_PROMPT).toMatch(/never read the list out/);
    expect(SYSTEM_PROMPT).toMatch(/only offer times a tool returned/);
  });

  test('the Spanish addendum still comes last', () => {
    const { LANGUAGE_ADDENDUM_ES } = require('../services/voice-agent/relay-language');
    expect(buildBasePrompt(false, 'es').endsWith(LANGUAGE_ADDENDUM_ES)).toBe(true);
  });

  test('the live bridge instructions stay well under the 16,384-token cap', () => {
    const { INSTRUCTIONS_MAX_CHARS } = require('../services/voice-agent/live-bridge');
    expect(buildBasePrompt(true).length).toBeLessThan(INSTRUCTIONS_MAX_CHARS / 2);
  });
});

describe('one source, no copy', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test.each([
    ['services/voice-agent/relay-conversation.js'],
    ['services/email/email-actions.js'],
  ])('%s reads sms-company-facts and holds no fact text of its own', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/require\('(\.\.\/)+sms-company-facts'\)|require\('\.\.\/sms-company-facts'\)/);
    expect(src).toMatch(/renderCompanyFactsSection/);
    // Any distinctive stretch of a fact line copied into the file would fail here.
    for (const fact of COMPANY_FACTS) {
      expect(src).not.toContain(fact.slice(0, 60));
    }
  });
});
