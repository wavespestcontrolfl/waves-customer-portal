// GET /api/admin/technicians feeds the schedule modals' technician picker. An
// admin gets every field. A technician gets its own row as is (own number) and
// each coworker as name, id, role and active only: no coworker phone (owner
// 2026-11-04, "Own number only").
function technicianPickerRows(rows, req) {
  if (req && req.technician && req.technician.role === 'admin') return rows;
  const ownId = req ? req.technicianId : null;
  return rows.map((row) => (
    row.id === ownId ? row : { id: row.id, name: row.name, role: row.role, active: row.active }
  ));
}

module.exports = { technicianPickerRows };
