/**
 * JSON feed adapters for event_sources.feed_type = 'json'.
 *
 * A JSON source names its mapper in scrape_config.jsonAdapter. An adapter is
 * a pure function from the parsed response body to the extracted-event shape
 * the scrape and news-RSS paths already feed to upsertExtractedEvents
 * ({ title, startAt, venueName, city, description, eventUrl, imageUrl }), so
 * the window filters, ET parsing, dedup keys and upsert stay in one place.
 *
 * eventastic: the Eventastic WordPress plugin (Madden Media DMO sites, e.g.
 * bradentongulfislands.com) publishes its events as the public WP REST custom
 * post type /wp-json/wp/v2/event. Each item carries its schedule in
 * meta_fields (eventastic_start_date 'YYYY-MM-DD', eventastic_start_time
 * '10:00 am', eventastic_recurring_days, ...). The post `date` is only the
 * publish time, which is why the 2026-06 repair saw no event dates and the
 * 2026-07-11 migration disabled the source; the meta_fields block is the
 * real schedule.
 */

const { validDateOnly } = require('../utils/date-only');

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
};

function decodeEntities(text) {
  return String(text).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (dec || hex) {
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function plainText(html) {
  if (!html || typeof html !== 'string') return '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// '4:00 pm' / '12:30 AM' / '16:00' -> 'HH:MM', or null when absent or unreadable.
function to24Hour(raw) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(String(raw || ''));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Recurring items (weekly happy hours, farmers markets) are routine
// programming that the editorial rules exclude anyway, and their start_date is
// the series start, not an occurrence, so the adapter skips them.
function isRecurring(meta) {
  return (Array.isArray(meta.eventastic_recurring_days) && meta.eventastic_recurring_days.length > 0)
    || Boolean(nonEmptyString(meta.eventastic_recurring_repeat));
}

// The venue term name when the item has one, else its street address.
function venueFor(item, meta) {
  const term = Array.isArray(item.venue_name) ? nonEmptyString(item.venue_name[0]?.name) : '';
  const street = [nonEmptyString(meta.eventastic_addr1), nonEmptyString(meta.eventastic_addr2)].filter(Boolean).join(', ');
  return term || street || null;
}

// One Eventastic REST item -> extracted event, or null when it has no usable
// one-off schedule.
function eventasticItemToExtractedEvent(item) {
  const meta = item?.meta_fields;
  if (!meta || typeof meta !== 'object' || isRecurring(meta)) return null;

  const title = plainText(item.title?.rendered);
  const startDate = nonEmptyString(meta.eventastic_start_date);
  if (!title || !validDateOnly(startDate)) return null;

  // No start time listed: a bare date is ET midnight, as for any date-only event.
  const time = to24Hour(meta.eventastic_start_time);

  return {
    // The WordPress post id is the item's identity: a rescheduled or retitled
    // post must update its row, not add a second one.
    externalId: item.id != null && String(item.id).trim() ? `wp:${String(item.id).trim()}` : undefined,
    title,
    startAt: time ? `${startDate}T${time}:00` : startDate,
    venueName: venueFor(item, meta),
    city: nonEmptyString(meta.eventastic_city) || null,
    description: plainText(item.excerpt?.rendered) || plainText(item.content?.rendered) || null,
    eventUrl: nonEmptyString(item.link) || null,
    imageUrl: nonEmptyString(item.thumb_url) || null,
  };
}

function eventasticToExtractedEvents(body) {
  if (!Array.isArray(body)) throw new Error('Eventastic feed is not a JSON array');
  return body.map(eventasticItemToExtractedEvent).filter(Boolean);
}

const JSON_ADAPTERS = Object.freeze({
  eventastic: eventasticToExtractedEvents,
});

module.exports = {
  JSON_ADAPTERS,
  eventasticToExtractedEvents,
  eventasticItemToExtractedEvent,
};
