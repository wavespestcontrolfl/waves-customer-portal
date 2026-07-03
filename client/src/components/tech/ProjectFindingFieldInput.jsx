import { useEffect, useMemo, useState } from 'react';
import AddressAutocomplete from '../AddressAutocomplete';
import { adminFetch } from '../../lib/adminFetch';
import { computePretreatChemistry } from '../../lib/termitePretreatRates';
import DictationButton from './DictationButton';

// Append a dictated chunk to an existing field value with a single space.
function appendDictation(current, chunk) {
  const base = String(current || '');
  return base.trim() ? `${base.replace(/\s+$/, '')} ${chunk}` : chunk;
}

const ESTIMATE_INPUT_STYLE = {
  minHeight: 48,
  border: '1px solid #D4D4D8',
  borderRadius: 10,
  padding: '12px 14px',
  fontSize: 15,
  fontWeight: 500,
  color: '#09090B',
  background: '#FFFFFF',
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
  const handleValueChange = (nextValue) => {
    onChange(nextValue);
    const exactMatch = options.find((option) => option.label.toLowerCase() === String(nextValue || '').trim().toLowerCase());
    if (exactMatch?.product) onProductSelect?.(exactMatch.product);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        name={name}
        type="text"
        value={value || ''}
        onChange={(event) => handleValueChange(event.target.value)}
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
                handleValueChange(option.value);
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

function parseMultiSelectValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatMultiSelectValue(values) {
  return values.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
}

// Always-visible multi-toggle chips (no dropdown) — built for one-thumb
// field completion. Same comma-joined storage as multi_select.
function InlineChipsInput({ id, name, value, onChange, options = [] }) {
  const selected = useMemo(() => parseMultiSelectValue(value), [value]);
  const selectedSet = useMemo(() => new Set(selected.map((item) => item.toLowerCase())), [selected]);

  const toggleOption = (option) => {
    const normalized = String(option || '').trim();
    if (!normalized) return;
    const next = selectedSet.has(normalized.toLowerCase())
      ? selected.filter((item) => item.toLowerCase() !== normalized.toLowerCase())
      : [...selected, normalized];
    onChange(formatMultiSelectValue(next));
  };

  return (
    <div id={id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <input type="hidden" name={name} value={formatMultiSelectValue(selected)} />
      {options.map((option) => {
        const isSelected = selectedSet.has(String(option).toLowerCase());
        return (
          <button
            key={option}
            type="button"
            onClick={() => toggleOption(option)}
            aria-pressed={isSelected}
            style={{
              minHeight: 38,
              padding: '8px 14px',
              borderRadius: 999,
              border: `1px solid ${isSelected ? '#1B2C5B' : '#CFE7F5'}`,
              background: isSelected ? '#1B2C5B' : '#F8FCFE',
              color: isSelected ? '#fff' : '#1B2C5B',
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

// Integer stepper for quick counts (traps checked, captures). Stores the
// number as a string; empty string = not recorded (distinct from 0).
function CountStepperInput({ id, name, value, onChange }) {
  const current = String(value ?? '').trim();
  const n = current === '' ? null : Number(current);
  const setCount = (next) => {
    if (next == null || next < 0) return onChange('');
    onChange(String(Math.min(9999, next)));
  };
  const buttonStyle = {
    width: 48,
    height: 48,
    borderRadius: 10,
    border: '1px solid #CFE7F5',
    background: '#F8FCFE',
    color: '#1B2C5B',
    fontSize: 20,
    fontWeight: 600,
    cursor: 'pointer',
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" aria-label="Decrease" style={buttonStyle} onClick={() => setCount(n == null ? null : n - 1)}>−</button>
      <input
        id={id}
        name={name}
        type="number"
        inputMode="numeric"
        min={0}
        max={9999}
        value={current}
        placeholder="—"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange('');
          const parsed = Number(raw);
          if (Number.isInteger(parsed) && parsed >= 0) setCount(parsed);
        }}
        style={{ ...ESTIMATE_INPUT_STYLE, width: 88, textAlign: 'center' }}
      />
      <button type="button" aria-label="Increase" style={buttonStyle} onClick={() => setCount(n == null ? 1 : n + 1)}>+</button>
    </div>
  );
}

function MultiSelectInput({ id, name, value, onChange, inputStyle, options = [] }) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseMultiSelectValue(value), [value]);
  const selectedSet = useMemo(() => new Set(selected.map((item) => item.toLowerCase())), [selected]);

  const toggleOption = (option) => {
    const normalized = String(option || '').trim();
    if (!normalized) return;
    const next = selectedSet.has(normalized.toLowerCase())
      ? selected.filter((item) => item.toLowerCase() !== normalized.toLowerCase())
      : [...selected, normalized];
    onChange(formatMultiSelectValue(next));
  };

  return (
    <div style={{ position: 'relative' }}>
      <input type="hidden" name={name} value={formatMultiSelectValue(selected)} />
      <button
        id={id}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        style={{
          ...inputStyle,
          ...ESTIMATE_INPUT_STYLE,
          width: '100%',
          minHeight: 48,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1, color: selected.length ? '#1B2C5B' : '#6B7280', lineHeight: 1.35 }}>
          {selected.length ? selected.join(', ') : 'Select one or more...'}
        </span>
        <span style={{ color: '#6B7280', fontSize: 12, fontWeight: 800 }}>Select</span>
      </button>
      {open && (
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
            maxHeight: 260,
            overflowY: 'auto',
            padding: 6,
          }}
        >
          {options.map((option) => {
            const checked = selectedSet.has(String(option || '').toLowerCase());
            return (
              <button
                key={option}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggleOption(option)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'left',
                  border: 0,
                  borderRadius: 8,
                  background: checked ? '#EAF6FC' : '#FFFFFF',
                  color: '#1B2C5B',
                  padding: '10px 10px',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: checked ? 800 : 600,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: `1px solid ${checked ? '#1B2C5B' : '#CFE7F5'}`,
                    background: '#FFFFFF',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: '0 0 auto',
                  }}
                >
                  {checked && (
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: '#1B2C5B',
                        display: 'block',
                      }}
                    />
                  )}
                </span>
                <span>{option}</span>
              </button>
            );
          })}
          {selected.length > 0 && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange('')}
              style={{
                width: '100%',
                marginTop: 4,
                border: '1px solid #D7E3EA',
                borderRadius: 8,
                background: '#FFFFFF',
                color: '#6B7280',
                padding: '9px 10px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 800,
              }}
            >
              Clear selections
            </button>
          )}
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

function customerContactSummary(customer) {
  return [
    customerDisplayName(customer),
    customer?.phone || customer?.phone_number || customer?.mobile || '',
    customer?.email || customer?.email_address || '',
  ].map((item) => String(item || '').trim()).filter(Boolean).join(' · ');
}

function customerSearchValue(customer, field) {
  if (field?.customerValue === 'contact_summary') {
    return customerContactSummary(customer) || customerDisplayName(customer) || '';
  }
  return customerDisplayName(customer) || '';
}

function customerSearchMeta(customer, field) {
  if (field?.customerValue === 'contact_summary') {
    return [
      customer?.phone || customer?.phone_number || customer?.mobile,
      customer?.email || customer?.email_address,
      customer?.city,
    ].filter(Boolean).join(' · ');
  }
  return [customer.address, customer.city].filter(Boolean).join(' · ');
}

function noDictationInputProps(field = {}) {
  const noDictationKeys = new Set([
    'property_address',
    'requested_by',
    'inspection_fee',
    'structure_sqft',
    'structures_inspected',
    'structure_footprint',
    'structure_footprint_approx',
    'structure_footprint_approx_sq_ft',
    'structure_footprint_sqft',
    'structure_footprint_sq_ft',
    'report_sent_to',
  ]);
  if (!field.disableDictation && !noDictationKeys.has(field.key)) return {};
  return {
    autoComplete: 'off',
    inputMode: field.inputMode || 'text',
    enterKeyHint: 'done',
    spellCheck: false,
    'data-no-dictation': 'true',
  };
}

function CustomerSearchInput({ id, name, value, onChange, placeholder, inputStyle, field }) {
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
        {...noDictationInputProps(field)}
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
            const meta = customerSearchMeta(customer, field);
            return (
              <button
                key={customer.id || `${label}-${index}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(customerSearchValue(customer, field) || label);
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
                {meta && (
                  <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: '#6B7280' }}>
                    {meta}
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
  return fields.some((field) => field.type === 'product_search'
    || (Array.isArray(field.fields) && hasCatalogBackedProjectFields(field.fields)));
}

export function normalizeApplicationRows(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function rowChemistryInputs(row = {}) {
  return {
    productName: row.product_name,
    squareFootage: row.square_footage,
    linearFeet: row.linear_feet,
    trenchDepthFt: row.trench_depth_ft,
  };
}

// Keep a row's concentration/gallons in step with the label-rate calculation,
// with the same ownership rule as the primary application's sync effect but
// expressed purely: a field is rewritten only while blank or still holding
// the previous inputs' computed value — a hand-typed labeled rate survives.
// A known bait/wood product force-clears both (no finished-solution chemistry
// exists, so anything here would print wrong on the certificate).
function applyRowChemistry(prevRow, nextRow) {
  const prevChem = computePretreatChemistry(rowChemistryInputs(prevRow));
  const nextChem = computePretreatChemistry(rowChemistryInputs(nextRow));
  if (nextChem.status === 'unknown_product') return nextRow;
  if (nextChem.status === 'not_applicable') {
    return { ...nextRow, concentration_pct: '', gallons_applied: '' };
  }
  const owns = (key, prevAuto) => {
    const current = String(nextRow[key] || '').trim();
    return current === '' || current === String(prevAuto ?? '');
  };
  const out = { ...nextRow };
  if (owns('concentration_pct', prevChem.status === 'ok' ? prevChem.concentrationPct : '')) {
    out.concentration_pct = nextChem.concentrationPct;
  }
  if (owns('gallons_applied', prevChem.status === 'ok' ? prevChem.gallonsText : '')) {
    out.gallons_applied = nextChem.gallonsText || '';
  }
  return out;
}

// Repeatable per-product application block (pre-treatment certificate):
// each row carries its own method + product + EPA/A.I./concentration +
// coverage so a combined job (soil barrier + wood treatment) records one
// FDACS 5E-14.106 entry per product. Rows live in the findings as an array
// of objects; the primary application stays in the flat top-level keys.
function ApplicationsRepeaterInput({ field, id, name, value, onChange, inputStyle, products, palette }) {
  const rows = normalizeApplicationRows(value);
  const subFields = Array.isArray(field.fields) ? field.fields : [];
  const indexOffset = Number(field.itemIndexOffset) || 1;
  const itemLabel = field.itemLabel || 'Item';

  const updateRow = (index, key, nextValue) => {
    const next = rows.map((row, i) => {
      if (i !== index) return row;
      return applyRowChemistry(row, { ...row, [key]: nextValue });
    });
    onChange(next);
  };

  const handleRowProductSelect = (index, product) => {
    const productName = productLabel(product);
    const epaRegistration = product?.epa_reg_number || product?.epaRegNumber || '';
    const activeIngredient = product?.active_ingredient || product?.activeIngredient || '';
    const next = rows.map((row, i) => {
      if (i !== index) return row;
      const picked = {
        ...row,
        product_name: productName || row.product_name || '',
        ...(epaRegistration ? { epa_registration: epaRegistration } : {}),
        ...(activeIngredient ? { active_ingredient: activeIngredient } : {}),
      };
      return applyRowChemistry(row, picked);
    });
    onChange(next);
  };

  const addRow = () => onChange([...rows, {}]);
  const removeRow = (index) => onChange(rows.filter((_, i) => i !== index));

  return (
    <div id={id} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {field.description && (
        <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>{field.description}</div>
      )}
      {rows.map((row, index) => {
        const chem = computePretreatChemistry(rowChemistryInputs(row));
        return (
          <div
            key={index}
            style={{
              border: '1px solid #D7E3EA',
              borderRadius: 12,
              background: '#F8FCFE',
              padding: '12px 14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#1B2C5B' }}>
                {itemLabel} {index + indexOffset}
              </div>
              <button
                type="button"
                onClick={() => removeRow(index)}
                style={{
                  border: '1px solid #D7E3EA',
                  borderRadius: 8,
                  background: '#FFFFFF',
                  color: '#6B7280',
                  fontSize: 12,
                  fontWeight: 800,
                  padding: '6px 10px',
                  cursor: 'pointer',
                }}
              >
                Remove
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {subFields.map((subField) => {
                if (subField.showWhen && String(row[subField.showWhen.field] || '') !== subField.showWhen.value) {
                  return null;
                }
                return (
                  <div key={subField.key}>
                    <label
                      htmlFor={`${id}-${index}-${subField.key}`}
                      style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#1B2C5B', marginBottom: 6 }}
                    >
                      {subField.label}
                    </label>
                    <ProjectFindingFieldInput
                      field={subField}
                      id={`${id}-${index}-${subField.key}`}
                      name={`${name}[${index}].${subField.key}`}
                      value={row[subField.key] || ''}
                      onChange={(nextValue) => updateRow(index, subField.key, nextValue)}
                      inputStyle={inputStyle}
                      products={products}
                      onProductSelect={(product) => handleRowProductSelect(index, product)}
                      palette={palette}
                    />
                    {subField.key === 'product_name' && chem.status === 'not_applicable' && chem.note && (
                      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>{chem.note}</div>
                    )}
                    {subField.key === 'concentration_pct' && chem.status === 'ok' && (
                      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                        Auto-filled with the label&apos;s standard pre-construction dilution — overtype to record a different labeled rate.
                      </div>
                    )}
                    {subField.key === 'gallons_applied' && chem.status === 'ok' && chem.note && (
                      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                        Auto-calculated: {chem.note}.
                      </div>
                    )}
                    {(subField.key === 'concentration_pct' || subField.key === 'gallons_applied') && chem.status === 'not_applicable' && (
                      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                        Not applicable for this product — kept blank on the certificate.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRow}
        style={{
          border: '1px dashed #CFE7F5',
          borderRadius: 10,
          background: '#FFFFFF',
          color: '#1B2C5B',
          fontSize: 14,
          fontWeight: 800,
          padding: '12px 14px',
          cursor: 'pointer',
          textAlign: 'center',
        }}
      >
        + {field.addLabel || `Add ${itemLabel.toLowerCase()}`}
      </button>
    </div>
  );
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
  palette,
}) {
  if (field.type === 'applications') {
    return (
      <ApplicationsRepeaterInput
        field={field}
        id={id}
        name={name}
        value={value}
        onChange={onChange}
        inputStyle={inputStyle}
        products={products}
        palette={palette}
      />
    );
  }

  if (field.type === 'address' && field.key !== 'property_address') {
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
        field={field}
      />
    );
  }

  if (field.type === 'select') {
    // Options are plain strings, or { value, label } pairs when the stored
    // value and the display text differ (e.g. the applicator picker stores
    // a technician id behind a name label).
    const options = (field.options || []).map((option) => (
      option && typeof option === 'object'
        ? { value: String(option.value), label: String(option.label ?? option.value) }
        : { value: String(option), label: String(option) }
    ));
    const currentValue = String(value || '').trim();
    const hasCurrentOption = !currentValue || options.some((option) => option.value === currentValue);
    return (
      <select
        id={id}
        name={name}
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE }}
      >
        <option value="">Select...</option>
        {!hasCurrentOption && (
          <option value={currentValue}>{currentValue}</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'multi_select') {
    return (
      <MultiSelectInput
        id={id}
        name={name}
        value={value || ''}
        onChange={onChange}
        inputStyle={inputStyle}
        options={field.options || []}
      />
    );
  }

  if (field.type === 'chips') {
    return (
      <InlineChipsInput
        id={id}
        name={name}
        value={value || ''}
        onChange={onChange}
        options={field.options || []}
      />
    );
  }

  if (field.type === 'count') {
    return (
      <CountStepperInput
        id={id}
        name={name}
        value={value}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'textarea') {
    const noDictationProps = noDictationInputProps(field);
    const suppressDictation = Boolean(noDictationProps['data-no-dictation']);
    return (
      <div style={{ position: 'relative' }}>
        <textarea
          id={id}
          name={name}
          value={value || ''}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder || ''}
          rows={3}
          {...noDictationProps}
          style={{
            ...inputStyle,
            ...ESTIMATE_INPUT_STYLE,
            resize: 'vertical',
            minHeight: 92,
            ...(suppressDictation ? {} : { paddingRight: 44 }),
          }}
        />
        {!suppressDictation && (
          <div style={{ position: 'absolute', right: 8, bottom: 8 }}>
            <DictationButton palette={palette} onAppend={(text) => onChange(appendDictation(value, text))} />
          </div>
        )}
      </div>
    );
  }

  const isDateOrTime = field.type === 'date' || field.type === 'time';
  const noDictationProps = noDictationInputProps(field);
  const suppressDictation = Boolean(noDictationProps['data-no-dictation']);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        name={name}
        type={isDateOrTime ? field.type : 'text'}
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder || ''}
        {...noDictationProps}
        style={{ ...inputStyle, ...ESTIMATE_INPUT_STYLE, ...((isDateOrTime || suppressDictation) ? {} : { paddingRight: 44 }) }}
      />
      {!isDateOrTime && !suppressDictation && (
        <div style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)' }}>
          <DictationButton palette={palette} onAppend={(text) => onChange(appendDictation(value, text))} />
        </div>
      )}
    </div>
  );
}
