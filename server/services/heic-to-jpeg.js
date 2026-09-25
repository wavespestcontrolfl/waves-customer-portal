'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const MAX_HEIC_BYTES = 5 * 1024 * 1024;
const MAX_CONCURRENT_CONVERSIONS = 2;
const WORKER_TIMEOUT_MS = 15_000;
const WORKER_PATH = path.join(__dirname, 'heic-to-jpeg-worker.js');

let activeConversions = 0;

function runWorker(buffer) {
  return new Promise((resolve, reject) => {
    // Transfer a private copy so the caller's Buffer is never detached.
    const input = Uint8Array.from(buffer);
    const worker = new Worker(WORKER_PATH, {
      workerData: input.buffer,
      transferList: [input.buffer],
    });
    let settled = false;

    const settle = (error, jpeg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      Promise.resolve(worker.terminate())
        .catch(() => {})
        .finally(() => {
          if (error) reject(error);
          else resolve(jpeg);
        });
    };

    const timeout = setTimeout(() => {
      settle(new Error('HEIC conversion timed out'));
    }, WORKER_TIMEOUT_MS);
    timeout.unref?.();

    worker.once('message', (message) => {
      if (!message?.ok || !message.jpeg) {
        settle(new Error(message?.error || 'HEIC conversion failed'));
        return;
      }
      settle(null, Buffer.from(message.jpeg));
    });
    // Keep the error listener installed through terminate(); a second worker
    // error during teardown must not become an unhandled process error.
    worker.on('error', (error) => settle(error));
    worker.once('exit', (code) => {
      if (code !== 0) settle(new Error(`HEIC conversion worker exited with code ${code}`));
      else settle(new Error('HEIC conversion worker exited without a result'));
    });
  });
}

async function convertHeicToJpeg(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('HEIC input must be a Buffer');
  if (buffer.length === 0) throw new Error('HEIC input is empty');
  if (buffer.length > MAX_HEIC_BYTES) throw new Error('HEIC input exceeds the size limit');
  if (activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
    throw new Error('HEIC conversion capacity is unavailable');
  }

  activeConversions += 1;
  try {
    return await runWorker(buffer);
  } finally {
    activeConversions -= 1;
  }
}

module.exports = { convertHeicToJpeg, MAX_HEIC_BYTES };
