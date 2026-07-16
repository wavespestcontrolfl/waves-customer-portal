/**
 * Per-category drip copy (estimate-followup-copy.js).
 *
 * Pins: category resolution folding rules (single residential lane keeps
 * its key, commercial_* folds to commercial, multi-lane folds to bundle,
 * unclassifiable folds to unknown), the always-complete email var set,
 * GSM-7 safety of every SMS-bound string, and the truth-scope rule —
 * recurring-terms claims (callbacks / 90-day / no-contract) never render
 * for rodent, termite, commercial, bundle, or unknown estimates.
 */

jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceLines: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { inferEstimateServiceLines } = require('../services/estimate-service-lines');
const {
  copyCategoryForEstimate,
  followupEmailVars,
  followupSmsHook,
  _private: { PACKS, RECURRING_TERMS_BENEFIT },
} = require('../services/estimate-followup-copy');

const EMAIL_VAR_KEYS = [
  'service_label',
  'category_headline',
  'category_hook',
  'category_benefit',
  'category_question',
];

// Basic GSM-7 alphabet (plus the escape-extension chars we allow). An SMS
// string outside this set flips the message to UCS-2 and doubles segments.
const GSM7 = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r^{}\\[\]~|€]*$/;

function lanes(...keys) {
  inferEstimateServiceLines.mockReturnValue(keys.map((key) => ({ key })));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('copyCategoryForEstimate', () => {
  test.each(['pest', 'lawn', 'mosquito', 'tree_shrub', 'palm_injection', 'rodent', 'termite'])(
    'single %s lane keeps its key', (key) => {
      lanes(key);
      expect(copyCategoryForEstimate({ id: 'e1' })).toBe(key);
    },
  );

  test('any commercial lane folds to commercial', () => {
    lanes('commercial_pest', 'pest');
    expect(copyCategoryForEstimate({ id: 'e1' })).toBe('commercial');
  });

  test('two residential lanes fold to bundle', () => {
    lanes('pest', 'lawn');
    expect(copyCategoryForEstimate({ id: 'e1' })).toBe('bundle');
  });

  test('unknown-only lanes fold to unknown', () => {
    lanes('unknown');
    expect(copyCategoryForEstimate({ id: 'e1' })).toBe('unknown');
  });

  test('inference failure fails soft to unknown (copy never blocks a send)', () => {
    inferEstimateServiceLines.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(copyCategoryForEstimate({ id: 'e1' })).toBe('unknown');
  });
});

describe('followupEmailVars', () => {
  const LANES_FOR = {
    pest: ['pest'],
    lawn: ['lawn'],
    mosquito: ['mosquito'],
    tree_shrub: ['tree_shrub'],
    palm_injection: ['palm_injection'],
    rodent: ['rodent'],
    termite: ['termite'],
    commercial: ['commercial_pest'],
    bundle: ['pest', 'lawn'],
    unknown: ['unknown'],
  };

  test('every category yields the complete, non-empty var set', () => {
    for (const category of Object.keys(PACKS)) {
      lanes(...LANES_FOR[category]);
      expect(copyCategoryForEstimate({ id: 'e1' })).toBe(category);
      const vars = followupEmailVars({ id: 'e1' });
      for (const key of EMAIL_VAR_KEYS) {
        expect(typeof vars[key]).toBe('string');
        expect(vars[key].length).toBeGreaterThan(0);
      }
    }
  });

  test('pest estimates speak pest', () => {
    lanes('pest');
    const vars = followupEmailVars({ id: 'e1' });
    expect(vars.service_label).toBe('pest control');
    expect(vars.category_headline).toContain('pest-free');
  });

  test('subjects stay <= 60 chars for every service_label', () => {
    for (const pack of Object.values(PACKS)) {
      expect(`Your Waves ${pack.label} estimate is ready to review`.length).toBeLessThanOrEqual(60);
      expect(`Questions about your Waves ${pack.label} estimate?`.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('truth scope — recurring-terms claims only where the estimate page makes them', () => {
  const NEUTRAL_CATEGORIES = ['rodent', 'termite', 'commercial', 'bundle', 'unknown'];

  test.each(NEUTRAL_CATEGORIES)('%s benefit line is terms-neutral', (category) => {
    const benefit = PACKS[category].benefit;
    expect(benefit).not.toMatch(/callback/i);
    expect(benefit).not.toMatch(/money-back/i);
    expect(benefit).not.toMatch(/contract/i);
  });

  test.each(['pest', 'lawn', 'mosquito', 'tree_shrub', 'palm_injection'])(
    '%s keeps the recurring-terms line', (category) => {
      expect(PACKS[category].benefit).toBe(RECURRING_TERMS_BENEFIT);
    },
  );
});

describe('followupSmsHook', () => {
  test('always returns a non-empty GSM-7 phrase', () => {
    for (const category of Object.keys(PACKS)) {
      const hook = PACKS[category].smsHook;
      expect(hook.length).toBeGreaterThan(0);
      expect(hook).toMatch(GSM7);
    }
    lanes('lawn');
    expect(followupSmsHook({ id: 'e1' })).toBe('greener-lawn program');
  });

  test('SMS labels are GSM-7 too (labels can ride SMS contexts)', () => {
    for (const pack of Object.values(PACKS)) {
      expect(pack.label).toMatch(GSM7);
    }
  });
});
