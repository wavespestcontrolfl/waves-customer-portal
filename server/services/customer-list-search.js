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

function applyCustomerSearchFilter(query, value) {
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
  });
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
  normalizedNameSearch,
  normalizedSearch,
};
