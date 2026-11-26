/* ============================================================================
 * webrtc.js — Capa de comunicación peer-to-peer (WebRTC DataChannel)
 * Sin servidores centralizados. El "signaling" se realiza mediante códigos
 * manuales que los usuarios intercambian entre sí (tipo emparejamiento / torrent).
 * ==========================================================================*/

const P2P = (() => {
  // STUN público de Google: solo ayuda a superar NATs, NO es un servidor de datos.
  const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  let localId = '';
  let peers = new Map(); // id -> RTCConnection
  const openChannels = new Set(); // DataChannel listos para enviar

  /* ---- Utilidades de codificación de códigos ---- */
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

  /* ---- Crear el peer local ---- */
  async function initLocalId() {
    if (!localId) localId = randomId();
    return localId;
  }

  /* ---- Generar una oferta (offer) para invitar a otro peer ---- */
  async function makeOffer() {
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS }); // conexión "directa" sin servidor de datos
    await configure(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Esperamos a que se resuelva ICE (candidates) para poder exportar el SDP completo.
    await waitForIce(pc);

    const payload = { type: 'offer', sdp: pc.localDescription.sdp, from: localId };
    return toCode(payload);
  }

  /* ---- Recibir una oferta y crear la respuesta (answer) ---- */
  async function handleOffer(offerCode) {
    const payload = fromCode(offerCode);
    if (payload.type !== 'offer') throw new Error('Código de oferta no válido.');

    await initLocalId();

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    await configure(pc, false); // sin DataChannel local; se crea al importar la respuesta

    await pc.setRemoteDescription(new RTCSessionDescription(payload));
    const dc = await pc.createAnswer();
    await pc.setLocalDescription(dc);
    await waitForIce(pc);

    registerPeer(payload.from, pc);
    const answerPayload = { type: 'answer', sdp: pc.localDescription.sdp, from: localId };
    return toCode(answerPayload);
  }

  /* ---- Recibir la respuesta de otro peer y cerrar el handshake ---- */
  async function handleAnswer(answerCode) {
    const payload = fromCode(answerCode);
    if (payload.type !== 'answer') throw new Error('Código de respuesta no válido.');

    await initLocalId();

    let pc = peers.get(payload.from);
    if (!pc) {
      // Si no tenemos una conexión local pendiente, creamos un peer receptor pasivo.
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
      if (st === 'connected' || st === 'completed') {
        console.log('[P2P] Conexión establecida con peer');
      } else if (st === 'failed') {
        console.warn('[P2P] Falló la conexión ICE');
      }
    };

    return pc;
  }

  function bindChannel(dc) {
    dc.onopen = () => {
      console.log('[P2P] DataChannel abierto');
      openChannels.add(dc);
      // Difundir inmediatamente nuestros datos locales al nuevo peer.
      const msg = JSON.stringify({ type: 'sync', data: Store.snapshot() });
      if (dc.readyState === 'open') dc.send(msg);
    };
    dc.onclose = () => {
      openChannels.delete(dc);
      renderPeers();
    };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sync' && typeof msg.data === 'object') {
          Store.merge(msg.data);
          // Devolvemos también nuestros datos actualizados.
          const reply = JSON.stringify({ type: 'sync', data: Store.snapshot() });
          if (dc.readyState === 'open') dc.send(reply);
        }
      } catch (e) {
        console.warn('[P2P] Mensaje P2P no parseado:', e);
      }
    };
  }

  /* ---- Difundir un mensaje por todos los canales abiertos ---- */
  function sendAll(message) {
    const payload = JSON.stringify(message);
    for (const dc of openChannels) {
      if (dc.readyState === 'open') dc.send(payload);
    }
  }

  async function waitForIce(pc) {
    if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'connected') return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000); // timeout de seguridad
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

  /* ---- Estado de los peers conectados ---- */
  function listPeers() {
    return Array.from(peers.entries()).map(([id, pc]) => ({
      id,
      label: 'Peer ' + id.slice(0, 6),
      state: pc.iceConnectionState,
    }));
  }

  /* ---- Renderizado ligero de la lista de peers ---- */
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
    listPeers,
    renderPeers,
    sendAll,
    get localId() { return localId; },
  };
})();
