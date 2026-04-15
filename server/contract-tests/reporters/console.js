const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function paint(c, s) {
  return process.stdout.isTTY ? `${c}${s}${C.reset}` : s;
}

function print(results, { verbose = false } = {}) {
  const byTool = new Map();
  for (const r of results) {
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  }
  let critical = 0, warning = 0, pass = 0;
  const lines = [];
  for (const [tool, rs] of byTool) {
    const failed = rs.filter(r => !r.pass);
    if (failed.length === 0) { pass++; continue; }
    const surface = rs[0].surface;
    lines.push(paint(C.bold, `\n✗ ${tool}`) + paint(C.dim, `  (${surface})`));
    for (const r of failed) {
      const sev = r.severity === 'critical' ? paint(C.red, '[critical]') :
                  r.severity === 'warning'  ? paint(C.yellow, '[warning]') :
                                              paint(C.dim, '[info]');
      if (r.severity === 'critical') critical++;
      else if (r.severity === 'warning') warning++;
      for (const e of r.errors || []) lines.push(`  ${sev} ${paint(C.dim, r.validator)} — ${e}`);
      for (const w of r.warnings || []) lines.push(`  ${paint(C.yellow, '[warn]')} ${paint(C.dim, r.validator)} — ${w}`);
    }
  }
  if (verbose) {
    for (const [tool, rs] of byTool) {
      for (const r of rs) {
        if (r.pass && r.notes?.length) lines.push(paint(C.dim, `  [info] ${tool} ${r.validator} — ${r.notes.join(', ')}`));
      }
    }
  }
  console.log(lines.join('\n'));
  console.log(
    `\n${paint(C.bold, 'Summary')}: ${paint(C.green, pass + ' passing')}, ` +
    `${paint(C.yellow, warning + ' warnings')}, ${paint(C.red, critical + ' critical')}`
  );
  return { critical, warning, pass };
}

module.exports = { print };
