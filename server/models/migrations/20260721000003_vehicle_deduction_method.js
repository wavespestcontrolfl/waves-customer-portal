/**
 * Vehicle deduction METHOD ELECTION on company_financials.
 *
 * Standard mileage and actual vehicle expenses both land on Schedule C
 * line 9 ("Car and truck expenses") — the seeded `Vehicle Expenses` category
 * carries irs_line '9' and mileage_log.deduction_amount is the same line. The
 * IRS lets you deduct ONE of them, never both, so before the mileage-review
 * lane (PR #2931) started writing positive deduction_amount values the P&L
 * would have double-counted that line the moment any vehicle expense was
 * categorized.
 *
 * NULL = not elected, and the P&L FAILS CLOSED on NULL: actual vehicle
 * expenses (real recorded cash) keep flowing as opex and the computed
 * standard-mileage deduction is EXCLUDED, with an amber disclosure. Excluding
 * the computed side can only understate a deduction, never overstate one —
 * the same direction of caution as the coverage disclosure from PR #2918.
 *
 * Deliberately NOT defaulted to 'standard_mileage': prod's equipment_register
 * carries the Ford Transit Van on MACRS, and MACRS/§179 depreciation on a
 * vehicle bars the standard mileage rate for that vehicle for its remaining
 * life (Pub 463). Defaulting would have manufactured a deduction the owner is
 * likely barred from taking. The election is an owner/CPA call.
 */

const COLS = ['vehicle_deduction_method', 'vehicle_deduction_method_set_at'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('company_financials', 'vehicle_deduction_method'))) {
    await knex.schema.alterTable('company_financials', (t) => {
      // Allow-list enforced in the service layer (server-owned policy, same
      // shape as sanitizeDeductiblePercent): 'standard_mileage' | 'actual_expenses'.
      t.string('vehicle_deduction_method', 20).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('company_financials', 'vehicle_deduction_method_set_at'))) {
    await knex.schema.alterTable('company_financials', (t) => {
      t.timestamp('vehicle_deduction_method_set_at').nullable();
    });
  }
};

exports.down = async function down(knex) {
  for (const col of COLS) {
    if (await knex.schema.hasColumn('company_financials', col)) {
      await knex.schema.alterTable('company_financials', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
