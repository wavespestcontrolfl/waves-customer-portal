/**
 * purchase-receipts/amazon-delivery-parser.js — pure parser for Amazon
 * "Delivered" order-confirmation emails.
 *
 * Only order-update@amazon.com messages whose subject starts with
 * "Delivered:" are Delivered candidates (e.g.
 * `Delivered: 2 "Atticus Talak 7.9 F..."`,
 * `Delivered: "Southern Ag Thuricide BT..." and 1 more item`,
 * `Delivered: 1 Lawn & Garden item`). body_text is empty on some of these —
 * extractText falls back to a stripped body_html. from/subject are
 * spoofable text, though — the caller (sweep.js) MUST check aligned
 * SPF/DKIM authentication before treating anything parsed here as license
 * to write stock; this module has no opinion on authentication.
 *
 * Real item-block shape (confirmed against prod): a line starting `* ` is
 * the title; its quantity is on the NEXT non-blank line by itself,
 * indented (`  Quantity: 4`) — never trailing the title on the same line.
 * A same-line "Quantity: N" is also accepted defensively (some other
 * Amazon template may still write it that way) but is not the common case.
 * A title with no quantity found either way is quantity 1; an explicit
 * quantity that isn't a whole number above 0 ("0", "unknown") is null — the
 * sweep holds that line for review rather than guessing a count.
 *
 * Order # sits on its own "Order #" line with the number on the line right
 * after it (or, defensively, trailing on the same line) — this is always
 * the number used, never the `orderId=`/`shipmentId=` query params on the
 * "Track package" URL, which can legitimately differ from the Order # for
 * a multi-shipment order.
 *
 * "Delivered: N Lawn & Garden item(s)" is a template with an Order # and a
 * Track link but NO `* title` blocks at all — parseAmazonDeliveredEmail
 * still returns an object (orderNumber set, items: []) rather than null, so
 * the caller (sweep.js) can record a single 'no_items' placeholder line
 * instead of silently dropping the delivery. (An earlier version of this
 * lane tried recovering the items from a sibling Ordered:/Shipped: email —
 * removed: it can't tie an item to a SPECIFIC shipment, so a multi-shipment
 * order would log the whole order's items once per itemless package, and a
 * replay against every prod itemless Delivered email recovered zero items
 * from it anyway.)
 *
 * Deliberately knows nothing about products, matching, inventory units, or
 * the `emails` table — see product-matcher.js, receipt-processor.js and
 * sweep.js for the rest of the pipeline.
 */
const AMAZON_DELIVERY_FROM = 'order-update@amazon.com';
// "Shipped:" mail for the same shipment. It carries the same Order #, item
// blocks and Track-link shipmentId as the later Delivered email (checked
// against every real pair), which is what lets undelivered-shipments.js
// notice a shipment whose Delivered email never came.
const AMAZON_SHIPPED_FROM = 'shipment-tracking@amazon.com';
const ORDER_NUMBER_RE = /Order\s*#\s*([\d-]+)/i;
// The "Track package" (or "Track your package") link's shipmentId query
// param: plain in body_text (`?shipmentId=X`), `&amp;shipmentId=X` in raw
// HTML, or URL-encoded inside Amazon's redirect link (`%26shipmentId%3DX`,
// the form every real delivery's body_html carries). Deliberately never the
// same URL's orderId=/orderID= — that value can legitimately differ from
// the "Order #" line for a multi-shipment order, and the Order # line is
// always the order-number source of truth.
const SHIPMENT_ID_RE = /(?:[?&;]|%26)shipmentId(?:=|%3D)([A-Za-z0-9._~-]+)/i;

function isAmazonDeliveredEmail(email) {
  const from = String(email?.from_address || '').trim().toLowerCase();
  const subject = String(email?.subject || '').trim();
  return from === AMAZON_DELIVERY_FROM && /^delivered:/i.test(subject);
}

function isAmazonShippedEmail(email) {
  const from = String(email?.from_address || '').trim().toLowerCase();
  const subject = String(email?.subject || '').trim();
  return from === AMAZON_SHIPPED_FROM && /^shipped:/i.test(subject);
}

