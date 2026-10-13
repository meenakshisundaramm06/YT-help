import type { Video, Category, AppMessage, BgMessage } from './types';

// ── Constants ────────────────────────────────────────────────────────────

const COLORS = [
  '#ef4444', '#22c55e', '#3b82f6', '#eab308', '#a855f7', '#f97316',
  '#14b8a6', '#ec4899', '#06b6d4', '#84cc16', '#f43f5e', '#6366f1', '#71717a',
];

const MIN_GROUP_SIZE = 2;

// ── State ────────────────────────────────────────────────────────────────

interface AppState {
  view: 'loading' | 'scanning' | 'categories' | 'grid' | 'detail' | 'removing' | 'done';
  allVideos: Video[];
  catOrder: string[];
  removedTotal: number;
  keptTotal: number;
  scanProgress: { scanned: number; total: number };
  currentCat: string | null;
  currentCatColor: number;
  selectedIndices: Set<number>;
  selectedCategories: Set<number>;
  detailIndex: number;
  playing: boolean;
  removeProgress: { done: number; total: number; title: string; catName: string };
  scanError: string | null;
}

const state: AppState = {
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
};

let port: chrome.runtime.Port | null = null;
const el = () => document.getElementById('app')!;

// ── Port connection ──────────────────────────────────────────────────────

function connect(): void {
  port = chrome.runtime.connect({ name: 'wl-app' });

  port.onMessage.addListener((msg: BgMessage) => {
    switch (msg.type) {
      case 'scan_progress':
        state.view = 'scanning';
        state.scanProgress = { scanned: msg.scanned, total: msg.total };
        render();
        break;

      case 'scan_complete':
        processVideos(msg.videos);
        state.view = 'categories';
        render();
        break;

      case 'scan_error':
        state.view = 'loading';
        state.scanError = msg.error;
        render();
        break;

      case 'remove_progress':
        state.view = 'removing';
        state.removeProgress = {
          done: msg.done,
          total: msg.total,
          title: msg.title,
          catName: state.removeProgress.catName,
        };
        render();
        break;

      case 'remove_complete':
        state.removedTotal += msg.removed;
        state.keptTotal += msg.failed;
        markRemovedVideos();
        if (buildCatList().length === 0) {
          state.view = 'done';
        } else {
          state.view = 'categories';
        }
        render();
        break;

      case 'remove_error':
        state.view = 'categories';
        render();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 1000);
  });

  sendMsg({ type: 'start_scan' });
}

function sendMsg(msg: AppMessage): void {
  if (port) port.postMessage(msg);
}

// ── Video processing ─────────────────────────────────────────────────────

const catColorMap: Record<string, number> = {};
let nextColorIdx = 0;

