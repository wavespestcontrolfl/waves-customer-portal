/**
 * Store rating pop-up in the Waves customer app (GATE_APP_RATING_PROMPT, owner
 * 2026-11-02 "do the rating for everyone").
 *
 * The app (client/src/native/appRating.js) calls claimAppRatingAsk through
 * POST /api/customer/app-rating/claim at most once a day, from the second day
 * the phone runs the app. Every app customer qualifies (owner ruling: no
 * Google-review condition); the server only spaces the asks:
 *   - at least one finished visit, so the customer has used the service the
 *     app is about (both stores ask for a customer with real use), and
 *   - no ask of the same mode in the last 120 days, so Apple's limit of three
 *     cards a year spreads across the year instead of landing in one week.
 * on = write an 'on' row and answer ask:true (the app then asks the store,
 * which decides whether its card shows and never says what happened);
 * shadow = write a 'shadow' row and answer ask:false (counts who would be
 * asked, the app shows nothing); off = write nothing, ask:false.
 *
 * The check and the write are one INSERT … SELECT … WHERE NOT EXISTS, so a
 * claim is recorded before the app hears ask:true: a lost response costs one
 * 120-day window, never a second card. Two phones on one account claiming in
 * the same instant can both win; each phone then asks once, and the store's
 * own limit still caps the cards. Sends no text, email or call.
 */
const db = require('../models/db');
const { appRatingPromptMode } = require('../config/feature-gates');

const SPACING_DAYS = 120;
const PLATFORMS = ['ios', 'android'];

async function claimAppRatingAsk({ customerId, platform }) {
  const mode = appRatingPromptMode();
  if (mode === 'off' || !customerId || !PLATFORMS.includes(platform)) return { ask: false, mode };
  const result = await db.raw(
    `INSERT INTO app_rating_asks (customer_id, platform, mode)
     SELECT ?::uuid, ?, ?
      WHERE EXISTS (SELECT 1 FROM scheduled_services ss
                     WHERE ss.customer_id = ?::uuid AND ss.status = 'completed')
        AND NOT EXISTS (SELECT 1 FROM app_rating_asks a
                         WHERE a.customer_id = ?::uuid AND a.mode = ?
                           AND a.created_at > now() - (?::int * interval '1 day'))
     RETURNING id`,
    [customerId, platform, mode, customerId, customerId, mode, SPACING_DAYS],
  );
  const claimed = (result?.rows || []).length > 0;
  return { ask: claimed && mode === 'on', mode };
}

module.exports = { claimAppRatingAsk, SPACING_DAYS };
