// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachGlassMotion } from './glass-motion';

let intersection;
let animate;
let releases;
let media;
const originalAnimate = Element.prototype.animate;
const flushMutations = async () => { await Promise.resolve(); await Promise.resolve(); };
const enter = (...targets) => intersection.callback(targets.map((target) => ({ target, isIntersecting: true })));
const mount = (html) => {
  document.body.innerHTML = html;
  const release = attachGlassMotion();
  releases.push(release);
  return release;
};
const changeMedia = (query, matches) => {
  const list = media.get(query);
  list.matches = matches;
  list.listeners.forEach((listener) => listener());
};

beforeEach(() => {
  releases = [];
  media = new Map();
  document.documentElement.setAttribute('data-glass-theme', '');
  vi.stubGlobal('matchMedia', (query) => {
    if (!media.has(query)) {
      const listeners = new Set();
      media.set(query, { matches: false, listeners,
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
      });
    }
    return media.get(query);
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) {
      this.callback = callback;
      this.observe = vi.fn();
      this.unobserve = vi.fn();
      this.disconnect = vi.fn();
      intersection = this;
    }
  });
  animate = vi.fn(function (frames, options) {
    return { frames, options, target: this, cancel: vi.fn(), pause: vi.fn(), onfinish: null };
  });
  Element.prototype.animate = animate;
});

afterEach(() => {
  releases.forEach((release) => release());
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-glass-theme');
  if (originalAnimate) Element.prototype.animate = originalAnimate;
  else delete Element.prototype.animate;
  vi.unstubAllGlobals();
});

