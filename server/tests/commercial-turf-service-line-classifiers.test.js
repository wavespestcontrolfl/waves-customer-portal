process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Regression for the "Commercial Turf Treatment Program" rename (PR #2227).
// The commercial lawn line persists its DISPLAY NAME into
// scheduled_services.service_type, so every classifier that derived lawn-ness
// from includes('lawn') must also recognize 'turf' — otherwise a completed turf
// job is silently bucketed as Pest Control and corrupts service-line P&L.

const { classifyServiceLine: classifyRevenueRoute } = require('../routes/admin-revenue');
const { classifyServiceLine: classifyRevenueTool } = require('../services/intelligence-bar/revenue-tools');

const TURF = 'Commercial Turf Treatment Program';

describe('revenue service-line classifiers recognize commercial turf as Lawn Care', () => {
  test('admin-revenue route classifier: turf -> Lawn Care (not Pest Control)', () => {
    expect(classifyRevenueRoute(TURF)).toBe('Lawn Care');
    // Residential lawn still classifies the same way.
    expect(classifyRevenueRoute('Lawn Care')).toBe('Lawn Care');
    // Sanity: a real pest line still buckets to Pest Control.
    expect(classifyRevenueRoute('Quarterly Pest Control')).toBe('Pest Control');
  });

  test('intelligence-bar revenue-tools classifier: turf -> Lawn Care (not Pest Control)', () => {
    expect(classifyRevenueTool(TURF)).toBe('Lawn Care');
    expect(classifyRevenueTool('Commercial Lawn Treatment')).toBe('Lawn Care');
    expect(classifyRevenueTool('Quarterly Pest Control')).toBe('Pest Control');
  });
});
