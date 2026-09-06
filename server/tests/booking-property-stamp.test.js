// New Appointment service-address picker — the create route's property resolver.
describe('bookingPropertyStamp (New Appointment service-address picker)', () => {
  const { bookingPropertyStamp } = require('../services/customer-properties');
  const PROPERTY = {
    id: '0f8c1e4a-2b3d-4c5e-8f90-1a2b3c4d5e6f', customer_id: 'cust-1', active: true,
    address_line1: '20 Oak St', address_line2: null, city: 'Naples', state: 'FL', zip: '34103',
    latitude: '27.4900000', longitude: '-82.6300000',
  };
  const connReturning = (row) => {
    const q = { where: jest.fn(() => q), forShare: jest.fn(() => q), first: jest.fn().mockResolvedValue(row) };
    return Object.assign(jest.fn(() => q), { q });
  };
  test('the transaction re-read takes a share lock only when asked', async () => {
    const plain = connReturning(PROPERTY);
    await bookingPropertyStamp({ customerId: 'cust-1', propertyId: PROPERTY.id }, plain);
    expect(plain.q.forShare).not.toHaveBeenCalled();
    const locked = connReturning(PROPERTY);
    await bookingPropertyStamp({ customerId: 'cust-1', propertyId: PROPERTY.id }, locked, { lock: true });
    expect(locked.q.forShare).toHaveBeenCalledTimes(1);
  });
  test('no propertyId → null (caller falls through to the sole-property anchor)', async () => {
    const conn = connReturning(PROPERTY);
    expect(await bookingPropertyStamp({ customerId: 'cust-1', propertyId: undefined }, conn)).toBeNull();
    expect(await bookingPropertyStamp({ customerId: 'cust-1', propertyId: '' }, conn)).toBeNull();
    expect(conn).not.toHaveBeenCalled();
  });
  test('a malformed id is a 422 before any read', async () => {
    const conn = connReturning(PROPERTY);
    await expect(bookingPropertyStamp({ customerId: 'cust-1', propertyId: 'not-a-uuid' }, conn))
      .rejects.toMatchObject({ statusCode: 422, code: 'INVALID_BOOKING_PROPERTY' });
    expect(conn).not.toHaveBeenCalled();
  });
  test('scopes the read to this customer\'s ACTIVE properties and 422s a miss', async () => {
    const conn = connReturning(undefined);
    await expect(bookingPropertyStamp({ customerId: 'cust-1', propertyId: PROPERTY.id }, conn))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(conn.q.where).toHaveBeenCalledWith({ id: PROPERTY.id, customer_id: 'cust-1', active: true });
  });
  test('refuses a property without a complete street address', async () => {
    const conn = connReturning({ ...PROPERTY, zip: '' });
    await expect(bookingPropertyStamp({ customerId: 'cust-1', propertyId: PROPERTY.id }, conn))
      .rejects.toMatchObject({ statusCode: 422 });
  });
  test('returns the scheduled_services address stamp (same field set the edit path writes)', async () => {
    const conn = connReturning(PROPERTY);
    expect(await bookingPropertyStamp({ customerId: 'cust-1', propertyId: PROPERTY.id }, conn)).toEqual({
      property_id: PROPERTY.id,
      service_address_line1: '20 Oak St',
      service_address_line2: '',
      service_address_city: 'Naples',
      service_address_state: 'FL',
      service_address_zip: '34103',
      lat: '27.4900000',
      lng: '-82.6300000',
    });
  });
});
