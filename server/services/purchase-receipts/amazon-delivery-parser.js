/**
 * purchase-receipts/amazon-delivery-parser.js — pure parser for Amazon
 * "Delivered" order-confirmation emails (and, for the itemless template
 * below, their sibling Ordered:/Shipped: emails).
 *
 * Only order-update@amazon.com messages whose subject starts with
 * "Delivered:" are Delivered candidates (e.g.
 * `Delivered: 2 "Atticus Talak 7.9 F..."`,
 * `Delivered: "Southern Ag Thuricide BT..." and 1 more item`,
 * `Delivered: 1 Lawn & Garden item`). body_text is empty on some of these —
 * extractText falls back to a stripped body_html.
 *
 * Real item-block shape (confirmed against prod): a line starting `* ` is
 * the title; its quantity is on the NEXT non-blank line by itself,
 * indented (`  Quantity: 4`) — never trailing the title on the same line.
 * A same-line "Quantity: N" is also accepted defensively (some other
 * Amazon template may still write it that way) but is not the common case.
 * A title with no quantity found either way is quantity 1.
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
 * the caller (sweep.js) can go look for the same order's items on a sibling
 * Ordered:/Shipped: email via parseAmazonOrderSiblingItems below.
 *
 * Deliberately knows nothing about products, matching, inventory units, or
 * the `emails` table — see product-matcher.js, receipt-processor.js and
 * sweep.js for the rest of the pipeline.
 */
const AMAZON_DELIVERY_FROM = 'order-update@amazon.com';
const AMAZON_ORDERED_FROM = 'auto-confirm@amazon.com';
const AMAZON_SHIPPED_FROM = 'shipment-tracking@amazon.com';
const ORDER_NUMBER_RE = /Order\s*#\s*([\d-]+)/i;
// The "Track package" (or "Track your package") link's shipmentId query
// param. Deliberately never the same URL's orderId=/orderID= — that value
// can legitimately differ from the "Order #" line for a multi-shipment
// order, and the Order # line is always the order-number source of truth.
const SHIPMENT_ID_RE = /[?&]shipmentId=([A-Za-z0-9._~-]+)/i;

function isAmazonDeliveredEmail(email) {
  const from = String(email?.from_address || '').trim().toLowerCase();
  const subject = String(email?.subject || '').trim();
  return from === AMAZON_DELIVERY_FROM && /^delivered:/i.test(subject);
}

// An "Ordered:" (auto-confirm@amazon.com) or "Shipped:" (shipment-tracking@
// amazon.com) email — used ONLY as an item-title/quantity source for an
// itemless Delivered email on the same order, never processed as its own
// delivery event (no stock is ever logged from one directly).
function isAmazonOrderSiblingEmail(email) {
  const from = String(email?.from_address || '').trim().toLowerCase();
  return from === AMAZON_ORDERED_FROM || from === AMAZON_SHIPPED_FROM;
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

function safeQuantity(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Item blocks: a line starting "* " is a title. Its quantity is either
// inline ("... Quantity: 4" trailing the same line — defensive) or, in the
// confirmed real template, alone on the NEXT non-blank line ("  Quantity:
// 4"); either way it is never Number()'d, only Number.parseInt on the
// captured digit group. No quantity found either way -> 1.
function parseItemBlocksFromText(text) {
  const rawLines = String(text || '').split('\n');
  const items = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line.startsWith('*')) continue;
    let title = line.replace(/^\*\s*/, '').trim();
    if (!title) continue;

    let quantity = 1;
    const inlineQty = title.match(/\s*quantity:\s*(\d+)\s*$/i);
    if (inlineQty) {
      quantity = safeQuantity(inlineQty[1]);
      title = title.slice(0, inlineQty.index).trim();
    } else {
      let j = i + 1;
      while (j < rawLines.length && rawLines[j].trim() === '') j++;
      if (j < rawLines.length) {
        const nextQty = rawLines[j].trim().match(/^quantity:\s*(\d+)\s*$/i);
        if (nextQty) quantity = safeQuantity(nextQty[1]);
      }
    }
    if (title) items.push({ title, quantity });
  }
  return items;
}

/**
 * @param {{from_address, subject, body_text, body_html, gmail_id, id}} email
 * @returns {{orderNumber: string|null, shipmentId: string|null, shipmentKey: string|null, items: {title:string, quantity:number}[]} | null}
 *   null only when the email isn't a Delivered candidate at all, or has
 *   neither an order number nor any items to work with. An itemless
 *   "N Lawn & Garden item(s)" template still returns an object (items: []).
 */
function parseAmazonDeliveredEmail(email) {
  if (!isAmazonDeliveredEmail(email)) return null;
  const text = extractText(email);
  if (!text) return null;
  const orderNumber = extractOrderNumber(text);
  const items = parseItemBlocksFromText(text);
  if (!orderNumber && !items.length) return null;
  const shipmentId = extractShipmentId(text);
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

/**
 * Item titles/quantities from a SIBLING Ordered:/Shipped: email for the
 * SAME order — only when its own from_address matches one of those two
 * senders and (when expectedOrderNumber is given) its own Order # line
 * matches exactly, never a substring coincidence elsewhere in the body.
 * Returns [] (never throws) when the email isn't a sibling, has no usable
 * text, its order number doesn't match, or it has no parseable item blocks
 * either — the caller (sweep.js) treats an empty result as "give up".
 */
function parseAmazonOrderSiblingItems(email, expectedOrderNumber) {
  if (!isAmazonOrderSiblingEmail(email)) return [];
  const text = extractText(email);
  if (!text) return [];
  if (expectedOrderNumber && extractOrderNumber(text) !== expectedOrderNumber) return [];
  return parseItemBlocksFromText(text);
}

module.exports = {
  parseAmazonDeliveredEmail,
  parseAmazonOrderSiblingItems,
  isAmazonDeliveredEmail,
  isAmazonOrderSiblingEmail,
  AMAZON_DELIVERY_FROM,
  AMAZON_ORDERED_FROM,
  AMAZON_SHIPPED_FROM,
};
