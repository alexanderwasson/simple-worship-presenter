'use strict';
/* Mobile remote client for Simple Worship Presenter. */
(function () {
  const TOKEN_KEY = 'swp-remote-token';
  const REMOTE_ID_KEY = 'swp-remote-id';

  const el = id => document.getElementById(id);
  const pairingView = el('pairingView');
  const remoteView = el('remoteView');
  const pairCode = el('pairCode');
  const pairButton = el('pairButton');
  const pairError = el('pairError');

  const statusDot = el('statusDot');
  const statusTitle = el('statusTitle');
  const statusDetail = el('statusDetail');

  let token = null;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let state = null;
  let allowed = [];
  let closedByUser = false;

  /* ------------------------------------------------------------ helpers */
  function showError(message) {
    pairError.textContent = message;
    pairError.classList.remove('hidden');
  }

  function setStatus(kind, title, detail) {
    statusDot.className = 'dot ' + (kind === 'up' ? '' : kind === 'stale' ? 'stale' : 'down');
    statusTitle.textContent = title;
    statusDetail.textContent = detail || '';
  }

  function tokenFromHash() {
    const m = location.hash.match(/code=([A-Za-z0-9]+)/);
    return m ? m[1].toUpperCase() : null;
  }

  function slideText(slide) {
    if (typeof slide === 'string') return slide;
    return (slide && (slide.text || slide.name)) || '';
  }

  /* ------------------------------------------------------------ pairing */
  async function pair(code) {
    pairButton.disabled = true;
    pairError.classList.add('hidden');
    try {
      const res = await fetch('/api/remote/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not pair this device');

      sessionStorage.setItem(TOKEN_KEY, data.token);
      sessionStorage.setItem(REMOTE_ID_KEY, data.remote_id);
      token = data.token;
      allowed = data.allowed || [];
      history.replaceState(null, '', location.pathname);
      showRemote();
      if (data.state) applyState(data.state, data.slide, allowed);
      connect();
    } catch (err) {
      showError(err.message);
    } finally {
      pairButton.disabled = false;
    }
  }

  function showRemote() {
    pairingView.classList.add('hidden');
    remoteView.classList.remove('hidden');
  }

  function showPairing(message) {
    remoteView.classList.add('hidden');
    pairingView.classList.remove('hidden');
    if (message) showError(message);
  }

  /* ------------------------------------------------------- live state */
  function applyState(next, slide, nextAllowed) {
    state = next || state;
    if (Array.isArray(nextAllowed)) allowed = nextAllowed;

    const labels = state && Array.isArray(state.labels) ? state.labels : [];
    const index = state ? state.index : 0;

    el('statusTitle').textContent = state.title || 'Untitled presentation';
    el('currentPos').textContent = state.count ? (index + 1) + ' / ' + state.count : '—';
    el('slideCount').textContent = state.count ? (index + 1) + ' / ' + state.count : '—';
    el('currentText').textContent = (slide && slide.title) || (labels[index] !== undefined ? labels[index] : '—');
    el('nextText').textContent = labels[index + 1] !== undefined ? labels[index + 1] : 'End of presentation';

    el('currentPreview').classList.toggle('blank', !!state.blank);
    el('blankBtn').classList.toggle('on', !!state.blank);

    // Only offer controls this remote is actually permitted to use.
    el('prevBtn').disabled = !allowed.includes('previous');
    el('nextBtn').disabled = !allowed.includes('next');
    el('blankBtn').disabled = !allowed.includes('blank');
    el('restoreBtn').disabled = !allowed.includes('unblank');

    el('slideList').innerHTML = labels.map((text, i) => `
      <button class="slide-item ${i === index ? 'current' : ''}" data-slide="${i}">
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <span class="label">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</span>
      </button>`).join('');

    Array.prototype.forEach.call(document.querySelectorAll('[data-slide]'), b => {
      b.onclick = () => sendCommand('goto', Number(b.dataset.slide));
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------ socket */
  function connect() {
    if (!token || closedByUser) return;
    clearTimeout(reconnectTimer);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(proto + '//' + location.host + '/api/remote/ws');

    setStatus('stale', 'Connecting…', 'Reaching the presentation server');

    socket.onopen = () => {
      reconnectAttempts = 0;
      // Authentication is a message, never part of the URL, so tokens stay out
      // of proxy logs.
      socket.send(JSON.stringify({ type: 'auth', kind: 'remote', token }));
    };

    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }

      switch (message.type) {
        case 'authenticated':
          setStatus('up', 'Connected', 'Ready to control the presentation');
          break;
        case 'state':
          setStatus('up', state && state.title ? state.title : 'Connected', 'Live');
          applyState(message.state, message.slide, message.allowed);
          break;
        case 'ack':
          break;
        case 'error':
          setStatus('stale', 'Message from server', message.error);
          if (/no longer authorised/i.test(message.error || '')) signOut(message.error);
          break;
      }
    };

    socket.onclose = () => {
      if (closedByUser) return;
      setStatus('down', 'Reconnecting…', 'The connection dropped');
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  function scheduleReconnect() {
    reconnectAttempts += 1;
    // Back off gently so a phone that lost signal does not hammer the server.
    const delay = Math.min(15000, 700 * Math.pow(1.7, Math.min(reconnectAttempts, 8)));
    reconnectTimer = setTimeout(connect, delay);
    // Also resync over REST so the display is right even if the socket lags.
    setTimeout(refreshOverRest, Math.min(delay, 2500));
  }

  async function refreshOverRest() {
    if (!token) return;
    try {
      const res = await fetch('/api/remote/me', { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 401) return signOut('This remote is no longer authorised. Pair again.');
      const data = await res.json();
      applyState(data.state, data.slide, data.allowed);
    } catch { /* the socket reconnect handles recovery */ }
  }

  /* ---------------------------------------------------------- commands */
  // Local echo makes the UI feel instant; the server reply is authoritative.
  function sendCommand(action, index) {
    if (!token) return;
    const message = { type: 'command', action };
    if (action === 'goto') message.index = index;

    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    } else {
      // REST fallback keeps the phone usable when WebSocket upgrade is blocked.
      fetch('/api/remote/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action, index })
      }).then(r => r.json()).then(data => {
        if (data.state) applyState(data.state, data.slide);
        else if (data.error) setStatus('stale', 'Could not send', data.error);
      }).catch(() => setStatus('down', 'Offline', 'Retrying…'));
    }

    // Optimistic movement, corrected when the server answers.
    if (state && state.labels && state.labels.length) {
      const at = state.index;
      const target = action === 'next' ? Math.min(at + 1, state.labels.length - 1)
        : action === 'previous' ? Math.max(at - 1, 0)
          : action === 'goto' ? index : at;
      if (target !== at) applyState({ ...state, index: target }, null, allowed);
    }
  }

  function signOut(message) {
    closedByUser = true;
    clearTimeout(reconnectTimer);
    try { if (socket) socket.close(); } catch { }
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REMOTE_ID_KEY);
    token = null;
    showPairing(message);
  }

  /* ------------------------------------------------------------- wiring */
  el('pairButton').onclick = () => pair(pairCode.value.trim());
  pairCode.addEventListener('keydown', e => {
    if (e.key === 'Enter') pair(pairCode.value.trim());
  });

  el('prevBtn').onclick = () => sendCommand('previous');
  el('nextBtn').onclick = () => sendCommand('next');
  el('blankBtn').onclick = () => sendCommand('blank');
  el('restoreBtn').onclick = () => sendCommand('unblank');
  el('disconnectBtn').onclick = () => signOut('Disconnected from the presentation.');

  // Keyboard support for a phone in a holder or a presenter using a keyboard.
  document.addEventListener('keydown', e => {
    if (!token) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      sendCommand('next');
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      sendCommand('previous');
    } else if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      sendCommand(state && state.blank ? 'unblank' : 'blank');
    }
  });

  // Stop iOS/Android from navigating away on a horizontal swipe while serving.
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) return;
    const scroller = e.target.closest('.slides');
    if (!scroller) e.preventDefault();
  }, { passive: false });

  /* --------------------------------------------------------------- boot */
  const fromHash = tokenFromHash();
  if (fromHash) {
    pair(fromHash);
  } else {
    const stored = sessionStorage.getItem(TOKEN_KEY);
    if (stored) {
      token = stored;
      showRemote();
      setStatus('stale', 'Reconnecting…', 'Restoring this device');
      connect();
      refreshOverRest();
    } else {
      showPairing();
    }
  }
})();
