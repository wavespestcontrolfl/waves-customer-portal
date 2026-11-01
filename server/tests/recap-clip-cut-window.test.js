// The 5-second window rules of the glasses clip cut (recap-clip-cut.js): what counts as a valid AI answer,
// and the middle window used when no provider gives one.
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/recap-transcode', () => ({}));
jest.mock('../services/service-report/recap-media', () => ({ roleInfo: () => ({ caption: 'On-site at your home' }) }));
jest.mock('../services/service-report/recap-pipeline', () => ({}));

const { middleWindowStart, parseWindowStart } = require('../services/service-report/recap-clip-cut');

describe('middleWindowStart', () => {
  test.each([[40, 17], [60, 27], [21, 8], [20.9, 7], [6, 0], [5, 0], [3, 0]])('a %s s clip starts at %i', (seconds, start) => {
    expect(middleWindowStart(seconds)).toBe(start);
  });
});

describe('parseWindowStart', () => {
  test.each([
    ['{"start_second": 0}', 40, 0],
    ['{"start_second": 35}', 40, 35],
    ['Here you go: {"start_second": 12}', 40, 12],
    ['```json\n{"start_second": 7}\n```', 40, 7],
    ['{"start_second": 36}', 40, null],
    ['{"start_second": -1}', 40, null],
    ['{"start_second": 2.5}', 40, null],
    ['{"start_second": "3"}', 40, null],
    ['{"start_second": 1}', 5, null],
    ['{"start_second": 0}', 5, 0],
    ['{"start_second": 15}', 20.9, 15],
    ['{"start_second": 16}', 20.9, null],
    ['{"other": 3}', 40, null],
    ['not json', 40, null],
    ['{broken', 40, null],
    ['', 40, null],
    [undefined, 40, null],
  ])('%j on a %s s clip -> %j', (text, seconds, expected) => {
    expect(parseWindowStart(text, seconds)).toBe(expected);
  });
});
