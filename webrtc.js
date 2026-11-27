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
  const channelPeerIds = new Map(); // DataChannel -> ID de usuario remoto
  const channelsByPeerId = new Map(); // ID de usuario remoto -> DataChannel
  const transferTotals = { sent: 0, received: 0 };

  function payloadByteLength(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
    return data?.byteLength || data?.size || 0;
  }

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
    if (!localId) {
      localId = localStorage.getItem('rummage-peer-id');
      if (!localId) {
        localId = randomId();
        localStorage.setItem('rummage-peer-id', localId);
      }
    }
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

  // ICE candidates
  async function apiPostCandidate(baseUrl, code, candidate, from) {
    const base = serverBase(baseUrl).replace(/\/api\/session$/, '');
    const res = await fetch(base + '/api/session/' + code + '/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate, from }),
    });
    if (!res.ok) throw new Error('error del servidor (' + res.status + ')');
    return res.json();
  }

  async function apiGetCandidates(baseUrl, code, from) {
    const base = serverBase(baseUrl).replace(/\/api\/session$/, '');
    const url = new URL(base + '/api/session/' + code + '/candidates');
    url.searchParams.set('from', from);
    const res = await fetch(url.href, { method: 'GET' });
    if (!res.ok) throw new Error('error del servidor (' + res.status + ')');
    return res.json();
  }

  function configureIceSignaling(pc, serverUrl, code, localRole) {
    const remoteRole = localRole === 'offerer' ? 'answerer' : 'offerer';
    const seenCandidates = new Set();
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        apiPostCandidate(serverUrl, code, event.candidate.toJSON(), localRole).catch((error) => {
          console.warn('[P2P] No se pudo publicar candidato ICE:', error.message);
        });
      }
    };

    return async function pollRemoteCandidates() {
      try {
        const data = await apiGetCandidates(serverUrl, code, remoteRole);
        for (const candidate of data.candidates || []) {
          const key = [candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex].join('|');
          if (seenCandidates.has(key)) continue;
          seenCandidates.add(key);
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (error) {
            console.warn('[P2P] No se pudo añadir candidato ICE:', error.message);
          }
        }
      } catch (error) {
        console.warn('[P2P] Error consultando candidatos ICE:', error.message);
      }

      if (!['connected', 'completed', 'failed', 'closed'].includes(pc.iceConnectionState)) {
        setTimeout(pollRemoteCandidates, 500);
      }
    };
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
  async function establishConnection(serverUrl, code, isInviter, presencePeerId = '', connection = null) {
    console.log('[P2P] establishConnection', { code, isInviter });
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    pc._presencePeerId = presencePeerId;
    pc._autoConnection = connection;
    const localRole = isInviter ? 'offerer' : 'answerer';
    const pollRemoteCandidates = configureIceSignaling(pc, serverUrl, code, localRole);

    if (isInviter) {
      console.log('[P2P] Inviter: creando offer');
      await configure(pc); // crea DataChannel de envío
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('[P2P] Inviter: offer creada');
      console.log('[P2P] Inviter: posteando offer');
      await apiPost(serverUrl, code, { offer: pc.localDescription });
      console.log('[P2P] Inviter: polling answer...');
      const response = await pollFor(serverUrl, code, d => d.answer && d.answer.type === 'answer', 45000);
      const answer = response.answer;
      console.log('[P2P] Inviter: recibida answer');
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      pollRemoteCandidates();
      registerPeer(code, pc);
    } else {
      console.log('[P2P] No-inviter: polling offer...');
      const response = await pollFor(serverUrl, code, d => d.offer && d.offer.type === 'offer', 45000);
      const offer = response.offer;
      console.log('[P2P] No-inviter: recibida offer');
      await configure(pc, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('[P2P] No-inviter: posteando answer');
      await apiPost(serverUrl, code, { answer: pc.localDescription });
      pollRemoteCandidates();
      registerPeer(code, pc);
    }
    pc._autoConnectReady = true;
  }

  // Registra presencia y conecta automáticamente con los peers detectados.
  async function autoConnect(serverUrl) {
    if (autoConn && !autoConn.stop) return autoConn;
    const reg = await apiPostPeer(serverUrl);
    autoConn = { serverUrl, peerId: reg.peerId, mySessionId: reg.sessionId, connected: new Set(), retryAt: new Map(), foundCount: 0, stop: false };

    async function pollPeers(connection) {
      if (connection.stop || autoConn !== connection) return;
      try {
        const list = await apiGetPeers(serverUrl, connection.peerId);
        connection.foundCount = list.length;
        console.log('[P2P] pollPeers: myPeerId=', connection.peerId, 'mySessionId=', connection.mySessionId, 'peers=', list);
        for (const p of list) {
          if (connection.connected.has(p.peerId) || (connection.retryAt.get(p.peerId) || 0) > Date.now()) continue;
          connection.retryAt.delete(p.peerId);
          connection.connected.add(p.peerId);
          // Determinístico: el peer con menor ID es el anfitrión de la sesión.
          const isInviter = connection.peerId < p.peerId;
          const code = isInviter ? connection.mySessionId : p.sessionId;
          console.log('[P2P] Intentando conectar con', p.peerId, 'isInviter=', isInviter, 'code=', code);
          establishConnection(serverUrl, code, isInviter, p.peerId, connection).catch((e) => {
            connection.connected.delete(p.peerId);
            connection.retryAt.set(p.peerId, Date.now() + 5000);
            console.warn('[P2P] Auto-connect con ' + p.peerId + ' falló:', e.message);
          });
        }
      } catch (e) { /* error transitorio de red */ }
      if (!connection.stop && autoConn === connection) setTimeout(() => pollPeers(connection), 2000);
    }
    pollPeers(autoConn);
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
    return { active: true, count: autoConn.foundCount };
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

      let settled = false;
      let peerPc = null;
      const bc = startLocalSignaling(room);

      // ICE candidates via BroadcastChannel
      pc.onicecandidate = (e) => { if (e.candidate) bc.postMessage({ type: 'candidate', payload: e.candidate.toJSON() }); };

      // El anfitrión responderá cuando reciba la oferta. Escuchamos su respuesta.
      const answerPromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => !settled && reject(new Error('esperando respuesta del peer...')), 45000);
        bc.setHandlers({
          answer: (a) => { if (!settled) { settled = true; clearTimeout(t); resolve(a); } },
          candidate: (c) => { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
        });
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
    const pollRemoteCandidates = configureIceSignaling(pc, serverUrl, code, 'offerer');

    await configure(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await apiPost(serverUrl, code, { offer: pc.localDescription });
    const response = await pollFor(serverUrl, code, d => d.answer && d.answer.type === 'answer', 45000);
    const answer = response.answer;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    pollRemoteCandidates();
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

      // ICE candidates via BroadcastChannel
      pc.onicecandidate = (e) => { if (e.candidate) bc.postMessage({ type: 'candidate', payload: e.candidate.toJSON() }); };

      // Escuchamos la oferta y generamos la respuesta.
      const offerPromise = new Promise((resolveOffer) => {
        const t = setTimeout(() => !settled && resolveOffer(null), 45000);
        bc.setHandlers({
          offer: async (o) => {
            if (!settled) { await pc.setRemoteDescription(new RTCSessionDescription(o)); settled = true; clearTimeout(t); }
          },
          candidate: (c) => { try { pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
        });
      });

      const answerPromise = new Promise((resolveAnswer, rejectAnswer) => {
        const t = setTimeout(() => !settled && rejectAnswer(new Error('esperando oferta del peer...')), 45000);
        let answerSent = false;
        offerPromise.then(async (o) => {
          if (!o || answerSent) return;
          try {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
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
    const response = await pollFor(serverUrl, code, d => d.offer && d.offer.type === 'offer', 45000);
    const offer = response.offer;
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    const pollRemoteCandidates = configureIceSignaling(pc, serverUrl, code, 'answerer');

    await configure(pc, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await apiPost(serverUrl, code, { answer: pc.localDescription });
    pollRemoteCandidates();
    registerPeer('server', pc);
    return pc;
  }

  /* ---- Señalización manual sin servidor (LEGACY) ---- */
  async function makeOffer() {
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    await configure(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
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
        bindChannel(event.channel, pc);
      }
    };
    if (sendChannel) bindChannel(sendChannel, pc);

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') console.log('[P2P] Conexión establecida con peer');
      else if (st === 'failed' || st === 'closed') {
        console.warn('[P2P] Falló la conexión ICE');
        releaseAutoPeer(pc);
      }
    };
    return pc;
  }

  function releaseAutoPeer(pc) {
    const connection = pc._autoConnection;
    const peerId = pc._presencePeerId;
    if (!connection || !peerId || !pc._autoConnectReady) return;
    connection.connected.delete(peerId);
    connection.retryAt.set(peerId, Date.now() + 5000);
  }

  function bindChannel(dc, pc) {
    const incomingTransfers = new Map();
    dc.bufferedAmountLowThreshold = 256 * 1024;

    dc.onopen = async () => {
      console.log('[P2P] DataChannel abierto');
      openChannels.add(dc);
      try {
        await sendChannelMessage(dc, { type: 'hello', peerId: localId });
      } catch (error) {
        console.warn('[P2P] No se pudo identificar el peer remoto:', error.message);
      }
    };
    dc.onclose = () => {
      openChannels.delete(dc);
      releaseAutoPeer(pc);
      const peerId = channelPeerIds.get(dc);
      channelPeerIds.delete(dc);
      if (peerId && channelsByPeerId.get(peerId) === dc) channelsByPeerId.delete(peerId);
      for (const transfer of incomingTransfers.values()) clearTimeout(transfer.timer);
      incomingTransfers.clear();
      renderPeers();
    };
    dc.onmessage = async (event) => {
      transferTotals.received += payloadByteLength(event.data);
      try {
        let msg = JSON.parse(event.data);
        if (msg.type === 'hello' && typeof msg.peerId === 'string' && msg.peerId && msg.peerId !== localId) {
          channelPeerIds.set(dc, msg.peerId);
          channelsByPeerId.set(msg.peerId, dc);
          const data = await Store.snapshot(msg.peerId);
          await sendChannelMessage(dc, { type: 'sync', data });
          return;
        }
        if (msg.type === 'deal-message' && msg.message) {
          await Store.merge({ messages: [msg.message] }, channelPeerIds.get(dc));
          return;
        }
        if (msg.type === 'sync-chunk') {
          if (!Number.isInteger(msg.index) || !Number.isInteger(msg.total) ||
              msg.index < 0 || msg.index >= msg.total || msg.total > 8192 ||
              typeof msg.transferId !== 'string' || typeof msg.data !== 'string') return;

          let transfer = incomingTransfers.get(msg.transferId);
          if (!transfer) {
            transfer = { parts: new Array(msg.total), received: 0, length: 0, timer: null };
            transfer.timer = setTimeout(() => incomingTransfers.delete(msg.transferId), 120000);
            incomingTransfers.set(msg.transferId, transfer);
          }
          if (transfer.parts.length !== msg.total || transfer.parts[msg.index] !== undefined) return;
          transfer.parts[msg.index] = msg.data;
          transfer.received++;
          transfer.length += msg.data.length;
          if (transfer.length > 64 * 1024 * 1024) {
            clearTimeout(transfer.timer);
            incomingTransfers.delete(msg.transferId);
            throw new Error('snapshot superior al límite de 64 MB');
          }
          if (transfer.received !== transfer.parts.length) return;

          clearTimeout(transfer.timer);
          incomingTransfers.delete(msg.transferId);
          msg = JSON.parse(transfer.parts.join(''));
        }
        if (msg.type === 'sync' && msg.data && typeof msg.data === 'object') {
          const peerId = channelPeerIds.get(dc);
          const changed = await Store.merge(msg.data, peerId);
          if (changed && dc.readyState === 'open') {
            const data = await Store.snapshot(peerId);
            await sendChannelMessage(dc, { type: 'sync', data });
          }
        }
      } catch (e) { console.warn('[P2P] Mensaje P2P no parseado:', e); }
    };
  }

  async function sendChannelMessage(dc, message) {
    const payload = JSON.stringify(message);
    const chunkSize = 8 * 1024;
    const maxPayloadSize = 64 * 1024 * 1024;
    if (payload.length > maxPayloadSize) throw new Error('snapshot superior al límite de 64 MB');

    async function sendRaw(data) {
      while (dc.readyState === 'open' && dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
        await new Promise((resolve) => {
          const check = () => {
            dc.removeEventListener('bufferedamountlow', check);
            dc.removeEventListener('close', check);
            resolve();
          };
          dc.addEventListener('bufferedamountlow', check, { once: true });
          dc.addEventListener('close', check, { once: true });
          if (dc.readyState !== 'open' || dc.bufferedAmount <= dc.bufferedAmountLowThreshold) check();
        });
      }
      if (dc.readyState === 'open') {
        dc.send(data);
        transferTotals.sent += payloadByteLength(data);
      }
    }

    if (payload.length <= chunkSize) return sendRaw(payload);
    const transferId = randomId();
    const total = Math.ceil(payload.length / chunkSize);
    for (let index = 0; index < total && dc.readyState === 'open'; index++) {
      await sendRaw(JSON.stringify({
        type: 'sync-chunk',
        transferId,
        index,
        total,
        data: payload.slice(index * chunkSize, (index + 1) * chunkSize),
      }));
    }
  }

  async function sendAll(message) {
    await Promise.all(Array.from(openChannels, (dc) => sendChannelMessage(dc, message)));
  }

  async function sendToPeer(peerId, message) {
    const dc = channelsByPeerId.get(peerId);
    if (!dc || dc.readyState !== 'open') return false;
    await sendChannelMessage(dc, message);
    return true;
  }

  function connectedPeerIds() {
    return Array.from(channelsByPeerId.keys());
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

  function connectionStatus() {
    return { openChannels: openChannels.size };
  }

  function getTransferTotals() {
    return { ...transferTotals };
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
    connectionStatus,
    transferTotals: getTransferTotals,
    listPeers,
    renderPeers,
    sendAll,
    sendToPeer,
    connectedPeerIds,
    get localId() { return localId; },
  };
})();
