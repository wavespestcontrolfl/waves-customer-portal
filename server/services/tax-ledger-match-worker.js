// Worker for tax-ledger-rules matchPage: compiles the enabled patterns it is
// given once, then answers a page of descriptions with, per description,
// the indexes of the patterns that match it. The parent terminates this
// thread when a page overruns MATCH_HARD_CAP_MS, so a pattern that
// backtracks for seconds on a real description never blocks the request
// loop (the probe at save time runs adversarial strings, not every
// description the bank will ever send).
const { parentPort, workerData } = require('worker_threads');

const res = workerData.patterns.map((p) => new RegExp(p, 'i'));
parentPort.on('message', ({ subjects }) => {
  const hits = subjects.map((s) => {
    const out = [];
    for (let i = 0; i < res.length; i += 1) if (res[i].test(s)) out.push(i);
    return out;
  });
  parentPort.postMessage({ hits });
});
