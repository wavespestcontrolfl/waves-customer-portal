/**
 * Chokepoint guard (owner ruling 2026-09-30): the direct invoice sender
 * (InvoiceService.sendViaSMS / sendViaSMSAndEmail) checks the collections dispute
 * hold DEFAULT-ON. Every caller must be classified here: an AUTOMATED caller is
 * gated (passes no holdExempt and handles the retryable COLLECTION_HOLD_DEFER
 * refusal as a wait); an operator- or customer-initiated caller passes
 * holdExempt explicitly. A new caller that is not listed fails this test, so it
 * gets classified deliberately instead of bypassing the hold by accident.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const CALLER = /\.sendViaSMS(?:AndEmail)?\(/g;

// file -> classification
const CLASSIFIED = {
  // operator-initiated (admin send / resend routes, the assistant + repair tools)
  'routes/admin-invoices.js': 'operator',
  'routes/admin-customers.js': 'operator',
  'services/intelligence-bar/closeout-repair-tools.js': 'operator',
  'services/ai-assistant/tools-expanded.js': 'operator',
  // customer-initiated (estimate accept, "text me the link")
  'services/estimate-converter.js': 'customer',
  'routes/estimate-public.js': 'customer',
  'services/collections/outbound-voice/collections-conversation.js': 'customer',
  // AUTOMATED: default-on hold check; each handles COLLECTION_HOLD_DEFER as a wait
  'services/recurring-card-on-file.js': 'gated',
  'services/termite-annual-renewal-charge.js': 'gated',
  'services/termite-annual-activation.js': 'gated',
};

function callSites(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const out = [];
  let m;
  CALLER.lastIndex = 0;
   
  while ((m = CALLER.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 2), m.index);
    // a real call site: `Foo.sendViaSMS(` / `.sendViaSMSAndEmail(` on an invoice service, not a comment mention
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(\/\/|\*)/.test(src.slice(lineStart, m.index))) continue;
    if (before === '') continue;
    out.push(src.slice(m.index, m.index + 700));
  }
  return out;
}

function sourceFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sourceFiles(rel);
    return e.name.endsWith('.js') ? [rel] : [];
  });
}

describe('direct invoice sender callers are all classified for the dispute-hold check', () => {
  test('no unclassified caller of sendViaSMS / sendViaSMSAndEmail exists', () => {
    const found = [...sourceFiles('services'), ...sourceFiles('routes')]
      .filter((f) => f !== 'services/invoice.js' && callSites(f).length > 0);
    expect(found.sort()).toEqual(Object.keys(CLASSIFIED).sort());
  });

  test.each(Object.entries(CLASSIFIED).filter(([, kind]) => kind !== 'gated'))(
    '%s passes holdExempt: %s at every call',
    (file, kind) => {
      for (const site of callSites(file)) expect(site).toContain(`holdExempt: '${kind}'`);
    },
  );

  test.each(Object.entries(CLASSIFIED).filter(([, kind]) => kind === 'gated'))(
    '%s (automated) passes no holdExempt, so the sender gates it',
    (file) => {
      for (const site of callSites(file)) expect(site.slice(0, 400)).not.toMatch(/holdExempt/);
    },
  );

  test('the automated callers treat the retryable refusal as a wait, never a failure', () => {
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    expect(read('services/termite-annual-activation.js')).toMatch(/COLLECTION_HOLD_DEFER[\s\S]{0,400}held: true/);
    expect(read('services/termite-annual-renewal-charge.js')).toMatch(/COLLECTION_HOLD_DEFER/);
    expect(read('services/recurring-card-on-file.js')).toMatch(/result\?\.code === 'COLLECTION_HOLD_DEFER'[\s\S]{0,400}continue;/);
  });
});
