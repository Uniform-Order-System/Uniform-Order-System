/**
 * Heuristic parser for WhatsApp uniform orders.
 * Real-world WhatsApp orders are messy ("3 shirt 32 size", "pinafore-2 (34)", etc).
 * This parser is intentionally rule-based and transparent (not a black-box AI call),
 * so you can see exactly why it extracted what it extracted, and tune the keyword
 * lists below as you see real order patterns.
 *
 * It is deliberately conservative: if a line doesn't clearly match, the whole
 * order is flagged needs_review = 1 so a human checks it in the dashboard
 * instead of silently guessing wrong.
 */

// Add/edit these as your product range dictates
const ITEM_KEYWORDS = [
  'shirt', 'trouser', 'pant', 'pinafore', 'skirt', 'tie', 'blazer',
  'tunic', 'shorts', 'frock', 'sweater', 'pullover', 'tracksuit',
  'track suit', 'socks', 'belt', 'cap', 'kurta', 'salwar', 'apron'
];

// e.g. "32", "8-9", "8-9yr", "M", "XL", "34\""
const SIZE_REGEX = /\b(\d{1,2}\s*-\s*\d{1,2}\s*(?:yr|yrs|years)?|\d{2}\"?|XXL|XL|L|M|S)\b/i;
const QTY_REGEX = /\b(\d{1,3})\s*(?:pcs|pc|x|nos|no)?\b/i;
const DATE_REGEX = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/;
const PHONE_NAME_HINT = /(?:name|customer|for)\s*[:\-]\s*([A-Za-z ]{2,40})/i;
const SCHOOL_HINT = /([A-Za-z.&' ]{3,50}\bSchool\b[A-Za-z.&' ]{0,20})/i;

function parseOrderMessage(rawMessage, customerPhone) {
  const lines = rawMessage
    .split(/\r?\n|;/)
    .map(l => l.trim())
    .filter(Boolean);

  const items = [];
  let needsReview = false;
  let schoolName = null;
  let customerName = null;
  let deliveryDate = null;

  const schoolMatch = rawMessage.match(SCHOOL_HINT);
  if (schoolMatch) schoolName = schoolMatch[1].trim();

  const nameMatch = rawMessage.match(PHONE_NAME_HINT);
  if (nameMatch) customerName = nameMatch[1].trim();

  const dateMatch = rawMessage.match(DATE_REGEX);
  if (dateMatch) deliveryDate = dateMatch[1];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const foundItem = ITEM_KEYWORDS.find(kw => lower.includes(kw));

    // Skip lines that are clearly just metadata (name/school/date lines) already captured
    if (!foundItem) {
      if (SCHOOL_HINT.test(line) || PHONE_NAME_HINT.test(line)) continue;
      // Unrecognized line with no item keyword -> flag for review, but keep raw text visible
      needsReview = true;
      continue;
    }

    const sizeMatch = line.match(SIZE_REGEX);
    const qtyMatch = line.match(QTY_REGEX);

    const item = {
      item_type: capitalize(foundItem),
      size: sizeMatch ? sizeMatch[1].toUpperCase() : null,
      quantity: qtyMatch ? parseInt(qtyMatch[1], 10) : 1
    };

    if (!item.size) needsReview = true; // size missing -> needs human check
    items.push(item);
  }

  if (items.length === 0) needsReview = true;

  return {
    customer_name: customerName,
    customer_phone: customerPhone || null,
    school_name: schoolName,
    delivery_date: deliveryDate,
    items,
    needs_review: needsReview ? 1 : 0,
    raw_message: rawMessage
  };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { parseOrderMessage };
