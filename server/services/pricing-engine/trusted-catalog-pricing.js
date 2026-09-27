'use strict';

// catalogPricing is a transient server-owned engine input. Browser-posted
// estimate_data can contain an older copy of the field, so every async engine
// boundary removes it first and, for trapping quotes, replaces it with an
// authoritative request-scoped catalog read.
async function withTrustedCatalogPricing(input, deps = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

  const trusted = { ...input };
  delete trusted.catalogPricing;
  if (!trusted.services?.rodentTrapping) return trusted;

  const readPrice = deps.readRodentAdditionalCheckPriceFromCatalog
    || require('./db-bridge').readRodentAdditionalCheckPriceFromCatalog;
  const database = deps.database || require('../../models/db');
  const rodentAdditionalCheckPrice = await readPrice(database);
  return {
    ...trusted,
    catalogPricing: { rodentAdditionalCheckPrice },
  };
}

module.exports = { withTrustedCatalogPricing };