describe('glass card entrances', () => {
  it('keeps offscreen content readable and enters each visible surface once', () => {
    mount('<section data-glass="card">Score 72</section><section data-glass="card">Below fold</section>');
    const [card, below] = document.querySelectorAll('section');
    expect(animate).not.toHaveBeenCalled();
    expect(below.style.cssText).toBe('');
    enter(card);
    const animation = animate.mock.results[0].value;
    expect(animation.frames[0].transform).toContain('rotateX(10deg)');
    expect(card.textContent).toBe('Score 72');
    animation.onfinish();
    expect(card.hasAttribute('data-glass-motion-state')).toBe(false);
    expect(animation.cancel).toHaveBeenCalledOnce();
    enter(card);
    expect(animate).toHaveBeenCalledOnce();
    enter(below);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it('lets children travel with their parent instead of compounding transforms', () => {
    mount('<section data-glass="card"><div data-glass="soft"><button data-glass-accent>Pay</button></div></section>');
    enter(...document.querySelectorAll('[data-glass], [data-glass-accent]'));
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.results[0].value.target.tagName).toBe('SECTION');
  });

  it('registers newly mounted dialogs and releases an entering ancestor before the overlay paints', async () => {
    mount('<section data-glass="card"></section>');
    const card = document.querySelector('section');
    enter(card);
    const animation = animate.mock.results[0].value;
    card.innerHTML = '<div role="dialog" data-glass="modal" style="position:fixed;inset:0">Confirm</div>';
    await flushMutations();
    expect(animation.cancel).toHaveBeenCalledOnce();
    const dialog = card.firstElementChild;
    expect(intersection.observe).toHaveBeenCalledWith(dialog);
    enter(dialog);
    expect(animate.mock.results[1].value.frames[0]).not.toHaveProperty('transform');
    dialog.remove();
    await flushMutations();
    expect(animate.mock.results[1].value.cancel).toHaveBeenCalledOnce();
  });

  it('preserves centering, fixed descendants, and disabled opacity', () => {
    mount('<div data-glass="modal" style="transform:translateX(-50%)">Centered</div><nav data-glass="card"><aside style="position:fixed">Overlay</aside></nav><button data-glass-accent disabled style="opacity:.55">Pay</button>');
    enter(...document.querySelectorAll('[data-glass], [data-glass-accent]'));
    const [centered, nav, button] = animate.mock.results.map((result) => result.value);
    expect(centered.frames[0]).not.toHaveProperty('transform');
    expect(nav.frames[0]).not.toHaveProperty('transform');
    expect(button.frames[1].opacity).toBe(0.55);
    centered.onfinish();
    expect(document.querySelector('div').style.transform).toBe('translateX(-50%)');
  });

  it('settles keyboard focus but preserves pointer hit geometry until the click completes', async () => {
    mount('<section data-glass="card"><input aria-label="Name"></section><button data-glass-accent>Continue</button>');
    const card = document.querySelector('section');
    const input = document.querySelector('input');
    const button = document.querySelector('button');
    enter(card, button);
    input.focus();
    expect(animate.mock.results[0].value.cancel).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(input);
    const press = new Event('pointerdown', { bubbles: true, cancelable: true });
    button.dispatchEvent(press);
    const animation = animate.mock.results[1].value;
    expect(animation.pause).toHaveBeenCalledOnce();
    expect(animation.cancel).not.toHaveBeenCalled();
    button.focus();
    expect(animation.cancel).not.toHaveBeenCalled();
    button.dispatchEvent(new Event('pointerup', { bubbles: true }));
    expect(animation.cancel).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(press.defaultPrevented).toBe(false);
  });

  it('settles immediately when reduced motion or print is enabled, including new arrivals', async () => {
    mount('<section data-glass="card">One</section>');
    enter(document.querySelector('section'));
    changeMedia('(prefers-reduced-motion: reduce)', true);
    expect(animate.mock.results[0].value.cancel).toHaveBeenCalledOnce();
    document.body.insertAdjacentHTML('beforeend', '<section data-glass="card">Two</section>');
    await flushMutations();
    enter(document.querySelector('section:last-child'));
    expect(animate).toHaveBeenCalledOnce();
    changeMedia('(prefers-reduced-motion: reduce)', false);
    document.body.insertAdjacentHTML('beforeend', '<section data-glass="card">Three</section>');
    await flushMutations();
    enter(document.querySelector('section:last-child'));
    expect(animate).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('beforeprint'));
    expect(animate.mock.results[1].value.cancel).toHaveBeenCalledOnce();
    document.body.insertAdjacentHTML('beforeend', '<section data-glass="card">Four</section>');
    await flushMutations();
    enter(document.querySelector('section:last-child'));
    expect(animate).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('afterprint'));
    changeMedia('print', true);
    document.body.insertAdjacentHTML('beforeend', '<section data-glass="card">Five</section>');
    await flushMutations();
    enter(document.querySelector('section:last-child'));
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it('keeps static/admin markup inert and enrolls custom glass or a newly activated scene', async () => {
    document.documentElement.removeAttribute('data-glass-theme');
    mount('<div data-glass="card">Paper</div><div data-glass-motion="card">Custom</div><div data-glass-motion="off"><div data-glass-motion="card">Excluded</div></div><div inert><div data-glass-motion="card">Locked</div></div>');
    expect(intersection.observe).toHaveBeenCalledTimes(1);
    enter(document.querySelector('[data-glass-motion="card"]'));
    expect(animate).toHaveBeenCalledOnce();
    document.documentElement.setAttribute('data-glass-theme', '');
    await flushMutations();
    expect(intersection.observe).toHaveBeenCalledWith(document.querySelector('[data-glass]'));
    document.querySelector('[inert]').removeAttribute('inert');
    await flushMutations();
    expect(intersection.observe).toHaveBeenCalledWith(document.body.lastElementChild.firstElementChild);
  });

  it('shares one observer across owners and removes effects/listeners only after the last owner exits', () => {
    const releaseFirst = mount('<section data-glass="card"></section>');
    const observer = intersection;
    const releaseSecond = attachGlassMotion();
    releases.push(releaseSecond);
    expect(intersection).toBe(observer);
    enter(document.querySelector('section'));
    releaseFirst();
    expect(observer.disconnect).not.toHaveBeenCalled();
    releaseSecond();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(animate.mock.results[0].value.cancel).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-glass-motion-state]')).toBeNull();
    expect([...media.values()].every((list) => list.listeners.size === 0)).toBe(true);
  });

  it('falls back to static content when Web Animations is unavailable', () => {
    delete Element.prototype.animate;
    mount('<section data-glass="card">Readable</section>');
    expect(document.body.textContent).toBe('Readable');
    expect(document.querySelector('[data-glass-motion-state]')).toBeNull();
  });
});
