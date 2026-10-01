/**
 * Directory-listing auditor: the five states, the blocked-fetch-is-never-missing
 * rule, mismatch field reporting, and NAP selection from config/locations.js.
 * No network: classifyListing is pure; audit() runs the REAL contact-finder
 * fetchPage (private-host refusal, redirect re-check) over a mocked fetchFn
 * and a mocked DNS resolver.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const auditor = require('../services/seo/citation-auditor');
const { WAVES_LOCATIONS } = require('../config/locations');

const { classifyListing, candidatesFor, normalizeStreet, streetOfAddress, STATES } = auditor._internals;
const BRAND = WAVES_LOCATIONS[0];
const PARRISH = WAVES_LOCATIONS.find((l) => l.id === 'parrish');

const filler = ' Licensed pest control company serving the Gulf Coast with quarterly service plans.'.repeat(4);
const page = (body, over = {}) => ({
  status: 200, finalUrl: 'https://dir.example/waves', redirectHops: 0, html: `<html><head><title>Waves Pest Control - Listing</title></head><body>${body}${filler}</body></html>`,
  blocked: false, truncated: false, contentType: 'text/html', error: null, ...over,
});
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe('classifyListing', () => {
  const expected = candidatesFor({});

  test('verified: name and phone match, address matched when shown', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>Call (941) 318-7612 - 13649 Luxe Ave #110, Bradenton, FL 34211</p>`), expected);
    expect(r.status).toBe('verified');
    expect(r.detail).toMatchObject({ address_checked: true, office: BRAND.id });
    expect(r.nap).toMatchObject({ nap_name: 'Waves Pest Control', nap_phone: BRAND.phone });
  });

  test('verified without an address when the page shows none', () => {
    const r = classifyListing(page('<h1>Waves Pest Control</h1><a href="tel:+19413187612">call</a>'), expected);
    expect(r.status).toBe('verified');
    expect(r.detail.address_checked).toBe(false);
  });

  test('a stated (JSON-LD) phone that is not ours is mismatched, naming the field and the value seen', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: '(941) 555-0142' })}`), expected);
    expect(r.status).toBe('mismatched');
    expect(r.detail.mismatches).toEqual([{ field: 'phone', expected: WAVES_LOCATIONS.map((l) => l.phone).join(' or '), seen: ['(941) 555-0142'] }]);
    expect(r.nap.nap_phone).toBe('(941) 555-0142');
  });

  test('expanded JSON-LD (schema.org IRI keys, @value arrays) is read like compact JSON-LD', () => {
    const S = 'https://schema.org/';
    const expandedLd = (phone) => ld([{ '@type': [`${S}LocalBusiness`], [`${S}name`]: [{ '@value': 'Waves Pest Control' }], [`${S}telephone`]: [{ '@value': phone }] }]);
    const conflicting = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${expandedLd('(941) 555-0142')}`), expected);
    expect(conflicting.status).toBe('mismatched');
    expect(conflicting.detail.mismatches).toEqual([{ field: 'phone', expected: WAVES_LOCATIONS.map((l) => l.phone).join(' or '), seen: ['(941) 555-0142'] }]);
    expect(classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${expandedLd(BRAND.phone)}`), expected).status).toBe('verified');
    const addr = ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, 'schema:address': { 'schema:streetAddress': '99 Old Rd', 'schema:addressLocality': 'Tampa' } });
    expect(classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${addr}`), expected).status).toBe('mismatched');
  });

  test('flattened JSON-LD: an address linked by @id is read from its node; an unknown link is not "no address"', () => {
    const S = 'https://schema.org/';
    const biz = { '@id': '_:biz', '@type': [`${S}LocalBusiness`], [`${S}name`]: [{ '@value': 'Waves Pest Control' }], [`${S}telephone`]: [{ '@value': BRAND.phone }], [`${S}address`]: [{ '@id': '_:address' }] };
    const addrNode = { '@id': '_:address', '@type': [`${S}PostalAddress`], [`${S}streetAddress`]: [{ '@value': '99 Old Rd' }], [`${S}addressLocality`]: [{ '@value': 'Tampa' }] };
    const body = `<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`;
    const linked = classifyListing(page(`${body}${ld([biz, addrNode])}`), expected);
    expect(linked.status).toBe('mismatched');
    expect(linked.detail.mismatches.map((m) => m.field)).toEqual(expect.arrayContaining(['address', 'city']));
    expect(classifyListing(page(`${body}${ld({ '@graph': [biz] })}${ld(addrNode)}`), expected).status).toBe('mismatched'); // across blocks
    const dangling = classifyListing(page(`${body}${ld([biz])}`), expected);
    expect(dangling.status).toBe('unverified');
    expect(dangling.detail.reason).toBe('address_unconfirmed');
  });

  test('mismatched structured address reports the address seen', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '99 Old Rd', addressLocality: 'Tampa', postalCode: '33601' } })}`), expected);
    expect(r.status).toBe('mismatched');
    expect(r.detail.mismatches).toEqual([
      { field: 'address', expected: BRAND.address, seen: '99 Old Rd, Tampa, 33601' },
      { field: 'city', expected: 'Bradenton or Lakewood Ranch', seen: 'Tampa' },
      { field: 'postal_code', expected: '34211', seen: '33601' },
    ]);
  });

  test('a wrong visible address next to the right name and phone is NOT verified (no JSON-LD)', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><p>99 Old Rd, Tampa, FL 33601</p>`), candidatesFor({}));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatchObject({ reason: 'address_unconfirmed', seen: '99 Old Rd' });
  });

  test('a sidebar of other businesses\' addresses is not a mismatch — it stays unverified unless JSON-LD says so', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><aside>Nearby: 410 Main Street, Bradenton; 22 Palm Avenue, Sarasota</aside>`), candidatesFor({}));
    expect(r.status).toBe('unverified');
    expect(r.detail.reason).toBe('address_unconfirmed');
    expect(r.detail.seen).toBe('410 Main Street');
  });

  test('our address anywhere on the page confirms it even beside other addresses', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><aside>410 Main Street, Bradenton</aside><footer>${BRAND.address}</footer>`), candidatesFor({}));
    expect(r.status).toBe('verified');
    expect(r.detail.address_checked).toBe(true);
  });

  test('a brand row must match the address of the office whose phone matched', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${PARRISH.phone}</p><p>${BRAND.address}</p>`), candidatesFor({}));
    expect(r.status).toBe('unverified');
    expect(r.detail).toMatchObject({ reason: 'address_unconfirmed', office: 'parrish' });
  });

  test('no address-like string at all: name + phone decide', () => {
    expect(classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><p>Serving Manatee and Sarasota counties since 2019.</p>`), candidatesFor({})).status).toBe('verified');
  });

  describe('street matching is on the FULL normalized street, never a partial', () => {
    const SARASOTA = WAVES_LOCATIONS.find((l) => l.id === 'sarasota');
    const VENICE = WAVES_LOCATIONS.find((l) => l.id === 'venice');
    const forOffice = (loc, addressText) => classifyListing(page(`<h1>Waves Pest Control</h1><p>${loc.phone}</p><p>${addressText}</p>`), candidatesFor({ location_id: loc.id }));

    test('expected streets normalize to number + full name + suffix (+ directional)', () => {
      expect(WAVES_LOCATIONS.map((l) => streetOfAddress(l.address))).toEqual([
        '13649 luxe avenue', '5155 115th circle east', '1450 pine warbler place', '1978 south tamiami trail',
      ]);
      expect(normalizeStreet('1978 S. Tamiami Trl #10, Venice')).toBe('1978 south tamiami trail venice');
      expect(normalizeStreet('13649 Luxe Ave Suite 110')).toBe('13649 luxe avenue');
    });

    test('"1450 Pine Street, Tampa" is NOT confirmed against 1450 Pine Warbler PL', () => {
      const r = forOffice(SARASOTA, '1450 Pine Street, Tampa, FL');
      expect(r.status).toBe('unverified');
      expect(r.detail).toMatchObject({ reason: 'address_unconfirmed', seen: '1450 Pine Street' });
    });

    test.each(['1450 Pine Warbler Pl, Sarasota, FL 34240', '1450 PINE WARBLER PLACE, SARASOTA, FLORIDA 34240', '1450 pine warbler pl. Sarasota FL 34240-1234'])('%s is confirmed', (text) => {
      const r = forOffice(SARASOTA, text);
      expect(r.status).toBe('verified');
      expect(r.detail.address_checked).toBe(true);
    });

    test('a number that merely ends in ours does not confirm (11450 Pine Warbler Pl)', () => {
      expect(forOffice(SARASOTA, '11450 Pine Warbler Pl').status).toBe('unverified');
    });

    test.each(['1978 S Tamiami Trl #10, Venice, FL 34293', '1978 South Tamiami Trail, Venice, Florida 34293', '1978 S. Tamiami Trail, Suite 10, Venice, FL 34293'])('%s matches 1978 South Tamiami Trail', (text) => {
      expect(forOffice(VENICE, text).status).toBe('verified');
    });

    test('a directional-less variant is ambiguous, so unconfirmed (never confirmed)', () => {
      expect(forOffice(VENICE, '1978 Tamiami Trail').status).toBe('unverified');
    });
  });

  describe('addresses: city, ZIP and directionals count; stored values are what was observed', () => {
    const LUXE_ENTITY = (address) => ({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address });
    const viaEntity = (address) => classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${ld(LUXE_ENTITY(address))}`), candidatesFor({}));
    const viaText = (addressText) => classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p><p>${addressText}</p>`), candidatesFor({}));

    test("'13649 Luxe Ave #110, Tampa, 33601' is not confirmed from text, and a mismatch when entity-stated", () => {
      const t = viaText('13649 Luxe Ave #110, Tampa, 33601');
      expect(t.status).toBe('unverified');
      expect(t.detail).toMatchObject({ reason: 'address_unconfirmed', seen: '13649 Luxe Ave' });
      const e = viaEntity({ streetAddress: '13649 Luxe Ave #110', addressLocality: 'Tampa', postalCode: '33601' });
      expect(e.status).toBe('mismatched');
      expect(e.detail.mismatches.map((m) => m.field)).toEqual(['city', 'postal_code']);
    });

    test("'13649 Luxe Avenue East' is not confirmed (extra directional), in text or as the entity street", () => {
      expect(viaText('13649 Luxe Avenue East, Bradenton, FL 34211').status).toBe('unverified');
      expect(viaEntity({ streetAddress: '13649 Luxe Avenue East' }).detail.mismatches.map((m) => m.field)).toEqual(['address']);
    });

    test.each(['13649 Luxe Ave #110, Bradenton, FL 34211', '13649 Luxe Avenue, Bradenton, Florida 34211', '13649 LUXE AVE STE 110 BRADENTON FL 34211-5678'])('%s in text is confirmed', (text) => {
      expect(viaText(text)).toMatchObject({ status: 'verified', detail: { address_checked: true } });
    });

    test('text with our street and city but no ZIP is not confirmed', () => {
      expect(viaText('13649 Luxe Ave, Bradenton, FL').status).toBe('unverified');
    });

    test('the bradenton office also answers to its display name, Lakewood Ranch (entity and text)', () => {
      expect(viaEntity({ streetAddress: '13649 Luxe Ave #110', addressLocality: 'Lakewood Ranch', addressRegion: 'FL', postalCode: '34211' }).status).toBe('verified');
      expect(viaText('13649 Luxe Ave #110, Lakewood Ranch, FL 34211')).toMatchObject({ status: 'verified', detail: { address_checked: true } });
      expect(viaText('13649 Luxe Ave #110, Lakewood Ranch, FL 34211').nap.nap_address).toBe('13649 Luxe Ave');
    });

    test('other offices accept only their own city: Sarasota for the bradenton office is still a mismatch', () => {
      const r = viaEntity({ streetAddress: '13649 Luxe Ave #110', addressLocality: 'Sarasota', postalCode: '34211' });
      expect(r.status).toBe('mismatched');
      expect(r.detail.mismatches).toEqual([{ field: 'city', expected: 'Bradenton or Lakewood Ranch', seen: 'Sarasota' }]);
      expect(viaText('13649 Luxe Ave #110, Sarasota, FL 34211').status).toBe('unverified');
      const parrish = classifyListing(page(`<h1>Waves Pest Control</h1><p>${PARRISH.phone}</p>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: PARRISH.phone, address: { streetAddress: '5155 115th Cir E', addressLocality: 'Lakewood Ranch' } })}`), candidatesFor({}));
      expect(parrish.detail.mismatches).toEqual([{ field: 'city', expected: 'Parrish', seen: 'Lakewood Ranch' }]);
    });

    test('an entity with the correct street but postalCode 34212 is mismatched on the postal code', () => {
      const r = viaEntity({ streetAddress: '13649 Luxe Ave #110', addressLocality: 'Bradenton', addressRegion: 'FL', postalCode: '34212' });
      expect(r.status).toBe('mismatched');
      expect(r.detail.mismatches).toEqual([{ field: 'postal_code', expected: '34211', seen: '34212' }]);
    });

    test('an entity in the wrong region is mismatched on the region', () => {
      const r = viaEntity({ streetAddress: '13649 Luxe Ave', addressLocality: 'Bradenton', addressRegion: 'GA' });
      expect(r.detail.mismatches).toEqual([{ field: 'region', expected: 'FL', seen: 'GA' }]);
    });

    test('an entity with the correct street and no locality or postal is confirmed; a ZIP+4 and Florida spelling also pass', () => {
      expect(viaEntity({ streetAddress: '13649 Luxe Ave #110' }).status).toBe('verified');
      expect(viaEntity({ streetAddress: '13649 Luxe Avenue', addressLocality: 'bradenton', addressRegion: 'Florida', postalCode: '34211-1234' }).status).toBe('verified');
    });

    test('an entity address given as one string goes through the same parser', () => {
      expect(viaEntity('13649 Luxe Ave #110, Bradenton, FL 34211').status).toBe('verified');
      expect(viaEntity('13649 Luxe Ave, Tampa, FL 33601').detail.mismatches.map((m) => m.field)).toEqual(['city', 'postal_code']);
    });

    test('nap_address stores the OBSERVED value when mismatched or unconfirmed, never the canonical one', () => {
      const m = viaEntity({ streetAddress: '13649 Luxe Ave #110', addressLocality: 'Bradenton', addressRegion: 'FL', postalCode: '34212' });
      expect(m.nap.nap_address).toBe('13649 Luxe Ave #110, Bradenton, FL 34212');
      expect(m.nap.nap_address).not.toBe(BRAND.address);
      const u = viaText('13649 Luxe Ave #110, Tampa, 33601');
      expect(u.nap.nap_address).toBe('13649 Luxe Ave');
      const none = classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`), candidatesFor({}));
      expect(none.nap.nap_address).toBeNull();
    });

    test('nap_name and nap_phone are observed values too', () => {
      const r = classifyListing(page('', { html: `<html><body><h1>WAVES PEST CONTROL</h1><p>(941) 555-0142</p>${filler}</body></html>` }), candidatesFor({}));
      expect(r.nap).toEqual({ nap_name: 'WAVES PEST CONTROL', nap_phone: null, nap_address: null }); // an unrelated visible phone is not the listing's
      const stated = classifyListing(page(`<h1>x</h1>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: '(941) 555-0142' })}`), candidatesFor({}));
      expect(stated.nap.nap_phone).toBe('(941) 555-0142');
      const e = classifyListing(page(`<h1>x</h1><p>${BRAND.phone}</p>${ld(LUXE_ENTITY({ streetAddress: '13649 Luxe Ave' }))}`), candidatesFor({}));
      expect(e.nap.nap_name).toBe('Waves Pest Control');
    });
  });

  describe('only the Waves JSON-LD entity is evidence', () => {
    const bizLd = (address) => ({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address });
    const publisher = { '@type': 'Organization', name: 'Local Directory Inc', telephone: '(813) 555-0100', address: { streetAddress: '1 Directory Way', addressLocality: 'Tampa' } };
    const withLd = (graph, extra = '') => classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${extra}${ld({ '@graph': graph })}`), candidatesFor({}));

    test('a publisher Organization listed before our LocalBusiness causes no false mismatch', () => {
      const r = withLd([publisher, bizLd({ streetAddress: '13649 Luxe Ave #110', addressLocality: 'Bradenton' })]);
      expect(r.status).toBe('verified');
      expect(r.detail.address_checked).toBe(true);
    });

    test('the Waves entity with a wrong street is mismatched, even after a publisher node', () => {
      const r = withLd([publisher, bizLd({ streetAddress: '99 Old Rd', addressLocality: 'Tampa' })]);
      expect(r.status).toBe('mismatched');
      expect(r.detail.mismatches.map((m) => m.field)).toEqual(['address', 'city']);
      expect(r.detail.mismatches[0]).toEqual({ field: 'address', expected: BRAND.address, seen: '99 Old Rd, Tampa' });
    });

    test('the Waves entity is also recognised by one of our office phones alone', () => {
      const r = withLd([publisher, { '@type': 'LocalBusiness', name: 'Bradenton Office', telephone: PARRISH.phone, address: { streetAddress: '9 Wrong St' } }]);
      expect(r.status).toBe('mismatched');
      expect(r.detail.mismatches.map((m) => m.field)).toEqual(['name', 'address']);
      expect(r.detail.mismatches[1]).toMatchObject({ seen: '9 Wrong St' });
    });

    describe('a field the Waves entity states wins over page text; unstated fields come from the text', () => {
      const VENICE = WAVES_LOCATIONS.find((l) => l.id === 'venice');
      const SARASOTA = WAVES_LOCATIONS.find((l) => l.id === 'sarasota');
      const footer = `<footer>${BRAND.phone} ${BRAND.address}</footer>`;
      const listing = (entity, extra, candidates = candidatesFor({})) =>
        classifyListing(page(`<h1>Waves Pest Control</h1>${extra}${ld(entity)}`), candidates);

      test('wrong entity phone + street are mismatched even though a footer shows the canonical details', () => {
        const r = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: '(941) 555-0142', address: { streetAddress: '99 Old Rd', addressLocality: 'Tampa' } }, footer);
        expect(r.status).toBe('mismatched');
        expect(r.detail.mismatches.map((m) => m.field)).toEqual(['phone', 'address', 'city']);
        expect(r.detail.mismatches[0].seen).toEqual(['(941) 555-0142']);
        expect(r.detail.mismatches[1].seen).toBe('99 Old Rd, Tampa');
      });

      test('entity with the right phone and no address: the text supplies our full street -> verified', () => {
        const r = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone }, footer);
        expect(r.status).toBe('verified');
        expect(r.detail.address_checked).toBe(true);
      });

      test('entity with the right phone and a wrong street is mismatched even though the text has our street', () => {
        const r = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '99 Old Rd' } }, footer);
        expect(r.status).toBe('mismatched');
        expect(r.detail.mismatches.map((m) => m.field)).toEqual(['address']);
      });

      test('a wrong name the entity states is not rescued by the brand name in the page text', () => {
        const r = listing({ '@type': 'LocalBusiness', name: 'Acme Bug Co', telephone: BRAND.phone }, footer);
        expect(r.status).toBe('mismatched');
        expect(r.detail.mismatches.map((m) => m.field)).toEqual(['name']);
      });

      test('entity with no phone: the phone is read from the text', () => {
        expect(listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', address: { streetAddress: '13649 Luxe Avenue' } }, footer).status).toBe('verified');
        const wrong = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control' }, '<p>(941) 555-0142</p>');
        expect(wrong).toMatchObject({ status: 'unverified', detail: { reason: 'phone_unconfirmed', seen: ['(941) 555-0142'] } }); // visible phones cannot prove a mismatch
      });

      describe('stated vs parsed: a stated field we cannot read fails, it is never treated as unstated', () => {
        test("telephone '941-555-014' (9 digits) with the correct number in the footer -> mismatched on phone, raw value seen", () => {
          const r = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: '941-555-014' }, footer);
          expect(r.status).toBe('mismatched');
          expect(r.detail.mismatches).toEqual([{ field: 'phone', expected: WAVES_LOCATIONS.map((l) => l.phone).join(' or '), seen: ['941-555-014'] }]);
          expect(r.nap.nap_phone).toBe('941-555-014');
        });

        test('an entity with NO telephone (absent, empty or blank) and the right number in the text is still verified', () => {
          for (const telephone of [undefined, '', '  ', []]) {
            expect(listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', ...(telephone === undefined ? {} : { telephone }) }, footer).status).toBe('verified');
          }
        });

        test('an unparseable telephone beside a correct one is not a mismatch (ours is stated)', () => {
          expect(listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: ['n/a', BRAND.phone] }, footer).status).toBe('verified');
        });

        test('an unparseable postal code or street fails; a blank one is unstated', () => {
          const bad = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '13649 Luxe Ave', postalCode: '3421' } }, footer);
          expect(bad.detail.mismatches).toEqual([{ field: 'postal_code', expected: '34211', seen: '3421' }]);
          const noStreet = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '#' } }, footer);
          expect(noStreet.detail.mismatches.map((m) => m.field)).toEqual(['address']);
          const blank = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: ' ', postalCode: '' } }, footer);
          expect(blank.status).toBe('verified'); // street unstated -> the footer's full address confirms
        });

        test('a name given as an object without a usable value fails; {"@value"} and arrays are read', () => {
          expect(listing({ '@type': 'LocalBusiness', name: { foo: 1 }, telephone: BRAND.phone }, footer).detail.mismatches.map((m) => m.field)).toEqual(['name']);
          expect(listing({ '@type': 'LocalBusiness', name: { '@value': 'Waves Pest Control' }, telephone: BRAND.phone }, footer).status).toBe('verified');
          expect(listing({ '@type': 'LocalBusiness', name: ['Waves Pest Control', 'WPC'], telephone: BRAND.phone }, footer).status).toBe('verified');
        });
      });

      test('unassigned brand row: entity phone matches Venice but the address matches Sarasota -> mismatched against Venice', () => {
        const r = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: VENICE.phone, address: { streetAddress: '1450 Pine Warbler Pl', addressLocality: 'Sarasota' } }, `<footer>${SARASOTA.address}</footer>`);
        expect(r.status).toBe('mismatched');
        expect(r.detail.office).toBe('venice');
        expect(r.detail.mismatches).toEqual([
          { field: 'address', expected: VENICE.address, seen: '1450 Pine Warbler Pl, Sarasota' },
          { field: 'city', expected: 'Venice', seen: 'Sarasota' },
        ]);
      });

      test('unassigned brand row: entity phone and address both Venice -> verified, office venice', () => {
        const r = listing({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: VENICE.phone, address: { streetAddress: '1978 S Tamiami Trl #10' } }, '');
        expect(r).toMatchObject({ status: 'verified', detail: { office: 'venice' } });
      });
    });

    test('no Waves entity: JSON-LD contributes nothing (no address mismatch, no phone evidence)', () => {
      const r = withLd([publisher, { '@type': 'LocalBusiness', name: 'Acme Bug Co', telephone: '(941) 555-0142', address: { streetAddress: '7 Acme Blvd' } }]);
      expect(r.status).toBe('verified');
      expect(r.detail.address_checked).toBe(false);
      expect(r.nap.nap_phone).toBe(BRAND.phone);
    });

    test('a JSON-LD-only phone from another business is not our phone evidence', () => {
      const r = classifyListing(page(`<h1>Waves Pest Control</h1>${ld({ '@graph': [publisher] })}`), candidatesFor({}));
      expect(r).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'phone_not_found' } });
    });
  });

  test('mismatched name when a phone is shown but our name is not', () => {
    const r = classifyListing({ ...page('<h1>Acme Bug Co</h1><p>(941) 318-7612</p>'), html: `<html><head><title>Acme Bug Co</title></head><body><h1>Acme Bug Co</h1><p>(941) 318-7612</p>${filler}</body></html>` }, expected);
    expect(r.status).toBe('mismatched');
    expect(r.detail.mismatches.map((m) => m.field)).toEqual(['name']);
    expect(r.detail.mismatches[0].seen).toBe('Acme Bug Co');
  });

  test('an unassigned brand listing may show ANY office and records which one matched', () => {
    for (const loc of WAVES_LOCATIONS) {
      const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${loc.phone} ${loc.address}</p>`), candidatesFor({}));
      expect(r.status).toBe('verified');
      expect(r.detail.office).toBe(loc.id);
      expect(r.nap.nap_address).toBe(loc.address.split(' #')[0].split(',')[0]); // the street as the page wrote it
    }
  });

  test('a brand listing pairs the phone with THAT office: another office\'s address is a mismatch', () => {
    const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${PARRISH.phone}</p>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: PARRISH.phone, address: { streetAddress: '13649 Luxe Ave' } })}`), candidatesFor({}));
    expect(r.status).toBe('mismatched');
    expect(r.detail.office).toBe('parrish');
    expect(r.detail.mismatches).toEqual([{ field: 'address', expected: PARRISH.address, seen: '13649 Luxe Ave' }]);
  });

  test('a row assigned to an office is judged against that office only', () => {
    const body = `<h1>Waves Pest Control</h1><p>${PARRISH.phone}</p>`;
    expect(classifyListing(page(body), candidatesFor({ location_id: 'parrish' })).status).toBe('verified');
    const other = classifyListing(page(body), candidatesFor({ location_id: 'venice' }));
    expect(other).toMatchObject({ status: 'unverified', detail: { reason: 'phone_unconfirmed' } });
    const stated = classifyListing(page(`<h1>Waves Pest Control</h1>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: PARRISH.phone })}`), candidatesFor({ location_id: 'venice' }));
    expect(stated.status).toBe('mismatched');
    expect(stated.detail.mismatches[0]).toMatchObject({ field: 'phone', expected: WAVES_LOCATIONS.find((l) => l.id === 'venice').phone });
  });

  describe('follow-ups from Codex round 3', () => {
    const wavesName = '<h1>Waves Pest Control</h1>';
    const ENT = (over) => ({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, ...over });
    const via = (over) => classifyListing(page(`${wavesName}${ld(ENT(over))}`), candidatesFor({}));
    const text = (body) => classifyListing(page(`${wavesName}<p>${BRAND.phone}</p>${body}`), candidatesFor({}));

    test('a non-Florida address with an unrecognised suffix is shown, so not verified', () => {
      const r = text('<p>99 Palm Terrace, Atlanta, GA 30303</p>');
      expect(r.status).toBe('unverified');
      expect(r.detail).toMatchObject({ reason: 'address_unconfirmed' });
      expect(r.detail.seen).toContain('Atlanta, GA 30303');
      expect(text('<p>Suite 5, Springfield IL 62704-1234</p>').status).toBe('unverified');
    });

    test('a non-Florida state code in title case, or any case after a comma, is still an address', () => {
      const r = text('<p>99 Palm Terrace, Atlanta, Ga 30303</p>');
      expect(r.status).toBe('unverified');
      expect(r.detail).toMatchObject({ reason: 'address_unconfirmed' });
      expect(r.detail.seen).toContain('Atlanta, Ga 30303');
      expect(text('<p>99 Palm Terrace, Atlanta, ga 30303</p>').status).toBe('unverified');
      expect(text('<p>99 Palm Terrace, Atlanta,ga. 30303</p>').status).toBe('unverified');
      expect(text('<p>Order id 12345 shipped in 2 days</p>').status).toBe('verified'); // prose word, no comma
    });

    test('a state code that is also a word or ID label needs a comma to read as an address', () => {
      expect(text('<p>Order ID 12345 confirmed</p>').status).toBe('verified');
      expect(text('<p>Listing ID 98765</p>').status).toBe('verified');
      expect(text('<p>Hi 12345 visitors this month</p>').status).toBe('verified');
      expect(text('<p>Boise, ID 83702</p>').status).toBe('unverified');
      expect(text('<p>Portland, or 97201</p>').status).toBe('unverified');
      expect(text('<p>Atlanta GA 30303</p>').status).toBe('unverified'); // unambiguous code, no comma needed
      expect(text('<p>99 Palm Terrace, Atlanta, Georgia 30303</p>').status).toBe('unverified'); // full state name
      expect(text('<p>Raleigh NORTH CAROLINA 27601</p>').status).toBe('unverified');
      expect(text('<p>Brooklyn, new york 11201</p>').status).toBe('unverified');
      expect(text('<p>99 Palm Terrace Tampa florida 33601</p>').status).toBe('unverified'); // lowercase Florida, no comma
      expect(text('<p>99 Palm Terrace Boise ID 83702</p>').status).toBe('unverified'); // house number gives context
      expect(text('<p>123 North Martin Luther King Junior Drive Boise ID 83702</p>').status).toBe('unverified');
      expect(text('<p>Order ID 12345 confirmed</p><p>Open 7 days</p>').status).toBe('verified');
    });

    test('a page with no state + ZIP and no street-like string is still judged on name + phone', () => {
      expect(text('<p>Serving Manatee County since 2019. Call 24/7.</p>').status).toBe('verified');
      expect(text('<p>Order id 12345 shipped in 2 days</p>').status).toBe('verified'); // lowercase words are not states
      expect(text('<p>PO 12345 and NO 54321 are reference numbers</p>').status).toBe('verified'); // not state codes
      expect(text('<p>1 Main Terrace, Sarasota, FLORIDA 34236</p>').status).toBe('unverified'); // Florida in any case
    });

    test('a bare JSON-LD value object is ignored, not a crash', () => {
      expect(text(ld({ '@value': null }) + ld([{ '@value': 'x' }])).status).toBe('verified');
    });

    test('JSON-LD value objects are unwrapped before entities are identified', () => {
      const node = { '@type': 'LocalBusiness', name: { '@value': 'Waves Pest Control', '@language': 'en' }, telephone: [{ '@value': '(941) 555-0142' }], address: { streetAddress: { '@value': '99 Old Rd' }, addressLocality: { '@value': 'Tampa' } } };
      const r = classifyListing(page(`${wavesName}<p>${BRAND.phone}</p>${ld(node)}`), candidatesFor({}));
      expect(r.status).toBe('mismatched'); // the structured mismatch is not ignored
      expect(r.detail.mismatches.map((m) => m.field)).toEqual(['phone', 'address', 'city']);
      // a node identified ONLY by a value-object office phone is a Waves entity too
      const byPhone = { '@type': 'LocalBusiness', name: 'Bradenton Office', telephone: { '@value': BRAND.phone }, address: { streetAddress: '99 Old Rd' } };
      expect(classifyListing(page(`${wavesName}<p>${BRAND.phone}</p>${ld(byPhone)}`), candidatesFor({})).detail.mismatches.map((m) => m.field)).toContain('address');
      expect(via({ name: { '@value': 'Waves Pest Control' }, telephone: { '@value': BRAND.phone } }).status).toBe('verified');
    });

    test('a combined "Suite #110" designator is stripped whole', () => {
      const { normalizeStreet, parseAddress } = auditor._internals;
      expect(normalizeStreet('13649 Luxe Ave Suite #110')).toBe('13649 luxe avenue');
      expect(normalizeStreet('13649 Luxe Ave Ste. #B-2, Bradenton')).toBe('13649 luxe avenue bradenton');
      expect(parseAddress('13649 Luxe Ave Suite #110, Bradenton, FL 34211')).toEqual({ street: '13649 luxe avenue', city: 'bradenton', region: 'fl', postal: '34211' });
      expect(via({ address: { streetAddress: '13649 Luxe Ave Suite #110', addressLocality: 'Bradenton' } }).status).toBe('verified');
      expect(text('<p>13649 Luxe Ave Suite #110, Bradenton, FL 34211</p>')).toMatchObject({ status: 'verified', detail: { address_checked: true } });
    });

    test('a branded soft-404 served as 200 is fetch-blocked even around stale listing JSON-LD', () => {
      const stale = classifyListing(page(`<h1>Page Not Found</h1><p>We can't find that page.</p>${wavesName}<p>${BRAND.phone}</p>${ld(ENT({}))}`, { html: `<html><head><title>Page not found | Directory</title></head><body><h1>Page Not Found</h1>${wavesName}<p>${BRAND.phone}</p>${ld(ENT({}))}${filler}</body></html>` }), candidatesFor({}));
      expect(stale).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'soft_404' } });
      expect(classifyListing(page(`<h1>This page doesn't exist anymore.</h1>${wavesName}<p>${BRAND.phone}</p>`), candidatesFor({})).detail.reason).toBe('soft_404');
      expect(classifyListing(page(`<h1>404</h1>${wavesName}<p>${BRAND.phone}</p>`), candidatesFor({})).detail.reason).toBe('soft_404');
      // a healthy listing is unaffected
      expect(text('').status).toBe('verified');
    });

    test('not-found wording outside the title and h1 is not a soft-404', () => {
      // "404 reviews", a 404-area-code phone and not-found body copy on a healthy listing
      expect(text('<p>404 reviews</p><p>Also nearby: (404) 555-0199, 404-555-0100</p>').status).toBe('verified');
      expect(text("<p>We can't find that page? Try the search.</p>").status).toBe('verified');
      const titled = (title) => classifyListing(page(`${wavesName}<p>${BRAND.phone}</p>`, { html: `<html><head><title>${title}</title></head><body>${wavesName}<p>${BRAND.phone}</p>${filler}</body></html>` }), candidatesFor({}));
      expect(titled('Waves Pest Control - 404 Reviews - Sarasota').status).toBe('verified');
      expect(titled('404-555-0100 | Directory').status).toBe('verified');
      expect(titled('404 - Page Not Found').detail.reason).toBe('soft_404');
      expect(titled('Error 404 | Directory').detail.reason).toBe('soft_404');
      expect(titled('Page&nbsp;Not&nbsp;Found').detail.reason).toBe('soft_404');
      expect(titled('Page&#160;not&#xA0;found | Directory').detail.reason).toBe('soft_404');
      expect(titled("Sorry, we couldn't find this page").detail.reason).toBe('soft_404');
      expect(titled('We could not find that page').detail.reason).toBe('soft_404');
      expect(titled('We cannot find the page you requested').detail.reason).toBe('soft_404');
    });

    test('an unused error template in a script, template or comment is not a soft-404', () => {
      for (const inert of [
        '<script type="text/template"><h1>Page not found</h1></script>',
        '<template><h1>Page not found</h1></template>',
        '<!-- <h1>Page not found</h1> -->',
      ]) expect(text(inert).status).toBe('verified');
    });

    test('a unit designator followed by a long whitespace run normalizes in linear time', () => {
      const started = Date.now();
      expect(normalizeStreet(`13649 Luxe Ave Suite${' '.repeat(200000)}`)).toBe('13649 luxe avenue suite');
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  describe('Codex round 2', () => {
    const ENT = (over) => ({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, ...over });
    const via = (over) => classifyListing(page(`<h1>Waves Pest Control</h1>${ld(ENT(over))}`), candidatesFor({}));
    const text = (body) => classifyListing(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>${body}`), candidatesFor({}));

    test('P2-1: an address ARRAY is evaluated — the entry matching the office wins, else the first is judged', () => {
      const ours = { streetAddress: '13649 Luxe Ave #110', addressLocality: 'Bradenton', addressRegion: 'FL', postalCode: '34211' };
      const other = { streetAddress: '99 Old Rd', addressLocality: 'Tampa', addressRegion: 'FL', postalCode: '33601' };
      expect(via({ address: [other, ours] })).toMatchObject({ status: 'verified', detail: { address_checked: true } });
      const none = via({ address: [other, { streetAddress: '7 Elm St', addressLocality: 'Tampa' }] });
      expect(none.status).toBe('mismatched');
      expect(none.detail.mismatches[0]).toMatchObject({ field: 'address', seen: '99 Old Rd, Tampa, FL 33601' });
      expect(via({ address: [] }).status).toBe('verified'); // an empty list states nothing
      expect(via({ address: ['13649 Luxe Ave #110 Bradenton FL 34211'] }).status).toBe('verified');
    });

    test.each([
      ['123 Martin Luther King Jr Memorial Blvd, Tampa, FL 33602', '123 Martin Luther King Jr Memorial Blvd'],
      ['99 Palm Terrace, Tampa, FL 33601', '99 Palm Terrace'],
      ['Visit us at Palm Plaza Tampa Florida 33601', 'Tampa Florida 33601'],
    ])('P2-2: a shown address we cannot recognise (%s) is unverified/address_unconfirmed, not verified', (addr, seenPart) => {
      const r = text(`<p>${addr}</p>`);
      expect(r.status).toBe('unverified');
      expect(r.detail.reason).toBe('address_unconfirmed');
      expect(r.detail.seen).toContain(seenPart);
    });

    test('P2-2: our full address among other shown addresses is still confirmed', () => {
      const r = text(`<p>99 Palm Terrace, Tampa, FL 33601</p><p>${BRAND.address}</p>`);
      expect(r.status).toBe('verified');
    });

    test('P2-3: HTML entities are decoded before name, phone and address are read', () => {
      const r = classifyListing(page('', { html: `<html><head><title>Listing</title></head><body><h1>Waves&nbsp;Pest&nbsp;Control</h1><p>(941)&nbsp;318-7612</p><p>13649&nbsp;Luxe&nbsp;Ave&nbsp;#110,&nbsp;Bradenton,&nbsp;FL&nbsp;34211</p><p>&#87;aves &amp; more${filler}</p></body></html>` }), candidatesFor({}));
      expect(r).toMatchObject({ status: 'verified', detail: { address_checked: true } });
      expect(r.nap.nap_name).toBe('Waves Pest Control');
      const num = classifyListing(page('', { html: `<html><body><h1>W&#97;ves P&#x65;st Control</h1><p>&#40;941&#41; 318-7612</p>${filler}</body></html>` }), candidatesFor({}));
      expect(num.status).toBe('verified');
    });

    test('P2-4: a malformed tel: encoding does not fail the page; the other evidence is kept', () => {
      const r = classifyListing(page('', { html: `<html><body><h1>Waves Pest Control</h1><a href="tel:%">call</a><a href="tel:%E0%A4%A">bad</a><a href="tel:%2B19413187612">ok</a>${filler}</body></html>` }), candidatesFor({}));
      expect(r.status).toBe('verified');
      const only = classifyListing(page('', { html: `<html><body><h1>Waves Pest Control</h1><a href="tel:%">call</a>${filler}</body></html>` }), candidatesFor({}));
      expect(only).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'phone_not_found' } });
    });
  });

  describe('visible phones are not listing evidence (Codex P2-1)', () => {
    const wavesName = '<h1>Waves Pest Control</h1>';
    test('the Waves name with an unrelated support/ad/sidebar phone and none of ours is unverified/phone_unconfirmed, never mismatched', () => {
      const r = classifyListing(page(`${wavesName}<p>Support: (813) 555-0100</p><aside>Ad: (941) 555-0199</aside>`), candidatesFor({}));
      expect(r.status).toBe('unverified');
      expect(r.detail).toMatchObject({ reason: 'phone_unconfirmed', seen: ['(813) 555-0100', '(941) 555-0199'] });
      expect(r.nap.nap_phone).toBeNull();
    });
    test('our phone among unrelated ones confirms the phone', () => {
      expect(classifyListing(page(`${wavesName}<p>(813) 555-0100</p><p>${BRAND.phone}</p>`), candidatesFor({})).status).toBe('verified');
    });
    test('no phone at all on the page stays fetch-blocked/phone_not_found', () => {
      expect(classifyListing(page(wavesName), candidatesFor({}))).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'phone_not_found' } });
    });
    test('an unrelated phone with neither our name nor our phone is no NAP at all', () => {
      expect(classifyListing(page('<h1>Acme</h1><p>(813) 555-0100</p>', { html: `<html><body><h1>Acme</h1><p>(813) 555-0100</p>${filler}</body></html>` }), candidatesFor({})).detail.reason).toBe('no_nap_found');
    });
  });

  describe('several Waves entities: the one matching the expected office is judged (Codex P2-4)', () => {
    const VENICE = WAVES_LOCATIONS.find((l) => l.id === 'venice');
    const parent = { '@type': 'Organization', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '13649 Luxe Ave #110', addressLocality: 'Bradenton', addressRegion: 'FL', postalCode: '34211' } };
    const branch = { '@type': 'LocalBusiness', name: 'Waves Pest Control Venice', telephone: VENICE.phone, address: { streetAddress: '1978 S Tamiami Trl #10', addressLocality: 'Venice', addressRegion: 'FL', postalCode: '34293' } };
    const withParent = (candidates) => classifyListing(page(`<h1>Waves Pest Control</h1>${ld({ ...parent, mainEntity: branch })}`), candidates);

    test('a parent Organization (default office) followed by a branch mainEntity matching the assigned office -> verified', () => {
      expect(withParent(candidatesFor({ location_id: 'venice' }))).toMatchObject({ status: 'verified', detail: { office: 'venice' } });
    });
    test('an unassigned brand row picks the node whose phone matches ANY office (here the first, then the branch)', () => {
      expect(withParent(candidatesFor({})).status).toBe('verified');
      const reversed = classifyListing(page(`<h1>Waves Pest Control</h1>${ld({ '@graph': [branch, parent] })}`), candidatesFor({ location_id: 'bradenton' }));
      expect(reversed).toMatchObject({ status: 'verified', detail: { office: 'bradenton' } });
    });
    test('phone first, then address/city: a node with the office address but no phone is preferred over a wrong-address one', () => {
      const noPhone = { '@type': 'LocalBusiness', name: 'Waves Pest Control', address: { streetAddress: '1978 South Tamiami Trail', addressLocality: 'Venice' } };
      const other = { '@type': 'LocalBusiness', name: 'Waves Pest Control', address: { streetAddress: '99 Old Rd', addressLocality: 'Tampa' } };
      const r = classifyListing(page(`<h1>Waves Pest Control</h1><p>${VENICE.phone}</p>${ld({ '@graph': [other, noPhone] })}`), candidatesFor({ location_id: 'venice' }));
      expect(r.status).toBe('verified');
    });
    test('no node matches the office: the first address-bearing one is judged as before (stated mismatch)', () => {
      const r = withParent(candidatesFor({ location_id: 'parrish' }));
      expect(r.status).toBe('mismatched');
      expect(r.detail.mismatches.map((m) => m.field)).toContain('address');
    });
  });

  describe('a short page with a usable Waves entity is judged on the entity (Codex P2-5)', () => {
    const shortPage = (body) => ({ status: 200, finalUrl: 'https://dir.example/w', redirectHops: 0, html: `<html><head><title>Waves</title></head><body>${body}</body></html>`, blocked: false, truncated: false, contentType: 'text/html', error: null });
    test('a complete entity on a tiny page verifies (or mismatches) instead of empty_or_js_only', () => {
      const good = shortPage(`<div id="root"></div>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '13649 Luxe Ave #110', addressLocality: 'Bradenton', postalCode: '34211' } })}`);
      expect(classifyListing(good, candidatesFor({})).status).toBe('verified');
      const bad = shortPage(`<div id="root"></div>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: '(941) 555-0142' })}`);
      expect(classifyListing(bad, candidatesFor({})).status).toBe('mismatched');
    });
    test('a short page WITHOUT a usable Waves entity is still empty_or_js_only', () => {
      expect(classifyListing(shortPage('<div id="root"></div>'), candidatesFor({})).detail.reason).toBe('empty_or_js_only');
      expect(classifyListing(shortPage(`<p>Acme</p>${ld({ '@type': 'LocalBusiness', name: 'Acme Bug Co', telephone: '(813) 555-0100' })}`), candidatesFor({})).detail.reason).toBe('empty_or_js_only');
    });
  });

  describe('unpunctuated structured address strings (Codex P2-3)', () => {
    const { parseAddress } = auditor._internals;
    test.each([
      '13649 Luxe Ave #110 Bradenton FL 34211',
      '13649 Luxe Ave #110\nBradenton\nFL 34211',
      '13649 Luxe Avenue Bradenton, FL 34211-5678',
      '13649 Luxe Ave #110, Bradenton, FL 34211',
    ])('%j parses to street / city / region / postal', (str) => {
      expect(parseAddress(str)).toEqual({ street: '13649 luxe avenue', city: 'bradenton', region: 'fl', postal: '34211' });
    });
    test('directionals and multi-word cities split at the last suffix', () => {
      expect(parseAddress('5155 115th Cir E Parrish FL 34219')).toEqual({ street: '5155 115th circle east', city: 'parrish', region: 'fl', postal: '34219' });
      expect(parseAddress('1978 S Tamiami Trl Unit 10 Venice FL 34293')).toEqual({ street: '1978 south tamiami trail', city: 'venice', region: 'fl', postal: '34293' });
      expect(parseAddress('13649 Luxe Ave Lakewood Ranch FL 34211')).toMatchObject({ street: '13649 luxe avenue', city: 'lakewood ranch' });
    });
    test('an entity address given as unpunctuated free text verifies, and a wrong one is a mismatch on the right fields', () => {
      const via = (address) => classifyListing(page(`<h1>Waves Pest Control</h1>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address })}`), candidatesFor({}));
      expect(via('13649 Luxe Ave #110 Bradenton FL 34211').status).toBe('verified');
      expect(via('13649 Luxe Ave #110\nBradenton\nFL 34211').status).toBe('verified');
      expect(via('13649 Luxe Ave #110 Tampa FL 33601').detail.mismatches.map((m) => m.field)).toEqual(['city', 'postal_code']);
    });
  });

  test('a truncated prefix of a page whose full version is mismatched is never verified', () => {
    const head = `<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`;
    const conflicting = ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: BRAND.phone, address: { streetAddress: '99 Old Rd', addressLocality: 'Tampa' } });
    const full = classifyListing(page(head + conflicting), candidatesFor({}));
    expect(full.status).toBe('mismatched');
    const prefix = classifyListing(page(head, { truncated: true }), candidatesFor({})); // the JSON-LD was cut off
    expect(prefix).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'truncated' } });
    // a page that would have verified is also not verified when cut off
    expect(classifyListing(page(`${head}<p>${BRAND.address}</p>`, { truncated: true }), candidatesFor({})).status).toBe('fetch-blocked');
    expect(classifyListing(page(`${head}<p>${BRAND.address}</p>`), candidatesFor({})).status).toBe('verified');
  });

  test('a cut-off body cannot prove a mismatch', () => {
    const r = classifyListing(page('<h1>Waves Pest Control</h1><p>(941) 555-0142</p>', { truncated: true }), expected);
    expect(r).toMatchObject({ status: 'fetch-blocked', detail: { reason: 'truncated' } });
  });

  test.each([
    [403, 'http_403'], [429, 'http_429'], [500, 'http_500'], [503, 'http_503'],
    [404, 'http_404'], [410, 'http_410'], [401, 'http_401'],
  ])('HTTP %i is fetch-blocked, never missing', (status, reason) => {
    const r = classifyListing({ status, html: null, contentType: 'text/html', error: null, blocked: false }, expected);
    expect(r.status).toBe('fetch-blocked');
    expect(r.detail.reason).toBe(reason);
    expect(r.nap).toBeNull();
  });

  test.each([
    ['timeout / network error', { status: 0, html: null, error: 'aborted' }, 'aborted'],
    ['DNS failure', { status: 0, html: null, error: 'dns_error' }, 'dns_error'],
    ['private host refused', { status: 0, html: null, blocked: true, error: 'blocked_host' }, 'blocked_host'],
    ['bot challenge', { html: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget">x</div></body></html>' }, 'challenge'],
    ['JS-only shell', { html: '<html><body><div id="root"></div><script>app()</script></body></html>' }, 'empty_or_js_only'],
    ['non-HTML body', { html: '{"a":1}', contentType: 'application/json' }, 'non_html'],
    ['no NAP on the page', { html: `<html><body><p>${'Welcome to our directory of local businesses and services. '.repeat(8)}</p></body></html>` }, 'no_nap_found'],
    ['name shown but phone not readable', { html: `<html><body><h1>Waves Pest Control</h1>${filler}</body></html>` }, 'phone_not_found'],
  ])('%s is fetch-blocked', (_label, over, reason) => {
    const r = classifyListing({ status: 200, finalUrl: 'https://dir.example/x', contentType: 'text/html', truncated: false, blocked: false, error: null, ...over }, expected);
    expect(r.status).toBe('fetch-blocked');
    expect(r.detail.reason).toBe(reason);
  });

  test('no fetch outcome ever classifies as missing or verified-by-default', () => {
    const outcomes = [403, 404, 429, 500, 0].map((status) => classifyListing({ status, html: null, error: status ? null : 'aborted' }, expected).status);
    expect(outcomes.every((s) => s === 'fetch-blocked')).toBe(true);
    expect(STATES).toContain('missing'); // reachable only through updateCitation
  });
});

describe('audit()', () => {
  let store;
  let updates;
  const T0 = new Date('2026-09-29T12:00:00.000Z');
  const rows = (list) => list.map((r) => ({ location_id: null, updated_at: T0, ...r }));
  // In-memory seo_citations: supports just the calls the auditor makes, and evaluates the
  // conditional UPDATE's WHERE against the LIVE store so a test can edit a row mid-sweep.
  beforeEach(() => {
    updates = [];
    db.mockImplementation((table) => {
      expect(table).toBe('seo_citations');
      const filters = [];
      const q = {
        where: (o) => { filters.push((r) => Object.entries(o).every(([k, v]) => (r[k] ?? null) === (v ?? null))); return q; },
        whereNot: (col, val) => { filters.push((r) => r[col] !== val); return q; },
        whereNull: (col) => { filters.push((r) => r[col] == null); return q; },
        whereRaw: (_sql, [ms]) => { filters.push((r) => r.updated_at != null && Math.abs(new Date(r.updated_at).getTime() - ms) < 1); return q; },
        then: (resolve, reject) => Promise.resolve(store.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))).then(resolve, reject),
        update: async (patch) => {
          const hit = store.filter((r) => filters.every((f) => f(r)));
          // Mirror Postgres: nap_name / nap_phone are varchar(255); a row can also fail to save.
          for (const col of ['nap_name', 'nap_phone']) {
            if (patch[col] != null && String(patch[col]).length > 255) throw new Error('value too long for type character varying(255)');
          }
          if (hit.some((r) => r.failWrite)) throw new Error('write failed');
          hit.forEach((r) => { updates.push({ id: r.id, patch }); Object.assign(r, patch); });
          return hit.length;
        },
      };
      return q;
    });
  });
  const fetchFn = (routes) => async (url) => {
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => (r.headers || {})[k] || null }, text: async () => r.body || '' };
  };
  const html = (status, body, headers = { 'content-type': 'text/html' }) => ({ status, body: `<html><head><title>x</title></head><body>${body}${filler}</body></html>`, headers });

  test('writes each state; rows with no URL stay unverified and are never fetched; human "missing" rows are skipped', async () => {
    store = rows([
      { id: 'ok', listing_url: 'https://ok.example/l', location_id: 'venice', status: 'unverified' },
      { id: 'bad', listing_url: 'https://bad.example/l', status: 'unverified' },
      { id: 'yelp', listing_url: 'https://yelp.example/l', status: 'unverified' },
      { id: 'redir', listing_url: 'https://redir.example/l', status: 'active' },
      { id: 'inner', listing_url: 'https://inner.example/l', status: 'unchecked' },
      { id: 'none', listing_url: null, status: 'unchecked' },
      { id: 'human', listing_url: 'https://human.example/l', status: 'missing' },
    ]);
    const routes = {
      'https://ok.example/l': html(200, `<h1>Waves Pest Control</h1><p>${WAVES_LOCATIONS.find((l) => l.id === 'venice').phone}</p>`),
      'https://bad.example/l': html(200, `<h1>Waves Pest Control</h1>${ld({ '@type': 'LocalBusiness', name: 'Waves Pest Control', telephone: '(941) 555-0142' })}`),
      'https://yelp.example/l': { status: 403, headers: {} },
      'https://redir.example/l': { status: 301, headers: { location: 'http://127.0.0.1/admin' } },
      'https://inner.example/l': new Error('socket hang up'),
    };
    const resolveHostFn = async (host) => host !== '127.0.0.1';
    const result = await auditor.audit({ fetchFn: fetchFn(routes), resolveHostFn });
    const byId = Object.fromEntries(updates.map((u) => [u.id, u.patch]));

    expect(byId.ok).toMatchObject({ status: 'verified', nap_consistent: true });
    expect(byId.bad).toMatchObject({ status: 'mismatched', nap_consistent: false, nap_phone: '(941) 555-0142' });
    expect(JSON.parse(byId.bad.status_detail).mismatches[0]).toMatchObject({ field: 'phone', seen: ['(941) 555-0142'] });
    expect(byId.yelp).toMatchObject({ status: 'fetch-blocked', nap_consistent: null });
    expect(JSON.parse(byId.yelp.status_detail)).toMatchObject({ reason: 'http_403', http_status: 403 });
    // a redirect to a loopback address is refused, and a refusal is a blocked fetch
    expect(byId.redir.status).toBe('fetch-blocked');
    expect(JSON.parse(byId.redir.status_detail).reason).toBe('blocked_host');
    expect(byId.inner.status).toBe('fetch-blocked');
    expect(byId.none).toMatchObject({ status: 'unverified' });
    expect(JSON.parse(byId.none.status_detail)).toEqual({ reason: 'no_listing_url' });
    expect(byId.human).toBeUndefined();
    expect(Object.values(byId).map((p) => p.status)).not.toContain('missing');
    expect(result).toEqual({ total: 6, skipped: 0, failed: 0, unverified: 1, verified: 1, mismatched: 1, 'fetch-blocked': 3, missing: 0 });
  });

  test('stored NAP values fit their varchar(255) columns and one failed write does not stop the sweep but fails the run', async () => {
    const longName = `Waves Pest Control ${'x'.repeat(400)}`;
    const good = `<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`;
    const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'LocalBusiness', name: longName, telephone: BRAND.phone })}</script>`;
    store = rows([
      { id: 'long', listing_url: 'https://long.example/l', status: 'unverified' },
      { id: 'boom', listing_url: 'https://boom.example/l', status: 'unverified', failWrite: true },
      { id: 'after', listing_url: 'https://after.example/l', status: 'unverified' },
    ]);
    const routes = {
      'https://long.example/l': html(200, `${ld}${good}`),
      'https://boom.example/l': html(200, good),
      'https://after.example/l': html(200, good),
    };
    // The sweep finishes every row, then REJECTS so the cron health wrapper records the failure.
    const error = await auditor.audit({ fetchFn: fetchFn(routes), resolveHostFn: async () => true }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/1 of 3 row\(s\) could not be saved/);
    const result = error.result;
    const byId = Object.fromEntries(updates.map((u) => [u.id, u.patch]));
    expect(byId.long.nap_name).toHaveLength(255);
    expect(JSON.parse(byId.long.status_detail).observed.nap_name).toBe(longName);
    expect(byId.boom).toBeUndefined();
    expect(byId.after).toMatchObject({ status: 'verified' });
    expect(result).toMatchObject({ total: 2, skipped: 0, failed: 1 });
    expect(require('../services/logger').error).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
  });

  test('a throwing check lands fetch-blocked and does not stop the sweep', async () => {
    store = rows([{ id: 'a', listing_url: 'https://a.example/l', status: 'unverified' }, { id: 'b', listing_url: 'https://b.example/l', status: 'unverified' }]);
    const spy = jest.spyOn(require('../services/seo/contact-finder')._internals, 'fetchPage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(page(`<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`));
    const result = await auditor.audit();
    spy.mockRestore();
    expect(updates.map((u) => u.patch.status)).toEqual(['fetch-blocked', 'verified']);
    expect(result['fetch-blocked']).toBe(1);
  });

  describe('a staff edit made between the read and the write wins', () => {
    const goodPage = `<h1>Waves Pest Control</h1><p>${BRAND.phone}</p>`;
    const run = async (edit) => {
      store = rows([{ id: 'r', listing_url: 'https://old.example/l', status: 'unverified' }]);
      const fetchOld = async () => {
        edit(store[0]); // staff act while the fetch is in flight
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => `<html><head><title>x</title></head><body>${goodPage}${filler}</body></html>` };
      };
      const result = await auditor.audit({ fetchFn: fetchOld, resolveHostFn: async () => true });
      return { result, row: store[0] };
    };

    test.each([
      ['marked missing', (r) => { r.status = 'missing'; r.updated_at = new Date(T0.getTime() + 5000); }],
      ['URL changed', (r) => { r.listing_url = 'https://new.example/l'; r.status = 'unverified'; r.updated_at = new Date(T0.getTime() + 5000); }],
      ['office changed', (r) => { r.location_id = 'venice'; r.updated_at = new Date(T0.getTime() + 5000); }],
      ['any edit that only moves updated_at', (r) => { r.updated_at = new Date(T0.getTime() + 5000); }],
    ])('%s: the stale result is discarded, not written over it', async (_label, edit) => {
      const { result, row } = await run(edit);
      expect(updates).toEqual([]);
      expect(row.status).not.toBe('verified');
      expect(result).toMatchObject({ total: 0, skipped: 1 });
      expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('changed during the sweep'));
    });

    test('an untouched row is written, matching a microsecond-precision updated_at within a millisecond', async () => {
      const { result, row } = await run((r) => { r.updated_at = new Date(T0.getTime() + 0.4); });
      expect(row.status).toBe('verified');
      expect(result).toMatchObject({ total: 1, skipped: 0, verified: 1 });
    });
  });
});

describe('getDashboard() and updateCitation()', () => {
  test('dashboard counts all five states and carries the NAP from locations.js', async () => {
    const rows = ['unverified', 'verified', 'verified', 'mismatched', 'fetch-blocked', 'missing'].map((status) => ({ status, priority: 'high' }));
    db.mockImplementation(() => ({ orderBy: () => ({ orderBy: async () => rows }) }));
    const d = await auditor.getDashboard();
    expect(d.byStatus).toEqual({ unverified: 1, verified: 2, mismatched: 1, 'fetch-blocked': 1, missing: 1 });
    expect(d.canonicalNAP).toMatchObject({ phone: BRAND.phone, address: BRAND.address, name: 'Waves Pest Control' });
    expect(d.locations.map((l) => l.id)).toEqual(WAVES_LOCATIONS.map((l) => l.id));
  });

  describe('updateCitation', () => {
    let patches;
    let stored;
    beforeEach(() => {
      patches = [];
      stored = { id: '1', listing_url: 'https://old.example/l', location_id: 'bradenton', status: 'verified', nap_name: 'Waves Pest Control', nap_phone: '(941) 318-7612', nap_address: '13649 Luxe Ave', last_checked: '2026-09-28' };
      db.mockImplementation(() => ({ where: () => ({ first: async () => stored, update: async (p) => { patches.push(p); } }) }));
    });

    test('a no-op save (same URL and office, normalized alike) keeps the verified evidence (Codex r2 P2-5)', async () => {
      await auditor.updateCitation('1', { listing_url: '  https://old.example/l ', location_id: 'bradenton', priority: 'high' });
      expect(patches).toHaveLength(1);
      for (const k of ['status', 'status_detail', 'nap_name', 'nap_phone', 'nap_address', 'last_checked', 'nap_consistent']) expect(patches[0]).not.toHaveProperty(k);
      stored = { ...stored, listing_url: null, location_id: '' };
      await auditor.updateCitation('1', { listing_url: '', location_id: '' }); // null vs empty is the same "unset"
      expect(patches[1]).not.toHaveProperty('status');
    });

    test('a real URL or office change resets the evidence; so does an explicit status', async () => {
      await auditor.updateCitation('1', { listing_url: 'https://other.example/l' });
      await auditor.updateCitation('1', { listing_url: 'https://old.example/l', location_id: 'venice' });
      await auditor.updateCitation('1', { listing_url: 'https://old.example/l', status: 'unverified' });
      for (const p of patches) expect(p).toMatchObject({ status: expect.stringMatching(/unverified/), nap_name: null, nap_phone: null, nap_address: null, last_checked: null });
    });

    test('listing URLs are parsed: https://% and hostless, non-http are rejected before persisting (Codex r2 P2-6)', async () => {
      for (const bad of ['https://%', 'https://', 'ftp://dir.example/l', 'mailto:a@b.co', 'https://a b']) {
        await expect(auditor.updateCitation('1', { listing_url: bad })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      }
      expect(patches).toHaveLength(0);
      await auditor.updateCitation('1', { listing_url: 'https://dir.example/a%20b?x=1' });
      expect(patches).toHaveLength(1);
    });

    test('only a human can record "missing"; verified/mismatched/fetch-blocked are refused', async () => {
      await auditor.updateCitation('1', { status: 'missing' });
      expect(patches[0]).toMatchObject({ status: 'missing', status_detail: null });
      for (const status of ['verified', 'mismatched', 'fetch-blocked', 'active']) {
        await expect(auditor.updateCitation('1', { status })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      }
      expect(patches).toHaveLength(1);
    });

    test('changing the URL or office resets the row to unverified for the next audit', async () => {
      await auditor.updateCitation('1', { listing_url: 'https://dir.example/waves', location_id: 'parrish' });
      expect(patches[0]).toMatchObject({ listing_url: 'https://dir.example/waves', location_id: 'parrish', status: 'unverified', nap_consistent: null });
      expect(patches[0].updated_at).toBeInstanceOf(Date); // the sweep's conditional write keys on it
    });

    test('any reset also clears the stale evidence: nap_* and last_checked, status_detail, nap_consistent (Codex P2-2)', async () => {
      const cleared = { status_detail: null, nap_consistent: null, nap_name: null, nap_phone: null, nap_address: null, last_checked: null };
      await auditor.updateCitation('1', { listing_url: 'https://new.example/l' });
      await auditor.updateCitation('1', { listing_url: '' });
      await auditor.updateCitation('1', { location_id: 'venice' });
      await auditor.updateCitation('1', { status: 'unverified' });
      await auditor.updateCitation('1', { status: 'missing' });
      for (const p of patches) expect(p).toMatchObject(cleared);
      await auditor.updateCitation('1', { priority: 'low' });
      expect(patches[5]).not.toHaveProperty('nap_name'); // a priority-only edit resets nothing
    });

    test('the fields the editor sends: URL is trimmed, blank clears it, priority is validated', async () => {
      await auditor.updateCitation('1', { listing_url: '  https://dir.example/waves  ' });
      expect(patches[0].listing_url).toBe('https://dir.example/waves');
      await auditor.updateCitation('1', { listing_url: '', location_id: '' });
      expect(patches[1]).toMatchObject({ listing_url: null, location_id: null, status: 'unverified' });
      await expect(auditor.updateCitation('1', { listing_url: 'https://a b' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      await expect(auditor.updateCitation('1', { priority: 'urgent' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
    });

    test('rejects an unknown office and a non-http URL; ignores unknown fields', async () => {
      await expect(auditor.updateCitation('1', { location_id: 'tampa' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      await expect(auditor.updateCitation('1', { listing_url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'INVALID_CITATION_UPDATE' });
      await auditor.updateCitation('1', { priority: 'low', nap_consistent: true, directory_name: 'x' });
      expect(patches[0]).not.toHaveProperty('nap_consistent');
      expect(patches[0]).not.toHaveProperty('directory_name');
    });
  });
});
