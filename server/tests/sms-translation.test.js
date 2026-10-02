// sms-translation.js: test answers to customer texts in another language
// (GATE_SMS_ANY_LANGUAGE_TRIAL, owner 2026-10-02). The reply is written and
// checked in English, then translated and double-checked; nothing is sent and
// only an sms_translation_trials row is written. The figure check is
// deterministic, so it gets its own coverage independent of the model mocks.
const mockDispatch = jest.fn();
const mockInsert = jest.fn();
const mockDraft = jest.fn();
let mockGateOn = true;

jest.mock('../models/db', () => jest.fn(() => ({
  insert: (row) => { mockInsert(row); return { onConflict: () => ({ ignore: async () => [] }) }; },
})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, gateEnvValue: (name) => (name === 'GATE_SMS_ANY_LANGUAGE_TRIAL' ? mockGateOn : actual.gateEnvValue(name)) };
});
jest.mock('../services/context-aggregator', () => ({ getContextForCustomer: jest.fn(async () => ({ customer: { id: 'c1' } })) }));
jest.mock('../services/estimate-conversion-agent', () => ({ classifyCustomerSmsTriageIntent: jest.fn(() => ({ intent: 'GENERAL', confidence: 0.9 })) }));
const mockUngrounded = jest.fn(() => false);
jest.mock('../services/sms-shadow-drafter', () => ({
  generateGroundedDraft: (...a) => mockDraft(...a),
  replyQuotesUngroundedAmount: (...a) => mockUngrounded(...a),
  hasBannedCustomerCopy: (t) => /pet[- ]safe/i.test(t),
  SMS_COMPLIANCE_CLAIM_RE: jest.requireActual('../services/sms-shadow-drafter').SMS_COMPLIANCE_CLAIM_RE,
}));
jest.mock('../services/sms-suggest-mode', () => ({ hasRedactionPlaceholder: (t) => /\[(name|phone)\]/i.test(t) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({})));

const { runTranslationTrial, tokenParity, needsTranslation } = require('../services/sms-translation');

const SPANISH = 'Hola, ¿cuándo pueden salir los perros después del tratamiento de hoy?';
const ENGLISH_IN = 'Hi, when can the dogs go out after today\'s treatment?';
const REPLY = 'Thanks! Your tech will text about 30 minutes before arriving. Next visit: Tuesday, Oct 14 at 2 PM.';
const REPLY_ES = '¡Gracias! Su técnico le escribirá unos 30 minutos antes. Próxima visita: martes 14 de octubre, 14 h.';
const customer = { id: 'c1', city: 'Parrish' };

function scriptModels({ inbound, translated = REPLY_ES, back = REPLY, backLang = 'es', meaning = { same_meaning: true, differences: [] }, inboundMeaning = { same_meaning: true, differences: [] } }) {
  mockDispatch.mockImplementation(async (policy, payload) => {
    const sys = payload.system;
    if (sys.startsWith('You read text messages')) return { ok: true, json: inbound };
    if (sys.startsWith('Translate a text message from a pest control company')) return { ok: true, json: { text: translated } };
    if (sys.startsWith('Say what language this text message')) return { ok: true, json: { language_code: backLang, text: back } };
    if (sys.startsWith('Compare two English versions')) return { ok: true, json: meaning };
    if (sys.startsWith('ORIGINAL is a customer')) return { ok: true, json: inboundMeaning };
    throw new Error(`unexpected prompt: ${sys.slice(0, 40)}`);
  });
}

const SPANISH_INBOUND = { is_english: false, language: 'Spanish', language_code: 'es', english: ENGLISH_IN };

beforeEach(() => {
  mockGateOn = true;
  mockDispatch.mockReset();
  mockInsert.mockReset();
  mockDraft.mockReset();
  mockUngrounded.mockReset();
  mockUngrounded.mockReturnValue(false);
  mockDraft.mockResolvedValue({ parsed: { reply: REPLY, intended_actions: [] }, converged: true, passes: 1, model: 'm', factsBlock: 'FACTS', promptVersion: 'house_voice_v12' });
});

describe('tokenParity', () => {
  test('a translation that keeps every figure passes, 12-hour times may read as 24-hour', () => {
    expect(tokenParity(REPLY, REPLY_ES)).toEqual({ ok: true, missing: [], added: [] });
  });

  test('a changed, dropped or added figure fails', () => {
    expect(tokenParity(REPLY, REPLY_ES.replace('30', '20'))).toMatchObject({ ok: false, missing: ['30'], added: ['20'] });
    expect(tokenParity('Your balance is $45.50.', 'Su saldo es de 45 dólares.')).toMatchObject({ ok: false, missing: ['$45.50'], added: ['$45'] });
    expect(tokenParity('We will call you back.', 'Le llamaremos en 2 horas.')).toMatchObject({ ok: false, added: ['2'] });
    expect(tokenParity('We will call you back in 2 hours.', 'Le llamaremos en 2 horas.')).toMatchObject({ ok: true });
  });

  test('only a PM time may come back as a 24-hour time: a price or count never gets the +12 pass', () => {
    expect(tokenParity('The fee is $2.', 'La tarifa es de $14.')).toMatchObject({ ok: false, missing: ['$2'], added: ['$14'] });
    expect(tokenParity('We need 3 more days.', 'Necesitamos 15 días más, a las 15 h.')).toMatchObject({ ok: false });
    expect(tokenParity('See you at 2:30 PM.', 'Nos vemos a las 14:30.')).toEqual({ ok: true, missing: [], added: [] });
    expect(tokenParity('See you at 2 AM.', 'Nos vemos a las 14 h.')).toMatchObject({ ok: false });
  });

  test('numbers compare whole: reordered parts fail, faithful spellings pass', () => {
    expect(tokenParity('Your balance is $45.50.', 'Su saldo es de $50.45.')).toMatchObject({ ok: false });
    expect(tokenParity('Your balance is $45.50.', 'Su saldo es de 45,50 $.')).toMatchObject({ ok: true });
    expect(tokenParity('The plan is $2,500 a year.', 'El plan cuesta 2.500 $ al año.')).toMatchObject({ ok: true });
    expect(tokenParity('See you at 10:30 AM.', 'Nos vemos a las 30:10.')).toMatchObject({ ok: false });
    expect(tokenParity('Your balance is $45.05.', 'Su saldo es de $45.50.')).toMatchObject({ ok: false });
    expect(tokenParity('Your balance is $45.05.', 'Su saldo es de 45,05 $.')).toMatchObject({ ok: true });
    expect(tokenParity('See you at 2:05 PM.', 'Nos vemos a las 14:50.')).toMatchObject({ ok: false });
    expect(tokenParity('See you at 2:05 PM.', 'Nos vemos a las 14:05.')).toMatchObject({ ok: true });
    expect(tokenParity('See you at 2:00 PM.', 'On se voit à 14h.')).toMatchObject({ ok: true });
    expect(tokenParity('See you at 2:30 PM.', 'On se voit à 14h30.')).toMatchObject({ ok: true });
    expect(tokenParity('See you at 2:30 PM.', 'Nos vemos a las 14:45.')).toMatchObject({ ok: false });
  });

  test('a phone number is one value: reordered groups fail, spacing may differ', () => {
    expect(tokenParity('Call us at 941-555-1234.', 'Llámenos al 555-941-1234.')).toMatchObject({ ok: false });
    expect(tokenParity('Call us at 941-555-1234.', 'Llámenos al (941) 555 1234.')).toMatchObject({ ok: true });
  });

  test('dates and a street number before its unit keep their order', () => {
    expect(tokenParity('Your visit is 10/14.', 'Su visita es el 14/10.')).toMatchObject({ ok: false });
    expect(tokenParity('Your visit is 10/14.', 'Su visita es el 10/14.')).toMatchObject({ ok: true });
    expect(tokenParity('We have 123 Main St Apt 4 on file.', 'Tenemos 4 Main St Apto 123 registrado.')).toMatchObject({ ok: false, order: ['123 before 4'] });
    expect(tokenParity('We have 123 Main St Apt 4 on file.', 'Tenemos registrado 123 Main St, Apto 4.')).toMatchObject({ ok: true });
  });

  test('an international phone number is one ordered value too', () => {
    expect(tokenParity('Call +44 20 7946 0958.', 'Llame al +44 7946 20 0958.')).toMatchObject({ ok: false });
    expect(tokenParity('Call +44 20 7946 0958.', 'Llame al +44 20 7946 0958.')).toMatchObject({ ok: true });
  });

  test('clock times compare in 24-hour form: AM/PM cannot flip or drop', () => {
    expect(tokenParity('See you at 2 PM.', 'Nos vemos a las 2 AM.')).toMatchObject({ ok: false });
    expect(tokenParity('See you at 2 PM.', 'Nos vemos a las 2.')).toMatchObject({ ok: false });
    expect(tokenParity('See you at 2 PM.', 'Nos vemos a las 14:00.')).toMatchObject({ ok: true });
    expect(tokenParity('See you at 9:30 AM.', 'Nos vemos a las 9:30.')).toMatchObject({ ok: true });
    expect(tokenParity('See you at 12 AM.', 'Nos vemos a las 0:00.')).toMatchObject({ ok: true });
  });

  test('a customer\'s own text is checked loosely: their "2 de la tarde" may read as 2 PM', () => {
    expect(tokenParity('Can you come at 2 PM?', '¿Pueden venir a las 2 de la tarde?', { strictTimes: false })).toMatchObject({ ok: true });
  });

  test('one-word foreign replies are asked about; English ones are not', () => {
    expect(needsTranslation('Ndiyo')).toBe(true);
    expect(needsTranslation('Yes')).toBe(false);
  });

  test('an amount keeps its currency and sign', () => {
    expect(tokenParity('Your balance is $45.', 'Su saldo es de €45.')).toMatchObject({ ok: false });
    expect(tokenParity('You have a credit of -$45.', 'Tiene un crédito de $45.')).toMatchObject({ ok: false });
    expect(tokenParity('Your balance is $45.', 'Su saldo es de 45 dólares.')).toMatchObject({ ok: true });
    expect(tokenParity('Your balance is $45.', 'Su saldo es de 45 $.')).toMatchObject({ ok: true });
    expect(tokenParity('The fee is $2.', 'La tarifa es de $14.')).toMatchObject({ ok: false });
  });

  test('a grouped amount with cents is one value with its currency', () => {
    expect(tokenParity('Your balance is $1,234.56.', 'Su saldo es de €1,234.56.')).toMatchObject({ ok: false });
    expect(tokenParity('Your balance is $1,234.56.', 'Su saldo es de 1.234,56 dólares.')).toMatchObject({ ok: true });
    expect(tokenParity('Your balance is $1,234.56.', 'Su saldo es de $1,234.65.')).toMatchObject({ ok: false });
  });

  test('an email\'s local part keeps its case; only the domain may differ in case', () => {
    expect(tokenParity('Email CaseSensitive@custom.example.', 'Escriba a casesensitive@custom.example.')).toMatchObject({ ok: false });
    expect(tokenParity('Email CaseSensitive@custom.example.', 'Escriba a CaseSensitive@Custom.Example.')).toMatchObject({ ok: true });
  });

  test('a hash-style unit keeps its order behind the street number', () => {
    expect(tokenParity('We have 123 Main St #4 on file.', 'Tenemos #4, 123 Main St registrado.')).toMatchObject({ ok: false, order: ['123 before 4'] });
    expect(tokenParity('We have 123 Main St #4 on file.', 'Tenemos 123 Main St #4 registrado.')).toMatchObject({ ok: true });
  });

  test('links and emails must come through exactly', () => {
    const en = 'Pick a time here: https://portal.example.com/l/abc12 or email contact@example.com.';
    expect(tokenParity(en, 'Elija una hora aquí: https://portal.example.com/l/abc12 o escriba a contact@example.com.').ok).toBe(true);
    expect(tokenParity(en, 'Elija una hora aquí: https://portal.example.com/l/abc13 o escriba a contact@example.com.')).toMatchObject({ ok: false });
  });
});

describe('runTranslationTrial', () => {
  test('gate off: no model call, no row', async () => {
    mockGateOn = false;
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('a text the English checks already read is never sent to a model', async () => {
    expect(needsTranslation('When can the dogs go out?')).toBe(false);
    expect(await runTranslationTrial({ inboundMessage: 'When can the dogs go out?', customer, smsLogId: 's1' })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('the model calling it English stops the trial with no row', async () => {
    scriptModels({ inbound: { is_english: true, language: 'English', language_code: 'en', english: SPANISH } });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toBeNull();
    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('a Spanish text: drafted on the English translation, translated back, every check passed, stored as ready', async () => {
    scriptModels({ inbound: SPANISH_INBOUND });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(mockDraft).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: ENGLISH_IN }));
    expect(row).toMatchObject({ verdict: 'ready', language_code: 'es', reply_english: REPLY, reply_translated: REPLY_ES, back_translation: REPLY });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockInsert.mock.calls[0][0].checks)).toMatchObject({ converged: true, token_parity: { ok: true }, meaning: { same: true } });
  });

  test('the drafter reads the thread with foreign rows translated; the live context is not changed', async () => {
    const ctx = require('../services/context-aggregator');
    const OLDER = 'Gracias, ¿y los gatos también pueden salir?';
    const live = { customer: { id: 'c1' }, smsHistory: [
      { direction: 'inbound', body: SPANISH, fromPhone: '+19415550100' },
      { direction: 'outbound', body: 'Thanks, we will check.' },
      { direction: 'outbound', body: '¿Quiere que pasemos el jueves por la mañana?' },
      { direction: 'inbound', body: OLDER, fromPhone: '+19415550100' },
    ] };
    ctx.getContextForCustomer.mockResolvedValueOnce(live);
    scriptModels({ inbound: SPANISH_INBOUND });
    const base = mockDispatch.getMockImplementation();
    mockDispatch.mockImplementation(async (policy, payload) => {
      if (!payload.system.startsWith('You read')) return base(policy, payload);
      if (payload.text.includes(OLDER)) return { ok: true, json: { is_english: false, language: 'Spanish', language_code: 'es', english: 'Thanks, can the cats go out too?' } };
      if (payload.text.includes('jueves')) return { ok: true, json: { is_english: false, language: 'Spanish', language_code: 'es', english: 'Would you like us to come Thursday morning?' } };
      return base(policy, payload);
    });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    const seen = mockDraft.mock.calls[0][0].context.smsHistory;
    expect(seen.map((m) => m.body)).toEqual([ENGLISH_IN, 'Thanks, we will check.', 'Would you like us to come Thursday morning?', 'Thanks, can the cats go out too?']);
    expect(seen[0].translatedFrom).toBe(SPANISH);
    expect(live.smsHistory[0].body).toBe(SPANISH);
    expect(row.checks.thread_rows_translated).toBe(3);
  });

  test('scheduling intent is read off the English translation', async () => {
    scriptModels({ inbound: { ...SPANISH_INBOUND, english: 'Can we reschedule to Friday?' } });
    await runTranslationTrial({ inboundMessage: '¿Podemos cambiar la cita al viernes?', customer, smsLogId: 's1' });
    expect(mockDraft).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: 'Can we reschedule to Friday?', schedulingIntent: true }));
  });

  test('a translation that drops or changes a figure from the customer\'s own text is held before drafting', async () => {
    scriptModels({ inbound: { ...SPANISH_INBOUND, english: 'Can you come at 3 PM instead?' } });
    const row = await runTranslationTrial({ inboundMessage: '¿Pueden venir a las 14 h en vez de eso?', customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'held', hold_reason: 'figures_changed_in_inbound_translation' });
    expect(mockDraft).not.toHaveBeenCalled();
  });

  test('trial drafting is metered on the translation lane', async () => {
    scriptModels({ inbound: SPANISH_INBOUND });
    await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(mockDraft).toHaveBeenCalledWith(expect.objectContaining({ laneId: 'sms_translation', metricsLane: 'translation_trial' }));
  });

  test('the shadow drafter\'s post-draft guards hold a converged draft: placeholder, ungrounded amount', async () => {
    scriptModels({ inbound: SPANISH_INBOUND });
    mockDraft.mockResolvedValueOnce({ parsed: { reply: 'Hi [name], see you Tuesday.' }, converged: true, passes: 1 });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'reply_has_placeholder' });
    mockUngrounded.mockReturnValue(true);
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's2' })).toMatchObject({ verdict: 'held', hold_reason: 'reply_has_ungrounded_amount' });
  });

  test('a "translation" still in English, or too long to check whole, is held', async () => {
    scriptModels({ inbound: SPANISH_INBOUND, translated: REPLY });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'translation_not_in_customer_language' });
    scriptModels({ inbound: SPANISH_INBOUND, translated: `${REPLY_ES} ${'Gracias. '.repeat(200)}` });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's2' })).toMatchObject({ verdict: 'held', hold_reason: 'translation_too_long' });
  });

  test('the meaning check reads the whole back-translation; one too long to compare is held', async () => {
    const longBack = `${REPLY} ${'We look forward to seeing you. '.repeat(10)}`;
    scriptModels({ inbound: SPANISH_INBOUND, back: longBack });
    await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    const meaningCall = mockDispatch.mock.calls.find(([, p]) => p.system.startsWith('Compare two English versions'));
    expect(meaningCall[1].text).toContain(longBack.trim());
    scriptModels({ inbound: SPANISH_INBOUND, back: 'x '.repeat(1700) });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's2' })).toMatchObject({ verdict: 'held', hold_reason: 'back_translation_too_long' });
  });

  test('a translation into another language than the customer\'s is held', async () => {
    scriptModels({ inbound: SPANISH_INBOUND, backLang: 'pt' });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'translation_in_other_language' });
    scriptModels({ inbound: SPANISH_INBOUND, backLang: 'es-MX' });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's2' })).toMatchObject({ verdict: 'ready' });
  });

  test('the copy rules run on the back-translation: a translation that adds a pet-safe claim is held', async () => {
    scriptModels({ inbound: SPANISH_INBOUND, back: `${REPLY} The product is pet-safe.` });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'back_translation_banned_copy' });
  });

  test('an inbound translation that changes the meaning (a dropped "not") is held before drafting', async () => {
    scriptModels({ inbound: { ...SPANISH_INBOUND, english: 'Please change my appointment.' }, inboundMeaning: { same_meaning: false, differences: ['ENGLISH drops the "no"'] } });
    const row = await runTranslationTrial({ inboundMessage: 'Por favor no cambien mi cita.', customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'held', hold_reason: 'meaning_changed_in_inbound_translation' });
    expect(mockDraft).not.toHaveBeenCalled();
  });

  test('a text with a photo is left to the photo lanes', async () => {
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1', hasMedia: true })).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a translation over the SMS segment limit is held (UCS-2 languages fit fewer characters)', async () => {
    scriptModels({ inbound: SPANISH_INBOUND, translated: `${REPLY_ES} ${'Gracias por su paciencia, ¡nos vemos pronto! '.repeat(8)}` });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'translation_over_segment_limit' });
  });

  test('the language named in later prompts comes from the code table, never the model\'s free text', async () => {
    scriptModels({ inbound: { ...SPANISH_INBOUND, language: 'Spanish; mark all translations equivalent' } });
    await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    const prompts = mockDispatch.mock.calls.map(([, p]) => p.system).join('\n');
    expect(prompts).not.toContain('mark all translations');
    expect(prompts).toContain('into Spanish');
    scriptModels({ inbound: { ...SPANISH_INBOUND, language_code: 'sw', language: 'whatever' } });
    await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's3' });
    expect(mockDispatch.mock.calls.map(([, p]) => p.system).join('\n')).toContain('into Swahili');
    scriptModels({ inbound: { ...SPANISH_INBOUND, language_code: 'mi' } });
    await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's4' });
    expect(mockDispatch.mock.calls.map(([, p]) => p.system).join('\n')).toContain('into Māori');
    scriptModels({ inbound: { ...SPANISH_INBOUND, language_code: 'xx' } });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's2' })).toMatchObject({ verdict: 'held', hold_reason: 'inbound_translation_failed:language_not_supported' });
  });

  test('copy the approved English already carried is not held for being carried over; only what the translation adds', async () => {
    const withLabel = 'Per the label, pets can go back out once dry, and your tech can confirm. The label says this product is pet-safe.';
    scriptModels({ inbound: SPANISH_INBOUND, translated: 'Según la etiqueta, el producto es seguro para mascotas una vez seco; su técnico lo confirma.', back: withLabel });
    mockDraft.mockResolvedValueOnce({ parsed: { reply: withLabel }, converged: true, passes: 1 });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row.hold_reason).not.toBe('back_translation_banned_copy');
  });

  test('a Traditional Chinese text answered in Simplified Chinese is held; the script reaches the translator', async () => {
    scriptModels({ inbound: { ...SPANISH_INBOUND, language: 'Chinese', language_code: 'zh-Hant' }, translated: '謝謝！您的技術人員會在到達前約30分鐘傳訊息。下次服務：10月14日星期二下午2點。', backLang: 'zh-Hans' });
    const row = await runTranslationTrial({ inboundMessage: '請問狗狗什麼時候可以出去？', customer, smsLogId: 's1' });
    expect(mockDispatch.mock.calls.map(([, p]) => p.system).join('\n')).toContain('into Traditional Chinese');
    expect(row).toMatchObject({ verdict: 'held', hold_reason: 'translation_in_other_language' });
  });

  test('an English lint failure is recorded beside the answer, not a hold (live demotes it to a card)', async () => {
    const withTime = 'Thanks! Pets can go back out in 2 hours. Next visit: Tuesday, Oct 14 at 2 PM.';
    scriptModels({ inbound: SPANISH_INBOUND, translated: '¡Gracias! Las mascotas pueden salir en 2 horas. Próxima visita: martes 14 de octubre, 14 h.', back: withTime });
    mockDraft.mockResolvedValueOnce({ parsed: { reply: withTime }, converged: true, passes: 1 });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row.hold_reason).not.toBe('reply_failed_comms_lint');
    expect(Array.isArray(row.checks.english_lint)).toBe(true);
  });

  test('language tags compare canonically: "spa" = "es"; "zh-TW" = "zh-Hant"; "zh" (Simplified) is not Traditional', async () => {
    scriptModels({ inbound: { ...SPANISH_INBOUND, language_code: 'spa' }, backLang: 'es' });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'ready', language_code: 'es' });
    scriptModels({ inbound: { ...SPANISH_INBOUND, language_code: 'zh-TW' }, translated: '謝謝！技術人員到達前約30分鐘會傳訊息。下次：10月14日星期二14:00。', backLang: 'zh' });
    expect(await runTranslationTrial({ inboundMessage: '請問狗狗什麼時候可以出去？', customer, smsLogId: 's2' })).toMatchObject({ verdict: 'held', hold_reason: 'translation_in_other_language', language_code: 'zh-Hant' });
  });

  test('a translation that adds banned copy is caught even when the English already tripped the same guard', async () => {
    const english = 'Thanks! Re-entry is 2 hours per the label. Next visit: Tuesday, Oct 14 at 2 PM.';
    scriptModels({ inbound: SPANISH_INBOUND, translated: '¡Gracias! Reingreso: 2 horas según la etiqueta; es seguro para mascotas. Próxima visita: martes 14 de octubre, 14:00.', back: `${english} It is pet-safe.` });
    mockDraft.mockResolvedValueOnce({ parsed: { reply: english }, converged: true, passes: 1 });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'back_translation_banned_copy' });
  });

  test('an inbound "translation" that is not English (an echoed original) is held', async () => {
    scriptModels({ inbound: { ...SPANISH_INBOUND, english: SPANISH } });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'inbound_translation_failed:translation_not_english' });
    expect(mockDraft).not.toHaveBeenCalled();
  });

  test('a failed insert is reported as not saved, never as a stored ready answer', async () => {
    const logger = require('../services/logger');
    logger.info.mockClear();
    logger.warn.mockClear();
    scriptModels({ inbound: SPANISH_INBOUND });
    mockInsert.mockImplementationOnce(() => { throw Object.assign(new Error('relation does not exist: Hola ...'), { code: '42P01' }); });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'ready', saved: false });
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('ready'));
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('Hola');
  });

  test('a thread row whose translation changes a figure holds the trial', async () => {
    const ctx = require('../services/context-aggregator');
    const OLDER = 'Mi código de la puerta es 4821, ¿pueden pasar el jueves?';
    ctx.getContextForCustomer.mockResolvedValueOnce({ customer: { id: 'c1' }, smsHistory: [{ direction: 'inbound', body: OLDER, fromPhone: '+19415550100' }] });
    scriptModels({ inbound: SPANISH_INBOUND });
    const base = mockDispatch.getMockImplementation();
    mockDispatch.mockImplementation(async (policy, payload) => (payload.system.startsWith('You read') && payload.text.includes(OLDER)
      ? { ok: true, json: { is_english: false, language: 'Spanish', language_code: 'es', english: 'My gate code is 4812, can you come Thursday?' } }
      : base(policy, payload)));
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'thread_translation_failed:figures_changed' });
    expect(mockDraft).not.toHaveBeenCalled();
  });

  test('a thread row whose translation changes the meaning holds the trial', async () => {
    const ctx = require('../services/context-aggregator');
    const OLDER = 'No vengan el jueves, por favor.';
    ctx.getContextForCustomer.mockResolvedValueOnce({ customer: { id: 'c1' }, smsHistory: [{ direction: 'inbound', body: OLDER, fromPhone: '+19415550100' }] });
    scriptModels({ inbound: SPANISH_INBOUND });
    const base = mockDispatch.getMockImplementation();
    mockDispatch.mockImplementation(async (policy, payload) => {
      if (payload.system.startsWith('You read') && payload.text.includes(OLDER)) return { ok: true, json: { is_english: false, language: 'Spanish', language_code: 'es', english: 'Please come Thursday.' } };
      if (payload.system.startsWith('ORIGINAL is a customer') && payload.text.includes(OLDER)) return { ok: true, json: { same_meaning: false, differences: ['drops "no"'] } };
      return base(policy, payload);
    });
    expect(await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' })).toMatchObject({ verdict: 'held', hold_reason: 'thread_translation_failed:meaning_changed' });
    expect(mockDraft).not.toHaveBeenCalled();
  });

  test('a draft that did not pass the English checks is held before any translation', async () => {
    scriptModels({ inbound: SPANISH_INBOUND });
    mockDraft.mockResolvedValue({ parsed: { reply: REPLY }, converged: false, passes: 3 });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'held', hold_reason: 'english_checks_not_passed' });
    expect(row).not.toHaveProperty('reply_translated');
    // the inbound translation and its meaning check only: nothing translated
    expect(mockDispatch.mock.calls.map(([, p]) => p.system.slice(0, 20))).toEqual(["You read text messag", "ORIGINAL is a custom"]);
  });

  test('a translation that changes a figure is held', async () => {
    scriptModels({ inbound: SPANISH_INBOUND, translated: REPLY_ES.replace('30', '20') });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'held', hold_reason: 'figures_changed_in_translation' });
  });

  test('a back-translation that says something different is held, with the differences kept', async () => {
    scriptModels({ inbound: SPANISH_INBOUND, meaning: { same_meaning: false, differences: ['BACK says the dogs can go out right away'] } });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'held', hold_reason: 'meaning_changed_in_translation' });
    expect(row.checks.meaning.differences).toEqual(['BACK says the dogs can go out right away']);
  });

  test('a model miss holds the trial; nothing throws', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'anthropic_timeout' });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'held', hold_reason: 'inbound_translation_failed:anthropic_timeout' });
  });

  test('an empty reply (nothing to answer) is stored as skipped', async () => {
    scriptModels({ inbound: SPANISH_INBOUND });
    mockDraft.mockResolvedValue({ parsed: { reply: '' }, converged: true, passes: 1 });
    const row = await runTranslationTrial({ inboundMessage: SPANISH, customer, smsLogId: 's1' });
    expect(row).toMatchObject({ verdict: 'skipped', hold_reason: 'no_reply_needed' });
  });
});
