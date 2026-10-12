'use strict';
/* Audience display. Read-only output surface: no editing controls.
   All operator-supplied text is escaped before rendering. */
const stage = document.getElementById('stage');
const titleEl = document.getElementById('title');
const kickerEl = document.getElementById('kicker');
const footerEl = document.getElementById('footer');
const countEl = document.getElementById('count');
const imageEl = document.getElementById('slideImage');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHANNEL = 'simple-worship-live';

// Mirrors the font choices offered in the workspace editor.
const FONT_STACKS = {
  'Manrope': "'Manrope', sans-serif",
  'Inter': "'Inter', sans-serif",
  'Montserrat': "'Montserrat', sans-serif",
  'Poppins': "'Poppins', sans-serif",
  'Source Sans 3': "'Source Sans 3', sans-serif",
  'Oswald': "'Oswald', sans-serif",
  'Bebas Neue': "'Bebas Neue', sans-serif",
  'Georgia': 'Georgia, serif',
  'Playfair Display': "'Playfair Display', serif",
  'Lora': "'Lora', serif",
  'Merriweather': "'Merriweather', serif",
  'Libre Baskerville': "'Libre Baskerville', serif",
  'Roboto Slab': "'Roboto Slab', serif",
  'DM Mono': "'DM Mono', monospace"
};

// Animated HTML for slide text. All fragments are escaped before wrapping.
function animatedText(text, style) {
  const anim = (style && style.animation) || 'none';
  const raw = String(text == null ? '' : text);
  if (anim === 'none') return esc(raw).replace(/\r?\n/g, '<br>');
  if (anim !== 'words') {
    return `<span class="swp-anim-${esc(anim)}">${esc(raw).replace(/\r?\n/g, '<br>')}</span>`;
  }
  let wordIndex = 0;
  return raw.split(/\r?\n/).map(line =>
    line.split(/(\s+)/).map(token => {
      if (!token || /^\s+$/.test(token)) return token;
      const delay = (wordIndex++ * 95) + 'ms';
      return `<span class="swp-word" style="animation-delay:${delay}">${esc(token)}</span>`;
    }).join('')
  ).join('<br>');
}

let index = 0;
let total = 0;
let last = null;
let bc = null;
try { bc = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null; } catch { bc = null; }

function receive(msg) {
  if (!msg) return;
  if (msg.type === 'blank') { stage.classList.add('blank'); return; }
  if (msg.type === 'unblank') { stage.classList.remove('blank'); if (last) render(last); return; }
  if (msg.type !== 'slide') return;

  last = msg;
  stage.classList.remove('blank');
  index = typeof msg.index === 'number' ? msg.index : index;
  total = msg.count || total;

  if (msg.background) stage.style.background = msg.background;
  kickerEl.textContent = msg.kicker || 'SIMPLE WORSHIP PRESENTER';
  footerEl.textContent = msg.footer || 'Simple Worship Presenter';

  const text = String(msg.title == null ? '' : msg.title);

  // Text formatting is authored in the editor; `size` is authored against a
  // 1280px-wide slide and scaled to this display so it matches the editor.
  const style = msg.style || {};
  const font = style.font || 'Manrope';
  const inner = document.querySelector('.stage-inner');
  const scale = (inner && inner.clientWidth ? inner.clientWidth : 1280) / 1280;
  titleEl.style.fontFamily = FONT_STACKS[font] || FONT_STACKS.Manrope;
  titleEl.style.fontSize = Math.round((Number(style.size) || 62) * scale) + 'px';
  titleEl.style.fontWeight = style.weight || 600;
  titleEl.style.color = style.color || '#ffffff';
  titleEl.style.lineHeight = style.lineHeight || 1.12;
  titleEl.style.textAlign = style.align || 'center';
  titleEl.style.letterSpacing = /Bebas|Oswald/.test(font) ? '0.02em' : '-0.025em';
  stage.style.justifyContent = { top: 'flex-start', center: 'center', bottom: 'flex-end' }[style.valign || 'center'] || 'center';

  // Animated backgrounds are real media, played silently and looped.
  const video = document.getElementById('stageVideo');
  const overlay = document.getElementById('stageOverlay');
  if (video && overlay) {
    const media = m.video;
    if (media && media.url) {
      if (video.dataset.src !== media.url) {
        video.dataset.src = media.url;
        video.src = media.url;
      }
      video.hidden = false;
      video.loop = media.loop !== false;
      video.muted = true;
      video.style.objectFit = media.fit || 'cover';
      const played = video.play?.();
      if (played && played.catch) played.catch(() => { /* autoplay blocked; first frame shows */ });
      overlay.hidden = false;
      overlay.style.background = 'rgba(0,0,0,' + Number(media.overlay ?? 0.35) + ')';
    } else {
      video.hidden = true;
      video.removeAttribute('src');
      video.dataset.src = '';
      video.pause?.();
      overlay.hidden = true;
    }
  }

  // Replacing the nodes on every change is what restarts the animation.
  titleEl.innerHTML = text ? animatedText(text, style) : '<em>Waiting for the operator…</em>';
  titleEl.classList.toggle('song', /verse|chorus|bridge/i.test(text));

  if (msg.image) {
    imageEl.src = msg.image;
    imageEl.hidden = false;
  } else {
    imageEl.removeAttribute('src');
    imageEl.hidden = true;
  }

  countEl.textContent = total ? String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0') : '—';
  setStatus(true);
}

