import React from 'react';
import { PublicStateCard } from './brand';

// The load-error preset over PublicStateCard (glass audit G-02).
//
// This used to be its own card — its own padding, its own 22px heading `div`,
// its own gold button — which made it the ninth terminal-state recipe rather
// than the shared one. It is now just the naming of a state: `state="error"`
// with the copy every caller was already getting. Nine call sites keep working
// unchanged, and the card they render is the same one every hand-rolled
// terminal branch now renders.
//
// A page with a hand-rolled terminal branch should reach for `PublicStateCard`
// directly; this stays for the load-error branch, where the resource noun is
// the only thing that varies.
export default function PublicLoadError({ onRetry, resource = 'link', light = false }) {
  return (
    <PublicStateCard
      state="error"
      title={<>We couldn&rsquo;t load that {resource}</>}
      onRetry={onRetry}
      tone={light ? 'light' : 'dark'}
    >
      This looks temporary. Your link is still valid&mdash;check your connection and try again.
    </PublicStateCard>
  );
}
