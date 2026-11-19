/**
 * DEV HARNESS — UI prototype for docs/sprinkler-timer-connect-scope.md.
 * Renders the REAL customer PortalPage (the portal-preview harness: stubbed
 * api, fictional Jordan Rivera) and places the prototype "Your sprinkler
 * timer" card directly under "This week's watering plan" on My Property.
 * Served by vite at /preview-sprinkler-timer.html?tab=property. NOT part of
 * the app build, and nothing is built behind it: no route, no table, no gate.
 *
 * ?timer= picks the screen the card opens on:
 *   pick       no timer on file: brand and model picker (default)
 *   x2         Hunter X2 still on the dial
 *   ready      on Hydrawise, not connected yet
 *   consent    ready, with the connect sheet open (sign-in shape)
 *   request    ready, with the connect sheet open (emailed-request shape)
 *   approve    request sent: waiting for the customer to approve it
 *   zones      just connected: choose the turf zones
 *   connected  normal week, Run this week's plan
 *   confirm    connected, with the run sheet open
 *   running    a run in progress
 *   paused     turf zones paused after a treatment
 *   offline    timer unreachable
 *   rainbird   Rain Bird (cannot connect yet): guide only
 *   xcore      Hunter X-Core (cannot connect): guide only
 *   proc       Hunter Pro-C (some can go on Hydrawise): guide, and the app question
 *   autosetup  connected, with the automatic-runs sheet open (step 4)
 *   auto       automatic runs on, showing the next run (step 4)
 *   rainskip   an automatic run skipped for rain (step 4)
 *   missed     an automatic run that did not start (step 4)
 *
 * The card is a second React root portalled into a slot kept right after the
 * plan card. PropertyTab has no slot of its own, and this harness must not
 * add one to production code for a screen that is not approved yet.
 */
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { createPortal } from 'react-dom';
import '../index.css';
import './portal-preview-main';
import api from '../utils/api';
import { etDateString, addETDays } from '../lib/timezone';
import SprinklerTimerCard from './sprinkler-timer/SprinklerTimerPrototype';

const view = new URLSearchParams(window.location.search).get('timer') || 'pick';

// The portal harness leaves the weekly plan dark; the timer card sits under it.
const plan = {
  validThrough: etDateString(addETDays(new Date(), 6)),
  title: 'About 30 minutes per turf zone',
  summary: 'Between last week’s rain and your sprinkler schedule, your lawn got about 0.6 inches of water.',
  instruction: 'Run each turf zone about 30 minutes on your permitted watering day, during your area’s allowed hours.',
  note: '',
  restrictionNote: 'Follow your property’s assigned watering day and allowed hours.',
  forecast: '',
  guides: [
    { label: 'Find your sprinkler timer and its guide', url: 'https://www.wavespestcontrol.com/sprinkler-timers/' },
    { label: 'Overwatering vs. underwatering', url: 'https://www.wavespestcontrol.com/lawn-care/overwatering-lawn-vs-underwatering/' },
  ],
};
api.getWateringPlan = async () => ({ available: true, plan });
const portalPreferences = api.getPropertyPreferences;
api.getPropertyPreferences = async () => ({ ...(await portalPreferences()), hasLawnCare: true });

const PLAN_CARD = 'section[aria-label="This week\'s watering plan"]';

function PrototypeSlot() {
  const [slot, setSlot] = useState(null);
  // Step 4 offers the watering days already on file in Irrigation settings.
  const [wateringDays, setWateringDays] = useState(null);
  useEffect(() => {
    api.getPropertyPreferences().then((prefs) => setWateringDays(prefs.preferences?.wateringDays || []));
  }, []);
  useEffect(() => {
    const node = document.createElement('div');
    const place = () => {
      const anchor = document.querySelector(PLAN_CARD);
      if (!anchor) { node.remove(); return; }
      if (anchor.nextSibling !== node) anchor.after(node);
    };
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    place();
    setSlot(node);
    return () => { observer.disconnect(); node.remove(); };
  }, []);
  return slot && wateringDays ? createPortal(<SprinklerTimerCard initialView={view} wateringDays={wateringDays} />, slot) : null;
}

const host = document.createElement('div');
document.body.appendChild(host);
ReactDOM.createRoot(host).render(<PrototypeSlot />);