// The classifier only ever hands this parser already-plain text; stripping
// HTML here as well is deliberately defensive (some rows apparently arrive
// with an empty body_text and only body_html) rather than a proper HTML
// parse. It removes tags/entities, never chemistry: it must never be
// confused with a pack-size parser (see product-costing.js for that).
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function extractText(email) {
  const bodyText = String(email?.body_text || '').trim();
  if (bodyText) return bodyText;
  return stripHtml(email?.body_html);
}

function extractOrderNumber(text) {
  const m = String(text || '').match(ORDER_NUMBER_RE);
  return m ? m[1] : null;
}

function extractShipmentId(text) {
  const m = String(text || '').match(SHIPMENT_ID_RE);
  return m ? m[1] : null;
}

// A quantity label ("Quantity:", "Qty") and EVERYTHING after it, so a value
// like "2 units" is judged whole rather than read as absent.
const QUANTITY_LINE_RE = /^(?:quantity|qty)\b\s*:?\s*(.*)$/i;
const QUANTITY_INLINE_RE = /\s*\b(?:quantity|qty)\s*:\s*(.*)$/i;

// An explicit "Quantity: N": a whole number above 0 ("2", "2.0"), else null.
function explicitQuantity(raw) {
  const match = String(raw).trim().match(/^(\d+)(?:\.0+)?$/);
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : null;
}

// Item blocks: a line starting "* " is a title. Its quantity is either
// inline ("... Quantity: 4" trailing the same line — defensive) or, in the
// confirmed real template, alone on the NEXT non-blank line ("  Quantity:
// 4"). No quantity label either way -> 1; a labelled value that isn't a
// clean whole number ("2 units", "not available") -> null.
function parseItemBlocksFromText(text) {
  const rawLines = String(text || '').split('\n');
  const items = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line.startsWith('*')) continue;
    let title = line.replace(/^\*\s*/, '').trim();
    if (!title) continue;

    let quantity = 1;
    const inlineQty = title.match(QUANTITY_INLINE_RE);
    if (inlineQty) {
      quantity = explicitQuantity(inlineQty[1]);
      title = title.slice(0, inlineQty.index).trim();
    } else {
      let j = i + 1;
      while (j < rawLines.length && rawLines[j].trim() === '') j++;
      if (j < rawLines.length) {
        const nextQty = rawLines[j].trim().match(QUANTITY_LINE_RE);
        if (nextQty) quantity = explicitQuantity(nextQty[1]);
      }
    }
    if (title) items.push({ title, quantity });
  }
  return items;
}

/**
 * @param {{from_address, subject, body_text, body_html, gmail_id, id}} email
 * @returns {{orderNumber: string|null, shipmentId: string|null, shipmentKey: string|null, items: {title:string, quantity:number}[]} | null}
 *   null only when the email isn't a Delivered candidate at all. Every
 *   candidate returns an object, even with no readable Order # or items
 *   (orderNumber: null / items: []), so the caller records a held line for
 *   review rather than letting an unreadable delivery vanish.
 */
function parseAmazonDeliveredEmail(email) {
  return isAmazonDeliveredEmail(email) ? parseOrderEmail(email) : null;
}

// The same shape for a "Shipped:" email; null when it isn't one.
function parseAmazonShippedEmail(email) {
  return isAmazonShippedEmail(email) ? parseOrderEmail(email) : null;
}

function parseOrderEmail(email) {
  const text = extractText(email);
  const orderNumber = extractOrderNumber(text);
  const items = parseItemBlocksFromText(text);
  // stripHtml drops hrefs, so an HTML-only email is also searched raw —
  // otherwise its shipment falls back to the email's own identity, and a
  // second email for the same shipment would get a different claim key.
  const shipmentId = extractShipmentId(text) || extractShipmentId(email?.body_html);
  return {
    orderNumber,
    shipmentId: shipmentId || null,
    // Falls back to the email's own identity so a delivery with no
    // discoverable shipmentId still gets its own idempotency claim instead
    // of colliding with (and being dropped as a duplicate of) another
    // shipment on the same order.
    shipmentKey: shipmentId || email?.gmail_id || email?.id || null,
    items,
  };
}

module.exports = {
  extractText,
  parseAmazonDeliveredEmail,
  parseAmazonShippedEmail,
  isAmazonDeliveredEmail,
  AMAZON_DELIVERY_FROM,
  AMAZON_SHIPPED_FROM,
};
