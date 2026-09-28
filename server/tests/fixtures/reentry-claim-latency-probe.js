// Times reentrySafetyClaimFinding in a fresh Node process for the #4905
// latency guard in content-guardrails.test.js. In-worker timing is flaky on
// CI (GC/background-compile from earlier test files skews it — see
// ask-waves-latency-probe.js, the sibling probe for the same issue), so this
// runs standalone and reports CPU time, not wall clock.
//
// This is a secondary, defense-in-depth check. The PRIMARY, deterministic
// regression guard for #4905 is the "constructs zero RegExp objects on a
// call" test in content-guardrails.test.js — V8's regexp tier-up state is
// tied to a shared, source-keyed compilation cache that recovers within a
// call or two even for the pre-fix (rebuild-every-call) code once a process
// is otherwise quiet, so an isolated microbenchmark like this one is not a
// reliable way to force the multi-hundred-millisecond-to-seconds field
// reports on their own — but it still pins a real, useful invariant (this
// corpus never costs more than the budget below) and pressures the shared
// cache with unrelated dynamic regexes between calls, closer to how real
// concurrent request traffic (this file alone builds many dynamic,
// content-keyed regexes per request — price/brand/city finders) behaves.
//
// Reads a JSON array of strings on stdin and prints `LATENCY <json>`: the
// CPU time in ms for each input, measured once (not best-of-N — repeating
// the SAME input warms the very thing being measured, since compilation
// state is keyed by the fixed pattern set, not by input content).
const fs = require('fs');
const { reentrySafetyClaimFinding } = require('../../services/content/content-guardrails');

const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));

const cpuMs = (fn) => {
  const started = process.cpuUsage();
  fn();
  const elapsed = process.cpuUsage(started);
  return (elapsed.user + elapsed.system) / 1000;
};

let noiseSeq = 0;
const noiseText = 'the quick brown fox jumps over the lazy dog near the porch and the garden fence line every single afternoon this week';
const noise = () => {
  // Distinct dynamic patterns (never repeats a source string) standing in
  // for the app's own varying, content-keyed regex traffic between calls.
  for (let i = 0; i < 300; i += 1) {
    noiseSeq += 1;
    const re = new RegExp(`\\bfox${noiseSeq}\\b|\\bdog${noiseSeq}\\b|\\bfence${noiseSeq}\\b`, 'gi');
    re.test(noiseText);
  }
};

// A truly brand-new V8 isolate pays some cold-start cost on its very FIRST
// handful of regex executions ever, no matter the implementation — that is
// inherent to the engine, not this bug, and every real server pays it once,
// at boot or on its first request, not on every request after. Warm up
// (covering the same dash/language shapes production sees) before measuring
// so the budget below reflects the STEADY STATE a live voice call or email
// actually sees.
const warmups = [
  'This is a generic warm-up sentence about scheduling a pest control visit.',
  'Another generic warm-up sentence — with an em dash, once dry.',
  'Hello - world, a plain ASCII-hyphen warm-up line.',
  'Gracias por su tiempo - hasta la próxima visita.',
];
for (const w of warmups) { noise(); reentrySafetyClaimFinding(w); }

const results = inputs.map((text) => {
  noise();
  return cpuMs(() => reentrySafetyClaimFinding(text));
});
process.stdout.write(`\nLATENCY ${JSON.stringify(results)}\n`);
