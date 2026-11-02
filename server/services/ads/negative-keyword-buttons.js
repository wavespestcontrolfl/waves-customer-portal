'use strict';

// The bell's Add / Decline buttons on an advisor word's row (owner plan A, 2026-11-02: "Your word list goes to Google
// automatically, and the advisor drafts new words for your one-click yes or no. Every block can be undone."; docs/
// admin-notifications.md section 2, part 9, kind negative_keyword; GATE_ADS_NEGATIVES). A tap runs the same server step
// as the Ads page (negative-keyword-actions.js decideSuggestion). It sends nothing to a customer and moves no money; Add
// changes where the ad can show in Google Ads, and Undo is on the Ads page.

const db = require('../../models/db');

const KIND = 'negative_keyword';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEMS = {
  add: { label: 'Add', prompt: 'Block this word in Google Ads now?' },
  decline: { label: 'Decline' },
};

// Stored on the row when it is raised (negative-keyword-actions.js negativeBellSpec); visibleItems decides which ones
// the bell shows.
const negativeButtons = () => ({
  kind: KIND,
  items: Object.entries(ITEMS).map(([id, { label, prompt }]) => ({ id, label, ...(prompt ? { prompt } : {}) })),
});

const negativeIdOf = (metadata) => (UUID.test(String(metadata?.negativeId || '')) ? String(metadata.negativeId) : null);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// Serving the bell: one read for every word row on the page. Only a word still waiting on the owner serves buttons.
async function visibleItems(rows) {
  const ids = [...new Set(rows.map((row) => negativeIdOf(row.metadata)).filter(Boolean))];
  const found = ids.length ? await db('ad_negative_keywords').whereIn('id', ids).select('id', 'state') : [];
  const state = new Map(found.map((r) => [String(r.id), r.state]));
  return new Map(rows.map((row) => [row.id, state.get(negativeIdOf(row.metadata)) === 'pending' ? Object.keys(ITEMS) : []]));
}

// code -> what the bell does. `close` is the resolution for a row whose word was already answered elsewhere; a row whose
// Google call failed stays open so the owner can tap again.
const REFUSALS = {
  decided: { close: 'Already decided on the Ads page' },
  gone: { close: 'This word is no longer on the Ads page' },
  protected: { close: 'Not added: the word could block searches you want' },
  converted: { close: 'Not added: a search with this word brought a conversion' },
};

async function run({ row, item, technicianId }) {
  const choice = Object.hasOwn(ITEMS, item.id) ? item.id : null;
  if (!choice) return { ok: false, code: 'unknown_action', message: 'This button is not known.' };
  const negativeId = negativeIdOf(parseMetadata(row.metadata));
  if (!negativeId) return { ok: false, code: 'gone', message: 'This word is no longer on the Ads page.', close: REFUSALS.gone.close };
  const result = await require('./negative-keyword-actions').decideSuggestion(negativeId, choice, { by: technicianId });
  if (result.ok) return { ok: true, message: result.message, resolution: choice === 'add' ? 'Added' : 'Declined' };
  const refusal = REFUSALS[result.code];
  return { ok: false, code: result.code, message: result.message, ...(refusal ? { close: refusal.close } : {}) };
}

const buttonHandler = {
  live: () => require('../../config/feature-gates').adsNegativesLive(),
  visibleItems,
  run,
};

module.exports = { negativeButtons, buttonHandler, _private: { ITEMS, REFUSALS, negativeIdOf } };
