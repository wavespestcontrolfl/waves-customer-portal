/**
 * Unit tests for the Veo video generator. Mocked fetch — no API calls.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const VideoGenerator = require('../services/content/video-generator');
const { VIDEO_CHAIN, extractVideo, isModelUnavailable } = VideoGenerator._internals;

function ok(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(Uint8Array.from([1, 2, 3, 4]).buffer),
  });
}
function err(status, body = '') {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}), text: () => Promise.resolve(body) });
}

const OP_STARTED = { name: 'operations/veo-op-123' };
const OP_DONE = {
  done: true,
  response: {
    generateVideoResponse: {
      generatedSamples: [{ video: { uri: 'https://files.test/video-abc' } }],
    },
  },
};

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => { process.env.GEMINI_API_KEY = 'test-key'; });
afterEach(() => {
  jest.clearAllMocks();
  if (ORIGINAL_ENV.GEMINI_API_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_ENV.GEMINI_API_KEY;
});

describe('internals', () => {
  test('chain is fast-first', () => {
    expect(VIDEO_CHAIN).toHaveLength(2);
    expect(VIDEO_CHAIN[0]).toMatch(/fast/);
  });

  test('extractVideo accepts both response spellings and inline bytes', () => {
    expect(extractVideo(OP_DONE)).toEqual({ uri: 'https://files.test/video-abc' });
    expect(extractVideo({
      response: { generateVideoResponse: { generatedVideos: [{ video: { uri: 'u2' } }] } },
    })).toEqual({ uri: 'u2' });
    expect(extractVideo({
      response: { generateVideoResponse: { generatedSamples: [{ video: { bytesBase64Encoded: 'QUJD' } }] } },
    })).toEqual({ base64: 'QUJD' });
    expect(extractVideo({ response: {} })).toBeNull();
  });

  test('isModelUnavailable: 404 and model-flavored 400s only', () => {
    expect(isModelUnavailable(404)).toBe(true);
    expect(isModelUnavailable(400, 'model not found')).toBe(true);
    expect(isModelUnavailable(400, 'invalid parameter foo')).toBe(false);
    expect(isModelUnavailable(429, 'quota')).toBe(false);
    expect(isModelUnavailable(500)).toBe(false);
  });
});

describe('generate', () => {
  test('start → poll → download happy path with 9:16 and API key header', async () => {
    const calls = [];
    const fetchFn = jest.fn().mockImplementation((url, opts = {}) => {
      calls.push({ url, opts });
      if (url.includes(':predictLongRunning')) return ok(OP_STARTED);
      if (url.includes('operations/')) return ok(OP_DONE);
      return ok({}); // download
    });

    const result = await VideoGenerator.generate({
      prompt: 'a lanai at dusk',
      aspectRatio: '9:16',
      pollIntervalMs: 1,
      fetchFn,
    });

    expect(result.mimeType).toBe('video/mp4');
    expect(result.model).toBe(VIDEO_CHAIN[0]);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBe(4);

    const start = calls.find((c) => c.url.includes(':predictLongRunning'));
    expect(start.url).toContain(VIDEO_CHAIN[0]);
    expect(start.opts.headers['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(start.opts.body);
    expect(body.parameters.aspectRatio).toBe('9:16');
    expect(body.instances[0].prompt).toContain('lanai');

    const download = calls.find((c) => c.url === 'https://files.test/video-abc');
    expect(download.opts.headers['x-goog-api-key']).toBe('test-key');
  });

  test('retired fast model (404) falls through to the quality model', async () => {
    const startedModels = [];
    const fetchFn = jest.fn().mockImplementation((url) => {
      if (url.includes(':predictLongRunning')) {
        const model = url.match(/models\/([^:]+):/)[1];
        startedModels.push(model);
        return model === VIDEO_CHAIN[0] ? err(404, 'model not found') : ok(OP_STARTED);
      }
      if (url.includes('operations/')) return ok(OP_DONE);
      return ok({});
    });

    const result = await VideoGenerator.generate({ prompt: 'x', pollIntervalMs: 1, fetchFn });
    expect(startedModels).toEqual([VIDEO_CHAIN[0], VIDEO_CHAIN[1]]);
    expect(result.model).toBe(VIDEO_CHAIN[1]);
  });

  test('a non-model start error (quota) does NOT retry the second model', async () => {
    const startedModels = [];
    const fetchFn = jest.fn().mockImplementation((url) => {
      if (url.includes(':predictLongRunning')) {
        startedModels.push(url.match(/models\/([^:]+):/)[1]);
        return err(429, 'quota exceeded');
      }
      return ok({});
    });

    await expect(VideoGenerator.generate({ prompt: 'x', pollIntervalMs: 1, fetchFn }))
      .rejects.toThrow(/all attempts failed/);
    expect(startedModels).toEqual([VIDEO_CHAIN[0]]);
  });

  test('a failed operation does NOT double cost on the second model', async () => {
    const startedModels = [];
    const fetchFn = jest.fn().mockImplementation((url) => {
      if (url.includes(':predictLongRunning')) {
        startedModels.push(url.match(/models\/([^:]+):/)[1]);
        return ok(OP_STARTED);
      }
      if (url.includes('operations/')) return ok({ done: true, error: { message: 'safety block' } });
      return ok({});
    });

    await expect(VideoGenerator.generate({ prompt: 'x', pollIntervalMs: 1, fetchFn }))
      .rejects.toThrow(/safety block/);
    expect(startedModels).toEqual([VIDEO_CHAIN[0]]);
  });

  test('times out against the budget instead of polling forever', async () => {
    const fetchFn = jest.fn().mockImplementation((url) => {
      if (url.includes(':predictLongRunning')) return ok(OP_STARTED);
      return ok({ done: false }); // never finishes
    });

    await expect(VideoGenerator.generate({ prompt: 'x', timeoutMs: 25, pollIntervalMs: 1, fetchFn }))
      .rejects.toThrow(/timed out/);
  });

  test('requires GEMINI_API_KEY and a prompt', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(VideoGenerator.generate({ prompt: 'x' })).rejects.toThrow(/GEMINI_API_KEY/);
    process.env.GEMINI_API_KEY = 'k';
    await expect(VideoGenerator.generate({})).rejects.toThrow(/prompt/);
  });
});
