// In-app notification destinations under the saved-property scope
// (GATE_APP_PROPERTY_SCOPE). Pure, so both the push sink and the bell writer
// qualify a link the same way and tests can assert the REAL shape while the
// push provider is mocked.

// A relative in-app destination qualified with the profile it is about
// (`notificationProperty` — the app's route guard needs it before it will
// consider a house) and, when known, the saved property
// (`notificationPropertyId`). Absolute and protocol-relative URLs pass
// through untouched. Idempotent: re-qualifying overwrites, never duplicates.
function qualifyNotificationLink(url, customerId, propertyId = null) {
  const raw = String(url || '');
  if (!raw.startsWith('/') || raw.startsWith('//')) return url;
  const target = new URL(raw, 'https://portal.wavespestcontrol.com');
  target.searchParams.set('notificationProperty', String(customerId));
  if (propertyId) target.searchParams.set('notificationPropertyId', String(propertyId));
  return `${target.pathname}${target.search}${target.hash}`;
}

module.exports = { qualifyNotificationLink };
