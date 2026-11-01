/**
 * The proposal builder's "Add program" templates start on the commercial engine's visit counts (owner 2026-11-01,
 * audit fix 6). The client cannot import the server constants, so this fails when a template count and the engine's
 * COMMERCIAL_*.programVisits drift apart. Synthetic data only.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const {
  COMMERCIAL_PEST, COMMERCIAL_RODENT_BAIT, COMMERCIAL_TERMITE_BAIT, COMMERCIAL_MOSQUITO, COMMERCIAL_LAWN, COMMERCIAL_TREE_SHRUB,
} = require('../services/pricing-engine/constants');

const templatesPath = path.resolve(__dirname, '../../client/src/lib/commercialProgramTemplates.js');

function loadTemplates() {
  const { code } = esbuild.transformSync(fs.readFileSync(templatesPath, 'utf8'), { loader: 'js', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports.PROGRAM_TEMPLATES;
}

const ENGINE_VISITS = {
  pest: COMMERCIAL_PEST.programVisits,
  rodent: COMMERCIAL_RODENT_BAIT.programVisits,
  termite: COMMERCIAL_TERMITE_BAIT.programVisits,
  mosquito: COMMERCIAL_MOSQUITO.programVisits,
  lawn: COMMERCIAL_LAWN.programVisits,
  tree_shrub: COMMERCIAL_TREE_SHRUB.programVisits,
};

describe('proposal builder program templates vs the commercial engine', () => {
  const templates = loadTemplates();

  test('every template has an engine program, and every engine program has a template', () => {
    expect(templates.map((t) => t.service).sort()).toEqual(Object.keys(ENGINE_VISITS).sort());
  });

  test.each(Object.entries(ENGINE_VISITS))('%s starts on the engine visit count', (service, visits) => {
    expect(Number.isInteger(visits) && visits > 0).toBe(true);
    expect(templates.find((t) => t.service === service).frequencyPerYear).toBe(visits);
  });

  test('the counts are the commercial cadences, not the residential ones (lawn 8, not the retired bi-monthly 6)', () => {
    expect(Object.fromEntries(templates.map((t) => [t.service, t.frequencyPerYear]))).toEqual({
      pest: 12, rodent: 4, termite: 4, mosquito: 9, lawn: 8, tree_shrub: 6,
    });
  });
});
