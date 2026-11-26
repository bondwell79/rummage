/* ============================================================================
 * webrtc.js — Capa de comunicación peer-to-peer (WebRTC DataChannel)
 * ==========================================================================
 * Señalización por servidor público: sustituye al antiguo intercambio manual de
 * códigos. La aplicación se conecta a un servidor público de señalización (el
 * "punto encuentro" temporal entre dos ordenadores) para establecer la conexión
 * P2P. Ver signaling-server/.
 *
 * Modo local (sin internet): cuando el servidor es "127.0.0.1"/"localhost" se usa
 * BroadcastChannel entre pestañas del mismo navegador como canal de señalización,
 * para poder probar dos peers sin un servidor real.
 * ==========================================================================*/

const P2P = (() => {
  // STUN público: ayuda a superar NATs (proporciona la candidata pública). NO es
  // un servidor de datos; los datos siguen fluyendo directo entre peers.
  const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  let localId = '';
  let peers = new Map(); // id -> RTCConnection
  const openChannels = new Set(); // DataChannel listos para enviar

  /* ---- Utilidades de codificación de códigos manuales (legacy) ---- */
  function toCode(obj) {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromCode(code) {
    code = code.trim().replace(/-/g, '+').replace(/_/g, '/');
    const pad = code.length % 4;
    if (pad) code += '='.repeat(4 - pad);
    return JSON.parse(atob(code));
  }

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  async function initLocalId() {
    if (!localId) localId = randomId();
    return localId;
  }

  /* ===================== Señalización por servidor público ================= */
  function isLocalServer(url) {
    try {
      const u = new URL(url);
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.protocol === 'file:';
    } catch { return false; }
  }

  function serverBase(url) {
    try { return new URL('/api/session', url).href.replace(/\/$/, ''); }
    catch { return '/api/session'; }
  }

  async function apiPost(baseUrl, code, payload) {
    const base = serverBase(baseUrl);
    const res = await fetch(base + (code ? '/' + code : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) throw new Error('error del servidor (' + res.status + ')');
    return res.json();
  }

  async function apiGet(baseUrl, code) {
    const base = serverBase(baseUrl);
    const res = await fetch(base + '/' + code, { method: 'GET' });
    if (!res.ok) throw new Error('error del servidor (' + res.status + ')');
    return res.json();
  }

  // Polling periódico contra el servidor hasta que haya algo o cancelemos.
  async function pollFor(baseUrl, code, predicate, timeout = 45000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const data = await apiGet(baseUrl, code);
        if (predicate(data)) return data;
      } catch (e) { /* el servidor puede responder 404 mientras espera */ }
      if (Date.now() > deadline) throw new Error('esperando respuesta del peer...');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  function randomCode(n) {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    const b = crypto.getRandomValues(new Uint8Array(n));
    for (const x of b) s += c[x % c.length];
    return s;
  }

  // Canal de señalización local entre pestañas (BroadcastChannel). Sin internet.
  function startLocalSignaling(room) {
    const bc = new BroadcastChannel('rummage-signal-' + room);
    const handlers = {};
    bc.onmessage = (e) => {
      if (e.data && e.data.type && handlers[e.data.type]) handlers[e.data.type](e.data.payload);
    };
    function send(type, payload) { bc.postMessage({ type, payload }); }
    return {
      setHandlers(h) { Object.assign(handlers, h); },
      invite(code2) { send('invite', code2); },
      sendOffer(o) { send('offer', o); },
      sendAnswer(a) { send('answer', a); },
      close() { bc.close(); },
    };
  }

  /* ===================== Conexía automática por presencia ================= */
  // Cada peer se registra como "disponible" en el servidor (presencia). La
  // aplicación detecta sola a los demás peers y establece la conexión P2P por
  // sí sola, sin salas ni códigos. El servidor reutiliza el sessionId de
  // presencia como código de sesión WebRTC para el handshake offer/answer.
  let autoConn = null; // { serverUrl, peerId, mySessionId, connected:Set, stop:bool }

  async function apiPostPeer(baseUrl) {
    const res = await fetch(new URL('/api/peer', baseUrl).href, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!res.ok) throw new Error('error del servidor (' + res.status + ')');
    return res.json();
  }

  async function apiGetPeers(baseUrl, exclude) {
    const u = new URL('/api/peers', baseUrl);
    if (exclude) u.searchParams.set('exclude', exclude);
    const res = await fetch(u.href, { method: 'GET' });
    if (!res.ok) throw new Error('error del servidor (' + res.status + ')');
    return res.json();
  }

  async function apiDeletePeer(baseUrl, peerId) {
    const res = await fetch(new URL('/api/peer/' + peerId, baseUrl).href, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error('error del servidor (' + res.status + ')');
  }

  // Establece una conexión P2P con un peer remoto dado un código de sesión.
  // El peer con menor peerId actúa como anfitrión (publica la oferta); el otro
  // responde con la respuesta. Ambos usan el mismo código de sesión.
  async function establishConnection(serverUrl, code, isInviter) {
    if (isInviter) {
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      await configure(pc); // crea DataChannel de envío
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      await apiPost(serverUrl, code, { offer: pc.localDescription });
      const answer = await pollFor(serverUrl, code, d => d.answer, 45000);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      registerPeer(code, pc);
    } else {
      const offer = await pollFor(serverUrl, code, d => d.offer, 45000);
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      await configure(pc, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc);
      await apiPost(serverUrl, code, { answer: pc.localDescription });
      registerPeer(code, pc);
    }
  }

  // Registra presencia y conecta automáticamente con los peers detectados.
  async function autoConnect(serverUrl) {
    if (autoConn && !autoConn.stop) return autoConn;
    const reg = await apiPostPeer(serverUrl);
    autoConn = { serverUrl, peerId: reg.peerId, mySessionId: reg.sessionId, connected: new Set(), stop: false };

    async function pollPeers() {
      if (autoConn.stop) return;
      try {
        const list = await apiGetPeers(serverUrl, autoConn.peerId);
        for (const p of list) {
          if (autoConn.connected.has(p.peerId)) continue;
          // Determinístico: el peer con menor ID es el anfitrión de la sesión.
          const isInviter = autoConn.peerId < p.peerId;
          const code = isInviter ? autoConn.mySessionId : p.sessionId;
          try {
            await establishConnection(serverUrl, code, isInviter);
            autoConn.connected.add(p.peerId);
          } catch (e) { console.warn('[P2P] Auto-connect con ' + p.peerId + ' falló:', e.message); }
        }
      } catch (e) { /* error transitorio de red */ }
      if (!autoConn.stop) setTimeout(pollPeers, 2000);
    }
    pollPeers();
    return autoConn;
  }

  // Detiene el descubrimiento automático y da de baja la presencia.
  function stopAutoConnect() {
    if (autoConn) {
      autoConn.stop = true;
      const prev = autoConn;
      autoConn = null;
      apiDeletePeer(prev.serverUrl, prev.peerId).catch(() => {});
    }
  }

  // Estado del descubrimiento automático (para UI).
  function autoConnectState() {
    if (!autoConn || autoConn.stop) return { active: false, count: 0 };
    return { active: true, count: autoConn.connected.size };
  }

  /* ---- INVITADO: crea sala + oferta, espera la respuesta del anfitrión ---- */
  async function invite(serverUrl) {
    await initLocalId();

    if (isLocalServer(serverUrl)) {
      const room = randomCode(6);
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      await configure(pc); // crea DataChannel de envío
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);

      let settled = false;
      let peerPc = null;
      const bc = startLocalSignaling(room);

      // El anfitrión responderá cuando reciba la oferta. Escuchamos su respuesta.
      const answerPromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => !settled && reject(new Error('esperando respuesta del peer...')), 45000);
        bc.setHandlers({ answer: (a) => { if (!settled) { settled = true; clearTimeout(t); resolve(a); } } });
      });

      // Retransmitimos la oferta periódicamente hasta obtener respuesta.
      let sending = true;
      const broadcastOffer = () => { try { bc.sendOffer(pc.localDescription); } catch (e) {} };
      const sendTimer = setInterval(broadcastOffer, 500);
      broadcastOffer();

      try {
        const answer = await answerPromise;
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } finally {
        sending = false;
        clearInterval(sendTimer);
        bc.close();
      }
      registerPeer('server', pc);
      return { code: room, pc };
    }

    // ---- Servidor real (polling HTTP) ----
    const sess = await apiPost(serverUrl, null, {});
    const code = sess.code;
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    await configure(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    await apiPost(serverUrl, code, { offer: pc.localDescription });
    const answer = await pollFor(serverUrl, code, d => d.answer, 45000);
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    registerPeer('server', pc);
    return { code, pc };
  }

  /* ---- ANFITIÓN: se une a una sala con un código y responde la oferta ---- */
  async function join(serverUrl, code) {
    await initLocalId();

    if (isLocalServer(serverUrl)) {
      const room = String(code).toUpperCase();
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      await configure(pc, false); // sin DataChannel local; se crea al recibir la del invitado

      let settled = false;
      const bc = startLocalSignaling(room);

      // Escuchamos la oferta y generamos la respuesta.
      const offerPromise = new Promise((resolveOffer) => {
        const t = setTimeout(() => !settled && resolveOffer(null), 45000);
        bc.setHandlers({ offer: async (o) => {
          if (!settled) { await pc.setRemoteDescription(new RTCSessionDescription(o)); settled = true; clearTimeout(t); }
        } });
      });

      const answerPromise = new Promise((resolveAnswer, rejectAnswer) => {
        const t = setTimeout(() => !settled && rejectAnswer(new Error('esperando oferta del peer...')), 45000);
        let answerSent = false;
        offerPromise.then(async (o) => {
          if (!o || answerSent) return;
          try {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await waitForIce(pc);
            bc.sendAnswer(pc.localDescription);
            answerSent = true;
          } catch (e) { rejectAnswer(e); }
        });
      });

      // Esperamos a que la conexión se establezca (canal abierto por el invitado).
      const connectedPromise = new Promise((resolve) => {
        const check = setInterval(() => {
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') { clearInterval(check); resolve(); }
        }, 200);
        setTimeout(() => { clearInterval(check); resolve(); }, 45000);
      });

      await answerPromise;
      await connectedPromise;
      bc.close();
      registerPeer('server', pc);
      return pc;
    }

    // ---- Servidor real: esperamos la oferta, respondemos ----
    const offer = await pollFor(serverUrl, code, d => d.offer, 45000);
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    await configure(pc, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);
    await apiPost(serverUrl, code, { answer: pc.localDescription });
    registerPeer('server', pc);
    return pc;
  }

  /* ---- Señalización manual sin servidor (LEGACY) ---- */
  async function makeOffer() {
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    await configure(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);
    return toCode({ type: 'offer', sdp: pc.localDescription.sdp, from: localId });
  }

  async function handleOffer(offerCode) {
    const payload = fromCode(offerCode);
    if (payload.type !== 'offer') throw new Error('Código de oferta no válido.');
    await initLocalId();
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    await configure(pc, false);
    await pc.setRemoteDescription(new RTCSessionDescription(payload));
    const dc = await pc.createAnswer();
    await pc.setLocalDescription(dc);
    await waitForIce(pc);
    registerPeer(payload.from, pc);
    return toCode({ type: 'answer', sdp: pc.localDescription.sdp, from: localId });
  }

  async function handleAnswer(answerCode) {
    const payload = fromCode(answerCode);
    if (payload.type !== 'answer') throw new Error('Código de respuesta no válido.');
    await initLocalId();
    let pc = peers.get(payload.from);
    if (!pc) {
      pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      await configure(pc, false);
      registerPeer(payload.from, pc);
    }
    await pc.setRemoteDescription(new RTCSessionDescription(payload));
  }

  /* ---- Configurar DataChannel y eventos de una conexión ---- */
  async function configure(pc, createSendChannel = true) {
    const sendChannel = createSendChannel ? pc.createDataChannel('rummage') : null;
    pc.ondatachannel = (event) => {
      if (event.channel && event.channel.label === 'rummage' && !event.channel._bound) {
        event.channel._bound = true;
        bindChannel(event.channel);
      }
    };
    if (sendChannel) bindChannel(sendChannel);

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') console.log('[P2P] Conexión establecida con peer');
      else if (st === 'failed') console.warn('[P2P] Falló la conexión ICE');
    };
    return pc;
  }

  function bindChannel(dc) {
    dc.onopen = () => {
      console.log('[P2P] DataChannel abierto');
      openChannels.add(dc);
      const msg = JSON.stringify({ type: 'sync', data: Store.snapshot() });
      if (dc.readyState === 'open') dc.send(msg);
    };
    dc.onclose = () => { openChannels.delete(dc); renderPeers(); };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync' && typeof msg.data === 'object') {
          Store.merge(msg.data);
          const reply = JSON.stringify({ type: 'sync', data: Store.snapshot() });
          if (dc.readyState === 'open') dc.send(reply);
        }
      } catch (e) { console.warn('[P2P] Mensaje P2P no parseado:', e); }
    };
  }

  function sendAll(message) {
    const payload = JSON.stringify(message);
    for (const dc of openChannels) {
      if (dc.readyState === 'open') dc.send(payload);
    }
  }

  async function waitForIce(pc) {
    if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'connected') return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      pc.oniceconnectionstatechange = () => {
        if (['connected', 'completed', 'checking', 'disconnected'].includes(pc.iceConnectionState)) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  function registerPeer(id, pc) {
    peers.set(id, pc);
    renderPeers();
  }

  function listPeers() {
    return Array.from(peers.entries()).map(([id, pc]) => ({
      id,
      label: 'Peer ' + id.slice(0, 6),
      state: pc.iceConnectionState,
    }));
  }

  function renderPeers() {
    const el = document.getElementById('peersList');
    if (!el) return;
    const list = listPeers();
    if (!list.length) {
      el.innerHTML = '<li>Sin peer conectados todavía.</li>';
      return;
    }
    el.innerHTML = list.map(p => `<li>✅ ${p.label} <span style="color:var(--muted)">(${p.state})</span></li>`).join('');
  }

  /* ---- Exponer API ---- */
  return {
    initLocalId,
    makeOffer,
    handleOffer,
    handleAnswer,
    invite,
    join,
    autoConnect,
    stopAutoConnect,
    autoConnectState,
    listPeers,
    renderPeers,
    sendAll,
    get localId() { return localId; },
  };
})();