function render(msg) { receive({ ...msg, type: 'slide' }); }

function setStatus(connected) {
  statusEl.classList.toggle('stale', !connected);
  statusText.textContent = connected ? 'Connected' : 'Reconnecting…';
}

if (bc) {
  bc.onmessage = e => receive(e.data);
  bc.postMessage({ type: 'presenter-ready' });
}

// Fallback path for browsers without BroadcastChannel.
window.addEventListener('storage', e => {
  if (e.key === 'swp-live' && e.newValue) { try { receive(JSON.parse(e.newValue)); } catch { } }
  if (e.key === 'swp-live-command' && e.newValue) { try { receive(JSON.parse(e.newValue)); } catch { } }
});

try {
  const saved = localStorage.getItem('swp-live');
  if (saved) receive(JSON.parse(saved));
} catch { }

// Local preview controls so the audience window is usable on its own.
window.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
    return;
  }
  if (!last) return;
  if (e.code === 'Space' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (index < total - 1) render({ ...last, index: index + 1 });
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (index > 0) render({ ...last, index: index - 1 });
  }
});

// Keep text scaling correct when the display is resized or moved to a projector.
window.addEventListener('resize', () => { if (last) receive({ ...last, type: 'slide' }); });

/* ---- authoritative server state -----------------------------------------
   The same state a paired phone drives. BroadcastChannel still gives instant
   same-device feedback, but the server wins whenever a remote is involved. */
function connectLive() {
  if (!window.WebSocket) return;
  let socket;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(proto + '//' + location.host + '/api/remote/ws');
  } catch {
    return;
  }

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'auth', kind: 'display' }));
    setStatus(true);
  };

  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type !== 'state') return;

    if (message.state && message.state.blank) {
      stage.classList.add('blank');
      last = message.slide;
      return;
    }
    stage.classList.remove('blank');
    if (message.slide) receive({ ...message.slide, type: 'slide' });
    if (message.state && typeof message.state.count === 'number') {
      total = message.state.count;
      index = message.state.index;
      countEl.textContent = total ? String(index + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0') : '—';
    }
  };

  socket.onclose = () => {
    setStatus(false);
    setTimeout(connectLive, 3000);
  };
  socket.onerror = () => { };
}
connectLive();

// Announce that this display exists so the operator can see it is live.
setTimeout(() => setStatus(!!last), 1500);
