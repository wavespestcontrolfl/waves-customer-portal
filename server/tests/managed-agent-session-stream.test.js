const { ReadableStream } = require('node:stream/web');
const { readSessionFrames } = require('../services/agent-control/session-stream');

function bodyFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function frames(body) {
  const result = [];
  for await (const frame of readSessionFrames(body)) result.push(frame);
  expect(body.locked).toBe(false);
  return result;
}

test.each(['\n', '\r\n', '\r'])('every byte split preserves frames with %j line endings', async (newline) => {
  const data = JSON.stringify({ name: 'get_lead_details', input: { note: 'QA café 🌊' } });
  const source = Buffer.from(`event: tool_use${newline}data: ${data}${newline}${newline}event: session.end_turn${newline}data: {}${newline}${newline}`);
  const expected = [{ event: 'tool_use', data }, { event: 'session.end_turn', data: '{}' }];
  for (let split = 1; split < source.length; split++) {
    expect(await frames(bodyFrom([source.subarray(0, split), source.subarray(split)]))).toEqual(expected);
  }
  expect(await frames(bodyFrom([...source].map((byte) => Uint8Array.of(byte))))).toEqual(expected);
});

test('joins multiline data, ignores comments, and resets the default event per frame', async () => {
  const source = ': keepalive\n\nevent: tool_use\ndata:{\ndata: "name": "get_lead_details"\ndata:}\n\ndata: {}\n\n';
  const result = await frames(bodyFrom([Buffer.from(source)]));
  expect(result).toEqual([
    { event: 'tool_use', data: '{\n"name": "get_lead_details"\n}' },
    { event: 'message', data: '{}' },
  ]);
  expect(JSON.parse(result[0].data)).toEqual({ name: 'get_lead_details' });
});

test('leaves malformed data interpretation to callers and discards an incomplete final frame', async () => {
  expect(await frames(bodyFrom([Buffer.from('event: error\ndata: unavailable\n\nevent: tool_use\ndata: {')]))).toEqual([
    { event: 'error', data: 'unavailable' },
  ]);
});

test('stopping at a terminal event cancels and unlocks the stream', async () => {
  const cancel = jest.fn();
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('event: session.end_turn\ndata: {}\n\n')); },
    cancel,
  });
  for await (const frame of readSessionFrames(body)) {
    expect(frame.event).toBe('session.end_turn');
    break;
  }
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});

test('a transport failure propagates and releases its reader', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error('QA disconnect')); } });
  await expect(frames(body)).rejects.toThrow('QA disconnect');
  expect(body.locked).toBe(false);
});
