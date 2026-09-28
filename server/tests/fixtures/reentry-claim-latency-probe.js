// Child-process probe for the #4905 latency guard (content-guardrails.test.js).
// Runs in a FRESH process so V8 has compiled none of the re-entry claim
// patterns yet — the state a newly booted server is in. It runs the same
// boot warm-up server/index.js runs before listening, then times each input
// (read as JSON from stdin) on first sight. Without the warm-up the first
// one-byte and the first two-byte input each cost hundreds of ms.
const fs = require('fs');
const { reentrySafetyClaimFinding, warmReentrySafetyPatterns } = require('../../services/content/content-guardrails');

const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.env.REENTRY_PROBE_SKIP_WARM !== '1') warmReentrySafetyPatterns();

const cpuMs = (fn) => {
  const started = process.cpuUsage();
  fn();
  const elapsed = process.cpuUsage(started);
  return (elapsed.user + elapsed.system) / 1000;
};

const results = inputs.map((text) => cpuMs(() => reentrySafetyClaimFinding(text)));
process.stdout.write(`\nLATENCY ${JSON.stringify(results)}\n`);
