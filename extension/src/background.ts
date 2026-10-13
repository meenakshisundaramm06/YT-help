import type { AppMessage, BgMessage } from './types';

let autoCreatedTabId: number | null = null;
let appTabId: number | null = null;

// ── YouTube tab management ───────────────────────────────────────────────

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
    ) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Safety timeout
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

async function getOrCreateYouTubeTab(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  if (tabs.length > 0 && tabs[0].id) return tabs[0].id;

  const tab = await chrome.tabs.create({
    url: 'https://www.youtube.com',
    active: false,
  });
  autoCreatedTabId = tab.id!;
  await waitForTabLoad(tab.id!);
  // Extra delay to let ytcfg initialize
  await sleep(2000);
  return tab.id!;
}

async function cleanupAutoTab(): Promise<void> {
  if (autoCreatedTabId !== null) {
    try {
      await chrome.tabs.remove(autoCreatedTabId);
    } catch {
      // Tab may already be closed
    }
    autoCreatedTabId = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── InnerTube: injected functions (run in YouTube page context) ──────────

// These functions are serialized and injected into the YouTube tab.
// They must be self-contained — no closures over outer variables.

async function fetchWatchLaterPage(continuation: string | null): Promise<unknown> {
  const ytcfg = (window as unknown as { ytcfg: { get(k: string): unknown } }).ytcfg;
  if (!ytcfg || !ytcfg.get) return { error: 'not_logged_in' };

  const apiKey = ytcfg.get('INNERTUBE_API_KEY') as string;
  if (!apiKey) return { error: 'not_logged_in' };

  // Use full INNERTUBE_CONTEXT for authenticated access
  const ctx = ytcfg.get('INNERTUBE_CONTEXT') || {
    client: {
      clientName: ytcfg.get('INNERTUBE_CLIENT_NAME'),
      clientVersion: ytcfg.get('INNERTUBE_CLIENT_VERSION'),
    },
  };
  const body: Record<string, unknown> = { context: JSON.parse(JSON.stringify(ctx)) };
  if (continuation) {
    body.continuation = continuation;
  } else {
    body.browseId = 'VLWL';
  }

  // Build auth headers including SAPISIDHASH
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sessionIndex = ytcfg.get('SESSION_INDEX');
  if (sessionIndex !== undefined) headers['X-Goog-AuthUser'] = String(sessionIndex);
  const visitorData = ytcfg.get('VISITOR_DATA') as string;
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

  // SAPISIDHASH generation
  const cookies = document.cookie.split('; ');
  let sapisid: string | null = null;
  for (const c of cookies) {
    if (c.startsWith('__Secure-3PAPISID=')) { sapisid = c.substring(18); break; }
  }
  if (!sapisid) {
    for (const c of cookies) {
      if (c.startsWith('SAPISID=')) { sapisid = c.substring(8); break; }
    }
  }
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    const input = ts + ' ' + sapisid + ' https://www.youtube.com';
    const encoded = new TextEncoder().encode(input);
    const hashBuf = await crypto.subtle.digest('SHA-1', encoded);
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    headers['Authorization'] = 'SAPISIDHASH ' + ts + '_' + hashHex;
  }

  const resp = await fetch(
    `/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
    { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) },
  );
  return resp.json();
}

async function removeVideosBatch(setVideoIds: string[]): Promise<{ ok: boolean; status: number }> {
  const ytcfg = (window as unknown as { ytcfg: { get(k: string): unknown } }).ytcfg;
  if (!ytcfg || !ytcfg.get) return { ok: false, status: 0 };

  const apiKey = ytcfg.get('INNERTUBE_API_KEY') as string;
  const ctx = ytcfg.get('INNERTUBE_CONTEXT') || {
    client: {
      clientName: ytcfg.get('INNERTUBE_CLIENT_NAME'),
      clientVersion: ytcfg.get('INNERTUBE_CLIENT_VERSION'),
    },
  };

  const body = {
    playlistId: 'WL',
    actions: setVideoIds.map((id) => ({ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' })),
    context: JSON.parse(JSON.stringify(ctx)),
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sessionIndex = ytcfg.get('SESSION_INDEX');
  if (sessionIndex !== undefined) headers['X-Goog-AuthUser'] = String(sessionIndex);

  const cookies = document.cookie.split('; ');
  let sapisid: string | null = null;
  for (const c of cookies) {
    if (c.startsWith('__Secure-3PAPISID=')) { sapisid = c.substring(18); break; }
  }
  if (!sapisid) {
    for (const c of cookies) {
      if (c.startsWith('SAPISID=')) { sapisid = c.substring(8); break; }
    }
  }
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    const input = ts + ' ' + sapisid + ' https://www.youtube.com';
    const encoded = new TextEncoder().encode(input);
    const hashBuf = await crypto.subtle.digest('SHA-1', encoded);
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    headers['Authorization'] = 'SAPISIDHASH ' + ts + '_' + hashHex;
  }

  const resp = await fetch(
    `/youtubei/v1/browse/edit_playlist?key=${apiKey}&prettyPrint=false`,
    { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) },
  );
  return { ok: resp.ok, status: resp.status };
}

// ── InnerTube response parsing ───────────────────────────────────────────

interface RawVideo {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  setVideoId: string;
  lengthText: string;
}

function deepGet(obj: unknown, ...keys: (string | number)[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

function findPlaylistVideoListRenderer(obj: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 12 || obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.playlistVideoListRenderer) return o.playlistVideoListRenderer as Record<string, unknown>;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findPlaylistVideoListRenderer(item, depth + 1);
      if (r) return r;
    }
  } else {
    for (const key of Object.keys(o)) {
      const r = findPlaylistVideoListRenderer(o[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function findContinuationToken(obj: unknown, depth: number): string | null {
  if (depth > 20 || obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.token === 'string' && o.token.length > 20) return o.token;
  if (o.continuationCommand && typeof (o.continuationCommand as Record<string, unknown>).token === 'string') {
    return (o.continuationCommand as Record<string, unknown>).token as string;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findContinuationToken(item, depth + 1);
      if (r) return r;
    }
  } else {
    for (const key of Object.keys(o)) {
      const r = findContinuationToken(o[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function parseVideosFromResponse(
  data: unknown,
  isInitial: boolean,
): { videos: RawVideo[]; continuation: string | null } {
  let items: unknown[];
  let renderer: Record<string, unknown> | null = null;

  if (isInitial) {
    renderer = findPlaylistVideoListRenderer(deepGet(data, 'contents'), 0);
    items = renderer && Array.isArray(renderer.contents) ? renderer.contents as unknown[] : [];
  } else {
    const actions = deepGet(data, 'onResponseReceivedActions') as unknown[] | undefined;
    if (actions && actions.length > 0) {
      items = (deepGet(actions[0], 'appendContinuationItemsAction', 'continuationItems') as unknown[]) || [];
    } else {
      items = [];
    }
  }

  const videos: RawVideo[] = [];
  let continuation: string | null = null;

  for (const item of items) {
    const vr = deepGet(item, 'playlistVideoRenderer') as Record<string, unknown> | undefined;
    if (vr) {
      const videoId = vr.videoId as string || '';
      const title = (deepGet(vr, 'title', 'runs', 0, 'text') as string) || '';
      const channel = (deepGet(vr, 'shortBylineText', 'runs', 0, 'text') as string) || '';
      const thumbs = deepGet(vr, 'thumbnail', 'thumbnails') as { url: string }[] | undefined;
      const thumbnail = thumbs && thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
      const setVideoId = (vr.setVideoId as string) || '';
      const lengthText = (deepGet(vr, 'lengthText', 'simpleText') as string) || '';
      videos.push({ videoId, title, channel, thumbnail, setVideoId, lengthText });
    }

    const itemObj = item as Record<string, unknown>;
    if (itemObj.continuationItemRenderer) {
      const token = findContinuationToken(itemObj.continuationItemRenderer, 0);
      if (token) continuation = token;
    }
    if (!continuation) {
      const contToken = deepGet(item, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token') as string | undefined;
      if (contToken) continuation = contToken;
    }
  }

  // Search renderer for continuation if not found in items
  if (!continuation && renderer) {
    if (renderer.continuations) {
      continuation = findContinuationToken(renderer.continuations, 0);
    }
    if (!continuation) {
      continuation = findContinuationToken(renderer, 0);
    }
  }

  return { videos, continuation };
}

// ── Scan orchestration ───────────────────────────────────────────────────

async function executeInYouTube<T>(tabId: number, fn: (...args: unknown[]) => Promise<T>, args: unknown[] = []): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: fn,
    args,
  });
  return results[0].result as T;
}

async function scanPlaylist(
  port: chrome.runtime.Port,
  stopped: { value: boolean },
): Promise<void> {
  let ytTabId: number;
  try {
    ytTabId = await getOrCreateYouTubeTab();
  } catch {
    sendMsg(port, { type: 'scan_error', error: 'Could not open YouTube tab.' });
    return;
  }

  const allVideos: RawVideo[] = [];
  let continuation: string | null = null;
  let isInitial = true;
  let totalEstimate = 0;

  while (!stopped.value) {
    let data: unknown;
    try {
      data = await executeInYouTube(ytTabId, fetchWatchLaterPage, [continuation]);
    } catch {
      // YouTube tab may have been closed — try to re-create
      try {
        ytTabId = await getOrCreateYouTubeTab();
        data = await executeInYouTube(ytTabId, fetchWatchLaterPage, [continuation]);
      } catch {
        sendMsg(port, { type: 'scan_error', error: 'Failed to connect to YouTube.' });
        return;
      }
    }

    if (data && typeof data === 'object' && 'error' in data) {
      sendMsg(port, {
        type: 'scan_error',
        error: (data as { error: string }).error === 'not_logged_in'
          ? 'Please sign in to YouTube first, then try again.'
          : `API error: ${(data as { error: string }).error}`,
      });
      return;
    }

    const parsed = parseVideosFromResponse(data, isInitial);

    // Get total from initial response
    if (isInitial) {
      const statsText = deepGet(data, 'header', 'playlistHeaderRenderer', 'stats') as unknown[] | undefined;
      if (statsText && statsText.length > 0) {
        const firstStat = deepGet(statsText[0], 'runs', 0, 'text') as string | undefined;
        if (firstStat) {
          const num = parseInt(firstStat.replace(/[^0-9]/g, ''), 10);
          if (!isNaN(num)) totalEstimate = num;
        }
      }
      // Fallback: try numVideosText
      if (totalEstimate === 0) {
        const numText = deepGet(data, 'header', 'playlistHeaderRenderer', 'numVideosText', 'runs', 0, 'text') as string | undefined;
        if (numText) {
          const num = parseInt(numText.replace(/[^0-9]/g, ''), 10);
          if (!isNaN(num)) totalEstimate = num;
        }
      }
    }

    allVideos.push(...parsed.videos);

    sendMsg(port, {
      type: 'scan_progress',
      scanned: allVideos.length,
      total: totalEstimate || allVideos.length,
    });

    if (!parsed.continuation) break;
    continuation = parsed.continuation;
    isInitial = false;

    await sleep(300);
  }

  if (stopped.value) return;

  if (allVideos.length === 0) {
    sendMsg(port, { type: 'scan_error', error: 'Your Watch Later playlist is empty.' });
    await cleanupAutoTab();
    return;
  }

  sendMsg(port, {
    type: 'scan_complete',
    videos: allVideos.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      channel: v.channel,
      thumbnail: v.thumbnail,
      setVideoId: v.setVideoId,
      lengthText: v.lengthText,
    })),
  });
}

// ── Removal orchestration ────────────────────────────────────────────────

const BATCH_SIZE = 20;
const BATCH_DELAY = 500;
const RETRY_DELAY = 3000;
const MAX_RETRIES = 2;

async function removeVideos(
  port: chrome.runtime.Port,
  videos: { videoId: string; setVideoId: string; title: string }[],
  stopped: { value: boolean },
): Promise<void> {
  let ytTabId: number;
  try {
    ytTabId = await getOrCreateYouTubeTab();
  } catch {
    sendMsg(port, { type: 'remove_error', error: 'Could not open YouTube tab.' });
    return;
  }

  let removed = 0;
  let failed = 0;
  const total = videos.length;

  for (let i = 0; i < videos.length; i += BATCH_SIZE) {
    if (stopped.value) break;

    const batch = videos.slice(i, i + BATCH_SIZE);
    const setVideoIds = batch.map((v) => v.setVideoId);
    const lastTitle = batch[batch.length - 1].title;

    sendMsg(port, {
      type: 'remove_progress',
      done: i,
      total,
      title: lastTitle,
    });

    let success = false;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        const result = await executeInYouTube(ytTabId, removeVideosBatch, [setVideoIds]);
        if (result && (result as { ok: boolean }).ok) {
          success = true;
          break;
        }
      } catch {
        // Tab may have closed
        try {
          ytTabId = await getOrCreateYouTubeTab();
        } catch {
          // give up on this batch
        }
      }
      if (retry < MAX_RETRIES) await sleep(RETRY_DELAY);
    }

    if (success) {
      removed += batch.length;
    } else {
      failed += batch.length;
    }

    if (i + BATCH_SIZE < videos.length) {
      await sleep(BATCH_DELAY);
    }
  }

  sendMsg(port, { type: 'remove_progress', done: total, total, title: '' });
  sendMsg(port, { type: 'remove_complete', removed, failed });
  await cleanupAutoTab();
}

// ── Port messaging ───────────────────────────────────────────────────────

function sendMsg(port: chrome.runtime.Port, msg: BgMessage): void {
  try {
    port.postMessage(msg);
  } catch {
    // Port disconnected
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'wl-app') return;

  const stopped = { value: false };

  port.onDisconnect.addListener(() => {
    stopped.value = true;
  });

  port.onMessage.addListener((msg: AppMessage) => {
    switch (msg.type) {
      case 'start_scan':
        stopped.value = false;
        scanPlaylist(port, stopped);
        break;
      case 'remove_videos':
        stopped.value = false;
        removeVideos(port, msg.videos, stopped);
        break;
      case 'stop':
        stopped.value = true;
        break;
    }
  });
});

// ── Extension icon click → open/focus app tab ────────────────────────────

chrome.action.onClicked.addListener(async () => {
  if (appTabId !== null) {
    try {
      const tab = await chrome.tabs.get(appTabId);
      if (tab) {
        await chrome.tabs.update(appTabId, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    } catch {
      appTabId = null;
    }
  }

  const appUrl = chrome.runtime.getURL('src/app.html');
  const tab = await chrome.tabs.create({ url: appUrl });
  appTabId = tab.id!;
});

// Track app tab closure
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === appTabId) appTabId = null;
  if (tabId === autoCreatedTabId) autoCreatedTabId = null;
});
