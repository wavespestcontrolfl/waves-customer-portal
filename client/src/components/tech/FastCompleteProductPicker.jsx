// client/src/components/tech/FastCompleteProductPicker.jsx
//
// "+ Other product" on the Fast Complete sheet: any catalog product the
// visit used beyond the house mix. On a phone it is a bottom sheet over the
// sheet's body (the sheet's header stays in view); at desktop width, a
// popover under the button. The products this service line used most in the
// last 90 days come first with their usual amount, then every pest product
// A–Z; the rest of the catalog waits behind "Show other products", and
// search covers all of it. Items never applied to a property (supplies,
// cleaner, traps, termite monitors) are not listed. A product already on the
// sheet can't be added twice: /complete keeps only the first row per product.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import useModalFocus from '../../hooks/useModalFocus';
import { Button, Input, cn } from '../ui';
import {
  byName, categoryLabel, isOutOfStock, productGroup, rankProducts, usualAmountText,
} from '../../lib/fast-complete-products';

const iconProps = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
};

export function WarningIcon() {
  return <svg {...iconProps}><path d="M12 3 2 20h20z" /><path d="M12 9v5" /><path d="M12 17.5v.01" /></svg>;
}

function CheckIcon() {
  return <svg {...iconProps} width={20} height={20}><path d="m5 12 5 5 9-10" /></svg>;
}

function SearchIcon() {
  return <svg {...iconProps} width={20} height={20} strokeWidth={2}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}

// The lists the picker browses: "Used most" in the server's order (most
// visits first), then pest and other products A–Z without repeating them.
function pickerLists(products, commonProducts) {
  const listed = products.filter((product) => product && productGroup(product) !== 'hidden');
  const byId = new Map(listed.map((product) => [String(product.id), product]));
  const commonById = new Map();
  for (const common of commonProducts) {
    const id = String(common.productId);
    if (byId.has(id) && !commonById.has(id)) commonById.set(id, common);
  }
  const rest = listed.filter((product) => !commonById.has(String(product.id))).sort(byName);
  return {
    listed,
    commonById,
    mostUsed: [...commonById.keys()].map((id) => byId.get(id)),
    pest: rest.filter((product) => productGroup(product) === 'pest'),
    other: rest.filter((product) => productGroup(product) === 'other'),
  };
}

function optionDetail(product, common) {
  const usual = usualAmountText(product, common);
  return [categoryLabel(product), usual && `usually ${usual}`].filter(Boolean).join(' · ');
}

function ProductOption({ product, common, onSheet, onPick }) {
  return (
    <Button
      type="button"
      variant="secondary"
      className="tech-visit-action tech-product-option"
      disabled={onSheet}
      onClick={() => onPick(product)}
    >
      <span className="tech-product-option-text">
        <span className="tech-product-option-name">{product.name}</span>
        {' '}
        <span className="tech-product-option-detail">{onSheet ? 'Already on the sheet' : optionDetail(product, common)}</span>
      </span>
      {!onSheet && isOutOfStock(product) && <span className="tech-product-pill"><WarningIcon />0 in stock</span>}
      {onSheet && <CheckIcon />}
    </Button>
  );
}

function OptionGroup({ title, products, lists, onSheetIds, onPick, revealed = false }) {
  const titleId = useId();
  const groupRef = useRef(null);
  // A list revealed from the footer is brought into view, not left below the fold.
  useEffect(() => {
    if (revealed) groupRef.current?.scrollIntoView?.({ block: 'start' });
  }, [revealed]);
  return (
    <div ref={groupRef} className="tech-product-group">
      <h4 id={titleId} className="tech-product-group-title">{title}</h4>
      <div role="group" aria-labelledby={titleId} className="tech-product-list">
        {products.map((product) => (
          <ProductOption
            key={product.id}
            product={product}
            common={lists.commonById.get(String(product.id))}
            onSheet={onSheetIds.has(String(product.id))}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}

function BrowseLists({ lists, showOther, groupProps }) {
  return (
    <>
      {lists.mostUsed.length > 0 && <OptionGroup title="Used most on pest visits" products={lists.mostUsed} {...groupProps} />}
      {lists.pest.length > 0 && <OptionGroup title="All pest products" products={lists.pest} {...groupProps} />}
      {showOther && lists.other.length > 0 && <OptionGroup title="Other products" products={lists.other} revealed {...groupProps} />}
    </>
  );
}

export default function FastCompleteProductPicker({ variant, products, commonProducts, onSheetIds, anchorRef, onPick, onClose }) {
  const titleId = useId();
  const searchId = useId();
  // Escape and Tab stay in the picker; the sheet's own Escape waits under it,
  // and focus goes back to "+ Other product" when it closes.
  const dialogRef = useModalFocus(true, onClose);
  const searchRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [query, setQuery] = useState('');
  const [showOther, setShowOther] = useState(false);
  const lists = useMemo(() => pickerLists(products, commonProducts), [products, commonProducts]);
  const popover = variant === 'popover';

  // A popover takes the search box and closes on a press anywhere else. The
  // phone sheet keeps focus on itself so the keyboard doesn't cover the list.
  useEffect(() => {
    if (!popover) return undefined;
    dialogRef.current?.scrollIntoView?.({ block: 'nearest' });
    searchRef.current?.focus();
    const onPointerDown = (event) => {
      if (dialogRef.current?.contains(event.target) || anchorRef?.current?.contains(event.target)) return;
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [popover, dialogRef, anchorRef]);

  const q = query.trim().toLowerCase();
  const results = q ? rankProducts(lists.listed, q) : null;
  const groupProps = { lists, onSheetIds, onPick };
  const panel = (
    <section
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={cn('tech-product-picker', `tech-product-picker--${variant}`)}
    >
      <div className="tech-product-picker-head">
        <h3 id={titleId} className="tech-product-picker-title">Add a product</h3>
        <Button type="button" variant="ghost" className="tech-visit-action tech-visit-close" aria-label="Close product list" onClick={onClose}>×</Button>
      </div>
      <div className="tech-product-search">
        <label htmlFor={searchId} className="sr-only">Search products</label>
        <SearchIcon />
        <Input
          ref={searchRef}
          id={searchId}
          type="text"
          enterKeyHint="search"
          autoComplete="off"
          className="tech-visit-control tech-product-search-input"
          placeholder="Search name or ingredient…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="tech-product-picker-scroll">
        {results ? (
          <>
            {results.length > 0 && <OptionGroup title="Matching products" products={results} {...groupProps} />}
            {!results.length && <p className="tech-visit-muted">No products match.</p>}
          </>
        ) : (
          <BrowseLists lists={lists} showOther={showOther} groupProps={groupProps} />
        )}
      </div>
      {!results && lists.other.length > 0 && (
        <div className="tech-product-picker-foot">
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={() => setShowOther((on) => !on)}>
            {showOther ? 'Hide other products' : 'Show other products'}
          </Button>
        </div>
      )}
    </section>
  );
  if (popover) return panel;
  return (
    <>
      <div className="tech-product-picker-backdrop" aria-hidden="true" onClick={onClose} />
      {panel}
    </>
  );
}
