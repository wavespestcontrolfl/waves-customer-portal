/**
 * websiteLineRefusal (services/website-line-contact.js): a staff text from a
 * website-only line goes only to someone who already called or texted that
 * line. The fake database answers the helper's two reads (sms_log, call_log)
 * by the rule its SQL states: an inbound row whose sender ends in the
 * person's last 10 digits (the indexed prefilter) and has the person's E.164
 * identity, to the line's E.164 identity. A stored value with a leading + keeps
 * its country code; a bare 10-digit or 1+10-digit value is a US number. The SQL
 * itself runs on Postgres in website-line-contact-postgres.test.js.
 */
const { websiteLineRefusal, WEBSITE_LINE_REFUSAL } = require('../services/website-line-contact');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { websiteOnlyLines } = require('../config/shared-phone-lines');

const WEB_LINE = '+19412542617';
const SPOKE_LINE = websiteOnlyLines(TWILIO_NUMBERS).find((line) => line.number !== WEB_LINE).number;
const PERSON = '+19415550123';
const digitsOf = (value) => String(value || '').replace(/[^0-9]/g, '');
// A stored value's E.164 identity, by the rule of the helper's SQL (storedE164Sql).
function storedE164(value) {
  const text = String(value ?? '').trim();
  const digits = digitsOf(text);
  if (text.startsWith('+')) return `+${digits}`;
  if (/^1[0-9]{10}$/.test(digits)) return `+${digits}`;
  return /^[0-9]{10}$/.test(digits) ? `+1${digits}` : null;
}

function fakeDatabase(rows = {}) {
  const reads = [];
  const database = jest.fn((table) => {
    const read = { table, where: [], raw: [], not: [] };
    reads.push(read);
    const forColumn = (column) => read.raw.find(([sql]) => sql.includes(`coalesce(${column},`))[1];
    const builder = {
      where(column, value) { read.where.push([column, value]); return builder; },
      whereRaw(sql, bindings) {
        if (sql === "COALESCE(??, '') <> ?") read.not.push(bindings);
        else read.raw.push([sql, bindings[0]]);
        return builder;
      },
      async first() {
        read.last10 = read.raw.find(([sql]) => sql.startsWith('right(regexp_replace(from_phone,'))[1];
        return (rows[table] || []).find((row) => read.where.every(([column, value]) => row[column] === value)
          && read.not.every(([column, value]) => (row[column] ?? '') !== value)
          && digitsOf(row.from_phone).slice(-10) === read.last10
          && forColumn('from_phone') === storedE164(row.from_phone)
          && forColumn('to_phone') === storedE164(row.to_phone));
      },
    };
    return builder;
  });
  database.reads = reads;
  return database;
}

const inbound = (from_phone, to_phone) => ({ id: 1, direction: 'inbound', from_phone, to_phone });

test('a line that is not website-only needs no read: the main line, the office lines, no line', async () => {
  const database = fakeDatabase();
  for (const from of [TWILIO_NUMBERS.mainLine.number, ...Object.values(TWILIO_NUMBERS.locations).map((line) => line.number), undefined, '']) {
    expect(await websiteLineRefusal(from, PERSON, { database })).toBeNull();
  }
  expect(database).not.toHaveBeenCalled();
});

test('a website-only line to someone who never called or texted it is refused, after reading both logs', async () => {
  for (const line of [WEB_LINE, SPOKE_LINE]) {
    const database = fakeDatabase();
    expect(await websiteLineRefusal(line, PERSON, { database })).toBe(WEBSITE_LINE_REFUSAL);
    expect(database.reads.map((read) => read.table).sort()).toEqual(['call_log', 'sms_log']);
    for (const read of database.reads) {
      expect(read.where).toEqual([['direction', 'inbound']]);
      expect(read.last10).toBe('9415550123');
    }
  }
});

