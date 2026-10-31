/**
 * The Gemini API key travels in the x-goog-api-key header, never in the URL.
 * A URL lands in logs, traces and error messages, and the log scrubbers are a
 * net, not the only line (10-24 and 10-26 a stolen Gemini key ran up $188).
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
// A Gemini host URL, or a Gemini method path, followed by a key query parameter.
const KEYED = [
  /generativelanguage\.googleapis\.com[^`'"\s]*[?&]key=/,
  /:(?:streamGenerateContent|generateContent|countTokens|embedContent|batchEmbedContents)[^`'"\s]*[?&]key=/,
];

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(?:c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = sourceFiles(SERVER).map((file) => ({ rel: path.relative(SERVER, file), text: fs.readFileSync(file, 'utf8') }));

test('no server code puts the Gemini key in a URL', () => {
  const offenders = [];
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (KEYED.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});

test('every file that calls a Gemini model endpoint sends the x-goog-api-key header', () => {
  const callers = files.filter(({ text }) => text.includes('generativelanguage.googleapis.com/v1beta/models'));
  expect(callers.length).toBeGreaterThan(5); // the walk found the callers
  expect(callers.filter(({ text }) => !text.includes('x-goog-api-key')).map(({ rel }) => rel)).toEqual([]);
});
