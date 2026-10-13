#!/usr/bin/env python3
"""
YouTube Watch Later Cleanup Tool

A browser-based UI to triage your Watch Later playlist grouped by channel.
Automatically scans, clusters videos, and lets you review or bulk-remove.

Usage:
  1. Open https://www.youtube.com/playlist?list=WL in Google Chrome
  2. Enable: Chrome > View > Developer > Allow JavaScript from Apple Events
  3. python3 cleanup_watchlater.py

Navigation:
  Categories → Grid (thumbnails) → Single Video Detail
       ↑            ↑                      |
       |            └──────────────────────┘
       └── Back

Controls (in the browser window):
  Grid view:
    A               →  Toggle select all
    Delete           →  Delete selected videos
    B / Escape      →  Back to channel list

  Single video view:
    ← / →               →  Previous / Next video
    Delete / Backspace  →  Remove from Watch Later
    Tab                 →  Keep, go back to grid
    Enter               →  Preview video (embedded player)
    B / Escape          →  Back to grid
    R                   →  Remove all remaining (with confirmation)

  Q                     →  Quit (from any view)
"""

import subprocess, json, time, sys, os, threading, queue, tty, termios, select
from http.server import HTTPServer, BaseHTTPRequestHandler

COLORS = [
    "#ef4444", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#f97316",
    "#14b8a6", "#ec4899", "#06b6d4", "#84cc16", "#f43f5e", "#6366f1", "#71717a",
]

MIN_GROUP_SIZE = 2

# ── Shared state ─────────────────────────────────────────────────────────

input_queue = queue.Queue()
_wl_tab_ref = None
state = {"status": "loading"}
all_videos = []
cat_order = []

# ── HTML SPA (shadcn-inspired) ───────────────────────────────────────────

