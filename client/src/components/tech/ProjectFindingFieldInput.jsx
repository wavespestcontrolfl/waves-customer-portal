import { useEffect, useMemo, useState } from 'react';
import AddressAutocomplete from '../AddressAutocomplete';
import { adminFetch } from '../../lib/adminFetch';

const ESTIMATE_INPUT_STYLE = {
  minHeight: 48,
  border: '1px solid #CFE7F5',
  borderRadius: 10,
  padding: '12px 14px',
  fontSize: 15,
  fontWeight: 500,
  color: '#1B2C5B',
  background: '#F8FCFE',
  outline: 'none',
};

function formatAddress(parts) {
  return parts?.formatted || [
    parts?.line1,
    [parts?.city, parts?.state].filter(Boolean).join(', '),
    parts?.zip,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function productLabel(product) {
  return String(product?.name || product?.product_name || '').trim();
}

function productMeta(product) {
  return [
    product?.category,
    product?.active_ingredient || product?.activeIngredient,
    product?.epa_reg_number || product?.epaRegNumber,
  ].filter(Boolean).join(' · ');
}

function buildProductOptions(products = [], fallbackOptions = []) {
  const seen = new Set();
  const options = [];
  const add = (value, meta = '') => {
    const label = String(value || '').trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ label, value: label, meta, product: null });
  };
  products.forEach((product) => {
    const label = productLabel(product);
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ label, value: label, meta: productMeta(product), product });
  });
  fallbackOptions.forEach((option) => add(option));
  return options;
}

function SearchableProductInput({
  id,
  name,
  value,
  onChange,
  placeholder,
  inputStyle,
  products,
  fallbackOptions,
  onProductSelect,
}) {
  const [focused, setFocused] = useState(false);
  const options = useMemo(
    () => buildProductOptions(products, fallbackOptions),
    [products, fallbackOptions],
  );
  const query = String(value || '').trim().toLowerCase();
  const filtered = options
    .filter((option) => !query || option.label.toLowerCase().includes(query) || option.meta.toLowerCase().includes(query))
    .slice(0, 8);
  const showOptions = focused && filtered.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        name={name}
        type="text"
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        placeholder={placeholder || 'Search products...'}
        autoComplete="off"
        style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE }}
      />
      {showOptions && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 30,
            background: '#FFFFFF',
            border: '1px solid #D7E3EA',
            borderRadius: 12,
            boxShadow: '0 12px 28px rgba(27, 44, 91, 0.14)',
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {filtered.map((option, index) => (
            <button
              key={option.value}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(option.value);
                if (option.product) onProductSelect?.(option.product);
                setFocused(false);
              }}
              style={{
                width: '100%',
                display: 'block',
                textAlign: 'left',
                border: 0,
                borderBottom: index === filtered.length - 1 ? 'none' : '1px solid #E7E2D7',
                background: '#FFFFFF',
                color: '#1B2C5B',
                padding: '11px 14px',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'block', fontSize: 14, fontWeight: 800 }}>{option.label}</span>
              {option.meta && (
                <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: '#6B7280' }}>
                  {option.meta}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function customerDisplayName(customer) {
  const company = String(customer?.companyName || customer?.company_name || '').trim();
  const person = [customer?.firstName || customer?.first_name, customer?.lastName || customer?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return company || person;
}

function CustomerSearchInput({ id, name, value, onChange, placeholder, inputStyle }) {
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState([]);
  const query = String(value || '').trim();

  useEffect(() => {
    if (!focused || query.length < 2) {
      setResults([]);
      return undefined;
    }
    const timeout = setTimeout(async () => {
      try {
        const response = await adminFetch(`/admin/customers?search=${encodeURIComponent(query)}&limit=8`);
        const body = await response.json();
        setResults((body.customers || body || []).slice(0, 8));
      } catch {
        setResults([]);
      }
    }, 220);
    return () => clearTimeout(timeout);
  }, [focused, query]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        name={name}
        type="text"
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        placeholder={placeholder || 'Search customers or type contractor name'}
        autoComplete="off"
        style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE }}
      />
      {focused && results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 30,
            background: '#FFFFFF',
            border: '1px solid #D7E3EA',
            borderRadius: 12,
            boxShadow: '0 12px 28px rgba(27, 44, 91, 0.14)',
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {results.map((customer, index) => {
            const label = customerDisplayName(customer) || 'Customer';
            return (
              <button
                key={customer.id || `${label}-${index}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(label);
                  setFocused(false);
                }}
                style={{
                  width: '100%',
                  display: 'block',
                  textAlign: 'left',
                  border: 0,
                  borderBottom: index === results.length - 1 ? 'none' : '1px solid #E7E2D7',
                  background: '#FFFFFF',
                  color: '#1B2C5B',
                  padding: '11px 14px',
                  cursor: 'pointer',
                }}
              >
                <span style={{ display: 'block', fontSize: 14, fontWeight: 800 }}>{label}</span>
                {(customer.address || customer.city) && (
                  <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: '#6B7280' }}>
                    {[customer.address, customer.city].filter(Boolean).join(' · ')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function hasCatalogBackedProjectFields(fields = []) {
  return fields.some((field) => field.type === 'product_search');
}

export default function ProjectFindingFieldInput({
  field,
  id,
  name,
  value,
  onChange,
  inputStyle,
  products = [],
  onProductSelect,
}) {
  if (field.type === 'address') {
    return (
      <AddressAutocomplete
        id={id}
        name={name}
        value={value || ''}
        onChange={onChange}
        onSelect={(parts) => onChange(formatAddress(parts))}
        placeholder={field.placeholder || 'Start typing the treatment address'}
        style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE }}
      />
    );
  }

  if (field.type === 'product_search') {
    return (
      <SearchableProductInput
        id={id}
        name={name}
        value={value || ''}
        onChange={onChange}
        placeholder={field.placeholder}
        inputStyle={inputStyle}
        products={products}
        fallbackOptions={field.options || []}
        onProductSelect={onProductSelect}
      />
    );
  }

  if (field.type === 'customer_search') {
    return (
      <CustomerSearchInput
        id={id}
        name={name}
        value={value || ''}
        onChange={onChange}
        placeholder={field.placeholder}
        inputStyle={inputStyle}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <select
        id={id}
        name={name}
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE }}
      >
        <option value="">Select...</option>
        {(field.options || []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'textarea') {
    return (
      <textarea
        id={id}
        name={name}
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder || ''}
        rows={3}
        style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE, resize: 'vertical', minHeight: 92 }}
      />
    );
  }

  return (
    <input
      id={id}
      name={name}
      type={field.type === 'date' || field.type === 'time' ? field.type : 'text'}
      value={value || ''}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder || ''}
      style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE }}
    />
  );
}
