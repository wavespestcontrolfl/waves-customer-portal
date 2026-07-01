const {
  coverageMonths,
  annualPrepaySetupFeeWaived,
  buildPrepayCoverageSummary,
  buildCoverageVisits,
  resolveInvoiceTermId,
} = require('../services/invoice-prepay');

describe('invoice-prepay helpers', () => {
  describe('coverageMonths', () => {
    it('resolves a standard one-year term to 12 months', () => {
      expect(coverageMonths('2026-06-06', '2027-06-05')).toBe(12);
    });

    it('rounds a partial term to the nearest whole month', () => {
      expect(coverageMonths('2026-01-01', '2026-07-01')).toBe(6);
    });

    it('accepts Date objects as well as strings', () => {
      expect(coverageMonths(new Date('2026-06-06'), new Date('2027-06-05'))).toBe(12);
    });

    it('returns null when a date is missing or invalid', () => {
      expect(coverageMonths(null, '2027-06-05')).toBeNull();
      expect(coverageMonths('2026-06-06', null)).toBeNull();
      expect(coverageMonths('not-a-date', '2027-06-05')).toBeNull();
    });

    it('returns null for a non-positive span', () => {
      expect(coverageMonths('2027-06-05', '2026-06-06')).toBeNull();
      expect(coverageMonths('2026-06-06', '2026-06-06')).toBeNull();
    });
  });

  describe('annualPrepaySetupFeeWaived', () => {
    it('detects the waiver from a line item description', () => {
      const invoice = {
        line_items: [
          { description: 'WaveGuard Membership — 12 months prepaid (setup fee waived)' },
        ],
      };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(true);
    });

    it('detects the waiver from invoice notes', () => {
      const invoice = { line_items: [], notes: 'Annual plan, setup fee waived for prepay.' };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(true);
    });

    it('parses line items delivered as a JSON string', () => {
      const invoice = {
        line_items: JSON.stringify([{ description: 'Setup waived for the year' }]),
      };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(true);
    });

    it('returns false when nothing mentions a waived setup fee', () => {
      const invoice = {
        line_items: [{ description: 'Quarterly pest control — April 2026' }],
        notes: 'Thanks for your business.',
      };
      expect(annualPrepaySetupFeeWaived(invoice)).toBe(false);
    });
  });

  describe('buildPrepayCoverageSummary', () => {
    const quarterly = {
      coverageVisitCount: 4,
      coverageCadence: 'quarterly',
      coverageServiceType: 'Quarterly Pest Control Service',
      coverageMonths: 12,
      termStart: '2026-06-20',
      termEnd: '2027-06-20',
    };

    it('builds the full-year quarterly sentence with a clean service label', () => {
      const summary = buildPrepayCoverageSummary(quarterly);
      expect(summary).toEqual({
        serviceLabel: 'pest control',
        countPhrase: '4 quarterly visits',
        coverageCount: 4,
        coverageSummary: 'your full year of pest control: 4 quarterly visits',
      });
    });

    it('never includes a dollar amount', () => {
      const { coverageSummary } = buildPrepayCoverageSummary(quarterly);
      expect(coverageSummary).not.toMatch(/\$/);
    });

    it('falls back to a plain count when the cadence has no adjective', () => {
      const summary = buildPrepayCoverageSummary({
        ...quarterly,
        coverageVisitCount: 9,
        coverageCadence: 'every_6_weeks',
        coverageServiceType: 'Mosquito Program',
      });
      expect(summary.countPhrase).toBe('9 visits');
      expect(summary.coverageSummary).toContain('your full year of mosquito: 9 visits');
    });

    it('uses a non-full-year shape for partial terms', () => {
      const summary = buildPrepayCoverageSummary({
        coverageVisitCount: 2,
        coverageCadence: 'quarterly',
        coverageServiceType: 'Pest Control',
        coverageMonths: 6,
        termStart: '2026-06-20',
        termEnd: '2026-12-20',
      });
      expect(summary.coverageSummary).toBe('2 quarterly visits of pest control across 6 months');
    });

    it('omits month names so the SMS stale-month guard cannot block the send', () => {
      // Future-dated renewal window: term a full year out from "now". The body
      // must not name a month (services/sms-guard.js would treat it as a stale
      // template render and block the 'invoice' send).
      const summary = buildPrepayCoverageSummary({
        ...quarterly,
        termStart: '2027-01-15',
        termEnd: '2028-01-15',
      });
      expect(summary.coverageSummary).not.toMatch(
        /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
      );
    });

    it('returns null when no visit count is configured (display-only flag)', () => {
      expect(buildPrepayCoverageSummary({ coverageVisitCount: null })).toBeNull();
      expect(buildPrepayCoverageSummary(null)).toBeNull();
    });
  });

  describe('buildCoverageVisits', () => {
    it('returns the dated quarterly schedule with each visit\'s share of the total', () => {
      const visits = buildCoverageVisits(
        {
          term_start: '2026-06-20',
          term_end: '2027-06-20',
          coverage_visit_count: 4,
          coverage_cadence: 'quarterly',
          coverage_service_type: 'Quarterly Pest Control',
        },
        528,
      );
      expect(visits.map((v) => v.date)).toEqual([
        '2026-06-20', '2026-09-20', '2026-12-20', '2027-03-20',
      ]);
      expect(visits.map((v) => v.amount)).toEqual([132, 132, 132, 132]);
    });

    it('splits visit dollars by the sold count so shares match the coverage ledger on a truncated term', () => {
      // term_end before the 3rd quarterly date truncates a 4-visit schedule to 2.
      const visits = buildCoverageVisits(
        {
          term_start: '2026-06-20',
          term_end: '2026-11-30',
          coverage_visit_count: 4,
          coverage_cadence: 'quarterly',
          coverage_service_type: 'Quarterly Pest Control',
        },
        528,
      );
      expect(visits.map((v) => v.date)).toEqual(['2026-06-20', '2026-09-20']);
      // Each share = total / sold count (528 / 4 = 132), matching the prepaid_amount
      // applyPrepaidCoverageForTerm stamps per covered visit. The rendered rows
      // intentionally sum to less than the prepay total on a truncated term.
      expect(visits.map((v) => v.amount)).toEqual([132, 132]);
    });

    it('returns an empty array when coverage is not configured', () => {
      expect(buildCoverageVisits({ term_start: '2026-06-20' }, 528)).toEqual([]);
      expect(buildCoverageVisits(null, 528)).toEqual([]);
    });
  });

  describe('resolveInvoiceTermId (visit fallback + anchor gate)', () => {
    // Minimal knex-shaped stub: conn(table).where(..).first(..) → the seeded row.
    const conn = ({ visitTermId = null, term = null } = {}) => (table) => ({
      where: () => ({
        first: async () => {
          if (table === 'scheduled_services') return { annual_prepay_term_id: visitTermId };
          if (table === 'annual_prepay_terms') return term;
          return null;
        },
      }),
    });

    it('uses the invoice\'s own term id when directly tagged (no visit query)', async () => {
      const boom = () => { throw new Error('should not query when already tagged'); };
      const id = await resolveInvoiceTermId(
        { annual_prepay_term_id: 'T1', scheduled_service_id: 'V1' }, boom,
      );
      expect(id).toBe('T1');
    });

    it('returns null when the invoice has neither a tag nor a visit', async () => {
      expect(await resolveInvoiceTermId({ id: 'I1' }, conn())).toBeNull();
    });

    it('returns null when the visit carries no term', async () => {
      const id = await resolveInvoiceTermId(
        { id: 'I1', scheduled_service_id: 'V1', total: 400 },
        conn({ visitTermId: null }),
      );
      expect(id).toBeNull();
    });

    it('accepts the visit term when the invoice IS the term\'s registered anchor', async () => {
      // The e10f9183 case: completion invoice registered as term.prepay_invoice_id.
      const id = await resolveInvoiceTermId(
        { id: 'INV1', scheduled_service_id: 'V1', total: 415.75 },
        conn({ visitTermId: 'T9', term: { id: 'T9', prepay_invoice_id: 'INV1', prepay_amount: '404.04' } }),
      );
      expect(id).toBe('T9');
    });

    it('accepts an anchor-scale amount when no anchor is registered yet (send-time)', async () => {
      // total 415.75 >= prepay 404.04 * 0.5, and the term hasn't registered the
      // invoice yet (untagged completion invoice at the moment the SMS goes out).
      const id = await resolveInvoiceTermId(
        { id: 'INV1', scheduled_service_id: 'V1', total: 415.75 },
        conn({ visitTermId: 'T9', term: { id: 'T9', prepay_invoice_id: null, prepay_amount: '404.04' } }),
      );
      expect(id).toBe('T9');
    });

    it('rejects a small residual on a covered visit when no anchor is registered (amount gate)', async () => {
      const id = await resolveInvoiceTermId(
        { id: 'ADDON', scheduled_service_id: 'V1', total: 32.34 },
        conn({ visitTermId: 'T9', term: { id: 'T9', prepay_invoice_id: null, prepay_amount: '404.04' } }),
      );
      expect(id).toBeNull();
    });

    it('rejects even a LARGE add-on when the term already registered a different anchor (Codex P1)', async () => {
      // prepay_invoice_id is set to another invoice, so this one is not the
      // prepayment regardless of amount — the amount fallback must not apply.
      const id = await resolveInvoiceTermId(
        { id: 'ADDON', scheduled_service_id: 'V1', total: 400 },
        conn({ visitTermId: 'T9', term: { id: 'T9', prepay_invoice_id: 'REAL_ANCHOR', prepay_amount: '404.04' } }),
      );
      expect(id).toBeNull();
    });

    it('never throws — a lookup failure resolves to null', async () => {
      const throwing = () => ({ where: () => ({ first: async () => { throw new Error('db down'); } }) });
      const id = await resolveInvoiceTermId({ id: 'I', scheduled_service_id: 'V', total: 400 }, throwing);
      expect(id).toBeNull();
    });
  });
});
