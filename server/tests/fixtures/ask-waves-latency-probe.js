// Times the Ask Waves chokepoint in a fresh Node process for the #4905
// latency guard in ask-waves-intake.test.js. Inside a long-lived jest worker,
// process CPU also carries garbage-collection and background-compile work for
// every test file that ran before, so the same input measured ~1 ms here and
// 54–62 ms there. Reads [{ reply, ctx, msg, topic? }] as JSON on stdin and prints
// `LATENCY <json>`: the best of three CPU times in ms for each input.
const fs = require('fs');
const { _internals: m } = require('../../services/ask-waves-intake');

const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const runChokepoint = (reply, ctx, msg, topic) => {
  m.normalizeIntakeResult({ reply, intent: 'question', service_keys: [], ready_for_quote: true, topic }, 'openai', ctx, msg);
  m.looksLikeEmergency(ctx);
};
const cpuMs = (fn) => {
  const started = process.cpuUsage();
  fn();
  const elapsed = process.cpuUsage(started);
  return (elapsed.user + elapsed.system) / 1000;
};

// Compile and exercise the full no-match path at the real input caps first.
const warmMsg = fill('my yard has ants and a question ', 2000);
const warmCtx = [...Array(12).fill(fill('ordinary pest question ', 600)), warmMsg].join('\n');
for (let k = 0; k < 2; k += 1) runChokepoint(fill('ordinary answer ', 600), warmCtx, warmMsg);

const results = inputs.map(({ reply, ctx, msg, topic }) => {
  const run = () => runChokepoint(reply, ctx, msg, topic);
  return Math.min(cpuMs(run), cpuMs(run), cpuMs(run));
});
process.stdout.write(`\nLATENCY ${JSON.stringify(results)}\n`);
