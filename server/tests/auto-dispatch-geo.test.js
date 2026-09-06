const { resolveGeo } = require('../services/auto-dispatch/geo');
const home = { customer_address_line1: '100 Example Street', customer_city: 'Example City', customer_zip: '00000', customer_latitude: 27.4, customer_longitude: -82.5 };
test('unstamped and matching visits can use primary coordinates', () => {
  expect(resolveGeo(home)).toEqual({ lat: 27.4, lng: -82.5 });
  expect(resolveGeo({ ...home, service_address_line1: home.customer_address_line1 })).toEqual({ lat: 27.4, lng: -82.5 });
});
test('a moved property cannot fall back to the primary home or mix coordinate pairs', () => {
  const moved = { ...home, service_address_line1: '200 Sample Avenue' };
  expect(resolveGeo(moved)).toBeNull();
  expect(resolveGeo({ ...moved, lat: 28 })).toBeNull();
  expect(resolveGeo({ ...moved, lat: 28, lng: -81 })).toEqual({ lat: 28, lng: -81 });
});
test('same street in a different city or ZIP is also divergent', () => {
  expect(resolveGeo({ ...home, service_address_line1: home.customer_address_line1, service_address_city: 'Different City' })).toBeNull();
  expect(resolveGeo({ ...home, service_address_line1: home.customer_address_line1, service_address_zip: '00001' })).toBeNull();
});
