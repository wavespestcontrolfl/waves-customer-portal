// The service name in the recurring placement text ("your next Waves
// Monthly Mosquito Control Service is ..."), owner 2026-10-26.
//
// It is the SAME customer-facing label the appointment reminders and the
// tech-arrived text use (appointment-reminders buildServiceLabel: admin
// suffixes stripped, add-ons joined, the accepted-estimate name recovered).
// No new naming rule. Legacy rows hold junk in service_type (a Square
// variation description like "- 1 hour - $117", or a random code); a junk
// name must not reach a customer, so the caller gets the word "visit" and
// the text reads "your next Waves visit is ...", as it did before.

const FALLBACK_NAME = 'visit';

// True when the text looks like a name a customer would recognise.
function isCleanServiceName(name) {
  const text = String(name == null ? '' : name).trim();
  if (!text || text.length > 120) return false;
  if (text.toLowerCase() === 'service') return false; // buildServiceLabel's "no label" placeholder
  if (!/^[A-Za-z]/.test(text)) return false; // "- 1 hour - $117", "$89.00", "30 min"
  if (/\$\s*\d/.test(text)) return false; // a price
  if (/\b\d+\s*(hour|hr|min)/i.test(text)) return false; // a duration
  if (!/\s/.test(text)) {
    if (/\d/.test(text)) return false; // "I6TSOQXQWTGW6UMLL2XATXDU"
    if (text.length >= 12 && text === text.toUpperCase()) return false;
  }
  return true;
}

// Never throws: any lookup failure reads as "visit".
async function placementServiceName(scheduledServiceId, rawServiceType) {
  try {
    if (!isCleanServiceName(rawServiceType)) return FALLBACK_NAME;
    const { buildServiceLabel } = require('./appointment-reminders');
    const label = String(await buildServiceLabel(scheduledServiceId, rawServiceType) || '').trim();
    return isCleanServiceName(label) ? label : FALLBACK_NAME;
  } catch {
    return FALLBACK_NAME;
  }
}

const PLACEMENT_TEMPLATE_KEY = 'appointment_recurring_placement_confirmed';

// Extra template variables for the series notice: only the placement copy has
// {service_name}; the series-moved copy gets nothing and costs no lookup.
async function seriesNoticeNameVars(templateKey, scheduledServiceId, rawServiceType) {
  if (templateKey !== PLACEMENT_TEMPLATE_KEY) return {};
  return { service_name: await placementServiceName(scheduledServiceId, rawServiceType) };
}

module.exports = { seriesNoticeNameVars, placementServiceName, isCleanServiceName, FALLBACK_NAME };
