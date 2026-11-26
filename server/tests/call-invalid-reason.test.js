/**
 * call_log.invalid_reason: the one resolver for the four places spam and wrong-number signals sit today
 * (v2 call_nature, legacy is_spam / call_type, the layered classifier's verdict and disposition,
 * lead_quality spam). Gap in existing proof: nothing reconciled them, so per-source bad-call counts
 * would have disagreed depending on which field a report read.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  INVALID_REASONS, resolveInvalidReason, resolveInvalidReasonFromRow, stampInvalidReason,
} = require('../services/call-invalid-reason');

describe('resolveInvalidReason precedence', () => {
  test('returns null when no signal says the call is bad', () => {
    expect(resolveInvalidReason()).toBeNull();
    expect(resolveInvalidReason({ legacy: { is_spam: false, call_type: 'new_inquiry' }, v2: { call_nature: 'new_lead', triage_flags: [] } })).toBeNull();
  });

  test.each([
    ['classifier verdict spam', { spamVerdict: { verdict: 'spam' } }, 'spam'],
    ['disposition spam_discarded', { disposition: 'spam_discarded' }, 'spam'],
    ['v2 robocall', { v2: { call_nature: 'robocall' } }, 'spam'],
    ['legacy is_spam', { legacy: { is_spam: true } }, 'spam'],
    ['legacy call_type spam', { legacy: { call_type: 'spam' } }, 'spam'],
    ['lead_quality spam on the row', { leadQuality: 'spam' }, 'spam'],
    ['processing_status spam', { processingStatus: 'spam' }, 'spam'],
    ['v2 wrong_number', { v2: { call_nature: 'wrong_number' } }, 'wrong_number'],
    ['legacy call_type wrong_number', { legacy: { call_type: 'wrong_number' } }, 'wrong_number'],
    ['disposition wrong_number_closed', { disposition: 'wrong_number_closed' }, 'wrong_number'],
    ['v2 spam_solicitation', { v2: { call_nature: 'spam_solicitation' } }, 'solicitor'],
    ['triage flag out_of_service_area', { v2: { triage_flags: ['out_of_service_area'] } }, 'out_of_area'],
    ['extra triage flag out_of_service_area', { triageFlags: ['out_of_service_area'] }, 'out_of_area'],
    ['address status out_of_service_area', { addressStatus: 'out_of_service_area' }, 'out_of_area'],
    ['triage flag service_not_offered', { triageFlags: ['service_not_offered'] }, 'service_not_offered'],
    ['v2 silent_or_noise', { v2: { call_nature: 'silent_or_noise' } }, 'silent'],
    ['processor out-of-area hold', { outOfAreaHold: true }, 'out_of_area'],
    ['validated v2 result', { v2Result: { status: 'valid', extraction: { call_nature: 'wrong_number' } } }, 'wrong_number'],
  ])('%s -> %s', (_name, signals, expected) => {
    expect(resolveInvalidReason(signals)).toBe(expected);
  });

  test('every value it can return is one the migration CHECK allows', () => {
    const all = [
      { spamVerdict: { verdict: 'spam' } }, { v2: { call_nature: 'wrong_number' } }, { v2: { call_nature: 'spam_solicitation' } },
      { triageFlags: ['out_of_service_area'] }, { triageFlags: ['service_not_offered'] }, { v2: { call_nature: 'silent_or_noise' } },
    ].map(resolveInvalidReason);
    expect(all.every((r) => INVALID_REASONS.includes(r))).toBe(true);
    expect(new Set(all).size).toBe(6);
  });

  test('precedence: spam beats wrong_number, wrong_number beats solicitor, solicitor beats out_of_area, out_of_area beats silent', () => {
    expect(resolveInvalidReason({ spamVerdict: { verdict: 'spam' }, v2: { call_nature: 'wrong_number' } })).toBe('spam');
    expect(resolveInvalidReason({ legacy: { is_spam: true }, v2: { call_nature: 'wrong_number' } })).toBe('wrong_number');
    expect(resolveInvalidReason({ v2: { call_nature: 'spam_solicitation' }, legacy: { is_spam: true, call_type: 'spam' } })).toBe('solicitor');
    expect(resolveInvalidReason({ v2: { call_nature: 'spam_solicitation', triage_flags: ['out_of_service_area'] } })).toBe('solicitor');
    expect(resolveInvalidReason({ v2: { call_nature: 'silent_or_noise', triage_flags: ['out_of_service_area'] } })).toBe('out_of_area');
  });

  test('a v2 result that did not validate is ignored', () => {
    expect(resolveInvalidReason({ v2Result: { status: 'schema_failed', extraction: { call_nature: 'wrong_number' } } })).toBeNull();
  });

  test('a vendor_or_partner call is not spam on the folded legacy call_type alone', () => {
    expect(resolveInvalidReason({ legacy: { call_type: 'spam' }, v2: { call_nature: 'vendor_or_partner' } })).toBeNull();
    expect(resolveInvalidReason({ legacy: { call_type: 'spam', is_spam: true }, v2: { call_nature: 'vendor_or_partner' } })).toBe('spam');
  });
});

describe('resolveInvalidReasonFromRow (read time, rows older than the column)', () => {
  test('a stored invalid_reason wins', () => {
    expect(resolveInvalidReasonFromRow({ invalid_reason: 'silent', ai_extraction: { is_spam: true } })).toBe('silent');
  });
  test('derives from ai_extraction given as an object or a JSON string, and from the other row columns', () => {
    expect(resolveInvalidReasonFromRow({ ai_extraction: { is_spam: true } })).toBe('spam');
    expect(resolveInvalidReasonFromRow({ ai_extraction: JSON.stringify({ call_type: 'wrong_number' }) })).toBe('wrong_number');
    expect(resolveInvalidReasonFromRow({ ai_extraction: 'not json', disposition: 'spam_discarded' })).toBe('spam');
    expect(resolveInvalidReasonFromRow({ enrichment_status: 'out_of_service_area' })).toBe('out_of_area');
    expect(resolveInvalidReasonFromRow({ ai_extraction: null })).toBeNull();
    expect(resolveInvalidReasonFromRow(null)).toBeNull();
  });
  test('reads a validated v2 extraction from ai_extraction_enriched, and ignores an unvalidated one', () => {
    const silent = JSON.stringify({ call_nature: 'silent_or_noise' });
    expect(resolveInvalidReasonFromRow({ v2_extraction_status: 'valid', ai_extraction_enriched: silent })).toBe('silent');
    expect(resolveInvalidReasonFromRow({ v2_extraction_status: 'valid', ai_extraction: { call_type: 'spam' },
      ai_extraction_enriched: { call_nature: 'spam_solicitation' } })).toBe('solicitor');
    expect(resolveInvalidReasonFromRow({ v2_extraction_status: 'schema_failed', ai_extraction_enriched: silent })).toBeNull();
  });
});

describe('stampInvalidReason', () => {
  function fakeDb(update) {
    const where = jest.fn(() => ({ update }));
    const database = jest.fn(() => ({ where }));
    return { database, where };
  }

  test('writes the resolved reason on the call row', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const { database, where } = fakeDb(update);
    await expect(stampInvalidReason(database, 'call-1', { legacy: { is_spam: true } })).resolves.toBe('spam');
    expect(database).toHaveBeenCalledWith('call_log');
    expect(where).toHaveBeenCalledWith({ id: 'call-1' });
    expect(update).toHaveBeenCalledWith({ invalid_reason: 'spam' });
  });

  test('a reprocess that finds a real lead clears the stored reason (writes null)', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const { database } = fakeDb(update);
    await expect(stampInvalidReason(database, 'call-1', { legacy: { is_spam: false } })).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith({ invalid_reason: null });
  });

  test('fails soft: a database error is logged, never thrown', async () => {
    const { database } = fakeDb(jest.fn().mockRejectedValue(new Error('connection reset')));
    await expect(stampInvalidReason(database, 'call-1', { legacy: { is_spam: true } })).resolves.toBeNull();
    expect(require('../services/logger').warn).toHaveBeenCalled();
  });
});
