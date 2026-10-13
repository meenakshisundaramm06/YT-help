// ============================================================
// Watch Later Cleanup — Console Test Script
// Paste this into DevTools console while on youtube.com
// (you must be signed in to YouTube)
// ============================================================
(function() {
'use strict';

// Prevent double-injection
if (window.__wlCleanup) { alert('Already running! Close the panel first.'); return; }
window.__wlCleanup = true;

// ── Constants ──────────────────────────────────────────────

const COLORS = [
  '#ef4444','#22c55e','#3b82f6','#eab308','#a855f7','#f97316',
  '#14b8a6','#ec4899','#06b6d4','#84cc16','#f43f5e','#6366f1','#71717a',
];
const MIN_GROUP_SIZE = 2;
const BATCH_SIZE = 20;
const BATCH_DELAY = 500;
const RETRY_DELAY = 3000;
const MAX_RETRIES = 2;

// ── State ──────────────────────────────────────────────────

const state = {
  view: 'loading',
  allVideos: [],
  catOrder: [],
  removedTotal: 0,
  keptTotal: 0,
  scanProgress: { scanned: 0, total: 0 },
  currentCat: null,
  currentCatColor: 0,
  selectedIndices: new Set(),
  selectedCategories: new Set(),
  detailIndex: 0,
  playing: false,
  removeProgress: { done: 0, total: 0, title: '', catName: '' },
  scanError: null,
  stopped: false,
};

// ── Trusted Types policy (YouTube enforces CSP) ───────────

const policyName = 'wl-cleanup-' + Date.now();
const policy = (window.trustedTypes && window.trustedTypes.createPolicy)
  ? window.trustedTypes.createPolicy(policyName, { createHTML: (s) => s })
  : { createHTML: (s) => s };

function safeHTML(str) { return policy.createHTML(str); }

// ── Inject UI container ────────────────────────────────────

const overlay = document.createElement('div');
overlay.id = 'wl-cleanup-overlay';
overlay.innerHTML = safeHTML(`
<style>
/* ── Panel shell ─────────────────────────────────────────── */
#wl-cleanup-overlay {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 99999;
  width: 520px; max-width: 100vw;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex; flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  box-shadow: -8px 0 32px rgba(0,0,0,.45);
}
#wl-cleanup-overlay *, #wl-cleanup-overlay *::before, #wl-cleanup-overlay *::after {
  margin: 0; padding: 0; box-sizing: border-box;
}
#wl-cleanup-overlay {
  --bg: #0a0a0c; --surface: #131316; --surface-raised: #1a1a1f;
  --border: #232328; --border-hover: #3a3a42;
  --fg: #ececef; --fg-muted: #9d9da6; --fg-dim: #65656e;
  --accent: #1a1a1f; --accent-hover: #232328;
  --destructive: #ef4444; --destructive-bg: rgba(239,68,68,.08);
  --success: #22c55e; --success-bg: rgba(34,197,94,.08);
  --blue: #6090ea;
  --radius: 8px; --radius-lg: 12px;
  color: var(--fg);
}

/* ── Header ──────────────────────────────────────────────── */
.wl-header {
  display: flex; align-items: center; gap: 12px;
  padding: 16px 20px; border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.wl-header-title {
  flex: 1; font-size: 13px; font-weight: 600; letter-spacing: .01em; color: var(--fg-muted);
}
.wl-close-btn {
  background: transparent; border: 1px solid var(--border); color: var(--fg-dim);
  width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
  font-size: 15px; display: flex; align-items: center; justify-content: center;
  transition: all .12s;
}
.wl-close-btn:hover { background: var(--accent-hover); border-color: var(--border-hover); color: var(--fg); }

/* ── Scrollable body ─────────────────────────────────────── */
.wl-body {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  scrollbar-width: thin; scrollbar-color: #27272a transparent;
}

/* ── Buttons ─────────────────────────────────────────────── */
.wl-root .btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--fg-muted);
  font: 12px/1 inherit; cursor: pointer;
  transition: all .12s;
  outline: none; user-select: none; white-space: nowrap;
}
.wl-root .btn:hover { background: var(--accent-hover); border-color: var(--border-hover); color: var(--fg); }
.wl-root .btn:active { transform: scale(.97); }
.wl-root .btn kbd {
  display: inline-block; padding: 2px 5px;
  background: rgba(255,255,255,.06); border: 1px solid var(--border); border-radius: 4px;
  font: 600 10px/13px ui-monospace, monospace; color: var(--fg-dim);
}
.wl-root .btn-destructive { border-color: rgba(239,68,68,.15); background: var(--destructive-bg); color: var(--destructive); }
.wl-root .btn-destructive:hover { background: rgba(239,68,68,.15); border-color: rgba(239,68,68,.25); color: #fca5a5; }
.wl-root .btn-success { border-color: rgba(34,197,94,.15); background: var(--success-bg); color: var(--success); }
.wl-root .btn-success:hover { background: rgba(34,197,94,.15); border-color: rgba(34,197,94,.25); color: #86efac; }
.wl-root .btn-ghost { border-color: transparent; background: transparent; }
.wl-root .btn-ghost:hover { background: var(--accent-hover); }
.wl-root .btn-back {
  border-color: transparent; background: transparent; color: var(--fg-dim);
  padding: 8px 10px;
}
.wl-root .btn-back:hover { background: var(--accent-hover); color: var(--fg); }

/* ── Scanning / Loading ──────────────────────────────────── */
.wl-root .scan {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 64px 32px; text-align: center; min-height: 240px;
}
.wl-root .scan h2 { font-size: 14px; font-weight: 500; color: var(--fg); margin-bottom: 24px; }
.wl-root .scan .track { width: 100%; max-width: 280px; height: 4px; background: var(--surface-raised); border-radius: 2px; overflow: hidden; margin-bottom: 16px; }
.wl-root .scan .fill { height: 100%; background: var(--blue); border-radius: 2px; transition: width .4s ease; }
.wl-root .scan .num { font-size: 13px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.wl-root .scan .hint { font-size: 11px; color: var(--fg-dim); margin-top: 20px; }

/* ── Category list ───────────────────────────────────────── */
.wl-root .cats { padding: 24px; }
.wl-root .cats h2 { font-size: 16px; font-weight: 600; }
.wl-root .cats .sub { font-size: 12px; color: var(--fg-dim); margin-top: 4px; margin-bottom: 20px; }
.wl-root .cat-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 0; margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.wl-root .cat-select-all {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--fg-muted); cursor: pointer; user-select: none;
}
.wl-root .cat-select-all input[type="checkbox"] { accent-color: var(--blue); width: 15px; height: 15px; cursor: pointer; }
.wl-root .cat-sel-count { font-size: 11px; color: var(--fg-dim); }
.wl-root .clist {
  display: flex; flex-direction: column; gap: 2px;
  margin-bottom: 20px;
}
.wl-root .citem {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: var(--radius);
  cursor: pointer; transition: background .12s;
}
.wl-root .citem:hover { background: var(--surface); }
.wl-root .cat-check { accent-color: var(--blue); width: 15px; height: 15px; cursor: pointer; flex-shrink: 0; }
.wl-root .cnum { font: 500 11px/1 ui-monospace, monospace; color: var(--fg-dim); width: 20px; text-align: right; flex-shrink: 0; }
.wl-root .cname { flex: 1; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-root .cbar { width: 56px; height: 4px; background: var(--surface-raised); border-radius: 2px; overflow: hidden; flex-shrink: 0; }
.wl-root .cbar div { height: 100%; border-radius: 2px; }
.wl-root .ccount { font: 600 12px/1 inherit; color: var(--fg-dim); width: 32px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.wl-root .cat-footer { display: flex; gap: 6px; padding-top: 4px; }

/* ── Grid view ───────────────────────────────────────────── */
.wl-root .grid-view { padding: 20px 24px 24px; }
.wl-root .grid-header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.wl-root .grid-header h2 { font-size: 15px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-root .grid-sub { font-size: 12px; color: var(--fg-dim); margin-bottom: 16px; }
.wl-root .grid-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 0; margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.wl-root .grid-toolbar label {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--fg-muted); cursor: pointer; user-select: none;
}
.wl-root .grid-toolbar label input[type="checkbox"] { accent-color: var(--blue); width: 15px; height: 15px; cursor: pointer; }
.wl-root .grid-toolbar .spacer { flex: 1; }
.wl-root .grid-sel-count { font-size: 11px; color: var(--fg-dim); }
.wl-root .grid-container {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
  max-height: 520px; overflow-y: auto; margin-bottom: 16px;
  scrollbar-width: thin; scrollbar-color: #27272a transparent;
}
.wl-root .grid-card {
  background: var(--surface); border: 2px solid var(--border);
  border-radius: var(--radius); overflow: hidden;
  cursor: pointer; transition: border-color .12s;
}
.wl-root .grid-card:hover { border-color: var(--border-hover); }
.wl-root .grid-card:hover .grid-thumb img { transform: scale(1.05); }
.wl-root .grid-card.selected { border-color: var(--blue); }
.wl-root .grid-thumb { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; overflow: hidden; }
.wl-root .grid-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
.wl-root .grid-check { position: absolute; top: 6px; left: 6px; z-index: 2; width: 18px; height: 18px; accent-color: var(--blue); cursor: pointer; }
.wl-root .grid-title {
  padding: 8px 10px 3px; font-size: 11px; font-weight: 500; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  min-height: 34px;
}
.wl-root .grid-ch { padding: 0 10px 10px; font-size: 10px; color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-root .grid-footer { display: flex; gap: 6px; flex-wrap: wrap; }

/* ── Video detail ────────────────────────────────────────── */
.wl-root .media { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; }
.wl-root .media img, .wl-root .media iframe { width: 100%; height: 100%; display: block; border: none; }
.wl-root .media img { object-fit: cover; }
.wl-root .over-badge { position: absolute; padding: 4px 10px; border-radius: 6px; font: 600 11px/1.3 inherit; backdrop-filter: blur(8px); }
.wl-root .over-badge.left { top: 10px; left: 10px; background: rgba(0,0,0,.7); }
.wl-root .over-badge.right { top: 10px; right: 10px; }
.wl-root .info { padding: 16px 24px 12px; }
.wl-root .title { font-size: 15px; font-weight: 600; line-height: 1.4; margin-bottom: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wl-root .ch { font-size: 12px; color: var(--fg-dim); margin-bottom: 16px; }
.wl-root .prow { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.wl-root .track-sm { flex: 1; height: 4px; background: var(--surface-raised); border-radius: 2px; overflow: hidden; }
.wl-root .track-sm .fill { height: 100%; border-radius: 2px; transition: width .4s ease; }
.wl-root .ptxt { font-size: 11px; color: var(--fg-dim); min-width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
.wl-root .sts { display: flex; gap: 16px; font-size: 12px; color: var(--fg-dim); margin-bottom: 16px; }
.wl-root .sr { color: var(--destructive); }
.wl-root .sk { color: var(--success); }
.wl-root .ctrls { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 24px 20px; }

/* ── Removing progress ───────────────────────────────────── */
.wl-root .removing {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 64px 32px; text-align: center; min-height: 240px;
}
.wl-root .removing h2 { font-size: 14px; font-weight: 500; margin-bottom: 8px; }
.wl-root .removing .sub { font-size: 12px; color: var(--fg-dim); margin-bottom: 24px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.wl-root .removing .track { width: 100%; max-width: 280px; height: 4px; background: var(--surface-raised); border-radius: 2px; overflow: hidden; }
.wl-root .removing .fill { height: 100%; border-radius: 2px; transition: width .4s ease; }
.wl-root .removing .num { font-size: 13px; color: var(--fg-muted); margin-top: 16px; font-variant-numeric: tabular-nums; }

/* ── Flash ───────────────────────────────────────────────── */
.wl-root .flash { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .2s; z-index: 10; border-radius: 0; }
.wl-root .flash.rm { background: rgba(239,68,68,.06); }
.wl-root .flash.kp { background: rgba(34,197,94,.06); }
.wl-root .flash.on { opacity: 1; }

/* ── Confirm dialog ──────────────────────────────────────── */
.wl-root .confirm-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,.5);
  display: flex; align-items: center; justify-content: center; z-index: 20;
}
.wl-root .confirm-box {
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 28px 32px; max-width: 340px; width: 85%;
  text-align: center;
}
.wl-root .confirm-box h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.wl-root .confirm-box p { font-size: 13px; color: var(--fg-muted); margin-bottom: 20px; line-height: 1.6; }
.wl-root .confirm-box .confirm-btns { display: flex; gap: 8px; justify-content: center; }

/* ── Done ────────────────────────────────────────────────── */
.wl-root .done {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 64px 32px; min-height: 300px;
}
.wl-root .done h2 { font-size: 17px; font-weight: 600; margin-bottom: 12px; }
.wl-root .done p { font-size: 13px; color: var(--fg-muted); line-height: 1.7; }
</style>
<div class="wl-root" style="width:100%;height:100%;position:relative;display:flex;flex-direction:column;">
  <div class="wl-header">
    <span class="wl-header-title">Watch Later Cleanup</span>
    <button class="wl-close-btn" id="wl-close-btn">&times;</button>
  </div>
  <div class="flash" id="wl-fl"></div>
  <div class="wl-body" id="wl-app"><div class="scan"><h2>Starting scan...</h2></div></div>
</div>`);
document.body.appendChild(overlay);

// IMPORTANT: scope all lookups to our overlay, never use document.getElementById
// (YouTube may have elements with the same IDs)
const appEl = () => overlay.querySelector('#wl-app');

// Close button
overlay.querySelector('#wl-close-btn').onclick = () => cleanup();

function cleanup() {
  state.stopped = true;
  overlay.remove();
  window.__wlCleanup = false;
}

// ── Helpers ────────────────────────────────────────────────

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function flash(t) {
  const f = overlay.querySelector('#wl-fl');
  if (!f) return;
  f.className = 'flash ' + t;
  requestAnimationFrame(() => { f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 280); });
}

function showConfirm(msg, onYes) {
  const ov = document.createElement('div');
  ov.className = 'confirm-overlay';
  ov.innerHTML = safeHTML('<div class="confirm-box"><h3>Confirm</h3><p>' + msg + '</p><div class="confirm-btns">'
    + '<button class="btn" data-cf="no">Cancel</button>'
    + '<button class="btn btn-destructive" data-cf="yes">Remove</button></div></div>');
  overlay.querySelector('.wl-root').appendChild(ov);
  ov.querySelector('[data-cf="yes"]').onclick = () => { ov.remove(); onYes(); };
  ov.querySelector('[data-cf="no"]').onclick = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── InnerTube API ──────────────────────────────────────────

function deepGet(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

// Generate SAPISIDHASH auth header (required for private playlists)
async function generateSAPISIDHASH() {
  // Try multiple cookie names YouTube uses
  const cookies = document.cookie.split('; ');
  let sapisid = null;
  for (const c of cookies) {
    if (c.startsWith('__Secure-3PAPISID=')) { sapisid = c.substring(18); break; }
  }
  if (!sapisid) {
    for (const c of cookies) {
      if (c.startsWith('SAPISID=')) { sapisid = c.substring(8); break; }
    }
  }
  if (!sapisid) {
    console.warn('[WL] No SAPISID cookie found — auth will fail');
    return null;
  }
  const ts = Math.floor(Date.now() / 1000);
  const origin = 'https://www.youtube.com';
  const input = ts + ' ' + sapisid + ' ' + origin;
  const encoded = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest('SHA-1', encoded);
  const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'SAPISIDHASH ' + ts + '_' + hashHex;
}

async function getInnerTubeHeaders() {
  const ytcfg = window.ytcfg;
  const headers = { 'Content-Type': 'application/json' };

  // SAPISIDHASH — critical for authenticated endpoints
  const auth = await generateSAPISIDHASH();
  if (auth) headers['Authorization'] = auth;

  const sessionIndex = ytcfg.get('SESSION_INDEX');
  if (sessionIndex !== undefined) headers['X-Goog-AuthUser'] = String(sessionIndex);

  const visitorData = ytcfg.get('VISITOR_DATA');
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

  const pageId = ytcfg.get('DELEGATED_SESSION_ID');
  if (pageId) headers['X-Goog-PageId'] = pageId;

  return headers;
}

function getFullContext() {
  const ytcfg = window.ytcfg;
  const ctx = ytcfg.get('INNERTUBE_CONTEXT');
  if (ctx) return JSON.parse(JSON.stringify(ctx)); // deep clone to avoid mutation
  return {
    client: {
      clientName: ytcfg.get('INNERTUBE_CLIENT_NAME'),
      clientVersion: ytcfg.get('INNERTUBE_CLIENT_VERSION'),
    },
  };
}

async function fetchWatchLaterPage(continuation) {
  const ytcfg = window.ytcfg;
  if (!ytcfg || !ytcfg.get) return { error: 'not_logged_in' };
  const apiKey = ytcfg.get('INNERTUBE_API_KEY');
  if (!apiKey) return { error: 'not_logged_in' };

  const body = { context: getFullContext() };
  if (continuation) body.continuation = continuation;
  else body.browseId = 'VLWL';

  const headers = await getInnerTubeHeaders();
  console.log('[WL] Browse request — auth:', !!headers['Authorization'], 'continuation:', !!continuation);

  const resp = await fetch('/youtubei/v1/browse?key=' + apiKey + '&prettyPrint=false', {
    method: 'POST', credentials: 'include',
    headers: headers,
    body: JSON.stringify(body),
  });
  const data = await resp.json();

  // Debug: log response shape on first call
  if (!continuation) {
    console.log('[WL] Response keys:', Object.keys(data));
    if (data.alerts) console.warn('[WL] Alerts:', JSON.stringify(data.alerts));
    if (data.contents) console.log('[WL] Contents keys:', Object.keys(data.contents));
  }

  return data;
}

async function removeVideosBatch(setVideoIds) {
  const ytcfg = window.ytcfg;
  if (!ytcfg || !ytcfg.get) return { ok: false, status: 0 };
  const apiKey = ytcfg.get('INNERTUBE_API_KEY');
  const body = {
    playlistId: 'WL',
    actions: setVideoIds.map(id => ({ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' })),
    context: getFullContext(),
  };
  const headers = await getInnerTubeHeaders();
  const resp = await fetch('/youtubei/v1/browse/edit_playlist?key=' + apiKey + '&prettyPrint=false', {
    method: 'POST', credentials: 'include',
    headers: headers,
    body: JSON.stringify(body),
  });
  return { ok: resp.ok, status: resp.status };
}

// Recursively search for playlistVideoListRenderer anywhere in the response
// Returns the full renderer object (not just contents) so we can access continuations too
function findPlaylistVideoListRenderer(obj, depth) {
  if (depth > 12 || obj == null || typeof obj !== 'object') return null;
  if (obj.playlistVideoListRenderer) return obj.playlistVideoListRenderer;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findPlaylistVideoListRenderer(item, depth + 1);
      if (r) return r;
    }
  } else {
    for (const key of Object.keys(obj)) {
      const r = findPlaylistVideoListRenderer(obj[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// Recursively search for any continuation token in an object
function findContinuationToken(obj, depth) {
  if (depth > 20 || obj == null || typeof obj !== 'object') return null;
  // Direct token path
  if (obj.token && typeof obj.token === 'string' && obj.token.length > 20) return obj.token;
  if (obj.continuationCommand && obj.continuationCommand.token) return obj.continuationCommand.token;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findContinuationToken(item, depth + 1);
      if (r) return r;
    }
  } else {
    // Search ALL keys — don't restrict to specific key names
    for (const key of Object.keys(obj)) {
      const r = findContinuationToken(obj[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function parseVideosFromResponse(data, isInitial) {
  let items;
  let renderer = null;

  if (isInitial) {
    // Try to find the playlistVideoListRenderer
    renderer = findPlaylistVideoListRenderer(data.contents, 0);
    if (renderer && renderer.contents) {
      items = renderer.contents;
      console.log('[WL] Found playlistVideoListRenderer with', items.length, 'items');
    } else {
      console.warn('[WL] Could not find playlistVideoListRenderer');
      items = [];
    }
  } else {
    const actions = deepGet(data, 'onResponseReceivedActions');
    if (actions && actions.length > 0) {
      items = deepGet(actions[0], 'appendContinuationItemsAction', 'continuationItems') || [];
    } else {
      items = [];
    }
  }

  const videos = [];
  let continuation = null;

  for (const item of items) {
    const r = deepGet(item, 'playlistVideoRenderer');
    if (r) {
      const thumbs = deepGet(r, 'thumbnail', 'thumbnails');
      videos.push({
        videoId: r.videoId || '',
        title: deepGet(r, 'title', 'runs', 0, 'text') || '',
        channel: deepGet(r, 'shortBylineText', 'runs', 0, 'text') || '',
        thumbnail: thumbs && thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '',
        setVideoId: r.setVideoId || '',
        lengthText: deepGet(r, 'lengthText', 'simpleText') || '',
      });
    }
    // Check for continuation inside the items array
    if (item.continuationItemRenderer) {
      console.log('[WL] Found continuationItemRenderer, keys:', JSON.stringify(Object.keys(item.continuationItemRenderer)));
      const token = findContinuationToken(item.continuationItemRenderer, 0);
      if (token) {
        continuation = token;
        console.log('[WL] Extracted continuation token from items array');
      }
    }
    // Fallback: direct path
    if (!continuation) {
      const ct = deepGet(item, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token');
      if (ct) continuation = ct;
    }
  }

  // If no continuation found in items, search the renderer for continuation tokens
  if (!continuation && renderer) {
    // Check renderer.continuations array (older format)
    if (renderer.continuations) {
      continuation = findContinuationToken(renderer.continuations, 0);
      if (continuation) console.log('[WL] Found continuation in renderer.continuations');
    }
    // Check for continuationItemRenderer as a sibling or nested differently
    if (!continuation) {
      continuation = findContinuationToken(renderer, 0);
      if (continuation) console.log('[WL] Found continuation via recursive search in renderer');
    }
  }

  console.log('[WL] Parsed', videos.length, 'videos, continuation:', !!continuation);
  return { videos, continuation };
}

// ── Scan ───────────────────────────────────────────────────

async function scanPlaylist() {
  state.view = 'scanning';
  render();

  const allVideos = [];
  let continuation = null;
  let isInitial = true;
  let totalEstimate = 0;

  while (!state.stopped) {
    let data;
    try {
      data = await fetchWatchLaterPage(continuation);
    } catch (err) {
      state.scanError = 'Network error: ' + err.message;
      state.view = 'loading';
      render();
      return;
    }

    if (data && data.error) {
      state.scanError = data.error === 'not_logged_in'
        ? 'Please sign in to YouTube first, then try again.'
        : 'API error: ' + data.error;
      state.view = 'loading';
      render();
      return;
    }

    const parsed = parseVideosFromResponse(data, isInitial);

    if (isInitial) {
      // Try to get total count
      const stats = deepGet(data, 'header', 'playlistHeaderRenderer', 'stats');
      if (stats && stats.length > 0) {
        const txt = deepGet(stats[0], 'runs', 0, 'text');
        if (txt) { const n = parseInt(txt.replace(/[^0-9]/g, ''), 10); if (!isNaN(n)) totalEstimate = n; }
      }
      if (totalEstimate === 0) {
        const txt = deepGet(data, 'header', 'playlistHeaderRenderer', 'numVideosText', 'runs', 0, 'text');
        if (txt) { const n = parseInt(txt.replace(/[^0-9]/g, ''), 10); if (!isNaN(n)) totalEstimate = n; }
      }
    }

    allVideos.push(...parsed.videos);
    state.scanProgress = { scanned: allVideos.length, total: totalEstimate || allVideos.length };
    render();

    if (!parsed.continuation) break;
    continuation = parsed.continuation;
    isInitial = false;
    await sleep(300);
  }

  if (state.stopped) return;

  if (allVideos.length === 0) {
    state.scanError = 'Your Watch Later playlist is empty.';
    state.view = 'loading';
    render();
    return;
  }

  console.log('[WL] Scan done, processing', allVideos.length, 'videos...');
  try {
    processVideos(allVideos);
    console.log('[WL] Processed. Categories:', state.catOrder.length, 'Videos:', state.allVideos.length);
  } catch (err) {
    console.error('[WL] processVideos error:', err);
    state.scanError = 'Error processing videos: ' + err.message;
    state.view = 'loading';
    render();
    return;
  }
  state.view = 'categories';
  render();
}

// ── Video processing ───────────────────────────────────────

// Stable color map — each category name keeps its color across sorts
const catColorMap = {};
let nextColorIdx = 0;

function processVideos(raw) {
  const chCounts = {};
  for (const v of raw) chCounts[v.channel] = (chCounts[v.channel] || 0) + 1;

  state.allVideos = raw.map(v => ({
    ...v,
    removed: false,
    category: chCounts[v.channel] >= MIN_GROUP_SIZE ? v.channel : 'Other',
  }));

  // Assign stable colors
  const seen = new Set();
  for (const v of state.allVideos) {
    if (!seen.has(v.category)) {
      seen.add(v.category);
      if (!(v.category in catColorMap)) {
        catColorMap[v.category] = nextColorIdx++;
      }
    }
  }

  state.catOrder = Array.from(seen);
}

function buildCatList() {
  const groups = {};
  for (const v of state.allVideos) { if (!v.removed) groups[v.category] = (groups[v.category] || 0) + 1; }
  const result = [];
  for (const name of state.catOrder) {
    const cnt = groups[name] || 0;
    if (cnt > 0) result.push({ name, count: cnt, color: catColorMap[name] || 0 });
  }
  // Always sort by count descending
  result.sort((a, b) => b.count - a.count);
  return result;
}

function getCategoryVideos(catName) {
  return state.allVideos.filter(v => v.category === catName && !v.removed);
}

// ── Removal ────────────────────────────────────────────────

async function startRemoval(vids, catName) {
  state.view = 'removing';
  state.removeProgress = { done: 0, total: vids.length, title: '', catName };
  render();

  const toRemove = vids.map(v => ({ videoId: v.videoId, setVideoId: v.setVideoId, title: v.title }));
  let removed = 0, failed = 0;
  const total = toRemove.length;

  for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
    if (state.stopped) break;
    const batch = toRemove.slice(i, i + BATCH_SIZE);
    const ids = batch.map(v => v.setVideoId);
    const lastTitle = batch[batch.length - 1].title;

    state.removeProgress = { done: i, total, title: lastTitle, catName };
    render();

    let success = false;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        const result = await removeVideosBatch(ids);
        if (result && result.ok) { success = true; break; }
      } catch (e) { /* retry */ }
      if (retry < MAX_RETRIES) await sleep(RETRY_DELAY);
    }

    if (success) {
      removed += batch.length;
      for (const b of batch) {
        const v = state.allVideos.find(x => x.setVideoId === b.setVideoId);
        if (v) v.removed = true;
      }
    } else {
      failed += batch.length;
    }
    if (i + BATCH_SIZE < toRemove.length) await sleep(BATCH_DELAY);
  }

  state.removeProgress = { done: total, total, title: '', catName };
  state.removedTotal += removed;
  state.keptTotal += failed;

  if (buildCatList().length === 0) {
    state.view = 'done';
  } else {
    state.view = 'categories';
  }
  render();
}

async function removeSingleVideo(v) {
  try {
    const result = await removeVideosBatch([v.setVideoId]);
    if (result && result.ok) {
      v.removed = true;
      state.removedTotal++;
      return true;
    }
  } catch (e) { /* fail */ }
  return false;
}

// ── Quit ───────────────────────────────────────────────────

function quit() {
  state.view = 'done';
  state.stopped = true;
  render();
}

// ── Render dispatch ────────────────────────────────────────

function setContent(el, html) {
  try {
    el.innerHTML = safeHTML(html);
  } catch (e) {
    console.warn('[WL] innerHTML failed, using fallback:', e.message);
    // Fallback: build in a detached temp node, then move children
    const temp = document.createElement('div');
    temp.innerHTML = safeHTML(html);
    while (el.firstChild) el.removeChild(el.firstChild);
    while (temp.firstChild) el.appendChild(temp.firstChild);
  }
}

function render() {
  try {
    const el = appEl();
    if (!el) { console.error('[WL] render: #wl-app not found in DOM'); return; }
    console.log('[WL] render:', state.view);
    switch (state.view) {
      case 'loading': renderLoading(el); break;
      case 'scanning': renderScanning(el); break;
      case 'categories': renderCategories(el); break;
      case 'grid': renderGrid(el); break;
      case 'detail': renderDetail(el); break;
      case 'removing': renderRemoving(el); break;
      case 'done': renderDone(el); break;
    }
    // Verify DOM updated
    const firstChild = el.firstElementChild;
    console.log('[WL] DOM verified:', firstChild ? firstChild.className : '(empty)');
  } catch (err) {
    console.error('[WL] render error:', err);
  }
}

// ── Renderers ──────────────────────────────────────────────

function renderLoading(el) {
  if (state.scanError) {
    setContent(el, '<div class="scan"><h2>' + esc(state.scanError) + '</h2>'
      + '<button class="btn" data-action="retry">Retry</button></div>');
    el.querySelector('[data-action="retry"]').onclick = () => {
      state.scanError = null;
      state.stopped = false;
      scanPlaylist();
    };
  } else {
    setContent(el, '<div class="scan"><h2>Connecting...</h2></div>');
  }
}

function renderScanning(el) {
  const { scanned, total } = state.scanProgress;
  const pct = total > 0 ? Math.min(100, (scanned / total) * 100).toFixed(0) : 0;
  setContent(el, '<div class="scan"><h2>Scanning your playlist...</h2>'
    + '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>'
    + '<div class="num">' + scanned + ' / ' + (total || '?') + ' videos loaded</div>'
    + '<div class="hint">Press Q to stop early</div></div>');
}

function renderCategories(el) {
  const cats = buildCatList();
  const mx = Math.max(...cats.map(c => c.count), 1);
  const totalRemaining = cats.reduce((s, c) => s + c.count, 0);
  const selCount = state.selectedCategories.size;
  const allSelected = cats.length > 0 && selCount === cats.length;

  let rows = '';
  cats.forEach((c, i) => {
    const col = COLORS[c.color % COLORS.length];
    const bw = Math.max(8, (c.count / mx) * 100);
    const sel = state.selectedCategories.has(i);
    rows += '<div class="citem" data-cat="' + i + '">'
      + '<input type="checkbox" class="cat-check" ' + (sel ? 'checked ' : '') + 'data-check-cat="' + i + '">'
      + '<div class="cnum">' + (i + 1) + '</div>'
      + '<div class="cname">' + esc(c.name) + '</div>'
      + '<div class="cbar"><div style="width:' + bw + '%;background:' + col + '"></div></div>'
      + '<div class="ccount">' + c.count + '</div>'
      + '</div>';
  });

  setContent(el, '<div class="cats"><h2>Watch Later</h2>'
    + '<div class="sub">' + totalRemaining + ' videos &middot; ' + cats.length + ' channels'
    + (state.removedTotal > 0 ? ' &middot; ' + state.removedTotal + ' removed' : '') + '</div>'
    + '<div class="cat-toolbar">'
    + '<label class="cat-select-all"><input type="checkbox" ' + (allSelected ? 'checked ' : '') + 'data-action="toggle-all-cats"> Select all</label>'
    + '<span class="cat-sel-count" data-sel-count>' + (selCount > 0 ? selCount + ' selected' : '') + '</span>'
    + '<span style="flex:1"></span>'
    + '<button class="btn btn-destructive" data-action="bulk-delete-cats" ' + (selCount === 0 ? 'style="opacity:.4;pointer-events:none"' : '') + '><kbd>Del</kbd> Delete' + (selCount > 0 ? ' (' + selCount + ')' : '') + '</button>'
    + '</div>'
    + '<div class="clist">' + rows + '</div>'
    + '<div class="cat-footer"><button class="btn btn-ghost" data-action="quit"><kbd>Q</kbd> Quit</button></div></div>');

  el.onclick = function(e) {
    const check = e.target.closest('[data-check-cat]');
    if (check) { e.stopPropagation(); toggleCategorySelect(parseInt(check.dataset.checkCat, 10)); return; }
    if (e.target.closest('[data-action="toggle-all-cats"]')) {
      const cats2 = buildCatList();
      state.selectedCategories.size === cats2.length ? state.selectedCategories.clear() : (state.selectedCategories = new Set(cats2.map((_, i) => i)));
      render(); return;
    }
    if (e.target.closest('[data-action="bulk-delete-cats"]')) { bulkRemoveSelectedCategories(); return; }
    const row = e.target.closest('[data-cat]');
    if (row && !e.target.closest('[data-check-cat]')) { enterCategory(parseInt(row.dataset.cat, 10)); return; }
    if (e.target.closest('[data-action="quit"]')) quit();
  };
}

function toggleCategorySelect(i) {
  state.selectedCategories.has(i) ? state.selectedCategories.delete(i) : state.selectedCategories.add(i);
  updateCategorySelectionUI();
}

function updateCategorySelectionUI() {
  const root = document.getElementById('wl-cleanup-content');
  if (!root) return;
  const cats = buildCatList();
  const selCount = state.selectedCategories.size;
  const allSelected = cats.length > 0 && selCount === cats.length;

  root.querySelectorAll('[data-check-cat]').forEach(chk => {
    const idx = parseInt(chk.dataset.checkCat, 10);
    chk.checked = state.selectedCategories.has(idx);
  });

  const allChk = root.querySelector('[data-action="toggle-all-cats"]');
  if (allChk) allChk.checked = allSelected;

  const selSpan = root.querySelector('[data-sel-count]');
  if (selSpan) selSpan.textContent = selCount > 0 ? selCount + ' selected' : '';

  const bulkBtn = root.querySelector('[data-action="bulk-delete-cats"]');
  if (bulkBtn) {
    bulkBtn.style.opacity = selCount === 0 ? '.4' : '';
    bulkBtn.style.pointerEvents = selCount === 0 ? 'none' : '';
    bulkBtn.innerHTML = safeHTML('<kbd>Del</kbd> Delete' + (selCount > 0 ? ' (' + selCount + ')' : ''));
  }
}

function bulkRemoveSelectedCategories() {
  if (state.selectedCategories.size === 0) return;
  const cats = buildCatList();
  const selectedCats = Array.from(state.selectedCategories).sort((a, b) => a - b).map(i => cats[i]).filter(Boolean);
  const totalVideos = selectedCats.reduce((sum, c) => sum + c.count, 0);
  
  showConfirm(
    'Remove all <b>' + totalVideos + '</b> videos from <b>' + selectedCats.length + '</b> selected channel' + (selectedCats.length > 1 ? 's' : '') + '?',
    () => {
      const allVideos = selectedCats.flatMap(c => getCategoryVideos(c.name));
      state.selectedCategories.clear();
      startRemoval(allVideos, selectedCats.map(c => c.name).join(', '));
    }
  );
}

function enterCategory(idx) {
  const cats = buildCatList();
  if (idx >= cats.length) return;
  state.currentCat = cats[idx].name;
  state.currentCatColor = cats[idx].color;
  state.selectedIndices.clear();
  state.view = 'grid';
  render();
}

function renderGrid(el) {
  const vids = getCategoryVideos(state.currentCat);
  if (vids.length === 0) { state.view = 'categories'; render(); return; }

  const col = COLORS[state.currentCatColor % COLORS.length];
  // Prune
  const pruned = new Set();
  state.selectedIndices.forEach(i => { if (i < vids.length) pruned.add(i); });
  state.selectedIndices = pruned;
  const selCount = state.selectedIndices.size;
  const allSelected = vids.length > 0 && selCount === vids.length;

  let cards = '';
  vids.forEach((v, i) => {
    const sel = state.selectedIndices.has(i);
    cards += '<div class="grid-card' + (sel ? ' selected' : '') + '" data-grid-idx="' + i + '">'
      + '<div class="grid-thumb">'
      + '<input type="checkbox" class="grid-check" ' + (sel ? 'checked ' : '') + 'data-check="' + i + '">'
      + '<img src="' + esc(v.thumbnail) + '" alt="">'
      + '</div>'
      + '<div class="grid-title">' + esc(v.title) + '</div>'
      + '<div class="grid-ch">' + esc(v.channel) + (v.lengthText ? ' &middot; ' + esc(v.lengthText) : '') + '</div>'
      + '</div>';
  });

  setContent(el, '<div class="grid-view">'
    + '<button class="btn btn-back" data-action="back">&larr; Back</button>'
    + '<div class="grid-header"><h2 style="color:' + col + '">' + esc(state.currentCat) + '</h2></div>'
    + '<div class="grid-sub">' + vids.length + ' videos' + (state.removedTotal > 0 ? ' &middot; ' + state.removedTotal + ' removed total' : '') + '</div>'
    + '<div class="grid-toolbar">'
    + '<label><input type="checkbox" ' + (allSelected ? 'checked ' : '') + 'data-action="toggle-all"> Select all</label>'
    + '<span class="grid-sel-count">' + (selCount > 0 ? selCount + ' selected' : '') + '</span>'
    + '<span class="spacer"></span>'
    + '<button class="btn btn-destructive" data-action="bulk-delete" style="' + (selCount === 0 ? 'opacity:.4;pointer-events:none' : '') + '"><kbd>Del</kbd> Delete' + (selCount > 0 ? ' (' + selCount + ')' : '') + '</button>'
    + '</div>'
    + '<div class="grid-container">' + cards + '</div>'
    + '<div class="grid-footer"><button class="btn btn-ghost" data-action="quit"><kbd>Q</kbd> Quit</button></div></div>');

  el.onclick = function(e) {
    const check = e.target.closest('[data-check]');
    if (check) { e.stopPropagation(); toggleSelect(parseInt(check.dataset.check, 10)); return; }
    const card = e.target.closest('[data-grid-idx]');
    if (card && !e.target.closest('[data-check]')) { enterDetail(parseInt(card.dataset.gridIdx, 10)); return; }
    if (e.target.closest('[data-action="toggle-all"]')) {
      const v2 = getCategoryVideos(state.currentCat);
      if (state.selectedIndices.size === v2.length) state.selectedIndices.clear();
      else state.selectedIndices = new Set(v2.map((_, i) => i));
      render(); return;
    }
    if (e.target.closest('[data-action="bulk-delete"]')) { bulkRemoveSelected(); return; }
    if (e.target.closest('[data-action="back"]')) { state.view = 'categories'; render(); return; }
    if (e.target.closest('[data-action="quit"]')) quit();
  };
}

function toggleSelect(i) {
  if (state.selectedIndices.has(i)) state.selectedIndices.delete(i);
  else state.selectedIndices.add(i);
  // Targeted DOM update — no full re-render
  updateGridSelectionUI();
}

function updateGridSelectionUI() {
  const el = appEl();
  if (!el) return;
  const vids = getCategoryVideos(state.currentCat);
  const selCount = state.selectedIndices.size;
  const allSelected = vids.length > 0 && selCount === vids.length;

  // Toggle card borders + checkboxes
  el.querySelectorAll('[data-grid-idx]').forEach(card => {
    const idx = parseInt(card.dataset.gridIdx, 10);
    const sel = state.selectedIndices.has(idx);
    if (sel) { card.classList.add('selected'); } else { card.classList.remove('selected'); }
    const chk = card.querySelector('[data-check]');
    if (chk) chk.checked = sel;
  });

  // Select all checkbox
  const allChk = el.querySelector('[data-action="toggle-all"]');
  if (allChk) allChk.checked = allSelected;

  // Selection count text
  const countEl = el.querySelector('.grid-sel-count');
  if (countEl) countEl.textContent = selCount > 0 ? selCount + ' selected' : '';

  // Bulk delete button state + label
  const bulkBtn = el.querySelector('[data-action="bulk-delete"]');
  if (bulkBtn) {
    bulkBtn.style.opacity = selCount === 0 ? '.4' : '';
    bulkBtn.style.pointerEvents = selCount === 0 ? 'none' : '';
    // Update label without innerHTML (avoid TrustedTypes for small update)
    const kbd = bulkBtn.querySelector('kbd');
    const label = ' Delete' + (selCount > 0 ? ' (' + selCount + ')' : '');
    if (kbd) { kbd.nextSibling.textContent = label; }
  }
}

function enterDetail(idx) {
  state.detailIndex = idx;
  state.playing = false;
  state.view = 'detail';
  render();
}

function bulkRemoveSelected() {
  if (state.selectedIndices.size === 0) return;
  const n = state.selectedIndices.size;
  showConfirm('Remove <b>' + n + '</b> selected video' + (n > 1 ? 's' : '') + '?', () => {
    const vids = getCategoryVideos(state.currentCat);
    const toRemove = Array.from(state.selectedIndices).sort((a, b) => a - b).map(i => vids[i]).filter(Boolean);
    state.selectedIndices.clear();
    startRemoval(toRemove, state.currentCat);
  });
}

function renderDetail(el) {
  const vids = getCategoryVideos(state.currentCat);
  if (vids.length === 0) { state.view = 'grid'; render(); return; }
  if (state.detailIndex >= vids.length) state.detailIndex = vids.length - 1;
  if (state.detailIndex < 0) state.detailIndex = 0;

  const v = vids[state.detailIndex];
  const col = COLORS[state.currentCatColor % COLORS.length];
  const pct = vids.length > 0 ? Math.min(100, (state.detailIndex / vids.length) * 100).toFixed(1) : 0;
  const hasPrev = state.detailIndex > 0;
  const hasNext = state.detailIndex < vids.length - 1;
  const dis = (has) => has ? '' : ' style="opacity:.3;pointer-events:none"';

  const media = state.playing && v.videoId
    ? '<iframe src="https://www.youtube.com/embed/' + v.videoId + '?autoplay=1" allow="autoplay;encrypted-media" allowfullscreen></iframe>'
    : '<img src="' + esc(v.thumbnail) + '" alt="">';

  setContent(el, '<div style="padding:12px 20px 0"><button class="btn btn-back" data-action="back">&larr; Back to grid</button></div>'
    + '<div class="media">' + media
    + '<div class="over-badge left">' + (state.detailIndex + 1) + ' / ' + vids.length + '</div>'
    + '<div class="over-badge right" style="background:' + col + '">' + esc(state.currentCat) + '</div></div>'
    + '<div class="info"><div class="title">' + esc(v.title) + '</div>'
    + '<div class="ch">' + esc(v.channel) + (v.lengthText ? ' &middot; ' + esc(v.lengthText) : '') + '</div>'
    + '<div class="prow"><div class="track-sm"><div class="fill" style="width:' + pct + '%;background:' + col + '"></div></div><div class="ptxt">' + pct + '%</div></div>'
    + '<div class="sts"><span class="sr">' + state.removedTotal + ' removed</span><span class="sk">' + state.keptTotal + ' kept</span></div></div>'
    + '<div class="ctrls">'
    + '<button class="btn" data-action="prev"' + dis(hasPrev) + '><kbd>&larr;</kbd> Prev</button>'
    + '<button class="btn" data-action="next"' + dis(hasNext) + '><kbd>&rarr;</kbd> Next</button>'
    + '<button class="btn btn-destructive" data-action="remove"><kbd>Del</kbd> Remove</button>'
    + '<button class="btn btn-success" data-action="keep"><kbd>Tab</kbd> Keep</button>'
    + '<button class="btn" data-action="preview"><kbd>&#9166;</kbd> ' + (state.playing ? 'Close' : 'Preview') + '</button>'
    + '<button class="btn btn-ghost" data-action="back"><kbd>B</kbd> Back</button>'
    + '<button class="btn btn-destructive" data-action="removeall"><kbd>R</kbd> Remove all</button>'
    + '<button class="btn btn-ghost" data-action="quit"><kbd>Q</kbd> Quit</button>'
    + '</div>');

  el.onclick = function(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const vids2 = getCategoryVideos(state.currentCat);
    switch (action) {
      case 'prev':
        if (state.detailIndex > 0) { state.detailIndex--; state.playing = false; render(); } break;
      case 'next':
        if (state.detailIndex < vids2.length - 1) { state.detailIndex++; state.playing = false; render(); } break;
      case 'remove':
        flash('rm');
        removeSingleVideo(vids2[state.detailIndex]).then(() => {
          const rem = getCategoryVideos(state.currentCat);
          if (rem.length === 0) state.view = 'grid';
          else if (state.detailIndex >= rem.length) state.detailIndex = rem.length - 1;
          state.playing = false;
          render();
        });
        break;
      case 'keep':
        flash('kp');
        state.keptTotal++;
        if (state.detailIndex < vids2.length - 1) state.detailIndex++;
        else state.view = 'grid';
        state.playing = false;
        render();
        break;
      case 'preview':
        state.playing = !state.playing; render(); break;
      case 'back':
        state.playing = false; state.view = 'grid'; render(); break;
      case 'removeall':
        confirmRemoveAll(); break;
      case 'quit':
        quit(); break;
    }
  };
}

function confirmRemoveAll() {
  const vids = getCategoryVideos(state.currentCat);
  showConfirm('Remove all <b>' + vids.length + '</b> remaining videos in this channel?', () => {
    startRemoval(vids, state.currentCat);
  });
}

function renderRemoving(el) {
  const { done, total, title, catName } = state.removeProgress;
  const pct = total > 0 ? Math.min(100, (done / total) * 100).toFixed(0) : 0;
  setContent(el, '<div class="removing"><h2>Removing from ' + esc(catName) + '</h2>'
    + '<div class="sub">' + esc(title) + '</div>'
    + '<div class="track"><div class="fill" style="width:' + pct + '%;background:var(--destructive)"></div></div>'
    + '<div class="num">' + done + ' / ' + total + '</div></div>');
}

function renderDone(el) {
  state.playing = false;
  setContent(el, '<div class="done"><h2>Cleanup Complete</h2><p>Reviewed ' + (state.removedTotal + state.keptTotal) + ' videos<br>'
    + '<span style="color:var(--destructive)">' + state.removedTotal + ' removed</span> &middot; '
    + '<span style="color:var(--success)">' + state.keptTotal + ' kept</span></p></div>');
}

// ── Keyboard shortcuts ─────────────────────────────────────

function handleKey(e) {
  if (!document.body.contains(overlay)) { document.removeEventListener('keydown', handleKey); return; }
  if (e.target.tagName === 'INPUT') return;
  const key = e.key;

  if (key.toLowerCase() === 'q' && state.view !== 'loading' && state.view !== 'done') { e.preventDefault(); quit(); return; }

  if (state.view === 'categories') {
    if (key >= '1' && key <= '9') { e.preventDefault(); enterCategory(parseInt(key, 10) - 1); return; }
    if (key === '0') { e.preventDefault(); enterCategory(9); return; }
    return;
  }

  if (state.view === 'grid') {
    if (key.toLowerCase() === 'a') {
      e.preventDefault();
      const vids = getCategoryVideos(state.currentCat);
      if (state.selectedIndices.size === vids.length) state.selectedIndices.clear();
      else state.selectedIndices = new Set(vids.map((_, i) => i));
      render(); return;
    }
    if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); bulkRemoveSelected(); return; }
    if (key === 'Escape' || key.toLowerCase() === 'b') { e.preventDefault(); state.view = 'categories'; render(); return; }
    return;
  }

  if (state.view === 'detail') {
    const vids = getCategoryVideos(state.currentCat);
    if (key === 'ArrowLeft') { e.preventDefault(); if (state.detailIndex > 0) { state.detailIndex--; state.playing = false; render(); } return; }
    if (key === 'ArrowRight') { e.preventDefault(); if (state.detailIndex < vids.length - 1) { state.detailIndex++; state.playing = false; render(); } return; }
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault(); flash('rm');
      removeSingleVideo(vids[state.detailIndex]).then(() => {
        const rem = getCategoryVideos(state.currentCat);
        if (rem.length === 0) state.view = 'grid';
        else if (state.detailIndex >= rem.length) state.detailIndex = rem.length - 1;
        state.playing = false; render();
      });
      return;
    }
    if (key === 'Tab') {
      e.preventDefault(); flash('kp'); state.keptTotal++;
      if (state.detailIndex < vids.length - 1) state.detailIndex++;
      else state.view = 'grid';
      state.playing = false; render(); return;
    }
    if (key === 'Enter') { e.preventDefault(); state.playing = !state.playing; render(); return; }
    if (key === 'Escape' || key.toLowerCase() === 'b') { e.preventDefault(); state.playing = false; state.view = 'grid'; render(); return; }
    if (key.toLowerCase() === 'r') { e.preventDefault(); confirmRemoveAll(); return; }
  }
}
document.addEventListener('keydown', handleKey);

// ── Start ──────────────────────────────────────────────────

console.log('%c[Watch Later Cleanup] Started — panel injected on the right', 'color: #22c55e; font-weight: bold;');
scanPlaylist();

})();
