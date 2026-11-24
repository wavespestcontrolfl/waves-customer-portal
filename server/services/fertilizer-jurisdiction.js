const { resolveAddressCounty } = require('../config/address-county');
const { stampedAddressDiverges } = require('./stamped-address');
const { streetKey } = require('./customer-property-address-keys');

const trimmed = (value) => String(value || '').trim();

// A visit booked at a second address uses its own city and ZIP. A primary-home
// county or missing address component can only carry over to a matching street.
function resolveOrdinanceJurisdiction(service = {}, profile = service) {
  const stampedCity = trimmed(service.service_address_city);
  const stampedZip = trimmed(service.service_address_zip);
  const stampedStreet = trimmed(service.service_address_line1);
  const customerCity = trimmed(service.city);
  const customerZip = trimmed(service.customer_zip || service.zip);
  const profileCity = trimmed(profile?.municipality);
  if ([stampedStreet, stampedCity, stampedZip].some(Boolean)) {
    const atHome = streetKey(stampedStreet) && !stampedAddressDiverges({
      ...service,
      customer_address_line1: service.customer_address_line1 || service.address_line1,
      customer_city: customerCity,
      customer_zip: customerZip,
    });
    const profileCityChanged = stampedCity && profileCity && stampedCity.toLowerCase() !== profileCity.toLowerCase();
    if (!atHome || profileCityChanged) {
      return { city: stampedCity, county: resolveAddressCounty({ city: stampedCity, zip: stampedZip }) || '' };
    }
  }
  const city = stampedCity || profileCity || customerCity;
  const county = trimmed(profile?.county) || resolveAddressCounty({ city, zip: stampedZip || customerZip }) || '';
  return { city, county };
}

async function getApplicableOrdinances(knex, { county, city }) {
  if (!county && !city) return [];

  let query = knex('municipality_ordinances').where({ active: true });
  query = query.where(function () {
    if (county) this.orWhere(function () {
      this.where({ jurisdiction_type: 'county' }).whereILike('county', county);
    });
    if (city) this.orWhere(function () {
      this.where({ jurisdiction_type: 'city' }).whereILike('city', city);
    });
  });
  return query;
}

module.exports = { getApplicableOrdinances, resolveOrdinanceJurisdiction };
