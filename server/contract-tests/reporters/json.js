const fs = require('fs');

function write(results, outPath) {
  const payload = {
    generated_at: new Date().toISOString(),
    total: results.length,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

module.exports = { write };
