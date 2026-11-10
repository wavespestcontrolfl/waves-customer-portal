/**
 * A client that hangs up in the middle of an upload is not a server fault.
 * multer 2 reports it to the route as Error('Request aborted' | 'Request closed')
 * (multer 1 never called back), so `uploadHangUp` (middleware/errors.js) stops
 * that one error before the Sentry handler and the 500 handler. Every other
 * error still reaches them. The second block uses the real multer and a real
 * socket that is cut mid-body.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

const http = require('http');
const express = require('express');
const multer = require('multer');
const { uploadHangUp } = require('../middleware/errors');

const fakeRes = (over = {}) => {
  const res = { headersSent: false, destroyed: false, statusCode: null, ended: false, ...over };
  res.status = (code) => { res.statusCode = code; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
};
const fakeReq = (over = {}) => ({ method: 'POST', originalUrl: '/api/admin/job-expenses/receipt-upload', destroyed: true, ...over });

describe('uploadHangUp', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each(['Request aborted', 'Request closed'])('stops "%s" when the request is gone: one info line, no error passed on', (message) => {
    const next = jest.fn();
    const res = fakeRes({ destroyed: true });
    uploadHangUp(new Error(message), fakeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(res.ended).toBe(false); // nothing to answer: the socket is closed
  });

  test('answers 400 with no body when the response can still be written', () => {
    const next = jest.fn();
    const res = fakeRes();
    uploadHangUp(new Error('Request aborted'), fakeReq({ destroyed: false, aborted: true }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.ended).toBe(true);
  });

  test('passes every other error on untouched', () => {
    const cases = [
      [new Error('Request aborted'), fakeReq({ destroyed: false, aborted: false })], // same words, client still connected
      [Object.assign(new Error('Request aborted'), { code: 'LIMIT_FILE_SIZE' }), fakeReq()], // a coded error is never a hang-up
      [new Error('relation "x" does not exist'), fakeReq()],
      [new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'photo'), fakeReq()],
    ];
    for (const [err, req] of cases) {
      const next = jest.fn();
      uploadHangUp(err, req, fakeRes(), next);
      expect(next).toHaveBeenCalledWith(err);
    }
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});

describe('a real upload cut by the client (real multer, real socket)', () => {
  test('multer reports the hang-up, and it never reaches the error handlers behind uploadHangUp', async () => {
    const reachedRoute = jest.fn();
    const laterHandlers = jest.fn();
    let seenByGuard = null;
    const app = express();
    app.post('/upload', multer({ storage: multer.memoryStorage() }).single('photo'), (req, res) => { reachedRoute(); res.json({ ok: true }); });
    app.use((err, req, res, next) => { seenByGuard = err; next(err); });
    app.use(uploadHangUp);
    app.use((err, req, res, next) => { laterHandlers(err); next(); }); // four arguments: Express reads this as an error handler
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    try {
      const boundary = 'hangupboundary';
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
      const client = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/upload', method: 'POST',
        // Promise far more bytes than are sent, so the server is still reading when the socket is cut.
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(head.length + 1024 * 1024) },
      });
      client.on('error', () => {});
      client.write(head);
      client.write(Buffer.alloc(16 * 1024, 1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      client.destroy();
      for (let i = 0; i < 100 && !seenByGuard; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seenByGuard).toBeInstanceOf(Error);
      expect(['Request aborted', 'Request closed']).toContain(seenByGuard.message);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(laterHandlers).not.toHaveBeenCalled();
      expect(reachedRoute).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('client hung up during an upload'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
