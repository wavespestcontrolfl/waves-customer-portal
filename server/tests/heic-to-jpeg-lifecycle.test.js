const EventEmitter = require('events');

const mockWorkers = [];
const mockWorker = jest.fn(() => {
  const worker = new EventEmitter();
  worker.terminate = jest.fn(async () => 1);
  mockWorkers.push(worker);
  return worker;
});

jest.mock('worker_threads', () => ({
  ...jest.requireActual('worker_threads'),
  Worker: mockWorker,
}));

const { convertHeicToJpeg } = require('../services/heic-to-jpeg');

describe('HEIC worker timeout lifecycle', () => {
  beforeEach(() => {
    mockWorkers.length = 0;
    mockWorker.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  test('terminates timed-out workers and releases both conversion slots', async () => {
    const first = convertHeicToJpeg(Buffer.from('one'));
    const second = convertHeicToJpeg(Buffer.from('two'));
    const firstRejection = expect(first).rejects.toThrow(/timed out/i);
    const secondRejection = expect(second).rejects.toThrow(/timed out/i);
    await expect(convertHeicToJpeg(Buffer.from('three'))).rejects.toThrow(/capacity/i);

    await jest.advanceTimersByTimeAsync(15_000);
    await Promise.all([firstRejection, secondRejection]);
    expect(mockWorkers).toHaveLength(2);
    expect(mockWorkers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);

    const afterTimeout = convertHeicToJpeg(Buffer.from('after'));
    const afterRejection = expect(afterTimeout).rejects.toThrow(/timed out/i);
    await jest.advanceTimersByTimeAsync(15_000);
    await afterRejection;
    expect(mockWorker).toHaveBeenCalledTimes(3);
    expect(mockWorkers[2].terminate).toHaveBeenCalledTimes(1);
  });
});
