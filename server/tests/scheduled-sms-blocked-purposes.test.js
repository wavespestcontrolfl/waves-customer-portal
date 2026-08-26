// Source contracts for the consent split (owner ruling 08-25): the generic
// admin composer's schedule-sms endpoint must block EVERY marketing-grade
// purpose — when seasonal types moved from 'marketing' to
// 'marketing_seasonal', a stale two-entry set would have silently re-opened
// scheduling of seasonal marketing content.
const fs = require('fs');
const path = require('path');

const commsSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-communications.js'), 'utf8');
const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');

describe('schedule-sms marketing-grade block (consent split)', () => {
  test('BLOCKED_SCHEDULED_PURPOSES covers marketing, marketing_seasonal, and retention', () => {
    expect(commsSource).toContain(
      "const BLOCKED_SCHEDULED_PURPOSES = new Set(['marketing', 'marketing_seasonal', 'retention'])",
    );
  });

  test('scheduler maps seasonal message types to the seasonal consent lane', () => {
    expect(schedulerSource).toContain("if (type.includes('seasonal')) return 'marketing_seasonal';");
    // Legacy deferred rows that stored replay_purpose 'marketing' for
    // seasonal-lane content (seasonal_*, reactivation, deferred guide
    // document sends) must normalize to the seasonal lane at fire time —
    // otherwise a promotions-only opt-in would authorize seasonal content
    // and seasonal-only recipients would be blocked.
    expect(schedulerSource).toContain("legacyType.includes('seasonal')");
    expect(schedulerSource).toContain("legacyType.includes('reactivation')");
    // Deferred guide reminders store a generic entry point
    // (document_request_reminder_deferred) — the stored 'marketing'
    // replay_purpose on a document_request* row is itself the guide marker
    // (plain document requests replay under 'document_request').
    expect(schedulerSource).toContain("legacyType.startsWith('document_request')");
    expect(schedulerSource).toContain("legacyEntry.includes('guide')");
  });
});