function processVideos(
  raw: Omit<Video, 'removed' | 'category'>[],
): void {
  const chCounts: Record<string, number> = {};
  for (const v of raw) {
    chCounts[v.channel] = (chCounts[v.channel] || 0) + 1;
  }

  state.allVideos = raw.map((v) => ({
    ...v,
    removed: false,
    category: chCounts[v.channel] >= MIN_GROUP_SIZE ? v.channel : 'Other',
  }));

  const seen = new Set<string>();
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

function buildCatList(): Category[] {
  const groups: Record<string, number> = {};
  for (const v of state.allVideos) {
    if (v.removed) continue;
    groups[v.category] = (groups[v.category] || 0) + 1;
  }
  const result: Category[] = [];
  for (const name of state.catOrder) {
    const cnt = groups[name] || 0;
    if (cnt > 0) {
      result.push({ name, count: cnt, color: catColorMap[name] || 0 });
    }
  }
  result.sort((a, b) => b.count - a.count);
  return result;
}

function getCategoryVideos(catName: string): Video[] {
  return state.allVideos.filter((v) => v.category === catName && !v.removed);
}

let pendingRemovalIds: Set<string> = new Set();

function markRemovedVideos(): void {
  for (const v of state.allVideos) {
    if (pendingRemovalIds.has(v.setVideoId)) {
      v.removed = true;
    }
  }
  pendingRemovalIds.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────

function flash(type: 'rm' | 'kp'): void {
  const f = document.getElementById('fl')!;
  f.className = 'flash ' + type;
  requestAnimationFrame(() => {
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 280);
  });
}

function showConfirm(msg: string, onYes: () => void): void {
  const ov = document.createElement('div');
  ov.className = 'confirm-overlay';
  ov.innerHTML = `
    <div class="bg-surface-raised border border-border rounded-xl p-7 max-w-[340px] w-[85%] text-center">
      <h3 class="text-sm font-semibold mb-2">Confirm</h3>
      <p class="text-[13px] text-fg-muted mb-5 leading-relaxed">${msg}</p>
      <div class="flex gap-2 justify-center">
        <button class="btn-base" data-cf="no">Cancel</button>
        <button class="btn-base btn-destructive" data-cf="yes">Remove</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cf="yes"]')!.addEventListener('click', () => { ov.remove(); onYes(); });
  ov.querySelector('[data-cf="no"]')!.addEventListener('click', () => ov.remove());
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Button styles injected globally (used in innerHTML templates)
const styleTag = document.createElement('style');
styleTag.textContent = `
  .btn-base { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); color: var(--color-fg-muted); font-size: 12px; line-height: 1; cursor: pointer; transition: all 0.12s; outline: none; user-select: none; white-space: nowrap; }
  .btn-base:hover { background: var(--color-accent-hover); border-color: var(--color-border-hover); color: var(--color-fg); }
  .btn-base:active { transform: scale(0.97); }
  .btn-base kbd { display: inline-block; padding: 2px 5px; background: rgba(255,255,255,.06); border: 1px solid var(--color-border); border-radius: 4px; font: 600 10px/13px ui-monospace, monospace; color: var(--color-fg-dim); }
  .btn-destructive { border-color: rgba(239,68,68,.15); background: rgba(239,68,68,.08); color: var(--color-destructive); }
  .btn-destructive:hover { background: rgba(239,68,68,.15); border-color: rgba(239,68,68,.25); color: #fca5a5; }
  .btn-success { border-color: rgba(34,197,94,.15); background: rgba(34,197,94,.08); color: var(--color-success); }
  .btn-success:hover { background: rgba(34,197,94,.15); border-color: rgba(34,197,94,.25); color: #86efac; }
  .btn-ghost { border-color: transparent; background: transparent; }
  .btn-ghost:hover { background: var(--color-accent-hover); }
  .btn-back { border-color: transparent; background: transparent; color: var(--color-fg-dim); padding: 8px 10px; }
  .btn-back:hover { background: var(--color-accent-hover); color: var(--color-fg); }
`;
document.head.appendChild(styleTag);

// ── Render dispatch ──────────────────────────────────────────────────────

function render(): void {
  switch (state.view) {
    case 'loading': renderLoading(); break;
    case 'scanning': renderScanning(); break;
    case 'categories': renderCategories(); break;
    case 'grid': renderGrid(); break;
    case 'detail': renderDetail(); break;
    case 'removing': renderRemoving(); break;
    case 'done': renderDone(); break;
  }
}

// ── Renderers ────────────────────────────────────────────────────────────

function renderLoading(): void {
  const error = state.scanError;
  if (error) {
    el().innerHTML = `
      <div class="flex flex-col items-center justify-center p-16 text-center min-h-[240px]">
        <h2 class="text-sm font-medium mb-4">${esc(error)}</h2>
        <button class="btn-base" data-action="retry">Retry</button>
      </div>`;
    el().querySelector('[data-action="retry"]')!.addEventListener('click', () => {
      state.scanError = null;
      state.view = 'loading';
      render();
      sendMsg({ type: 'start_scan' });
    });
  } else {
    el().innerHTML = `
      <div class="flex flex-col items-center justify-center p-16 text-center min-h-[240px]">
        <h2 class="text-sm font-medium">Connecting...</h2>
      </div>`;
  }
}

function renderScanning(): void {
  const { scanned, total } = state.scanProgress;
  const pct = total > 0 ? Math.min(100, (scanned / total) * 100).toFixed(0) : '0';
  el().innerHTML = `
    <div class="flex flex-col items-center justify-center p-16 text-center min-h-[240px]">
      <h2 class="text-sm font-medium mb-6">Scanning your playlist...</h2>
      <div class="w-full max-w-[280px] h-1 bg-surface-raised rounded-sm overflow-hidden mb-4">
        <div class="h-full bg-blue rounded-sm transition-[width] duration-400 ease-out" style="width:${pct}%"></div>
      </div>
      <div class="text-[13px] text-fg-muted tabular-nums">${scanned} / ${total || '?'} videos loaded</div>
      <div class="text-[11px] text-fg-dim mt-5">Press Q to stop early</div>
    </div>`;
}

function renderCategories(): void {
  const cats = buildCatList();
  const mx = Math.max(...cats.map((c) => c.count), 1);
  const totalRemaining = cats.reduce((s, c) => s + c.count, 0);
  const selCount = state.selectedCategories.size;
  const allSelected = cats.length > 0 && selCount === cats.length;

  let rows = '';
  cats.forEach((c, i) => {
    const col = COLORS[c.color % COLORS.length];
    const bw = Math.max(8, (c.count / mx) * 100);
    const sel = state.selectedCategories.has(i);
    rows += `
      <div class="flex items-center gap-2.5 py-2.5 px-3 rounded-lg cursor-pointer transition-colors duration-[120ms] hover:bg-surface citem" data-cat="${i}">
        <input type="checkbox" class="accent-blue w-[15px] h-[15px] cursor-pointer shrink-0" ${sel ? 'checked' : ''} data-check-cat="${i}">
        <div class="font-mono font-medium text-[11px] text-fg-dim w-5 text-right shrink-0">${i + 1}</div>
        <div class="flex-1 text-[13px] font-medium truncate">${esc(c.name)}</div>
        <div class="w-14 h-1 bg-surface-raised rounded-sm overflow-hidden shrink-0">
          <div class="h-full rounded-sm" style="width:${bw}%;background:${col}"></div>
        </div>
        <div class="font-semibold text-xs text-fg-dim w-8 text-right shrink-0 tabular-nums">${c.count}</div>
      </div>`;
  });

  el().innerHTML = `
    <div class="p-6">
      <h2 class="text-base font-semibold">Watch Later</h2>
      <div class="text-xs text-fg-dim mt-1 mb-5">${totalRemaining} videos &middot; ${cats.length} channels${state.removedTotal > 0 ? ' &middot; ' + state.removedTotal + ' removed' : ''}</div>
      <div class="flex items-center gap-2.5 flex-wrap py-2.5 mb-3 border-b border-border">
        <label class="inline-flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none">
          <input type="checkbox" class="accent-blue w-[15px] h-[15px] cursor-pointer" ${allSelected ? 'checked' : ''} data-action="toggle-all-cats"> Select all
        </label>
        <span class="text-[11px] text-fg-dim" data-sel-count>${selCount > 0 ? selCount + ' selected' : ''}</span>
        <span class="flex-1"></span>
        <button class="btn-base btn-destructive" data-action="bulk-delete-cats" ${selCount === 0 ? 'style="opacity:.4;pointer-events:none"' : ''}><kbd>Del</kbd> Delete${selCount > 0 ? ' (' + selCount + ')' : ''}</button>
      </div>
      <div class="flex flex-col gap-0.5 mb-5 scroll-thin">${rows}</div>
      <div class="flex gap-1.5 pt-1">
        <button class="btn-base btn-ghost" data-action="quit"><kbd>Q</kbd> Quit</button>
      </div>
    </div>`;

  el().addEventListener('click', handleCategoriesClick);
}

function handleCategoriesClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const check = target.closest('[data-check-cat]') as HTMLInputElement | null;
  if (check) {
    e.stopPropagation();
    toggleCategorySelect(parseInt(check.dataset.checkCat!, 10));
    return;
  }
  if (target.closest('[data-action="toggle-all-cats"]')) {
    const cats = buildCatList();
    state.selectedCategories.size === cats.length ? state.selectedCategories.clear() : (state.selectedCategories = new Set(cats.map((_, i) => i)));
    render();
    return;
  }
  if (target.closest('[data-action="bulk-delete-cats"]')) {
    bulkRemoveSelectedCategories();
    return;
  }
  const row = target.closest('[data-cat]') as HTMLElement | null;
  if (row && !target.closest('[data-check-cat]')) {
    enterCategory(parseInt(row.dataset.cat!, 10));
    return;
  }
  if (target.closest('[data-action="quit"]')) quit();
}

function toggleCategorySelect(i: number): void {
  state.selectedCategories.has(i) ? state.selectedCategories.delete(i) : state.selectedCategories.add(i);
  updateCategorySelectionUI();
}

function updateCategorySelectionUI(): void {
  const root = el();
  const cats = buildCatList();
  const selCount = state.selectedCategories.size;
  const allSelected = cats.length > 0 && selCount === cats.length;

  root.querySelectorAll<HTMLInputElement>('[data-check-cat]').forEach((chk) => {
    const idx = parseInt(chk.dataset.checkCat!, 10);
    chk.checked = state.selectedCategories.has(idx);
  });

  const allChk = root.querySelector<HTMLInputElement>('[data-action="toggle-all-cats"]');
  if (allChk) allChk.checked = allSelected;

  const selSpan = root.querySelector('[data-sel-count]') as HTMLElement | null;
  if (selSpan) selSpan.textContent = selCount > 0 ? selCount + ' selected' : '';

  const bulkBtn = root.querySelector<HTMLElement>('[data-action="bulk-delete-cats"]');
  if (bulkBtn) {
    bulkBtn.style.opacity = selCount === 0 ? '.4' : '';
    bulkBtn.style.pointerEvents = selCount === 0 ? 'none' : '';
    bulkBtn.innerHTML = `<kbd>Del</kbd> Delete${selCount > 0 ? ' (' + selCount + ')' : ''}`;
  }
}

function bulkRemoveSelectedCategories(): void {
  if (state.selectedCategories.size === 0) return;
  const cats = buildCatList();
  const selectedCats = Array.from(state.selectedCategories).sort((a, b) => a - b).map((i) => cats[i]).filter(Boolean);
  const totalVideos = selectedCats.reduce((sum, c) => sum + c.count, 0);
  
  showConfirm(
    `Remove all <b>${totalVideos}</b> videos from <b>${selectedCats.length}</b> selected channel${selectedCats.length > 1 ? 's' : ''}?`,
    () => {
      const allVideos = selectedCats.flatMap((c) => getCategoryVideos(c.name));
      state.selectedCategories.clear();
      startRemoval(allVideos, selectedCats.map(c => c.name).join(', '));
    }
  );
}

function enterCategory(idx: number): void {
  const cats = buildCatList();
  if (idx >= cats.length) return;
  state.currentCat = cats[idx].name;
  state.currentCatColor = cats[idx].color;
  state.selectedIndices.clear();
  state.view = 'grid';
  render();
}

function renderGrid(): void {
  const vids = getCategoryVideos(state.currentCat!);
  if (vids.length === 0) { state.view = 'categories'; render(); return; }

  const col = COLORS[state.currentCatColor % COLORS.length];
  const pruned = new Set<number>();
  state.selectedIndices.forEach((i) => { if (i < vids.length) pruned.add(i); });
  state.selectedIndices = pruned;
  const selCount = state.selectedIndices.size;
  const allSelected = vids.length > 0 && selCount === vids.length;

  let cards = '';
  vids.forEach((v, i) => {
    const sel = state.selectedIndices.has(i);
    cards += `
      <div class="bg-surface border-2 ${sel ? 'border-blue' : 'border-border'} rounded-lg overflow-hidden cursor-pointer transition-all duration-150 hover:border-border-hover grid-card" data-grid-idx="${i}">
        <div class="relative w-full aspect-video bg-black overflow-hidden grid-thumb">
          <input type="checkbox" class="absolute top-1.5 left-1.5 z-[2] w-[18px] h-[18px] accent-blue cursor-pointer" ${sel ? 'checked' : ''} data-check="${i}">
          <img src="${esc(v.thumbnail)}" alt="" class="w-full h-full object-cover block transition-transform duration-200">
        </div>
        <div class="px-2.5 pt-2 pb-1 text-[11px] font-medium leading-snug line-clamp-2 min-h-[34px]">${esc(v.title)}</div>
        <div class="px-2.5 pb-2.5 text-[10px] text-fg-dim truncate">${esc(v.channel)}${v.lengthText ? ' &middot; ' + esc(v.lengthText) : ''}</div>
      </div>`;
  });

  el().innerHTML = `
    <div class="p-5 pb-6 px-6">
      <button class="btn-base btn-back" data-action="back">&larr; Back</button>
      <div class="flex items-center gap-2.5 mb-1">
        <h2 class="text-[15px] font-semibold flex-1 truncate" style="color:${col}">${esc(state.currentCat!)}</h2>
      </div>
      <div class="text-xs text-fg-dim mb-4">${vids.length} videos${state.removedTotal > 0 ? ' &middot; ' + state.removedTotal + ' removed total' : ''}</div>
      <div class="flex items-center gap-2.5 flex-wrap py-2.5 mb-4 border-b border-border">
        <label class="inline-flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none">
          <input type="checkbox" class="accent-blue w-[15px] h-[15px] cursor-pointer" ${allSelected ? 'checked' : ''} data-action="toggle-all"> Select all
        </label>
        <span class="text-[11px] text-fg-dim" data-sel-count>${selCount > 0 ? selCount + ' selected' : ''}</span>
        <span class="flex-1"></span>
        <button class="btn-base btn-destructive" data-action="bulk-delete" ${selCount === 0 ? 'style="opacity:.4;pointer-events:none"' : ''}><kbd>Del</kbd> Delete${selCount > 0 ? ' (' + selCount + ')' : ''}</button>
      </div>
      <div class="grid grid-cols-3 gap-3 max-h-[520px] overflow-y-auto mb-4 scroll-thin">${cards}</div>
      <div class="flex gap-1.5 flex-wrap">
        <button class="btn-base btn-ghost" data-action="quit"><kbd>Q</kbd> Quit</button>
      </div>
    </div>`;

  el().addEventListener('click', handleGridClick);
}

function handleGridClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const check = target.closest('[data-check]') as HTMLInputElement | null;
  if (check) { e.stopPropagation(); toggleSelect(parseInt(check.dataset.check!, 10)); return; }
  const card = target.closest('[data-grid-idx]') as HTMLElement | null;
  if (card && !target.closest('[data-check]')) { enterDetail(parseInt(card.dataset.gridIdx!, 10)); return; }
  if (target.closest('[data-action="toggle-all"]')) {
    const vids = getCategoryVideos(state.currentCat!);
    state.selectedIndices.size === vids.length ? state.selectedIndices.clear() : (state.selectedIndices = new Set(vids.map((_, i) => i)));
    render(); return;
  }
  if (target.closest('[data-action="bulk-delete"]')) { bulkRemoveSelected(); return; }
  if (target.closest('[data-action="back"]')) { state.view = 'categories'; render(); return; }
  if (target.closest('[data-action="quit"]')) quit();
}

function toggleSelect(i: number): void {
  state.selectedIndices.has(i) ? state.selectedIndices.delete(i) : state.selectedIndices.add(i);
  updateGridSelectionUI();
}

function updateGridSelectionUI(): void {
  const root = el();
  const vids = getCategoryVideos(state.currentCat!);
  const selCount = state.selectedIndices.size;
  const allSelected = vids.length > 0 && selCount === vids.length;

  root.querySelectorAll<HTMLElement>('[data-grid-idx]').forEach((card) => {
    const idx = parseInt(card.dataset.gridIdx!, 10);
    const sel = state.selectedIndices.has(idx);
    if (sel) { card.classList.remove('border-border'); card.classList.add('border-blue'); }
    else { card.classList.remove('border-blue'); card.classList.add('border-border'); }
    const chk = card.querySelector<HTMLInputElement>('[data-check]');
    if (chk) chk.checked = sel;
  });

  const allChk = root.querySelector<HTMLInputElement>('[data-action="toggle-all"]');
  if (allChk) allChk.checked = allSelected;

  const countEl = root.querySelector('.text-fg-dim:not(.tabular-nums)');
  // Update via class-based selector
  const selSpan = root.querySelector('[data-sel-count]') as HTMLElement | null;
  if (selSpan) selSpan.textContent = selCount > 0 ? selCount + ' selected' : '';

  const bulkBtn = root.querySelector<HTMLElement>('[data-action="bulk-delete"]');
  if (bulkBtn) {
    bulkBtn.style.opacity = selCount === 0 ? '.4' : '';
    bulkBtn.style.pointerEvents = selCount === 0 ? 'none' : '';
  }
}

function enterDetail(idx: number): void {
  state.detailIndex = idx;
  state.playing = false;
  state.view = 'detail';
  render();
}

function bulkRemoveSelected(): void {
  if (state.selectedIndices.size === 0) return;
  const n = state.selectedIndices.size;
  showConfirm(`Remove <b>${n}</b> selected video${n > 1 ? 's' : ''}?`, () => {
    const vids = getCategoryVideos(state.currentCat!);
    const toRemove = Array.from(state.selectedIndices).sort((a, b) => a - b).map((i) => vids[i]).filter(Boolean);
    state.selectedIndices.clear();
    startRemoval(toRemove, state.currentCat!);
  });
}

function renderDetail(): void {
  const vids = getCategoryVideos(state.currentCat!);
  if (vids.length === 0) { state.view = 'grid'; render(); return; }
  if (state.detailIndex >= vids.length) state.detailIndex = vids.length - 1;
  if (state.detailIndex < 0) state.detailIndex = 0;

  const v = vids[state.detailIndex];
  const col = COLORS[state.currentCatColor % COLORS.length];
  const pct = vids.length > 0 ? Math.min(100, (state.detailIndex / vids.length) * 100).toFixed(1) : '0';
  const hasPrev = state.detailIndex > 0;
  const hasNext = state.detailIndex < vids.length - 1;
  const dis = (has: boolean) => has ? '' : 'style="opacity:.3;pointer-events:none"';

  const media = state.playing && v.videoId
    ? `<iframe src="https://www.youtube.com/embed/${v.videoId}?autoplay=1" allow="autoplay;encrypted-media" allowfullscreen class="w-full h-full block border-none"></iframe>`
    : `<img src="${esc(v.thumbnail)}" alt="" class="w-full h-full object-cover block">`;

  el().innerHTML = `
    <div class="pt-3 px-6">
      <button class="btn-base btn-back" data-action="back">&larr; Back to grid</button>
    </div>
    <div class="relative w-full aspect-video bg-black">
      ${media}
      <div class="absolute top-2.5 left-2.5 py-1 px-2.5 rounded-md text-[11px] font-semibold leading-tight backdrop-blur-md bg-black/70">${state.detailIndex + 1} / ${vids.length}</div>
      <div class="absolute top-2.5 right-2.5 py-1 px-2.5 rounded-md text-[11px] font-semibold leading-tight backdrop-blur-md" style="background:${col}">${esc(state.currentCat!)}</div>
    </div>
    <div class="px-6 pt-4 pb-3">
      <div class="text-[15px] font-semibold leading-snug mb-1 line-clamp-2">${esc(v.title)}</div>
      <div class="text-xs text-fg-dim mb-4">${esc(v.channel)}${v.lengthText ? ' &middot; ' + esc(v.lengthText) : ''}</div>
      <div class="flex items-center gap-2.5 mb-2.5">
        <div class="flex-1 h-1 bg-surface-raised rounded-sm overflow-hidden">
          <div class="h-full rounded-sm transition-[width] duration-400 ease-out" style="width:${pct}%;background:${col}"></div>
        </div>
        <div class="text-[11px] text-fg-dim min-w-9 text-right tabular-nums">${pct}%</div>
      </div>
      <div class="flex gap-4 text-xs text-fg-dim mb-4">
        <span class="text-destructive">${state.removedTotal} removed</span>
        <span class="text-success">${state.keptTotal} kept</span>
      </div>
    </div>
    <div class="flex gap-1.5 flex-wrap px-6 pb-5">
      <button class="btn-base" data-action="prev" ${dis(hasPrev)}><kbd>&larr;</kbd> Prev</button>
      <button class="btn-base" data-action="next" ${dis(hasNext)}><kbd>&rarr;</kbd> Next</button>
      <button class="btn-base btn-destructive" data-action="remove"><kbd>Del</kbd> Remove</button>
      <button class="btn-base btn-success" data-action="keep"><kbd>Tab</kbd> Keep</button>
      <button class="btn-base" data-action="preview"><kbd>&#9166;</kbd> ${state.playing ? 'Close' : 'Preview'}</button>
      <button class="btn-base btn-ghost" data-action="back"><kbd>B</kbd> Back</button>
      <button class="btn-base btn-destructive" data-action="removeall"><kbd>R</kbd> Remove all</button>
      <button class="btn-base btn-ghost" data-action="quit"><kbd>Q</kbd> Quit</button>
    </div>`;

  el().addEventListener('click', handleDetailClick);
}

function handleDetailClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!btn) return;
  const action = btn.dataset.action;
  const vids = getCategoryVideos(state.currentCat!);

  switch (action) {
    case 'prev':
      if (state.detailIndex > 0) { state.detailIndex--; state.playing = false; render(); }
      break;
    case 'next':
      if (state.detailIndex < vids.length - 1) { state.detailIndex++; state.playing = false; render(); }
      break;
    case 'remove': {
      const v = vids[state.detailIndex];
      flash('rm');
      v.removed = true;
      state.removedTotal++;
      pendingRemovalIds.add(v.setVideoId);
      sendMsg({ type: 'remove_videos', videos: [{ videoId: v.videoId, setVideoId: v.setVideoId, title: v.title }] });
      const remaining = getCategoryVideos(state.currentCat!);
      if (remaining.length === 0) state.view = 'grid';
      else if (state.detailIndex >= remaining.length) state.detailIndex = remaining.length - 1;
      state.playing = false;
      render();
      break;
    }
    case 'keep':
      flash('kp');
      state.keptTotal++;
      if (state.detailIndex < vids.length - 1) state.detailIndex++;
      else state.view = 'grid';
      state.playing = false;
      render();
      break;
    case 'preview':
      state.playing = !state.playing;
      render();
      break;
    case 'back':
      state.playing = false;
      state.view = 'grid';
      render();
      break;
    case 'removeall':
      confirmRemoveAll();
      break;
    case 'quit':
      quit();
      break;
  }
}

function confirmRemoveAll(): void {
  const vids = getCategoryVideos(state.currentCat!);
  showConfirm(
    `Remove all <b>${vids.length}</b> remaining videos in this channel?`,
    () => startRemoval(vids, state.currentCat!),
  );
}

function renderRemoving(): void {
  const { done, total, title, catName } = state.removeProgress;
  const pct = total > 0 ? Math.min(100, (done / total) * 100).toFixed(0) : '0';
  el().innerHTML = `
    <div class="flex flex-col items-center justify-center p-16 text-center min-h-[240px]">
      <h2 class="text-sm font-medium mb-2">Removing from ${esc(catName)}</h2>
      <div class="text-xs text-fg-dim mb-6 truncate max-w-full">${esc(title)}</div>
      <div class="w-full max-w-[280px] h-1 bg-surface-raised rounded-sm overflow-hidden">
        <div class="h-full rounded-sm transition-[width] duration-400 ease-out bg-destructive" style="width:${pct}%"></div>
      </div>
      <div class="text-[13px] text-fg-muted mt-4 tabular-nums">${done} / ${total}</div>
    </div>`;
}

function renderDone(): void {
  state.playing = false;
  el().innerHTML = `
    <div class="flex flex-col items-center justify-center p-16 text-center min-h-[300px]">
      <h2 class="text-[17px] font-semibold mb-3">Cleanup Complete</h2>
      <p class="text-[13px] text-fg-muted leading-relaxed">
        Reviewed ${state.removedTotal + state.keptTotal} videos<br>
        <span class="text-destructive">${state.removedTotal} removed</span> &middot;
        <span class="text-success">${state.keptTotal} kept</span>
      </p>
    </div>`;
}

// ── Removal ──────────────────────────────────────────────────────────────

function startRemoval(vids: Video[], catName: string): void {
  state.view = 'removing';
  state.removeProgress = { done: 0, total: vids.length, title: '', catName };

  const toSend: { videoId: string; setVideoId: string; title: string }[] = [];
  for (const v of vids) {
    pendingRemovalIds.add(v.setVideoId);
    v.removed = true;
    toSend.push({ videoId: v.videoId, setVideoId: v.setVideoId, title: v.title });
  }

  render();
  sendMsg({ type: 'remove_videos', videos: toSend });
}

function quit(): void {
  state.view = 'done';
  sendMsg({ type: 'stop' });
  render();
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const key = e.key;

  if (key.toLowerCase() === 'q' && state.view !== 'loading' && state.view !== 'done') {
    e.preventDefault(); quit(); return;
  }

  if (state.view === 'categories') {
    if (key >= '1' && key <= '9') { e.preventDefault(); enterCategory(parseInt(key, 10) - 1); return; }
    if (key === '0') { e.preventDefault(); enterCategory(9); return; }
    return;
  }

  if (state.view === 'grid') {
    if (key.toLowerCase() === 'a') {
      e.preventDefault();
      const vids = getCategoryVideos(state.currentCat!);
      state.selectedIndices.size === vids.length ? state.selectedIndices.clear() : (state.selectedIndices = new Set(vids.map((_, i) => i)));
      render(); return;
    }
    if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); bulkRemoveSelected(); return; }
    if (key === 'Escape' || key.toLowerCase() === 'b') { e.preventDefault(); state.view = 'categories'; render(); return; }
    return;
  }

  if (state.view === 'detail') {
    if (key === 'ArrowLeft') {
      e.preventDefault();
      if (state.detailIndex > 0) { state.detailIndex--; state.playing = false; render(); }
      return;
    }
    if (key === 'ArrowRight') {
      e.preventDefault();
      const vids = getCategoryVideos(state.currentCat!);
      if (state.detailIndex < vids.length - 1) { state.detailIndex++; state.playing = false; render(); }
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      const vids = getCategoryVideos(state.currentCat!);
      const v = vids[state.detailIndex];
      if (v) {
        flash('rm'); v.removed = true; state.removedTotal++;
        pendingRemovalIds.add(v.setVideoId);
        sendMsg({ type: 'remove_videos', videos: [{ videoId: v.videoId, setVideoId: v.setVideoId, title: v.title }] });
        const remaining = getCategoryVideos(state.currentCat!);
        if (remaining.length === 0) state.view = 'grid';
        else if (state.detailIndex >= remaining.length) state.detailIndex = remaining.length - 1;
        state.playing = false; render();
      }
      return;
    }
    if (key === 'Tab') {
      e.preventDefault(); flash('kp'); state.keptTotal++;
      const vids = getCategoryVideos(state.currentCat!);
      if (state.detailIndex < vids.length - 1) state.detailIndex++;
      else state.view = 'grid';
      state.playing = false; render(); return;
    }
    if (key === 'Enter') { e.preventDefault(); state.playing = !state.playing; render(); return; }
    if (key === 'Escape' || key.toLowerCase() === 'b') { e.preventDefault(); state.playing = false; state.view = 'grid'; render(); return; }
    if (key.toLowerCase() === 'r') { e.preventDefault(); confirmRemoveAll(); return; }
  }

  if (state.view === 'scanning' && key.toLowerCase() === 'q') {
    e.preventDefault(); sendMsg({ type: 'stop' });
  }
});

// ── Init ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  connect();
});
