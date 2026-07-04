// scan.js — camera + barcode scanning (ADDENDA §1 wiring).
// Native BarcodeDetector preferred (Android Chrome / HA Android webview), with the
// vendored zxing-wasm ponyfill as fallback (iOS Safari/companion, Firefox). The wasm
// is pointed at our LOCAL vendored copy so scanning works fully offline. Always offers
// a manual text-entry fallback. Rear camera, throttled decode, tracks stopped on exit.

import { BarcodeDetector as ZXBarcodeDetector, setZXingModuleOverrides }
  from './vendor/barcode-detector/ponyfill.js';
import { t } from './i18n.js';

// Point the wasm at our LOCAL vendored copy (resolved against the ingress base).
setZXingModuleOverrides({
  locateFile: () => new URL('vendor/zxing_reader.wasm', document.baseURI).href,
});

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'data_matrix'];
const DECODE_INTERVAL_MS = 300; // ~3-4 fps

// Prefer native BarcodeDetector when it covers our formats (no 1MB wasm download).
async function getDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      const fmts = FORMATS.filter(f => sup.includes(f));
      if (fmts.length) return new window.BarcodeDetector({ formats: fmts });
    } catch (_) { /* fall through to wasm */ }
  }
  return new ZXBarcodeDetector({ formats: FORMATS });
}

// EAN/UPC normalization: UPC-A may arrive as 13-digit EAN-13 with leading 0; keep raw
// but expose a normalized form callers can use for lookup. (Lookup itself happens in app.js.)
export function normalizeBarcode(raw) {
  if (raw == null) return '';
  const digits = String(raw).trim();
  // UPC-A (12) -> EAN-13 by prefixing 0, so lookups are consistent.
  if (/^\d{12}$/.test(digits)) return '0' + digits;
  return digits;
}

// Build the scanner overlay DOM. Returns the root element.
function buildOverlay() {
  const root = document.createElement('div');
  root.className = 'scanner';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('scanner'));
  root.innerHTML = `
    <div class="scanner__video-wrap">
      <video class="scanner__video" playsinline muted autoplay></video>
      <div class="scanner__reticle" aria-hidden="true">
        <span class="scanner__corner scanner__corner--tl"></span>
        <span class="scanner__corner scanner__corner--tr"></span>
        <span class="scanner__corner scanner__corner--bl"></span>
        <span class="scanner__corner scanner__corner--br"></span>
        <span class="scanner__scanline"></span>
      </div>
      <p class="scanner__hint">${t('scan_hint')}</p>
    </div>
    <div class="scanner__bar">
      <button type="button" class="btn btn--ghost scanner__cancel">${t('cancel')}</button>
      <button type="button" class="btn btn--ghost scanner__manual">${t('manual_entry')}</button>
    </div>
    <form class="scanner__manual-form" hidden>
      <label class="field">
        <span class="field__label">${t('enter_barcode')}</span>
        <input class="input scanner__manual-input" type="text" inputmode="numeric"
               autocomplete="off" autocapitalize="off" spellcheck="false" dir="ltr">
      </label>
      <div class="scanner__manual-actions">
        <button type="submit" class="btn btn--primary">${t('confirm')}</button>
      </div>
    </form>
    <div class="scanner__error" hidden>
      <p class="scanner__error-title">${t('camera_denied')}</p>
      <p class="scanner__error-sub">${t('camera_denied_sub')}</p>
    </div>
  `;
  return root;
}

/**
 * openScanner() — opens the camera scanner overlay.
 * @returns {Promise<{rawValue:string, format:string}|null>}
 *   resolves with the decoded code (rawValue + format), or null if cancelled.
 */
export function openScanner() {
  return new Promise((resolve) => {
    const root = buildOverlay();
    document.body.appendChild(root);
    document.body.classList.add('no-scroll');

    const video = root.querySelector('.scanner__video');
    const cancelBtn = root.querySelector('.scanner__cancel');
    const manualBtn = root.querySelector('.scanner__manual');
    const manualForm = root.querySelector('.scanner__manual-form');
    const manualInput = root.querySelector('.scanner__manual-input');
    const errorBox = root.querySelector('.scanner__error');
    const videoWrap = root.querySelector('.scanner__video-wrap');

    let stream = null;
    let detector = null;
    let rafId = 0;
    let lastDecode = 0;
    let finished = false;

    function cleanup() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (stream) {
        // Stop all MediaStream tracks -> releases camera + indicator light.
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onNav);
      window.removeEventListener('popstate', onNav);
      document.body.classList.remove('no-scroll');
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    function finish(result) {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    }

    function onKey(e) {
      if (e.key === 'Escape') finish(null);
    }

    // Release the camera if the app navigates away while the scanner is open.
    function onNav() { finish(null); }

    function showError() {
      videoWrap.hidden = true;
      errorBox.hidden = false;
      // Auto-reveal the manual form when the camera is unavailable.
      manualForm.hidden = false;
      manualInput.focus();
    }

    async function tick(ts) {
      if (finished) return;
      rafId = requestAnimationFrame(tick);
      if (ts - lastDecode < DECODE_INTERVAL_MS) return;
      lastDecode = ts;
      if (!detector || video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          const c = codes[0];
          finish({ rawValue: c.rawValue, format: c.format });
        }
      } catch (_) { /* transient decode failure — keep going */ }
    }

    async function start() {
      try {
        detector = await getDetector();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play().catch(() => {});
        rafId = requestAnimationFrame(tick);
      } catch (err) {
        // If a stream was acquired before the throw (e.g. play() failed), release it.
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          stream = null;
        }
        showError();
      }
    }

    cancelBtn.addEventListener('click', () => finish(null));
    manualBtn.addEventListener('click', () => {
      manualForm.hidden = !manualForm.hidden;
      if (!manualForm.hidden) manualInput.focus();
    });
    manualForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = manualInput.value.trim();
      if (val) finish({ rawValue: val, format: 'manual' });
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onNav);
    window.addEventListener('popstate', onNav);

    start();
  });
}

export default openScanner;