PREVIEW_HTML = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Watch Later Cleanup</title>
<style>
:root {
  --bg: #09090b; --card: #09090b; --card-raised: #111113;
  --border: #27272a; --border-hover: #3f3f46;
  --fg: #fafafa; --fg-muted: #a1a1aa; --fg-dim: #71717a;
  --accent: #18181b; --accent-hover: #27272a;
  --destructive: #ef4444; --destructive-bg: rgba(239,68,68,.1);
  --success: #22c55e; --success-bg: rgba(34,197,94,.1);
  --blue: #3b82f6;
  --radius: 8px; --radius-lg: 12px;
}
*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg); color: var(--fg);
  display:flex; align-items:center; justify-content:center;
  min-height:100vh; padding:24px;
  -webkit-font-smoothing: antialiased;
}
.card {
  max-width: 720px; width: 100%;
  background: var(--card-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--accent); color: var(--fg-muted);
  font: 13px/1 inherit; cursor: pointer;
  transition: background .15s, border-color .15s, color .15s;
  outline: none; user-select: none; white-space: nowrap;
}
.btn:hover { background: var(--accent-hover); border-color: var(--border-hover); color: var(--fg); }
.btn:active { transform: scale(.97); }
.btn kbd {
  display: inline-block; padding: 1px 5px;
  background: #27272a; border-radius: 4px;
  font: 700 10px/14px ui-monospace, monospace; color: var(--fg-dim);
}
.btn-destructive { border-color: transparent; background: var(--destructive-bg); color: var(--destructive); }
.btn-destructive:hover { background: rgba(239,68,68,.2); border-color: rgba(239,68,68,.3); color: #fca5a5; }
.btn-success { border-color: transparent; background: var(--success-bg); color: var(--success); }
.btn-success:hover { background: rgba(34,197,94,.2); border-color: rgba(34,197,94,.3); color: #86efac; }
.btn-ghost { border-color: transparent; background: transparent; }
.btn-ghost:hover { background: var(--accent-hover); }
.btn-back {
  border-color: transparent; background: transparent; color: var(--fg-dim);
  padding: 7px 12px; margin-bottom: 4px;
}
.btn-back:hover { background: var(--accent-hover); color: var(--fg); }

/* ── Scanning ── */
.scan { padding: 56px 32px; text-align: center; }
.scan h2 { font-size: 15px; font-weight: 500; color: var(--fg); margin-bottom: 20px; }
.scan .track { width: 100%; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; margin-bottom: 12px; }
.scan .fill { height: 100%; background: var(--blue); border-radius: 2px; transition: width .4s ease; }
.scan .num { font-size: 13px; color: var(--fg-muted); }
.scan .hint { font-size: 12px; color: var(--fg-dim); margin-top: 14px; }

/* ── Category list ── */
.cats { padding: 20px; }
.cats h2 { font-size: 15px; font-weight: 600; }
.cats .sub { font-size: 12px; color: var(--fg-dim); margin-top: 2px; margin-bottom: 16px; }
.clist {
  display: flex; flex-direction: column; gap: 1px;
  max-height: 480px; overflow-y: auto;
  margin-bottom: 16px;
  scrollbar-width: thin; scrollbar-color: #27272a transparent;
}
.citem {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: var(--radius);
  cursor: pointer; transition: background .12s;
  position: relative;
}
.citem:hover { background: var(--accent-hover); }
.cnum { font: 500 12px/1 ui-monospace, monospace; color: var(--fg-dim); width: 24px; text-align: right; flex-shrink: 0; }
.cname { flex: 1; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbar { width: 48px; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; flex-shrink: 0; }
.cbar div { height: 100%; border-radius: 2px; }
.ccount { font: 600 12px/1 inherit; color: var(--fg-dim); width: 32px; text-align: right; flex-shrink: 0; }
.cdel {
  opacity: 0; padding: 4px 8px; margin-left: 4px;
  border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--fg-dim); cursor: pointer;
  font: 12px/1 inherit; transition: all .12s; flex-shrink: 0;
}
.citem:hover .cdel { opacity: 1; }
.cdel:hover { background: var(--destructive-bg); color: var(--destructive); border-color: rgba(239,68,68,.2); }
.cat-footer { display: flex; gap: 6px; }

/* ── Grid view ── */
.grid-view { padding: 16px 20px 20px; }
.grid-header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.grid-header h2 { font-size: 15px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid-sub { font-size: 12px; color: var(--fg-dim); margin-bottom: 14px; }
.grid-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 0; margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.grid-toolbar label {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--fg-muted); cursor: pointer; user-select: none;
}
.grid-toolbar label input[type="checkbox"] {
  accent-color: var(--blue); width: 14px; height: 14px; cursor: pointer;
}
.grid-toolbar .spacer { flex: 1; }
.grid-sel-count { font-size: 11px; color: var(--fg-dim); }
.grid-container {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
  max-height: 480px; overflow-y: auto;
  margin-bottom: 14px;
  scrollbar-width: thin; scrollbar-color: #27272a transparent;
}
.grid-card {
  background: var(--accent); border: 2px solid var(--border);
  border-radius: var(--radius); overflow: hidden;
  cursor: pointer; transition: border-color .15s, transform .12s;
  position: relative;
}
.grid-card:hover { border-color: var(--border-hover); }
.grid-card:hover .grid-thumb img { transform: scale(1.04); }
.grid-card.selected { border-color: var(--blue); }
.grid-thumb {
  position: relative; width: 100%; aspect-ratio: 16/9;
  background: #000; overflow: hidden;
}
.grid-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
.grid-check {
  position: absolute; top: 6px; left: 6px; z-index: 2;
  width: 18px; height: 18px; accent-color: var(--blue); cursor: pointer;
}
.grid-title {
  padding: 6px 8px 2px; font-size: 11px; font-weight: 500; line-height: 1.3;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  min-height: 32px;
}
.grid-ch {
  padding: 0 8px 8px; font-size: 10px; color: var(--fg-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.grid-footer { display: flex; gap: 6px; flex-wrap: wrap; }

/* ── Video review ── */
.media { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; }
.media img, .media iframe { width: 100%; height: 100%; display: block; border: none; }
.media img { object-fit: cover; }
.over-badge {
  position: absolute; padding: 3px 8px; border-radius: 6px;
  font: 600 11px/1.3 inherit; backdrop-filter: blur(8px);
}
.over-badge.left { top: 10px; left: 10px; background: rgba(0,0,0,.7); }
.over-badge.right { top: 10px; right: 10px; }
.info { padding: 14px 20px 10px; }
.title {
  font-size: 15px; font-weight: 600; line-height: 1.4; margin-bottom: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ch { font-size: 12px; color: var(--fg-dim); margin-bottom: 12px; }
.prow { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.track-sm { flex: 1; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
.track-sm .fill { height: 100%; border-radius: 2px; transition: width .4s ease; }
.ptxt { font-size: 11px; color: var(--fg-dim); min-width: 36px; text-align: right; }
.sts { display: flex; gap: 14px; font-size: 11px; color: var(--fg-dim); margin-bottom: 14px; }
.sr { color: var(--destructive); } .sk { color: var(--success); }
.ctrls { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 20px 16px; }

/* ── Removing progress ── */
.removing { padding: 40px 24px; text-align: center; }
.removing h2 { font-size: 14px; font-weight: 500; margin-bottom: 6px; }
.removing .sub { font-size: 12px; color: var(--fg-dim); margin-bottom: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.removing .num { font-size: 13px; color: var(--fg-muted); margin-top: 12px; }
.removing .hint { font-size: 11px; color: var(--fg-dim); margin-top: 10px; }

/* ── Flash overlay ── */
.flash { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .25s; z-index: 100; }
.flash.rm { background: var(--destructive-bg); }
.flash.kp { background: var(--success-bg); }
.flash.on { opacity: 1; }

/* ── Confirm overlay ── */
.confirm-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.6);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.confirm-box {
  background: var(--card-raised); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 24px 28px; max-width: 360px; width: 90%;
  text-align: center;
}
.confirm-box h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.confirm-box p { font-size: 12px; color: var(--fg-muted); margin-bottom: 18px; line-height: 1.5; }
.confirm-box .confirm-btns { display: flex; gap: 8px; justify-content: center; }

/* ── Done ── */
.done { text-align: center; padding: 56px 24px; }
.done h2 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.done p { font-size: 13px; color: var(--fg-muted); line-height: 1.6; }
</style></head><body>
<div class="flash" id="fl"></div>
<div class="card"><div id="app"><div class="scan"><h2>Connecting...</h2></div></div></div>
<script>
const C=["#ef4444","#22c55e","#3b82f6","#eab308","#a855f7","#f97316","#14b8a6","#ec4899","#06b6d4","#84cc16","#f43f5e","#6366f1","#71717a"];
let playing=false, lastUrl='', lastJSON='';
let selectedIndices=new Set();

function flash(t){const e=document.getElementById('fl');e.className='flash '+t;requestAnimationFrame(()=>{e.classList.add('on');setTimeout(()=>e.classList.remove('on'),280)})}

function showConfirm(msg,onYes){
  const ov=document.createElement('div');ov.className='confirm-overlay';
  ov.innerHTML='<div class="confirm-box"><h3>Confirm</h3><p>'+msg+'</p><div class="confirm-btns">'
    +'<button class="btn" id="cf-no">Cancel</button>'
    +'<button class="btn btn-destructive" id="cf-yes">Remove</button></div></div>';
  document.body.appendChild(ov);
  document.getElementById('cf-yes').onclick=()=>{ov.remove();onYes()};
  document.getElementById('cf-no').onclick=()=>ov.remove();
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove()});
}
function confirmDelCat(i){
  const d=window._d;if(!d||d.status!=='categories')return;
  const cats=d.categories||[];if(i>=cats.length)return;
  const c=cats[i];
  showConfirm('Remove all <b>'+c.count+'</b> videos from <b>'+c.name+'</b>?',()=>send('delcat:'+i));
}
function confirmRemoveAll(){
  showConfirm('Remove all remaining videos in this channel?',()=>send('removeall'));
}

function send(a){
  fetch('/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:a})}).catch(()=>{});
  if(a==='remove')flash('rm');if(a==='keep')flash('kp');
  if(a==='remove'||a==='keep'||a==='back'||a==='removeall'||a==='next'||a==='prev')playing=false;
}

function sendData(payload){
  fetch('/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
  if(payload.key==='bulk_remove')flash('rm');
}

function vidId(u){const m=u&&u.match(/[?&]v=([^&]+)/);return m?m[1]:null}

function thumbSrc(url,q){const v=vidId(url);return v?'https://i.ytimg.com/vi/'+v+'/'+(q||'hqdefault')+'.jpg':'';}

function thumbErr(img){
  const vid=img.dataset.vid;
  if(!vid){img.onerror=null;img.style.opacity=0;return}
  const q=['hqdefault','mqdefault','default'];
  const t=parseInt(img.dataset.t||'0');
  if(t<q.length){img.dataset.t=t+1;img.src='https://i.ytimg.com/vi/'+vid+'/'+q[t]+'.jpg'}
  else{img.onerror=null;img.style.opacity=0}
}

function toggleSelect(i){
  if(selectedIndices.has(i)) selectedIndices.delete(i);
  else selectedIndices.add(i);
  renderGrid(window._d);
}

function toggleAll(checked){
  const vids=window._d.grid_videos||[];
  selectedIndices.clear();
  if(checked) vids.forEach((_,i)=>selectedIndices.add(i));
  renderGrid(window._d);
}

function bulkRemoveSelected(){
  if(selectedIndices.size===0)return;
  const n=selectedIndices.size;
  showConfirm('Remove <b>'+n+'</b> selected video'+(n>1?'s':'')+'?',()=>{
    const indices=Array.from(selectedIndices).sort((a,b)=>a-b);
    sendData({key:'bulk_remove',indices:indices});
    selectedIndices.clear();
  });
}

document.addEventListener('keydown',e=>{
  const d=window._d;
  let a=null;

  // Grid-specific keys
  if(d&&d.status==='grid'){
    if(e.key.toLowerCase()==='a'){e.preventDefault();const vids=d.grid_videos||[];if(selectedIndices.size===vids.length)toggleAll(false);else toggleAll(true);return}
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();bulkRemoveSelected();return}
    if(e.key==='Escape'||e.key.toLowerCase()==='b'){e.preventDefault();send('back');return}
    if(e.key.toLowerCase()==='q'){e.preventDefault();send('quit');return}
    return;
  }

  // Single video keys — prev/next with arrow keys
  if(d&&d.status==='active'){
    if(e.key==='ArrowLeft'){e.preventDefault();send('prev');return}
    if(e.key==='ArrowRight'){e.preventDefault();send('next');return}
  }
  if(e.key==='Backspace'||e.key==='Delete')a='remove';
  else if(e.key==='Tab')a='keep';
  else if(e.key==='Enter'){
    if(d&&d.status==='active'){e.preventDefault();playing=!playing;renderActive(d);return}
  }
  else if(e.key==='Escape'||e.key.toLowerCase()==='b')a='back';
  else if(e.key.toLowerCase()==='q')a='quit';
  else if(e.key.toLowerCase()==='r'&&d&&d.status==='active'){e.preventDefault();confirmRemoveAll();return}
  else if(e.key>='1'&&e.key<='9')a='cat:'+(parseInt(e.key)-1);
  else if(e.key==='0')a='cat:9';
  if(a){e.preventDefault();send(a)}
});

function renderGrid(d){
  const el=document.getElementById('app');
  const vids=d.grid_videos||[];
  const col=C[(d.cat_color||0)%C.length];
  const allSelected=vids.length>0&&selectedIndices.size===vids.length;

  let cards='';
  vids.forEach((v,i)=>{
    const sel=selectedIndices.has(i);
    const vid=vidId(v.url);
    const src=vid?'https://i.ytimg.com/vi/'+vid+'/hqdefault.jpg':v.thumbnail;
    const da=vid?' data-vid="'+vid+'" data-t="0"':'';
    cards+='<div class="grid-card'+(sel?' selected':'')+'">'
      +'<div class="grid-thumb" onclick="sendData({key:\'grid_click\',index:'+i+'})">'
      +'<input type="checkbox" class="grid-check" '+(sel?'checked ':'')+' onclick="event.stopPropagation();toggleSelect('+i+')">'
      +'<img src="'+src+'"'+da+' alt="" onerror="thumbErr(this)">'
      +'</div>'
      +'<div class="grid-title" onclick="sendData({key:\'grid_click\',index:'+i+'})">'+v.title+'</div>'
      +'<div class="grid-ch">'+v.channel+'</div>'
      +'</div>';
  });

  const selCount=selectedIndices.size;
  el.innerHTML='<div class="grid-view">'
    +'<button class="btn btn-back" onclick="send(\'back\')">&larr; Back</button>'
    +'<div class="grid-header"><h2 style="color:'+col+'">'+d.current_cat+'</h2></div>'
    +'<div class="grid-sub">'+vids.length+' videos'+(d.removed>0?' &middot; '+d.removed+' removed total':'')+'</div>'
    +'<div class="grid-toolbar">'
    +'<label><input type="checkbox" '+(allSelected?'checked ':'')+' onchange="toggleAll(this.checked)"> Select all</label>'
    +'<span class="grid-sel-count">'+(selCount>0?selCount+' selected':'')+'</span>'
    +'<span class="spacer"></span>'
    +'<button class="btn btn-destructive" onclick="bulkRemoveSelected()" style="'+(selCount===0?'opacity:.4;pointer-events:none':'')+'"><kbd>Del</kbd> Delete'+(selCount>0?' ('+selCount+')':'')+'</button>'
    +'</div>'
    +'<div class="grid-container">'+cards+'</div>'
    +'<div class="grid-footer">'
    +'<button class="btn btn-ghost" onclick="send(\'quit\')"><kbd>Q</kbd> Quit</button>'
    +'</div></div>';
}

function renderActive(d){
  const el=document.getElementById('app');
  const pct=d.cat_total>0?Math.min(100,(d.cat_index/d.cat_total)*100).toFixed(1):0;
  const col=C[(d.cat_color||0)%C.length];
  const vid=vidId(d.url);
  const detailSrc=vid?'https://i.ytimg.com/vi/'+vid+'/sddefault.jpg':d.thumbnail;
  const detailDa=vid?' data-vid="'+vid+'" data-t="0"':'';
  const media=playing&&vid
    ?'<iframe src="https://www.youtube.com/embed/'+vid+'?autoplay=1" allow="autoplay;encrypted-media" allowfullscreen></iframe>'
    :'<img src="'+detailSrc+'"'+detailDa+' alt="" onerror="thumbErr(this)">';
  const prevDis=d.has_prev?'':' style="opacity:.3;pointer-events:none"';
  const nextDis=d.has_next?'':' style="opacity:.3;pointer-events:none"';
  el.innerHTML=
    '<div style="padding:12px 20px 0"><button class="btn btn-back" onclick="send(\'back\')">&larr; Back to grid</button></div>'
    +'<div class="media">'+media
    +'<div class="over-badge left">'+d.cat_index+' / '+d.cat_total+'</div>'
    +'<div class="over-badge right" style="background:'+col+'">'+d.current_cat+'</div></div>'
    +'<div class="info"><div class="title">'+d.title+'</div><div class="ch">'+d.channel+'</div>'
    +'<div class="prow"><div class="track-sm"><div class="fill" style="width:'+pct+'%;background:'+col+'"></div></div><div class="ptxt">'+pct+'%</div></div>'
    +'<div class="sts"><span class="sr">'+d.removed+' removed</span><span class="sk">'+d.kept+' kept</span></div></div>'
    +'<div class="ctrls">'
    +'<button class="btn"'+prevDis+' onclick="send(\'prev\')"><kbd>&larr;</kbd> Prev</button>'
    +'<button class="btn"'+nextDis+' onclick="send(\'next\')"><kbd>&rarr;</kbd> Next</button>'
    +'<button class="btn btn-destructive" onclick="send(\'remove\')"><kbd>Del</kbd> Remove</button>'
    +'<button class="btn btn-success" onclick="send(\'keep\')"><kbd>Tab</kbd> Keep</button>'
    +'<button class="btn" onclick="playing=!playing;renderActive(window._d)"><kbd>&#9166;</kbd> '+(playing?'Close':'Preview')+'</button>'
    +'<button class="btn btn-ghost" onclick="send(\'back\')"><kbd>B</kbd> Back</button>'
    +'<button class="btn btn-destructive" onclick="confirmRemoveAll()"><kbd>R</kbd> Remove all</button>'
    +'<button class="btn btn-ghost" onclick="send(\'quit\')"><kbd>Q</kbd> Quit</button>'
    +'</div>';
}

async function poll(){
  try{
    const r=await fetch('/data?t='+Date.now());
    const text=await r.text();

    // Skip re-render if nothing changed
    if(text===lastJSON) return;
    lastJSON=text;

    const d=JSON.parse(text);
    window._d=d;
    const el=document.getElementById('app');

    if(d.status==='loading'){el.innerHTML='<div class="scan"><h2>Connecting...</h2></div>';return}

    if(d.status==='scanning'){
      const p=d.total>0?Math.min(100,(d.scanned/d.total)*100).toFixed(0):0;
      el.innerHTML='<div class="scan"><h2>Scanning your playlist...</h2>'
        +'<div class="track"><div class="fill" style="width:'+p+'%"></div></div>'
        +'<div class="num">'+d.scanned+' / '+(d.total||'?')+' videos loaded</div>'
        +'<div class="hint">Press Q to stop early</div></div>';
      return}

    if(d.status==='categories'){
      const cats=d.categories||[];
      const mx=Math.max(...cats.map(c=>c.count),1);
      let rows='';
      cats.forEach((c,i)=>{
        const col=C[c.color%C.length];
        const bw=Math.max(8,(c.count/mx)*100);
        rows+='<div class="citem" onclick="send(\'cat:'+i+'\')">'
          +'<div class="cnum">'+(i+1)+'</div>'
          +'<div class="cname">'+c.name+'</div>'
          +'<div class="cbar"><div style="width:'+bw+'%;background:'+col+'"></div></div>'
          +'<div class="ccount">'+c.count+'</div>'
          +'<button class="cdel" onclick="event.stopPropagation();confirmDelCat('+i+')" title="Remove all '+c.count+' videos">Remove all</button>'
          +'</div>';
      });
      el.innerHTML='<div class="cats"><h2>Watch Later</h2>'
        +'<div class="sub">'+d.total_remaining+' videos &middot; '+cats.length+' channels'+(d.removed>0?' &middot; '+d.removed+' removed':'')+'</div>'
        +'<div class="clist">'+rows+'</div>'
        +'<div class="cat-footer"><button class="btn btn-ghost" onclick="send(\'quit\')"><kbd>Q</kbd> Quit</button></div></div>';
      return}

    if(d.status==='grid'){
      // Prune selected indices that are out of range
      const vids=d.grid_videos||[];
      const pruned=new Set();
      selectedIndices.forEach(i=>{if(i<vids.length)pruned.add(i)});
      selectedIndices=pruned;
      renderGrid(d);
      return}

    if(d.status==='active'){
      if(d.url!==lastUrl){playing=false;lastUrl=d.url}
      renderActive(d);return}

    if(d.status==='removing'){
      const p=d.r_total>0?Math.min(100,(d.r_done/d.r_total)*100).toFixed(0):0;
      el.innerHTML='<div class="removing"><h2>Removing from '+d.current_cat+'</h2>'
        +'<div class="sub">'+d.r_title+'</div>'
        +'<div class="track"><div class="fill" style="width:'+p+'%;background:var(--destructive)"></div></div>'
        +'<div class="num">'+d.r_done+' / '+d.r_total+'</div>'
        +'<div class="hint">Press B to stop</div></div>';
      return}

    if(d.status==='done'){
      playing=false;
      el.innerHTML='<div class="done"><h2>Cleanup Complete</h2><p>Reviewed '+(d.removed+d.kept)+' videos<br>'
        +'<span style="color:var(--destructive)">'+d.removed+' removed</span> &middot; '
        +'<span style="color:var(--success)">'+d.kept+' kept</span></p></div>'}
  }catch(e){}}
setInterval(poll,400);poll();
</script></body></html>"""

# ── Server ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/data'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(state).encode())
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(PREVIEW_HTML.encode())

    def do_POST(self):
        if self.path == '/input':
            n = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(n).decode()
            try:
                data = json.loads(body)
                k = data.get('key', '')
                if k == 'bulk_remove':
                    indices = data.get('indices', [])
                    input_queue.put(('bulk_remove', indices))
                elif k == 'grid_click':
                    index = data.get('index', 0)
                    input_queue.put(('grid_click', index))
                elif k:
                    input_queue.put(k)
            except Exception: pass
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'ok')

    def log_message(self, *a): pass

# ── Terminal ─────────────────────────────────────────────────────────────

KEYMAP = {
    '\x7f': 'remove', '\x08': 'remove',
    '\t': 'keep', '\r': 'open', '\n': 'open',
    'q': 'quit', 'b': 'back', 'r': 'removeall',
    'a': 'selectall',
    '1':'cat:0','2':'cat:1','3':'cat:2','4':'cat:3','5':'cat:4',
    '6':'cat:5','7':'cat:6','8':'cat:7','9':'cat:8','0':'cat:9',
}

def terminal_reader():
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        while True:
            ch = os.read(fd, 1).decode('utf-8', errors='ignore')
            if ch == '\x1b':
                if select.select([sys.stdin], [], [], 0.05)[0]:
                    os.read(fd, 10); continue
                input_queue.put('back')
            else:
                a = KEYMAP.get(ch) or KEYMAP.get(ch.lower())
                if a: input_queue.put(a)
    except Exception: pass
    finally: termios.tcsetattr(fd, termios.TCSADRAIN, old)

def wait_for(valid):
    """Wait for a valid input. `valid` can contain strings and type names like 'grid_click' or 'bulk_remove'.
    Returns either a string or a tuple (action, data) for compound messages."""
    while True:
        try:
            k = input_queue.get(timeout=0.2)
            if isinstance(k, tuple):
                if k[0] in valid:
                    return k
            elif k in valid:
                return k
        except queue.Empty: pass

def drain():
    while not input_queue.empty():
        try: input_queue.get_nowait()
        except queue.Empty: break

def tprint(m=""):
    sys.stdout.write(m + "\r\n"); sys.stdout.flush()

# ── AppleScript bridge ──────────────────────────────────────────────────

def find_wl_tab():
    global _wl_tab_ref
    s = '''tell application "Google Chrome"
        set w to 1
        repeat with win in windows
            set t to 1
            repeat with tb in tabs of win
                if URL of tb contains "list=WL" then return (w as text) & "," & (t as text)
                set t to t+1
            end repeat
            set w to w+1
        end repeat
        return "0,0"
    end tell'''
    p = subprocess.run(["osascript", "-e", s], capture_output=True, text=True, timeout=10)
    if p.returncode == 0:
        parts = p.stdout.strip().split(",")
        if len(parts) == 2 and parts[0] != "0":
            _wl_tab_ref = (int(parts[0]), int(parts[1])); return True
    _wl_tab_ref = None; return False

def run_js(code, _retry=True):
    global _wl_tab_ref
    if not _wl_tab_ref and not find_wl_tab():
        raise RuntimeError("No Watch Later tab found.")
    w, t = _wl_tab_ref
    tmp = "/tmp/_yt_wl_js.js"
    with open(tmp, "w") as f: f.write(code)
    s = f'''set f to POSIX file "{tmp}"
    set js to read f as «class utf8»
    tell application "Google Chrome" to execute tab {t} of window {w} javascript js'''
    try: p = subprocess.run(["osascript", "-e", s], capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired: _wl_tab_ref = None; return None
    if p.returncode != 0:
        if _retry:
            _wl_tab_ref = None
            if find_wl_tab(): return run_js(code, False)
        raise RuntimeError(p.stderr.strip())
    return p.stdout.strip()

# ── YouTube helpers ──────────────────────────────────────────────────────

def get_total():
    r = run_js("""(function(){
        var e=document.querySelector('yt-formatted-string.byline-item');
        if(e)return e.textContent.trim();
        var s=document.querySelectorAll('.metadata-stats yt-formatted-string,#stats yt-formatted-string');
        for(var i=0;i<s.length;i++)if(s[i].textContent.match(/\\d/))return s[i].textContent.trim();
        return''})();""")
    if r:
        n = ''.join(c for c in r if c.isdigit())
        if n: return int(n)
    return 0

def get_loaded():
    r = run_js("document.querySelectorAll('ytd-playlist-video-renderer').length")
    return int(r) if r and r.isdigit() else 0

def extract_batch(start, count):
    r = run_js(f"""(function(){{var v=document.querySelectorAll('ytd-playlist-video-renderer'),r=[],e=Math.min({start}+{count},v.length);
    for(var i={start};i<e;i++){{var x=v[i],te=x.querySelector('#video-title'),
    ce=x.querySelector('#channel-name a')||x.querySelector('#channel-name #text')||x.querySelector('#channel-name yt-formatted-string'),
    ie=x.querySelector('img');
    r.push({{t:te?te.textContent.trim():'?',c:ce?ce.textContent.trim():'?',u:te?te.href:'',i:ie?ie.src:''}})}}
    return JSON.stringify(r)}})();""")
    if not r: return []
    try: return [{"title":v["t"],"channel":v["c"],"url":v["u"],"thumbnail":v["i"]} for v in json.loads(r)]
    except: return []

def scan_playlist(total):
    global state
    tprint("  Scanning playlist...")
    last, stall = 0, 0
    while stall < 4:
        run_js("window.scrollTo(0,document.documentElement.scrollHeight)")
        time.sleep(1.0)
        n = get_loaded()
        state = {"status": "scanning", "scanned": n, "total": total}
        if n != last: stall = 0; last = n
        else: stall += 1
        try:
            if input_queue.get_nowait() == 'quit':
                tprint("  Scan stopped early."); break
        except queue.Empty: pass
    tprint(f"  Loaded {last}. Extracting...")
    vids = []
    for i in range(0, last, 80):
        vids.extend(extract_batch(i, 80))
    run_js("window.scrollTo(0,0)")
    tprint(f"  Got {len(vids)} videos.")
    return vids

def remove_by_url(url):
    escaped = url.replace("\\", "\\\\").replace("'", "\\'")
    r = run_js(f"""(function(){{var v=document.querySelectorAll('ytd-playlist-video-renderer');
    for(var i=0;i<v.length;i++){{var t=v[i].querySelector('#video-title');
    if(t&&t.href==='{escaped}'){{v[i].scrollIntoView({{block:'center'}});
    var b=v[i].querySelector('#button.dropdown-trigger')||v[i].querySelector('yt-icon-button#button')
    ||v[i].querySelector('#menu yt-icon-button')||v[i].querySelector('#menu button');
    if(b){{b.click();return'OK'}}return'NB'}}}}return'NF'}})();""")
    if r != 'OK': return False
    time.sleep(0.5)
    r = run_js("""(function(){var it=document.querySelectorAll(
    'tp-yt-paper-listbox ytd-menu-service-item-renderer,ytd-menu-popup-renderer ytd-menu-service-item-renderer,ytd-menu-service-item-renderer');
    for(var i=0;i<it.length;i++){if(it[i].textContent.toLowerCase().includes('remove from')){it[i].click();return'OK'}}return'NF'})();""")
    return r == 'OK'

def close_menu():
    run_js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")

# ── Bulk remove ──────────────────────────────────────────────────────────

def bulk_remove(vids, cat_name, cat_color):
    """Remove all videos in a list. Returns (removed, failed). Abortable with B."""
    global state
    remaining = [v for v in vids if not v["removed"]]
    total = len(remaining)
    rm, fail = 0, 0
    for j, v in enumerate(remaining):
        state = {
            "status": "removing", "current_cat": cat_name, "cat_color": cat_color,
            "r_done": j, "r_total": total, "r_title": v["title"],
        }
        ok = remove_by_url(v["url"])
        if ok:
            v["removed"] = True; rm += 1
            tprint(f"    [{j+1}/{total}] Removed: {v['title'][:60]}")
            time.sleep(0.3)
        else:
            close_menu(); fail += 1
            tprint(f"    [{j+1}/{total}] Failed: {v['title'][:60]}")
        # Check for abort
        try:
            a = input_queue.get_nowait()
            if isinstance(a, str) and a in ('back', 'quit'):
                tprint("    Bulk remove stopped.")
                return rm, fail
        except queue.Empty: pass
    return rm, fail

# ── Main ─────────────────────────────────────────────────────────────────

def build_cat_list():
    groups = {}
    for v in all_videos:
        if v["removed"]: continue
        c = v["category"]
        groups[c] = groups.get(c, 0) + 1
    result = []
    for i, name in enumerate(cat_order):
        cnt = groups.get(name, 0)
        if cnt > 0:
            result.append({"name": name, "count": cnt, "color": i})
    return result

def main():
    global state, all_videos, cat_order

    print("=" * 52)
    print("  YouTube Watch Later Cleanup")
    print("=" * 52)
    print()
    print("  1. Open Watch Later in Chrome:")
    print("     https://www.youtube.com/playlist?list=WL")
    print("  2. Chrome > View > Developer >")
    print("     Allow JavaScript from Apple Events")
    print()
    input("  Press Enter when ready...")
    print()

    try: run_js("1")
    except RuntimeError as e:
        print(f"  ERROR: {e}"); sys.exit(1)

    total = get_total()
    tprint(f"  Playlist: {total} videos" if total else "  Could not read total.")

    threading.Thread(target=lambda: HTTPServer(('127.0.0.1', 8976), Handler).serve_forever(), daemon=True).start()
    time.sleep(0.3)
    subprocess.Popen(["open", "http://127.0.0.1:8976"])
    threading.Thread(target=terminal_reader, daemon=True).start()
    tprint("  UI opened at http://127.0.0.1:8976\r\n")

    # ── Scan ──
    raw = scan_playlist(total)
    if not raw:
        tprint("  No videos found."); return

    # ── Group by channel ──
    ch_counts = {}
    for v in raw:
        ch_counts[v["channel"]] = ch_counts.get(v["channel"], 0) + 1
    for v in raw:
        v["category"] = v["channel"] if ch_counts[v["channel"]] >= MIN_GROUP_SIZE else "Other"
        v["removed"] = False
    all_videos = raw

    seen = set(); cat_order = []
    for v in all_videos:
        if v["category"] not in seen:
            seen.add(v["category"]); cat_order.append(v["category"])
    cat_order.sort(key=lambda c: sum(1 for v in all_videos if v["category"] == c), reverse=True)
    tprint(f"  Grouped into {len(cat_order)} channels.\r\n")

    removed_total = 0
    kept_total = 0

    # ── Category loop ──
    while True:
        drain()
        cats = build_cat_list()
        if not cats:
            state = {"status": "done", "removed": removed_total, "kept": kept_total}
            tprint("  All done!"); break

        total_remaining = sum(c["count"] for c in cats)
        state = {"status": "categories", "categories": cats,
                 "total_remaining": total_remaining, "removed": removed_total, "kept": kept_total}

        tprint("  ── Pick a channel ──")
        for i, c in enumerate(cats[:10]):
            tprint(f"  {(i+1)%10}. {c['name']} ({c['count']})")
        if len(cats) > 10:
            tprint(f"  ... and {len(cats)-10} more (use the browser)")

        valid = {'quit'} | {f'cat:{i}' for i in range(len(cats))} | {f'delcat:{i}' for i in range(len(cats))}
        choice = wait_for(valid)

        if choice == 'quit':
            state = {"status": "done", "removed": removed_total, "kept": kept_total}
            tprint(f"\r\n  Stopped. Removed: {removed_total} | Kept: {kept_total}")
            break

        # ── Bulk remove entire channel from category list ──
        if isinstance(choice, str) and choice.startswith('delcat:'):
            idx = int(choice.split(':')[1])
            if idx >= len(cats): continue
            sel = cats[idx]["name"]
            col = cats[idx]["color"]
            vids = [v for v in all_videos if v["category"] == sel and not v["removed"]]
            tprint(f"\r\n  Removing all {len(vids)} from {sel}...")
            rm, fail = bulk_remove(vids, sel, col)
            removed_total += rm; kept_total += fail
            tprint(f"  Done: {rm} removed, {fail} failed.\r\n")
            continue

        # ── Enter a channel → Grid view ──
        idx = int(choice.split(':')[1])
        if idx >= len(cats): continue
        sel = cats[idx]["name"]
        col = cats[idx]["color"]

        tprint(f"\r\n  ── {sel} (grid) ──")

        # ── Grid loop ──
        while True:
            drain()
            vids = [v for v in all_videos if v["category"] == sel and not v["removed"]]
            if not vids:
                tprint(f"  No videos left in {sel}.")
                break

            grid_videos = [{"title": v["title"], "channel": v["channel"],
                            "thumbnail": v["thumbnail"], "url": v["url"]}
                           for v in vids]
            state = {
                "status": "grid",
                "current_cat": sel, "cat_color": col,
                "grid_videos": grid_videos,
                "removed": removed_total, "kept": kept_total,
            }

            grid_valid = {'quit', 'back', 'grid_click', 'bulk_remove'}
            action = wait_for(grid_valid)

            if action == 'quit':
                state = {"status": "done", "removed": removed_total, "kept": kept_total}
                tprint(f"\r\n  Stopped. Removed: {removed_total} | Kept: {kept_total}")
                time.sleep(2); return

            if action == 'back':
                tprint("    Back to channels.\r\n")
                break

            # ── Compound actions (tuples) ──
            if isinstance(action, tuple):
                act_name, act_data = action

                if act_name == 'bulk_remove':
                    indices = act_data
                    to_remove = [vids[i] for i in indices if i < len(vids)]
                    if to_remove:
                        tprint(f"    Bulk removing {len(to_remove)} selected videos...")
                        rm, fail = bulk_remove(to_remove, sel, col)
                        removed_total += rm; kept_total += fail
                        tprint(f"    Done: {rm} removed, {fail} failed.")
                    continue

                if act_name == 'grid_click':
                    click_idx = act_data
                    if click_idx >= len(vids):
                        continue

                    # ── Single video detail loop ──
                    exit_to = None
                    while exit_to is None:
                        if click_idx < 0 or click_idx >= len(vids):
                            exit_to = 'grid'; break
                        v = vids[click_idx]

                        has_prev = click_idx > 0
                        has_next = click_idx < len(vids) - 1
                        tprint(f"  [{click_idx+1}/{len(vids)}] {v['title']}")
                        state = {
                            "status": "active",
                            "title": v["title"], "channel": v["channel"],
                            "thumbnail": v["thumbnail"], "url": v["url"],
                            "current_cat": sel, "cat_color": col,
                            "cat_index": click_idx + 1, "cat_total": len(vids),
                            "removed": removed_total, "kept": kept_total,
                            "has_prev": has_prev, "has_next": has_next,
                        }

                        detail_act = wait_for(('remove', 'keep', 'open', 'back', 'quit', 'removeall', 'next', 'prev'))

                        if detail_act == 'open':
                            subprocess.Popen(["open", v["url"]])
                            tprint("    Opened."); continue
                        if detail_act == 'next':
                            if click_idx < len(vids) - 1:
                                click_idx += 1
                            continue
                        if detail_act == 'prev':
                            if click_idx > 0:
                                click_idx -= 1
                            continue
                        if detail_act == 'quit':
                            state = {"status": "done", "removed": removed_total, "kept": kept_total}
                            tprint(f"\r\n  Stopped. Removed: {removed_total} | Kept: {kept_total}")
                            time.sleep(2); return
                        if detail_act == 'back':
                            tprint("    Back to grid.")
                            exit_to = 'grid'
                        elif detail_act == 'removeall':
                            remaining = [v2 for v2 in vids if not v2["removed"]]
                            tprint(f"    Removing all {len(remaining)} remaining...")
                            rm, fail = bulk_remove(remaining, sel, col)
                            removed_total += rm; kept_total += fail
                            tprint(f"  Done: {rm} removed, {fail} failed.\r\n")
                            exit_to = 'categories'
                        elif detail_act == 'remove':
                            ok = remove_by_url(v["url"])
                            if ok:
                                tprint("    Removed."); v["removed"] = True; removed_total += 1
                                time.sleep(0.3)
                            else:
                                tprint("    Failed, skipping."); close_menu(); kept_total += 1
                            exit_to = 'grid'
                        elif detail_act == 'keep':
                            tprint("    Kept."); kept_total += 1
                            exit_to = 'grid'

                    if exit_to == 'categories':
                        break  # break grid loop → back to category loop
                    else:
                        continue  # continue grid loop

    time.sleep(2)

if __name__ == "__main__":
    main()
