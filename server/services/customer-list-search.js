'use strict';

// Customer-directory search stays accent-sensitive because the application
// does not require PostgreSQL's optional unaccent extension. Lower-casing and
// removing punctuation still makes Unicode names, apostrophes, and hyphens
// behave consistently without changing identity data.
const NAME_CHARACTERS = /[^\p{L}\p{N}]+/gu;

function normalizedSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ');
}

function customerSearchTerms(value) {
  return normalizedSearch(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function normalizedNameSearch(value) {
  return normalizedSearch(value)
    .toLowerCase()
    .replace(NAME_CHARACTERS, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function compactNameSearch(value) {
  return normalizedNameSearch(value).replace(/\s+/gu, '');
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

const firstNameSql = "regexp_replace(lower(COALESCE(customers.first_name, '')), '[^[:alnum:]]+', '', 'g')";
const lastNameSql = "regexp_replace(lower(COALESCE(customers.last_name, '')), '[^[:alnum:]]+', '', 'g')";
const forwardNameSql = `(${firstNameSql} || ${lastNameSql})`;
const reverseNameSql = `(${lastNameSql} || ${firstNameSql})`;
const hasFullNameSql = `(${firstNameSql} <> '' AND ${lastNameSql} <> '')`;
const searchableTextSql = `
  CONCAT_WS(' ',
    customers.first_name,
    customers.last_name,
    customers.company_name,
    customers.phone,
    customers.email,
    customers.address_line1,
    customers.address_line2,
    customers.city,
    customers.state,
    customers.zip,
    customers.account_id,
    customers.profile_label
  )
`;

const searchableColumns = [
  'first_name',
  'last_name',
  'phone',
  'email',
  'address_line1',
  'city',
  'company_name',
  'state',
  'zip',
  'profile_label',
];

// `homes`: also match any active home of the customer (office searches only:
// a technician's search must not reveal a customer's other homes).
function applyCustomerSearchFilter(query, value, { homes = false } = {}) {
  const search = normalizedSearch(value);
  if (!search) return query;

  const contains = `%${escapeLikePattern(search)}%`;
  const terms = customerSearchTerms(search);
  const compactName = compactNameSearch(search);
  const compactContains = compactName ? `%${escapeLikePattern(compactName)}%` : null;
  const isPhoneLike = /^[\d\s().+\-]+$/.test(search);
  const phoneDigits = isPhoneLike ? search.replace(/\D/g, '') : '';

  return query.where(function customerSearchWhere() {
    searchableColumns.forEach((column, index) => {
      const method = index === 0 ? 'whereRaw' : 'orWhereRaw';
      this[method](`COALESCE(customers.${column}::text, '') ILIKE ? ESCAPE '\\'`, [contains]);
    });
    this.orWhereRaw("COALESCE(customers.account_id::text, '') ILIKE ? ESCAPE '\\'", [contains])
      .orWhereRaw("CONCAT_WS(' ', customers.first_name, customers.last_name) ILIKE ? ESCAPE '\\'", [contains])
      .orWhereRaw(`${searchableTextSql} ILIKE ? ESCAPE '\\'`, [contains]);

    // Compact name matching treats punctuation and whitespace as separators,
    // so O'Neill/O-Neill/ONeill and Anne-Marie/Anne Marie can find each other.
    if (compactContains) {
      this.orWhereRaw(`${forwardNameSql} ILIKE ? ESCAPE '\\'`, [compactContains])
        .orWhereRaw(`${reverseNameSql} ILIKE ? ESCAPE '\\'`, [compactContains]);
    }

    // Keep the existing all-token fallback: it lets a phrase match fields in
    // the combined visible row even when punctuation or spacing differs.
    if (terms.length > 1) {
      this.orWhere(function customerSearchAllTerms() {
        terms.forEach((term) => {
          this.whereRaw(`${searchableTextSql} ILIKE ? ESCAPE '\\'`, [`%${escapeLikePattern(term)}%`]);
        });
      });
    }

    if (phoneDigits.length >= 3) {
      this.orWhereRaw("regexp_replace(COALESCE(customers.phone, ''), '[^0-9]', '', 'g') LIKE ? ESCAPE '\\'", [`%${phoneDigits}%`]);
    }

    // Any active home of the customer, not only the address on the customer
    // row: a second home's street finds its owner too.
    // Every word of the search must be a whole word of one home's address, so
    // a pasted "100 Main St, Apt 5, Sarasota, FL 34202" finds it as written and
    // "Apt 5" never matches the 5 in another home's ZIP or unit 52.
    const home = homes ? homeMatch(search) : null;
    if (home) this.orWhereRaw(`EXISTS (SELECT 1 FROM customer_properties cp WHERE ${home.sql})`, home.bindings);
  });
}

// An active home of the customer whose address holds every search word as a
// whole word; null when the search has no words.
function homeMatch(value) {
  const terms = customerSearchTerms(normalizedSearch(value));
  if (!terms.length) return null;
  const homeText = "CONCAT_WS(' ', cp.address_line1, cp.address_line2, cp.city, cp.state, cp.zip)";
  return {
    sql: `cp.customer_id = customers.id AND cp.active AND ${terms.map(() => `${homeText} ~* ?`).join(' AND ')}`,
    bindings: terms.map((term) => `\\m${term}\\M`),
  };
}

// The address of the home the search matched, so a customer found through a
// second home shows that home, not the address on the customer row. The
// primary home first; NULL when no home matched or there is no search.
function matchedHomeAddressSql(knex, value, { homes = false } = {}) {
  const home = homes === true && value ? homeMatch(value) : null;
  if (!home) return knex.raw('NULL::text as matched_home_address');
  return knex.raw(`(SELECT CONCAT_WS(', ', cp.address_line1, NULLIF(cp.address_line2, ''), cp.city)
    FROM customer_properties cp WHERE ${home.sql}
    ORDER BY cp.is_primary DESC NULLS LAST, cp.id LIMIT 1) as matched_home_address`, home.bindings);
}

function applyCustomerNameOrder(query, value, direction = 'asc') {
  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  const compactName = compactNameSearch(value);

  if (compactName) {
    const exact = compactName;
    const prefix = `${escapeLikePattern(compactName)}%`;
    const contains = `%${escapeLikePattern(compactName)}%`;
    query.orderByRaw(`
      CASE
        WHEN ${hasFullNameSql} AND (${forwardNameSql} = ? OR ${reverseNameSql} = ?) THEN 0
        WHEN ${lastNameSql} = ? THEN 1
        WHEN ${firstNameSql} = ? THEN 2
        WHEN ${hasFullNameSql} AND (${forwardNameSql} LIKE ? ESCAPE '\\' OR ${reverseNameSql} LIKE ? ESCAPE '\\') THEN 3
        WHEN ${lastNameSql} LIKE ? ESCAPE '\\' THEN 4
        WHEN ${firstNameSql} LIKE ? ESCAPE '\\' THEN 5
        WHEN ${forwardNameSql} LIKE ? ESCAPE '\\' OR ${reverseNameSql} LIKE ? ESCAPE '\\' THEN 6
        ELSE 7
      END ASC
    `, [exact, exact, exact, exact, prefix, prefix, prefix, prefix, contains, contains]);
  }

  return query
    .orderByRaw(`LOWER(NULLIF(BTRIM(customers.first_name), '')) ${dir} NULLS LAST`)
    .orderByRaw(`LOWER(NULLIF(BTRIM(customers.last_name), '')) ${dir} NULLS LAST`)
    .orderBy('customers.id', 'asc');
}

function applyStableCustomerOrder(query) {
  return query
    .orderByRaw("LOWER(NULLIF(BTRIM(customers.first_name), '')) ASC NULLS LAST")
    .orderByRaw("LOWER(NULLIF(BTRIM(customers.last_name), '')) ASC NULLS LAST")
    .orderBy('customers.id', 'asc');
}

module.exports = {
  applyCustomerNameOrder,
  applyCustomerSearchFilter,
  applyStableCustomerOrder,
  compactNameSearch,
  customerSearchTerms,
  escapeLikePattern,
  matchedHomeAddressSql,
  normalizedNameSearch,
  normalizedSearch,
};
