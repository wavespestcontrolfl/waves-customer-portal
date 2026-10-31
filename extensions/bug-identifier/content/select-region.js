// Injected on demand (chrome.scripting, after the user picks "Select a bug on
// this page"): drag a box around the bug. The overlay removes itself BEFORE it
// reports the box, so the screen capture that follows never shows it.
(() => {
  if (window.__wavesBugIdSelect) return;
  window.__wavesBugIdSelect = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .shade { position: fixed; inset: 0; background: rgba(27, 44, 91, 0.35); }
      .box { position: fixed; display: none; border: 2px solid #FFD700; border-radius: 4px;
        box-shadow: 0 0 0 100vmax rgba(27, 44, 91, 0.35); }
      .tip { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px);
        background: #1B2C5B; color: #fff; font: 600 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        padding: 10px 18px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); pointer-events: none; }
    </style>
    <div class="shade"></div>
    <div class="box"></div>
    <div class="tip" role="status">Drag a box around the bug &middot; Esc to cancel</div>`;
  const shade = root.querySelector('.shade');
  const box = root.querySelector('.box');
  let start = null;

  function rectTo(event) {
    const x = Math.min(start.x, event.clientX);
    const y = Math.min(start.y, event.clientY);
    return { x, y, width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
  }

  function onDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    start = { x: event.clientX, y: event.clientY };
    host.setPointerCapture(event.pointerId);
    shade.style.display = 'none';
    box.style.display = 'block';
    onMove(event);
  }

  function onMove(event) {
    if (!start) return;
    const r = rectTo(event);
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  function onUp(event) {
    if (!start) return;
    const r = rectTo(event);
    start = null;
    if (r.width < 12 || r.height < 12) {
      // A click, not a box: start over.
      box.style.display = 'none';
      shade.style.display = 'block';
      return;
    }
    cleanup();
    // Two frames so the overlay is off the screen before the capture.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chrome.runtime.sendMessage({ type: 'bugid:region', rect: { ...r, viewportW: window.innerWidth } });
    }));
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
    chrome.runtime.sendMessage({ type: 'bugid:region-cancel' });
  }

  function cleanup() {
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    delete window.__wavesBugIdSelect;
  }

  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey, true);
  document.documentElement.appendChild(host);
})();
