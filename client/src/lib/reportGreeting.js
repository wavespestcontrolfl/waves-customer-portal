// The first name a report page greets with ("Hi {first}, ...").
//
// The report payload carries the composed full name (`customerName`) and, since
// the call booker can create a customer with a blank first_name, the customer's
// own first name as `customerFirstName` (null when blank). For that customer the
// composed name is just the surname, so the first token of customerName would
// greet "Hi Murphy". When the key is present it is authoritative; a payload
// without it (cached older payloads) keeps the first token of customerName.
// Returns '' when there is no first name: callers fall back to "there" / no name.
function firstToken(value) {
  return String(value == null ? '' : value).trim().split(/\s+/)[0] || '';
}

export function reportGreetingFirstName(data) {
  if (data && Object.prototype.hasOwnProperty.call(data, 'customerFirstName')) {
    return firstToken(data.customerFirstName);
  }
  return firstToken(data?.customerName);
}
