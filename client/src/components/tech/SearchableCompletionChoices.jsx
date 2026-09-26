import { useEffect, useId, useMemo, useRef, useState } from 'react';

const clean = (value) => String(value || '').trim();
const keyOf = (value) => clean(value).toLowerCase();

/** Searchable visit facts. A suggestion changes the record only when selected. */
export default function SearchableCompletionChoices({
  label,
  options = [],
  values = [],
  onChange,
  disabled = false,
  allowCustom = true,
  maxSelections = Infinity,
  placeholder,
  helper,
}) {
  const listId = useId();
  const listRef = useRef(null);
  const focusFirstOptionWhenOpen = useRef(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = values.map(clean).filter(Boolean);
  const selectedKeys = new Set(selected.map(keyOf));
  const choices = useMemo(() => {
    const seen = new Set();
    return options.map((option) => typeof option === 'string' ? { label: option } : option)
      .filter((option) => {
        const key = keyOf(option?.label);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [options]);
  const search = keyOf(query);
  const searchTerms = search.split(/\s+/).filter(Boolean);
  const matches = choices.filter((option) => {
    const haystack = [option.label, option.group, option.detail, ...(option.keywords || [])].join(' ').toLowerCase();
    return searchTerms.every((term) => haystack.includes(term));
  });
  const atLimit = selected.length >= maxSelections;
  const custom = allowCustom && clean(query) && !choices.some((option) => keyOf(option.label) === search)
    && !selectedKeys.has(search);
  const toggle = (value) => {
    if (disabled) return;
    const normalized = clean(value);
    if (selectedKeys.has(keyOf(normalized))) {
      onChange(selected.filter((item) => keyOf(item) !== keyOf(normalized)));
    } else if (normalized && !atLimit) {
      onChange([...selected, normalized]);
    }
  };
  const addCustom = () => {
    if (!custom || atLimit) return;
    toggle(query);
    setQuery('');
  };
  const buttonStyle = {
    minHeight: 42, padding: '10px 12px', border: 0, borderRadius: 8,
    background: '#fff', color: '#18181b', textAlign: 'left', font: 'inherit', cursor: 'pointer',
  };
  const enabledOptions = () => Array.from(
    listRef.current?.querySelectorAll('button[role="option"]:not(:disabled)') || [],
  );
  const focusFirstOption = () => enabledOptions()[0]?.focus();
  const handleOptionKeyDown = (event) => {
    const optionsInList = enabledOptions();
    const currentIndex = optionsInList.indexOf(event.currentTarget);
    let nextIndex;
    if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, optionsInList.length - 1);
    else if (event.key === 'ArrowUp') nextIndex = Math.max(currentIndex - 1, 0);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = optionsInList.length - 1;
    else return;
    event.preventDefault();
    optionsInList[nextIndex]?.focus();
  };

  useEffect(() => {
    if (!open || !focusFirstOptionWhenOpen.current) return;
    focusFirstOptionWhenOpen.current = false;
    focusFirstOption();
  }, [open]);

  return (
    <div style={{ position: 'relative', opacity: disabled ? 0.55 : 1 }}
      data-modal-escape-owned={open && !disabled ? 'true' : undefined}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.querySelector('input[role="combobox"]')?.focus();
          setOpen(false);
        }
      }}>
      <input
        type="search"
        role="combobox"
        aria-label={`Search ${label.toLowerCase()}`}
        aria-expanded={open && !disabled}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (open) focusFirstOption();
            else {
              focusFirstOptionWhenOpen.current = true;
              setOpen(true);
            }
          }
          if (event.key === 'Enter' && custom) { event.preventDefault(); addCustom(); }
        }}
        placeholder={placeholder || `Search ${label.toLowerCase()}…`}
        style={{ width: '100%', boxSizing: 'border-box', minHeight: 46, padding: '11px 13px', border: '1px solid #d4d4d8', borderRadius: 10, background: '#fff', color: '#18181b', font: '400 14px Roboto, Arial, sans-serif' }}
      />
      {helper && <div style={{ marginTop: 6, fontSize: 14, color: '#71717a', lineHeight: 1.4 }}>{helper}</div>}
      {open && !disabled && (
        <div ref={listRef} id={listId} role="listbox" aria-label={`${label} choices`} aria-multiselectable="true"
          style={{ position: 'absolute', top: 48, left: 0, right: 0, zIndex: 45, maxHeight: 290, overflowY: 'auto', padding: 6, border: '1px solid #e4e4e7', borderRadius: 12, background: '#fff', boxShadow: '0 10px 28px rgba(0,0,0,.12)' }}>
          {matches.map((option) => {
            const checked = selectedKeys.has(keyOf(option.label));
            return (
              <button key={option.id || option.label} type="button" role="option" aria-selected={checked}
                disabled={atLimit && !checked} onClick={() => toggle(option.label)} onKeyDown={handleOptionKeyDown}
                style={{ ...buttonStyle, display: 'flex', width: '100%', gap: 10, alignItems: 'flex-start', background: checked ? '#f4f4f5' : '#fff', opacity: atLimit && !checked ? 0.45 : 1 }}>
                <span aria-hidden="true" style={{ width: 16, flexShrink: 0 }}>{checked ? '✓' : '+'}</span>
                <span style={{ minWidth: 0, lineHeight: 1.4 }}>
                  <span style={{ display: 'block', fontSize: 14 }}>{option.label}</span>
                  {(option.group || option.detail) && <span style={{ display: 'block', fontSize: 14, color: '#71717a' }}>{[option.group, option.detail].filter(Boolean).join(' · ')}</span>}
                </span>
              </button>
            );
          })}
          {custom && <button type="button" role="option" aria-selected="false" disabled={atLimit} onClick={addCustom} onKeyDown={handleOptionKeyDown}
            style={{ ...buttonStyle, width: '100%', borderTop: '1px solid #e4e4e7' }}>Add “{clean(query)}”</button>}
          {!matches.length && !custom && <div style={{ padding: 12, fontSize: 14, color: '#71717a' }}>No matching choices.</div>}
          {atLimit && <div style={{ padding: '6px 12px', fontSize: 14, color: '#71717a' }}>Up to {maxSelections} selections.</div>}
        </div>
      )}
      {selected.length > 0 && <div aria-label={`Selected ${label.toLowerCase()}`} style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
        {selected.map((value) => <div key={keyOf(value)} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#f4f4f5', borderRadius: 8, padding: '4px 7px 4px 11px', fontSize: 14, lineHeight: 1.4 }}>
          <span style={{ flex: 1 }}>{value}</span>
          <button type="button" aria-label={`Remove ${value}`} disabled={disabled} onClick={() => toggle(value)}
            style={{ ...buttonStyle, minHeight: 36, minWidth: 36, background: 'transparent', padding: 5, textAlign: 'center' }}>×</button>
        </div>)}
      </div>}
    </div>
  );
}
