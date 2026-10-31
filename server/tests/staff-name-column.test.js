/**
 * technicians has one `name` column (no first_name / last_name), and
 * adminAuthenticate puts that row on req.technician. A staff label built from
 * the missing columns recorded "undefined ", "" or a fallback (the email, the id)
 * instead of the person: lead history (#7143), Agent Ops reviews and actions.
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('no route or middleware reads first_name / last_name off req.technician', () => {
  const hits = ['routes', 'middleware']
    .flatMap((dir) => jsFiles(path.join(SERVER, dir)))
    .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
      .map((line, i) => (/req\.technician\??\.(first|last)_name/.test(line) ? `${path.relative(SERVER, file)}:${i + 1}` : null))
      .filter(Boolean));
  expect(hits).toEqual([]);
});
