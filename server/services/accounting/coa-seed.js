/**
 * Canonical Chart of Accounts & accounting math primitives for Waves Pest Control.
 *
 * All money values in the General Ledger are exact integer cents (signed when
 * representing net balances, non-negative on individual debit/credit lines).
 */

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];
const NORMAL_BALANCE_BY_TYPE = {
  asset: 'debit',
  cogs: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

const BALANCE_SHEET_TYPES = new Set(['asset', 'liability', 'equity']);
const INCOME_STATEMENT_TYPES = new Set(['revenue', 'cogs', 'expense']);

// Canonical system account codes used by the posting engine and statement builders.
const SYSTEM_CODES = {
  CHECKING_PRIMARY: '1010',
  CHECKING_PAYROLL: '1020',
  SAVINGS_RESERVE: '1030',
  STRIPE_CLEARING: '1050',
  UNDEPOSITED_FUNDS: '1060',
  ACCOUNTS_RECEIVABLE: '1100',
  FIXED_ASSETS_VEHICLES: '1500',
  FIXED_ASSETS_EQUIPMENT: '1510',
  ACCUM_DEPRECIATION: '1590',

  CREDIT_CARD_PRIMARY: '2000',
  SALES_TAX_PAYABLE: '2100',
  PAYROLL_TAX_LIABILITIES: '2200',
  PAYROLL_BENEFITS_PAYABLE: '2210',
  NET_PAY_CLEARING: '2290',
  UNEARNED_REVENUE: '2300',
  CUSTOMER_CREDITS: '2350',
  LOANS_PAYABLE: '2500',

  OWNER_EQUITY: '3000',
  OWNER_DRAWS: '3100',
  RETAINED_EARNINGS: '3200',

  REV_RESIDENTIAL_PEST: '4000',
  REV_COMMERCIAL_PEST: '4010',
  REV_LAWN_TREE_SHRUB: '4020',
  REV_TERMITE_PROJECTS: '4030',
  REV_OTHER: '4080',
  REV_CARD_SURCHARGE: '4085',
  REV_REFUNDS_ALLOWANCES: '4090',

  COGS_FIELD_WAGES: '5100',
  COGS_FIELD_PAYROLL_TAX: '5110',
  COGS_CHEMICALS_SUPPLIES: '5200',
  COGS_FIELD_VEHICLE: '5300',
  COGS_MERCHANT_FEES: '5400',
  COGS_SUBCONTRACTORS: '5500',

  OPEX_ADVERTISING: '6010',
  OPEX_OFFICE_WAGES: '6100',
  OPEX_OFFICE_PAYROLL_TAX: '6110',
  OPEX_EMPLOYEE_BENEFITS: '6120',
  OPEX_RETIREMENT_SIMPLE: '6130',
  OPEX_INSURANCE: '6200',
  OPEX_LEGAL_PROFESSIONAL: '6250',
  OPEX_OFFICE_EXPENSES: '6300',
  OPEX_SOFTWARE_TECH: '6350',
  OPEX_REPAIRS_MAINTENANCE: '6400',
  OPEX_TAXES_LICENSES: '6450',
  OPEX_UTILITIES: '6500',
  OPEX_TRAVEL: '6550',
  OPEX_BUSINESS_MEALS: '6560',
  OPEX_ENTERTAINMENT: '6570',
  OPEX_TRAINING_CEU: '6580',
  OPEX_INTEREST_OTHER: '6610',
  OPEX_DEPRECIATION: '6700',
  OPEX_HOME_OFFICE: '6750',
  OPEX_UNCATEGORIZED: '6990',
};

const SYSTEM_ACCOUNTS = [
  // ── Assets (1xxx) ────────────────────────────────────────────────────────
  {
    code: SYSTEM_CODES.CHECKING_PRIMARY,
    name: 'Capital One Operating Checking',
    account_type: 'asset',
    sub_type: 'checking',
    normal_balance: 'debit',
    description: 'Primary operating bank checking account',
    sort_order: 1010,
  },
  {
    code: SYSTEM_CODES.CHECKING_PAYROLL,
    name: 'Mercury Payroll Checking',
    account_type: 'asset',
    sub_type: 'checking',
    normal_balance: 'debit',
    description: 'Dedicated payroll checking account (Mercury)',
    sort_order: 1020,
  },
  {
    code: SYSTEM_CODES.SAVINGS_RESERVE,
    name: 'Tax & Operating Savings Reserve',
    account_type: 'asset',
    sub_type: 'savings',
    normal_balance: 'debit',
    description: 'Cash reserve for quarterly taxes and emergency runway',
    sort_order: 1030,
  },
  {
    code: SYSTEM_CODES.STRIPE_CLEARING,
    name: 'Stripe Clearing',
    account_type: 'asset',
    sub_type: 'stripe_clearing',
    normal_balance: 'debit',
    description: 'Net Stripe captures awaiting bank payout settlement; clears to $0 when payouts settle',
    sort_order: 1050,
  },
  {
    code: SYSTEM_CODES.UNDEPOSITED_FUNDS,
    name: 'Undeposited Funds',
    account_type: 'asset',
    sub_type: 'undeposited_funds',
    normal_balance: 'debit',
    description: 'Cash and checks received awaiting bank deposit',
    sort_order: 1060,
  },
  {
    code: SYSTEM_CODES.ACCOUNTS_RECEIVABLE,
    name: 'Accounts Receivable',
    account_type: 'asset',
    sub_type: 'ar',
    normal_balance: 'debit',
    description: 'Unpaid customer and commercial payer invoices',
    sort_order: 1100,
  },
  {
    code: SYSTEM_CODES.FIXED_ASSETS_VEHICLES,
    name: 'Service Vehicles',
    account_type: 'asset',
    sub_type: 'fixed_asset',
    normal_balance: 'debit',
    description: 'Capitalized fleet vehicles at historical cost',
    sort_order: 1500,
  },
  {
    code: SYSTEM_CODES.FIXED_ASSETS_EQUIPMENT,
    name: 'Field & Spray Equipment',
    account_type: 'asset',
    sub_type: 'fixed_asset',
    normal_balance: 'debit',
    description: 'Capitalized spray rigs, pumps, dethatchers, and machinery',
    sort_order: 1510,
  },
  {
    code: SYSTEM_CODES.ACCUM_DEPRECIATION,
    name: 'Accumulated Depreciation',
    account_type: 'asset',
    sub_type: 'accum_depreciation',
    normal_balance: 'credit',
    description: 'Contra-asset tracking cumulative tax/book depreciation',
    sort_order: 1590,
  },

  // ── Liabilities (2xxx) ───────────────────────────────────────────────────
  {
    code: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
    name: 'Business Credit Cards',
    account_type: 'liability',
    sub_type: 'credit_card',
    normal_balance: 'credit',
    description: 'Revolving business credit card balances (payments reduce this liability, not P&L)',
    sort_order: 2000,
  },
  {
    code: SYSTEM_CODES.SALES_TAX_PAYABLE,
    name: 'Florida Sales Tax Payable (DR-15)',
    account_type: 'liability',
    sub_type: 'sales_tax_payable',
    normal_balance: 'credit',
    description: 'Pass-through FL state + county surtax collected; FL DOR remittances debit this account (never Schedule C)',
    sort_order: 2100,
  },
  {
    code: SYSTEM_CODES.PAYROLL_TAX_LIABILITIES,
    name: 'Payroll Tax Liabilities (941 / FUTA / RT-6)',
    account_type: 'liability',
    sub_type: 'payroll_liability',
    normal_balance: 'credit',
    description: 'Withheld employee taxes + accrued employer FICA, FUTA, and FL RT-6 awaiting EFTPS / FL DOR deposit',
    sort_order: 2200,
  },
  {
    code: SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE,
    name: 'SIMPLE IRA & HSA Payable',
    account_type: 'liability',
    sub_type: 'payroll_liability',
    normal_balance: 'credit',
    description: 'Employee deferrals and employer SIMPLE IRA 2% / HSA contributions awaiting Schwab remittance',
    sort_order: 2210,
  },
  {
    code: SYSTEM_CODES.NET_PAY_CLEARING,
    name: 'Payroll Net Pay Clearing',
    account_type: 'liability',
    sub_type: 'net_pay_clearing',
    normal_balance: 'credit',
    description: 'Net paychecks owed on finalized runs; clears to $0 when Mercury ACH or paper checks settle',
    sort_order: 2290,
  },
  {
    code: SYSTEM_CODES.UNEARNED_REVENUE,
    name: 'Unearned Revenue (Annual Prepays & Deposits)',
    account_type: 'liability',
    sub_type: 'unearned_revenue',
    normal_balance: 'credit',
    description: 'Customer annual prepayments and estimate deposits recognized over service delivery',
    sort_order: 2300,
  },
  {
    code: SYSTEM_CODES.CUSTOMER_CREDITS,
    name: 'Customer Credit Liability',
    account_type: 'liability',
    sub_type: 'customer_credits',
    normal_balance: 'credit',
    description: 'Issued referral and service credits owed to customers',
    sort_order: 2350,
  },
  {
    code: SYSTEM_CODES.LOANS_PAYABLE,
    name: 'Vehicle & Equipment Loans Payable',
    account_type: 'liability',
    sub_type: 'loan_payable',
    normal_balance: 'credit',
    description: 'Principal balance of business vehicle and equipment financing',
    sort_order: 2500,
  },

  // ── Equity (3xxx) ────────────────────────────────────────────────────────
  {
    code: SYSTEM_CODES.OWNER_EQUITY,
    name: 'Owner Contributions & Opening Equity',
    account_type: 'equity',
    sub_type: 'owner_equity',
    normal_balance: 'credit',
    description: 'Owner capital contributions and cutover opening balance equity',
    sort_order: 3000,
  },
  {
    code: SYSTEM_CODES.OWNER_DRAWS,
    name: 'Owner Draws / Distributions',
    account_type: 'equity',
    sub_type: 'owner_draw',
    normal_balance: 'debit',
    description: 'Owner personal draws and non-business share of commingled/shared bills (contra-equity)',
    sort_order: 3100,
  },
  {
    code: SYSTEM_CODES.RETAINED_EARNINGS,
    name: 'Retained Earnings',
    account_type: 'equity',
    sub_type: 'retained_earnings',
    normal_balance: 'credit',
    description: 'Prior-year accumulated net income carried forward',
    sort_order: 3200,
  },

  // ── Revenue (4xxx) ───────────────────────────────────────────────────────
  {
    code: SYSTEM_CODES.REV_RESIDENTIAL_PEST,
    name: 'Residential Pest & Mosquito Revenue',
    account_type: 'revenue',
    sub_type: 'service_revenue',
    normal_balance: 'credit',
    schedule_c_line: '1',
    form_1120s_line: '1a',
    description: 'WaveGuard pest, mosquito, and residential general pest services',
    sort_order: 4000,
  },
  {
    code: SYSTEM_CODES.REV_COMMERCIAL_PEST,
    name: 'Commercial Pest Revenue',
    account_type: 'revenue',
    sub_type: 'service_revenue',
    normal_balance: 'credit',
    schedule_c_line: '1',
    form_1120s_line: '1a',
    description: 'Commercial accounts and recurring facilities contracts (excluding pass-through FL sales tax)',
    sort_order: 4010,
  },
  {
    code: SYSTEM_CODES.REV_LAWN_TREE_SHRUB,
    name: 'Lawn, Tree & Shrub Revenue',
    account_type: 'revenue',
    sub_type: 'service_revenue',
    normal_balance: 'credit',
    schedule_c_line: '1',
    form_1120s_line: '1a',
    description: 'Fertilization, weed control, tree & shrub care, dethatching, and topdressing',
    sort_order: 4020,
  },
  {
    code: SYSTEM_CODES.REV_TERMITE_PROJECTS,
    name: 'Termite, Rodent & Specialty Projects Revenue',
    account_type: 'revenue',
    sub_type: 'service_revenue',
    normal_balance: 'credit',
    schedule_c_line: '1',
    form_1120s_line: '1a',
    description: 'Termite bait/trenching, WDO inspections, rodent exclusion, and project bids',
    sort_order: 4030,
  },
  {
    code: SYSTEM_CODES.REV_OTHER,
    name: 'Other Service Revenue',
    account_type: 'revenue',
    sub_type: 'service_revenue',
    normal_balance: 'credit',
    schedule_c_line: '1',
    form_1120s_line: '1a',
    description: 'Miscellaneous service revenue',
    sort_order: 4080,
  },
  {
    code: SYSTEM_CODES.REV_CARD_SURCHARGE,
    name: 'Card Surcharge Recovery',
    account_type: 'revenue',
    sub_type: 'surcharge_recovery',
    normal_balance: 'credit',
    schedule_c_line: '1',
    form_1120s_line: '1a',
    description: 'Credit card surcharge amounts collected alongside invoice or deposit payments (keeps 1100 A/R exact)',
    sort_order: 4085,
  },
  {
    code: SYSTEM_CODES.REV_REFUNDS_ALLOWANCES,
    name: 'Refunds, Discounts & Chargebacks',
    account_type: 'revenue',
    sub_type: 'refunds_allowances',
    normal_balance: 'debit',
    schedule_c_line: '2',
    form_1120s_line: '1b',
    description: 'Contra-revenue for customer refunds, adjustments, and lost disputes',
    sort_order: 4090,
  },

  // ── Cost of Goods Sold / Direct Field Costs (5xxx) ───────────────────────
  {
    code: SYSTEM_CODES.COGS_FIELD_WAGES,
    name: 'Field Technician Wages',
    account_type: 'cogs',
    sub_type: 'direct_labor',
    normal_balance: 'debit',
    schedule_c_line: '26',
    form_1120s_line: '8',
    description: 'Direct field technician gross W-2 wages (excludes office/admin staff)',
    sort_order: 5100,
  },
  {
    code: SYSTEM_CODES.COGS_FIELD_PAYROLL_TAX,
    name: 'Field Technician Payroll Taxes',
    account_type: 'cogs',
    sub_type: 'direct_labor',
    normal_balance: 'debit',
    schedule_c_line: '23',
    form_1120s_line: '12',
    description: 'Employer FICA, FUTA, and FL RT-6 attributable to field technicians',
    sort_order: 5110,
  },
  {
    code: SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES,
    name: 'Chemicals, Materials & Field Supplies',
    account_type: 'cogs',
    sub_type: 'materials',
    normal_balance: 'debit',
    schedule_c_line: '22',
    form_1120s_line: '2',
    legacy_category_name: 'Supplies',
    description: 'Pesticides, fertilizers, PPE, bait stations, and direct field consumables',
    sort_order: 5200,
  },
  {
    code: SYSTEM_CODES.COGS_FIELD_VEHICLE,
    name: 'Field Vehicle Fuel & Fleet Expenses',
    account_type: 'cogs',
    sub_type: 'field_vehicle',
    normal_balance: 'debit',
    schedule_c_line: '9',
    form_1120s_line: '19',
    legacy_category_name: 'Vehicle Expenses',
    description: 'Service truck fuel, tolls, washes, and fleet operating costs',
    sort_order: 5300,
  },
  {
    code: SYSTEM_CODES.COGS_MERCHANT_FEES,
    name: 'Merchant Processing & Bank Fees',
    account_type: 'cogs',
    sub_type: 'merchant_fees',
    normal_balance: 'debit',
    schedule_c_line: '10',
    form_1120s_line: '19',
    legacy_category_name: 'Commissions & Fees',
    description: 'Stripe card/ACH processing fees, wire fees, and merchant charges',
    sort_order: 5400,
  },
  {
    code: SYSTEM_CODES.COGS_SUBCONTRACTORS,
    name: 'Contract Labor (1099)',
    account_type: 'cogs',
    sub_type: 'subcontractors',
    normal_balance: 'debit',
    schedule_c_line: '11',
    form_1120s_line: '19',
    legacy_category_name: 'Contract Labor',
    description: 'Independent contractors and 1099-NEC field or specialist labor',
    sort_order: 5500,
  },

  // ── Operating Expenses (6xxx) ────────────────────────────────────────────
  {
    code: SYSTEM_CODES.OPEX_ADVERTISING,
    name: 'Advertising & Marketing',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '8',
    form_1120s_line: '16',
    legacy_category_name: 'Advertising & Marketing',
    description: 'Google Ads, Meta, EDDM postcards, SEO, yard signs, and print',
    sort_order: 6010,
  },
  {
    code: SYSTEM_CODES.OPEX_OFFICE_WAGES,
    name: 'Office & Admin Wages',
    account_type: 'expense',
    sub_type: 'office_payroll',
    normal_balance: 'debit',
    schedule_c_line: '26',
    form_1120s_line: '8',
    description: 'CSR, office manager, and non-field W-2 wages (kept out of COGS)',
    sort_order: 6100,
  },
  {
    code: SYSTEM_CODES.OPEX_OFFICE_PAYROLL_TAX,
    name: 'Office & Admin Payroll Taxes',
    account_type: 'expense',
    sub_type: 'office_payroll',
    normal_balance: 'debit',
    schedule_c_line: '23',
    form_1120s_line: '12',
    description: 'Employer FICA, FUTA, and FL RT-6 attributable to office/admin staff',
    sort_order: 6110,
  },
  {
    code: SYSTEM_CODES.OPEX_EMPLOYEE_BENEFITS,
    name: 'Employee Benefit Programs (HSA / Health)',
    account_type: 'expense',
    sub_type: 'employee_benefits',
    normal_balance: 'debit',
    schedule_c_line: '14',
    form_1120s_line: '18',
    description: 'Employer HSA contributions and qualifying employee benefit programs',
    sort_order: 6120,
  },
  {
    code: SYSTEM_CODES.OPEX_RETIREMENT_SIMPLE,
    name: 'SIMPLE IRA Employer Contributions',
    account_type: 'expense',
    sub_type: 'retirement_plan',
    normal_balance: 'debit',
    schedule_c_line: '19',
    form_1120s_line: '17',
    description: 'Employer 2% nonelective or 3% matching SIMPLE IRA contributions',
    sort_order: 6130,
  },
  {
    code: SYSTEM_CODES.OPEX_INSURANCE,
    name: 'Business Insurance',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '15',
    form_1120s_line: '19',
    legacy_category_name: 'Insurance',
    description: 'General liability, commercial auto, and workers compensation insurance',
    sort_order: 6200,
  },
  {
    code: SYSTEM_CODES.OPEX_LEGAL_PROFESSIONAL,
    name: 'Legal & Professional Services',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '17',
    form_1120s_line: '19',
    legacy_category_name: 'Legal & Professional',
    description: 'CPA, tax preparation, legal counsel, and business advisory',
    sort_order: 6250,
  },
  {
    code: SYSTEM_CODES.OPEX_OFFICE_EXPENSES,
    name: 'Office Supplies & Postage',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '18',
    form_1120s_line: '19',
    legacy_category_name: 'Office Expenses',
    description: 'Office supplies, shipping, postage, and admin consumables',
    sort_order: 6300,
  },
  {
    code: SYSTEM_CODES.OPEX_SOFTWARE_TECH,
    name: 'Software, Cloud & Technology',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '27a',
    form_1120s_line: '19',
    legacy_category_name: 'Software & Technology',
    description: 'Railway, Twilio, AI APIs, Google Workspace, Bouncie, domains, and SaaS',
    sort_order: 6350,
  },
  {
    code: SYSTEM_CODES.OPEX_REPAIRS_MAINTENANCE,
    name: 'Repairs & Maintenance',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '21',
    form_1120s_line: '9',
    legacy_category_name: 'Repairs & Maintenance',
    description: 'Equipment repairs, shop maintenance, and non-capitalized servicing',
    sort_order: 6400,
  },
  {
    code: SYSTEM_CODES.OPEX_TAXES_LICENSES,
    name: 'Business Taxes, Permits & Licenses',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '23',
    form_1120s_line: '12',
    legacy_category_name: 'Taxes & Licenses',
    description: 'FDACS pest licenses, Sunbiz annual report, county BTR (NEVER FL DR-15 sales tax)',
    sort_order: 6450,
  },
  {
    code: SYSTEM_CODES.OPEX_UTILITIES,
    name: 'Phone & Utilities (Business Share)',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '25',
    form_1120s_line: '19',
    legacy_category_name: 'Utilities',
    description: 'Business phone, internet, and business-share utilities',
    sort_order: 6500,
  },
  {
    code: SYSTEM_CODES.OPEX_TRAVEL,
    name: 'Business Travel',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '24a',
    form_1120s_line: '19',
    legacy_category_name: 'Travel',
    description: 'Airfare, lodging, and out-of-area business travel',
    sort_order: 6550,
  },
  {
    code: SYSTEM_CODES.OPEX_BUSINESS_MEALS,
    name: 'Business Meals (50% Deductible)',
    account_type: 'expense',
    sub_type: 'meals',
    normal_balance: 'debit',
    schedule_c_line: '24b',
    form_1120s_line: '19',
    deductible_pct: 50,
    legacy_category_name: 'Meals & Entertainment',
    description: 'Documented business meals subject to IRS 50% limit (excludes entertainment)',
    sort_order: 6560,
  },
  {
    code: SYSTEM_CODES.OPEX_ENTERTAINMENT,
    name: 'Client Entertainment (0% Non-Deductible)',
    account_type: 'expense',
    sub_type: 'non_deductible',
    normal_balance: 'debit',
    deductible_pct: 0,
    description: 'Non-deductible entertainment under TCJA; excluded from Schedule C deductions',
    sort_order: 6570,
  },
  {
    code: SYSTEM_CODES.OPEX_TRAINING_CEU,
    name: 'Training, CEUs & Association Dues',
    account_type: 'expense',
    sub_type: 'operating_expense',
    normal_balance: 'debit',
    schedule_c_line: '27a',
    form_1120s_line: '19',
    legacy_category_name: 'Training & Education',
    description: 'FDACS CEU courses, GHP/L&O certifications, and FPMA/NPMA dues',
    sort_order: 6580,
  },
  {
    code: SYSTEM_CODES.OPEX_INTEREST_OTHER,
    name: 'Interest Expense (Non-Mortgage, Line 16b)',
    account_type: 'expense',
    sub_type: 'interest_expense',
    normal_balance: 'debit',
    schedule_c_line: '16b',
    form_1120s_line: '13',
    legacy_category_name: 'Interest',
    description: 'Vehicle financing, equipment loan, and business credit card interest (IRS Line 16b, never 16a)',
    sort_order: 6610,
  },
  {
    code: SYSTEM_CODES.OPEX_DEPRECIATION,
    name: 'Depreciation & Section 179 Expense',
    account_type: 'expense',
    sub_type: 'depreciation_expense',
    normal_balance: 'debit',
    schedule_c_line: '13',
    form_1120s_line: '14',
    legacy_category_name: 'Depreciation',
    description: 'Non-cash MACRS / Section 179 / Bonus depreciation offsetting 1590 Accumulated Depreciation',
    sort_order: 6700,
  },
  {
    code: SYSTEM_CODES.OPEX_HOME_OFFICE,
    name: 'Business Use of Home (Form 8829)',
    account_type: 'expense',
    sub_type: 'home_office',
    normal_balance: 'debit',
    schedule_c_line: '30',
    legacy_category_name: 'Home Office',
    description: 'Form 8829 simplified or actual home-office deduction',
    sort_order: 6750,
  },
  {
    code: SYSTEM_CODES.OPEX_UNCATEGORIZED,
    name: 'Uncategorized Expense (Ask My Accountant)',
    account_type: 'expense',
    sub_type: 'uncategorized',
    normal_balance: 'debit',
    schedule_c_line: '27a',
    form_1120s_line: '19',
    description: 'Temporary clearing expense for items needing owner/CPA classification',
    sort_order: 6990,
  },
];

function isDebitNormal(account) {
  if (!account) return true;
  if (account.normal_balance === 'debit') return true;
  if (account.normal_balance === 'credit') return false;
  return NORMAL_BALANCE_BY_TYPE[account.account_type] === 'debit';
}

/**
 * Signed balance in the account's natural direction (positive = normal balance).
 * For debit-normal accounts (Assets, COGS, Expenses, Draws): debits - credits.
 * For credit-normal accounts (Liabilities, Equity, Revenue, Accum Depr): credits - debits.
 */
function naturalBalanceCents(account, debitCents, creditCents) {
  const dr = Math.trunc(Number(debitCents) || 0);
  const cr = Math.trunc(Number(creditCents) || 0);
  return isDebitNormal(account) ? (dr - cr) : (cr - dr);
}

/**
 * Balance expressed in the section's natural direction (so contra-accounts like
 * Accumulated Depreciation, Owner Draws, and Refunds & Allowances automatically
 * carry negative values inside their section totals).
 */
function sectionSignedBalanceCents(account, debitCents, creditCents) {
  const dr = Math.trunc(Number(debitCents) || 0);
  const cr = Math.trunc(Number(creditCents) || 0);
  const sectionNormal = NORMAL_BALANCE_BY_TYPE[account.account_type] || 'debit';
  return sectionNormal === 'debit' ? (dr - cr) : (cr - dr);
}

function dollarsToCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function centsToDollars(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

/**
 * Convert a PostgreSQL DATE cell (ISO string or node-postgres local-midnight Date)
 * to 'YYYY-MM-DD' WITHOUT timezone shifting. Never pass a DATE cell through
 * etDateString() or String(d).slice(0, 10) ("Fri Nov 27").
 */
function dateCellText(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return m ? m[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

/**
 * Read-only check returning any canonical system account codes missing from gl_accounts.
 * Safe for dry runs and read-only report endpoints (never writes to the database).
 */
async function findMissingSystemAccountCodes(conn) {
  const existing = await conn('gl_accounts').select('code');
  const present = new Set(existing.map((r) => r.code));
  return SYSTEM_ACCOUNTS.filter((a) => !present.has(a.code)).map((a) => a.code);
}

/**
 * Idempotently guarantees all system Chart of Accounts rows exist and bridges
 * legacy expense_categories rows where not already mapped.
 */
async function ensureSystemAccounts(conn) {
  const existing = await conn('gl_accounts').select('id', 'code', 'expense_category_id');
  const byCode = new Map(existing.map((r) => [r.code, r]));
  const missing = SYSTEM_ACCOUNTS.filter((a) => !byCode.has(a.code));
  if (!missing.length) return existing.length;

  let catByLower = new Map();
  if (await conn.schema.hasTable('expense_categories')) {
    const cats = await conn('expense_categories').select('id', 'name');
    catByLower = new Map(cats.map((c) => [String(c.name || '').trim().toLowerCase(), c.id]));
  }

  for (const acct of missing) {
    const matchedCatId = acct.legacy_category_name
      ? (catByLower.get(acct.legacy_category_name.toLowerCase()) || null)
      : null;
    await conn('gl_accounts')
      .insert({
        code: acct.code,
        name: acct.name,
        account_type: acct.account_type,
        sub_type: acct.sub_type,
        normal_balance: acct.normal_balance,
        expense_category_id: matchedCatId,
        schedule_c_line: acct.schedule_c_line || null,
        form_1120s_line: acct.form_1120s_line || null,
        deductible_pct: acct.deductible_pct ?? 100,
        is_system: true,
        active: true,
        description: acct.description || null,
        sort_order: acct.sort_order,
      })
      .onConflict('code')
      .ignore();
  }
  return existing.length + missing.length;
}

module.exports = {
  ACCOUNT_TYPES,
  NORMAL_BALANCE_BY_TYPE,
  BALANCE_SHEET_TYPES,
  INCOME_STATEMENT_TYPES,
  SYSTEM_CODES,
  SYSTEM_ACCOUNTS,
  isDebitNormal,
  naturalBalanceCents,
  sectionSignedBalanceCents,
  dollarsToCents,
  centsToDollars,
  dateCellText,
  findMissingSystemAccountCodes,
  ensureSystemAccounts,
};
