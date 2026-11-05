const { technicianPickerRows } = require('../services/technician-picker-rows');

const ROWS = [
  { id: 'tech-own', name: 'Own Tech', role: 'technician', phone: '+19415550101', active: true },
  { id: 'tech-co', name: 'Co Worker', role: 'technician', phone: '+19415550102', active: true },
];

describe('GET /api/admin/technicians rows', () => {
  test('a technician keeps its own phone and gets no coworker phone', () => {
    const out = technicianPickerRows(ROWS, { technicianId: 'tech-own', techRole: 'technician', technician: { id: 'tech-own', role: 'technician' } });
    expect(out[0]).toEqual(ROWS[0]);
    expect(out[1]).toEqual({ id: 'tech-co', name: 'Co Worker', role: 'technician', active: true });
    expect(out[1]).not.toHaveProperty('phone');
  });

  test('an admin still gets every field', () => {
    const out = technicianPickerRows(ROWS, { technicianId: 'admin-1', techRole: 'admin', technician: { id: 'admin-1', role: 'admin' } });
    expect(out).toEqual(ROWS);
  });

  test('a caller with no staff row is treated as a technician (fails closed)', () => {
    const out = technicianPickerRows(ROWS, {});
    expect(out.every((row) => !('phone' in row))).toBe(true);
  });
});