test('an inbound text or call from the person to that line lets the reply go, in any stored format', async () => {
  expect(await websiteLineRefusal(WEB_LINE, PERSON, { database: fakeDatabase({ sms_log: [inbound(PERSON, WEB_LINE)] }) })).toBeNull();
  expect(await websiteLineRefusal(WEB_LINE, PERSON, { database: fakeDatabase({ call_log: [inbound('(941) 555-0123', '9412542617')] }) })).toBeNull();
  expect(await websiteLineRefusal('(941) 254-2617', '941-555-0123', { database: fakeDatabase({ sms_log: [inbound(PERSON, WEB_LINE)] }) })).toBeNull();
});

test('contact on another line, an outbound row, or a foreign number with the same last 10 digits does not count', async () => {
  const database = fakeDatabase({
    sms_log: [
      inbound(PERSON, SPOKE_LINE),
      { id: 2, direction: 'outbound', from_phone: WEB_LINE, to_phone: PERSON },
      inbound('+449415550123', WEB_LINE),
    ],
    call_log: [{ id: 3, direction: 'outbound', from_phone: PERSON, to_phone: WEB_LINE }],
  });
  expect(await websiteLineRefusal(WEB_LINE, PERSON, { database })).toBe(WEBSITE_LINE_REFUSAL);
});

test('a 10-digit international number and the US number with the same 10 digits are two people', async () => {
  const usTexted = fakeDatabase({ sms_log: [inbound('9415550123', WEB_LINE)] });
  expect(await websiteLineRefusal(WEB_LINE, '+9415550123', { database: usTexted })).toBe(WEBSITE_LINE_REFUSAL);
  expect(await websiteLineRefusal(WEB_LINE, PERSON, { database: usTexted })).toBeNull();
  const internationalCalled = fakeDatabase({ call_log: [inbound('+9415550123', WEB_LINE)] });
  expect(await websiteLineRefusal(WEB_LINE, '9415550123', { database: internationalCalled })).toBe(WEBSITE_LINE_REFUSAL);
  expect(await websiteLineRefusal(WEB_LINE, '+9415550123', { database: internationalCalled })).toBeNull();
});

test('a short international number (9 digits) that texted the line gets its reply: the indexed suffix has no +', async () => {
  const SHORT = '+353876543';
  const database = fakeDatabase({ sms_log: [inbound(SHORT, WEB_LINE)] });
  expect(await websiteLineRefusal(WEB_LINE, SHORT, { database })).toBeNull();
  expect(database.reads.map((read) => read.last10)).toEqual(['353876543', '353876543']);
});

test('a Sandy sandbox call or a tech-voice call is internal and does not count', async () => {
  const { VOICE_RELAY_SANDBOX_SOURCE, TECH_VOICE_SOURCE } = require('../services/voice-agent/relay-protocol');
  for (const source of [VOICE_RELAY_SANDBOX_SOURCE, TECH_VOICE_SOURCE]) {
    const database = fakeDatabase({ call_log: [{ ...inbound(PERSON, WEB_LINE), source }] });
    expect(await websiteLineRefusal(WEB_LINE, PERSON, { database })).toBe(WEBSITE_LINE_REFUSAL);
  }
  const callRead = fakeDatabase({ call_log: [{ ...inbound(PERSON, WEB_LINE), source: 'twilio' }] });
  expect(await websiteLineRefusal(WEB_LINE, PERSON, { database: callRead })).toBeNull();
  expect(callRead.reads.find((read) => read.table === 'call_log').not.map(([column]) => column)).toEqual(['source', 'source']);
  expect(callRead.reads.find((read) => read.table === 'sms_log').not).toEqual([]);
});

test('a recipient with no phone digits is refused without a read', async () => {
  const database = fakeDatabase();
  expect(await websiteLineRefusal(WEB_LINE, '', { database })).toBe(WEBSITE_LINE_REFUSAL);
  expect(database).not.toHaveBeenCalled();
});

test('a failed read throws, so the route answers an error and sends nothing', async () => {
  const database = jest.fn(() => { throw new Error('read failed'); });
  await expect(websiteLineRefusal(WEB_LINE, PERSON, { database })).rejects.toThrow('read failed');
});
