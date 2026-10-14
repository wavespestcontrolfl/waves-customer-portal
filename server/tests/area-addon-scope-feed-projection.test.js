// Codex round 17 on #6135: the schedule `/week` feed projected service_key_snapshot but not area_addon_scope, so
// areaAddOnFeed (area-addon-governed-rate.js) never saw the own add-on's sold scope (its grass) and the Week view
// withheld the governed Arena rate. Every query that builds a schedule row for these readers must carry the column:
// the day feed through `scheduled_services.*`, the explicit-column feeds through the guarded column name.
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// The route handlers of admin-schedule.js whose rows feed the completion context (areaAddOnFeed, job card, tech home,
// Dispatch all read the rows that context is built from), and the ones among them that project neither
// `scheduled_services.*` nor the scope column.
function feedHandlersMissingScope(source) {
  const handlers = source.split(/\nrouter\.(?=(?:get|post|put|patch|delete)\()/);
  return handlers
    .filter((body) => body.includes('await loadProjectCompletionContextByServiceId('))
    .filter((body) => !body.includes("'scheduled_services.*'") && !body.includes('area_addon_scope'))
    .map((body) => body.slice(0, 60).split('\n')[0]);
}

describe('area_addon_scope rides every schedule feed that feeds the add-on readers', () => {
  const schedule = read('routes/admin-schedule.js');

  test('the day feed and the week feed both feed the completion context, and both carry the scope', () => {
    const feeding = schedule.split(/\nrouter\.(?=(?:get|post|put|patch|delete)\()/).filter((body) => body.includes('await loadProjectCompletionContextByServiceId('));
    expect(feeding.length).toBe(2);
    expect(feedHandlersMissingScope(schedule)).toEqual([]);
  });

  test('the week feed selects it through the same late-column guard as the other late columns', () => {
    const week = schedule.slice(schedule.indexOf("router.get('/week'"), schedule.indexOf("router.get('/month'"));
    expect(week).toMatch(/\['area_addon_scope'\]\.filter\(\(col\) => discountProvenanceCols\[col\]\)\.map\(\(col\) => `scheduled_services\.\$\{col\}`\)/);
    expect(schedule).toMatch(/const DISCOUNT_PROVENANCE_COLUMNS = \[[^\]]*'area_addon_scope'/);
  });

  test('the checker fails for a feed projection that selects service_key_snapshot and omits the scope', () => {
    const week = schedule.slice(schedule.indexOf("router.get('/week'"), schedule.indexOf("router.get('/month'"));
    const broken = schedule.replace(week, week.replace(/ *\.\.\.\['area_addon_scope'\][^\n]*\n/, ''));
    expect(broken).not.toBe(schedule);
    expect(feedHandlersMissingScope(broken)).toHaveLength(1);
  });

  test('the other readers of the own scope load it: job card, completion, tags', () => {
    expect(read('services/job-card.js')).toMatch(/'ss\.customer_request_pests', 'ss\.area_addon_scope'/);
    expect(read('services/complete-scheduled-service.js')).toMatch(/\.select\(\s*'scheduled_services\.\*'/);
    expect(read('services/area-addon-governed-rate.js')).toMatch(/parseScope\(row\.area_addon_scope\)/);
  });
});
