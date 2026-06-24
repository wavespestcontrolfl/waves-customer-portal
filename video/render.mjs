// Programmatic renderer for the per-visit recap. The server's render pipeline
// (P1b) imports renderRecap() and feeds it { data, media }; output is an MP4 path
// it then uploads to S3. Also runnable as a CLI for samples/CI:
//   node render.mjs <payload.json> <out.mp4>
// where payload.json = { customerName, serviceDate, pestReportV2, media? }.
import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, ensureBrowser } from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundle once and reuse (the webpack bundle is the slow part; in a long-lived
// render worker this is built at startup, not per video).
let cachedServeUrl = null;
async function getServeUrl() {
  if (!cachedServeUrl) {
    cachedServeUrl = await bundle({ entryPoint: path.join(__dirname, 'src', 'index.jsx') });
  }
  return cachedServeUrl;
}

export async function renderRecap({ data, media = [], outPath, onProgress }) {
  if (!data?.pestReportV2) throw new Error('renderRecap: data.pestReportV2 is required');
  await ensureBrowser();
  const serveUrl = await getServeUrl();
  // Music plays only when a licensed track has been dropped at video/public/music.mp3
  // (owner-supplied); otherwise the recap renders silent.
  const music = fs.existsSync(path.join(__dirname, 'public', 'music.mp3'));
  const inputProps = { data, media, music };
  const composition = await selectComposition({ serveUrl, id: 'VisitRecap', inputProps });
  await renderMedia({
    serveUrl,
    composition,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    concurrency: 4,
    onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
  });
  return outPath;
}

// CLI entry
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [payloadPath, outPath = path.join(__dirname, 'out', 'visit-recap.mp4')] = process.argv.slice(2);
  if (!payloadPath) {
    console.error('usage: node render.mjs <payload.json> [out.mp4]');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const data = { customerName: raw.customerName || 'there', serviceDate: raw.serviceDate || '', pestReportV2: raw.pestReportV2 };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const t0 = Date.now();
  renderRecap({ data, media: raw.media || [], outPath })
    .then(() => console.log(`Rendered ${outPath} in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
    .catch((err) => { console.error(err); process.exit(1); });
}
