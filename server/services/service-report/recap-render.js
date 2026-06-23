// Runs the Remotion render as an ISOLATED child process (`node video/render.mjs`)
// so the heavy Remotion + headless-Chrome deps never load into the API server.
// In prod this is the render worker (Railway service / Lambda); here it shells out
// to the in-repo video/ workspace. Writes the payload to a temp file, renders to a
// temp MP4, returns its path (caller uploads to S3 then cleans up).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO_DIR = path.join(__dirname, '..', '..', '..', 'video');
const RENDER_SCRIPT = path.join(VIDEO_DIR, 'render.mjs');
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

async function renderRecapToFile(payload, { timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  if (!fs.existsSync(RENDER_SCRIPT)) throw new Error(`recap renderer missing at ${RENDER_SCRIPT} (video/ workspace not installed)`);
  const id = crypto.randomBytes(8).toString('hex');
  const payloadFile = path.join(os.tmpdir(), `recap-${id}.json`);
  const outFile = path.join(os.tmpdir(), `recap-${id}.mp4`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RENDER_SCRIPT, payloadFile, outFile], {
        cwd: VIDEO_DIR,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`recap render timed out after ${timeoutMs}ms`)); }, timeoutMs);
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outFile)) resolve();
        else reject(new Error(`recap render exited ${code}: ${stderr.slice(-500)}`));
      });
    });
    return outFile;
  } catch (err) {
    cleanupRecapFile(outFile);
    throw err;
  } finally {
    cleanupRecapFile(payloadFile);
  }
}

function cleanupRecapFile(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
}

module.exports = { renderRecapToFile, cleanupRecapFile, VIDEO_DIR, RENDER_SCRIPT };
