/**
 * purchase-receipts/amazon-delivery-parser.js — pure parser for Amazon
 * "Delivered" order-confirmation emails.
 *
 * Only order-update@amazon.com messages whose subject starts with
 * "Delivered:" are candidates (e.g. `Delivered: 2 "Atticus Talak 7.9 F..."`,
 * `Delivered: "Southern Ag Thuricide BT..." and 1 more item`). body_text is
 * empty on some of these — the caller (email-classifier's raw HTML) has
 * already been stripped down to plain text with one `* <title> Quantity: N`
 * line per item by the time it reaches this parser; a missing Quantity line
 * means quantity 1 (single-item deliveries commonly omit it).
 *
 * Deliberately knows nothing about products, matching, or inventory units —
 * see product-matcher.js and receipt-processor.js for the rest of the
 * pipeline.
 */
const AMAZON_DELIVERY_FROM = 'order-update@amazon.com';
const ORDER_NUMBER_RE = /Order\s*#\s*([\d-]+)/i;

function isAmazonDeliveredEmail(email) {
  const from = String(email?.from_address || '').trim().toLowerCase();
  const subject = String(email?.subject || '').trim();
  return from === AMAZON_DELIVERY_FROM && /^delivered:/i.test(subject);
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

// A single item block: `* <title> Quantity: <n>` — the quantity, when
// present, always trails the title. Never Number() the raw match; parseInt
// on the captured digit group is the extent of the numeric handling here.
function parseItemLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line.startsWith('*')) return null;
  let body = line.replace(/^\*\s*/, '').trim();
  if (!body) return null;
  const qtyMatch = body.match(/\s*quantity:\s*(\d+)\s*$/i);
  let quantity = 1;
  if (qtyMatch) {
    const parsedQty = Number.parseInt(qtyMatch[1], 10);
    quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
    body = body.slice(0, qtyMatch.index).trim();
  }
  if (!body) return null;
  return { title: body, quantity };
}

/**
 * @param {{from_address, subject, body_text, body_html}} email
 * @returns {{orderNumber: string|null, items: {title:string, quantity:number}[]} | null}
 */
function parseAmazonDeliveredEmail(email) {
  if (!isAmazonDeliveredEmail(email)) return null;
  const text = extractText(email);
  if (!text) return null;
  const orderMatch = text.match(ORDER_NUMBER_RE);
  const orderNumber = orderMatch ? orderMatch[1] : null;
  const items = [];
  for (const rawLine of text.split('\n')) {
    const item = parseItemLine(rawLine);
    if (item) items.push(item);
  }
  if (!items.length) return null;
  return { orderNumber, items };
}

module.exports = { parseAmazonDeliveredEmail, isAmazonDeliveredEmail, AMAZON_DELIVERY_FROM };
