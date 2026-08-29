import { describe, expect, it } from 'vitest';
import {
  SERIES_ACK_REQUIRED,
  SERIES_CHANGED,
  apiErrorMessage,
  isCollectivePreview,
  parseSeriesAckError,
  seriesAckPayload,
  seriesMoveSummary,
} from './seriesMove';

const PREVIEW = {
  enabled: true,
  collective: true,
  deltaDays: 3,
  movableCount: 4,
  occurrenceIds: ['b', 'a', 'c', 'd'],
  skippedCount: 0,
  exceptionCount: 0,
  conflictCount: 0,
  firstAffectedDate: '2026-09-04',
  lastAffectedDate: '2026-12-04',
};

describe('isCollectivePreview', () => {
  it('needs the gate on, a collective plan, and a non-empty occurrence set', () => {
    expect(isCollectivePreview(PREVIEW)).toBe(true);
    expect(isCollectivePreview({ ...PREVIEW, enabled: false })).toBe(false);
    expect(isCollectivePreview({ ...PREVIEW, collective: false })).toBe(false);
    expect(isCollectivePreview({ ...PREVIEW, occurrenceIds: [] })).toBe(false);
    expect(isCollectivePreview({ ...PREVIEW, occurrenceIds: undefined })).toBe(false);
    expect(isCollectivePreview(null)).toBe(false);
  });
});

describe('seriesAckPayload', () => {
  it('binds the ack to the previewed occurrence ids as strings', () => {
    expect(seriesAckPayload({ ...PREVIEW, occurrenceIds: [1, 2] })).toEqual({
      seriesAck: true,
      seriesAckIds: ['1', '2'],
    });
  });

  it('is empty when there is nothing to acknowledge (gate off / single visit)', () => {
    expect(seriesAckPayload({ ...PREVIEW, enabled: false })).toEqual({});
    expect(seriesAckPayload({ enabled: true, collective: false })).toEqual({});
    expect(seriesAckPayload(null)).toEqual({});
  });
});

describe('seriesMoveSummary', () => {
  it('names the later visits and the last affected date', () => {
    expect(seriesMoveSummary(PREVIEW)).toBe(
      'Moves this visit and 3 later visits in the recurring plan (through Dec 4, 2026).',
    );
  });

  it('uses the singular for one later visit and folds in the caveats', () => {
    expect(seriesMoveSummary({
      ...PREVIEW, movableCount: 2, skippedCount: 1, conflictCount: 2, lastAffectedDate: '2026-10-02',
    })).toBe(
      'Moves this visit and 1 later visit in the recurring plan (through Oct 2, 2026). '
      + '1 visit in progress or skipped stays put; 2 landing dates overlap another appointment.',
    );
  });

  it('says so when this is the last visit in the plan', () => {
    expect(seriesMoveSummary({ ...PREVIEW, movableCount: 1, occurrenceIds: ['a'] }))
      .toBe('Moves this visit — it is the last one in the recurring plan.');
  });

  it('is empty for a non-collective preview', () => {
    expect(seriesMoveSummary({ ...PREVIEW, enabled: false })).toBe('');
  });
});

describe('parseSeriesAckError', () => {
  const body = { error: 'Confirm the series move.', code: SERIES_ACK_REQUIRED, preview: PREVIEW };

  it('reads the raw JSON body the inline grid helpers throw as the message', () => {
    const parsed = parseSeriesAckError(new Error(JSON.stringify(body)));
    expect(parsed).toEqual({ code: SERIES_ACK_REQUIRED, message: body.error, preview: PREVIEW });
  });

  it('reads the structured shape (err.code + err.preview) SchedulePage attaches', () => {
    const err = Object.assign(new Error(body.error), { status: 409, code: SERIES_ACK_REQUIRED, preview: PREVIEW });
    expect(parseSeriesAckError(err)).toEqual({ code: SERIES_ACK_REQUIRED, message: body.error, preview: PREVIEW });
  });

  it('reads err.details from the shared admin-fetch helper', () => {
    const err = Object.assign(new Error(body.error), { status: 409, code: SERIES_ACK_REQUIRED, details: body });
    expect(parseSeriesAckError(err)?.preview).toEqual(PREVIEW);
  });

  it('recognises SERIES_CHANGED and ignores every other error', () => {
    expect(parseSeriesAckError(new Error(JSON.stringify({ error: 'x', code: SERIES_CHANGED })))?.code).toBe(SERIES_CHANGED);
    expect(parseSeriesAckError(new Error(JSON.stringify({ error: 'x', code: 'SLOT_TAKEN' })))).toBeNull();
    expect(parseSeriesAckError(new Error('HTTP 500'))).toBeNull();
    expect(parseSeriesAckError(new Error('{not json'))).toBeNull();
    expect(parseSeriesAckError(null)).toBeNull();
  });
});

describe('apiErrorMessage', () => {
  it('unwraps the server error sentence from a raw JSON message', () => {
    expect(apiErrorMessage(new Error(JSON.stringify({ error: 'Pick a future date.' })))).toBe('Pick a future date.');
  });

  it('falls back to the plain message, then the fallback', () => {
    expect(apiErrorMessage(new Error('HTTP 500'))).toBe('HTTP 500');
    expect(apiErrorMessage(new Error(''), 'Failed to save')).toBe('Failed to save');
    expect(apiErrorMessage(new Error('{"code":"X"}'), 'Failed')).toBe('{"code":"X"}');
  });
});
