// Worker for tax-ledger-rules assertPatternFast: runs one pattern against
// the adversarial strings it is given and reports how long that took. The
// parent terminates this thread when it overruns the budget, so a pattern
// that backtracks for seconds never blocks the request loop.
const { parentPort, workerData } = require('worker_threads');

const { pattern, strings } = workerData;
const re = new RegExp(pattern, 'i');
const started = Date.now();
for (const s of strings) re.test(s);
parentPort.postMessage({ ms: Date.now() - started });
