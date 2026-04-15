/**
 * Manual contract overrides for tools whose DB references can't be reliably
 * extracted via regex (raw SQL, dynamic column names, CTEs, etc.).
 *
 * Format:
 *   {
 *     '<tool_name>': {
 *       tables:  ['table_a', 'table_b'],
 *       columns: { table_a: ['col1', 'col2'], table_b: ['*'] },
 *       reason:  'why this needs manual declaration',
 *       sideEffects: true,         // optional — skip execute-smoke
 *       registerManually: true,    // optional — add a tool the registry wouldn't find
 *       schema:  { ... },          // optional — required if registerManually
 *     }
 *   }
 *
 * Tools can also declare an inline `_contracts` object on their definition;
 * the registry honors both.
 */
module.exports = {
  // Example placeholder — populate after the first dry-run surfaces raw-SQL tools.
  // 'find_churn_risk_customers': {
  //   tables:  ['customers', 'scheduled_services'],
  //   columns: {
  //     customers: ['id', 'waveguard_tier', 'monthly_rate'],
  //     scheduled_services: ['customer_id', 'scheduled_date', 'status'],
  //   },
  //   reason: 'Uses db.raw for the 90-day rolling window CTE',
  // },
};
