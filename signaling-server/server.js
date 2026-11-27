/* ============================================================================
 * rummage — Servidor de señalización P2P (polling HTTP)
 * ==========================================================================
 * Este es el "servidor público" que sustituye al intercambio manual de códigos.
 * No transporta datos: solo hace de encuentro temporal para el handshake WebRTC
 * (oferta/respuesta y candidatos ICE). Los datos siguen fluyendo directo entre
 * peers vía WebRTC DataChannel.
 *
 * Además, soporta la CONEXIÓN AUTOMÁTICA por presencia: los peers se registran
 * como disponibles y la aplicación detecta sola a los demás para conectarse sin
 * crear salas ni pegar códigos.
 *
 * API (polling HTTP, funciona tras cualquier servidor con un backend mínimo):
 *   Presencia / descubrimiento automático:
 *     POST /api/peer                  -> { peerId, sessionId }  (registrarse)
 *     GET  /api/peers                 -> [ { peerId, sessionId } ] (peers disponibles)
 *     DELETE /api/peer/:peerId        -> { ok: true }           (dar de baja)
 *   Handshake offer/answer (polling HTTP):
 *     POST /api/session               -> { code, sessionId }    (crear sesión = invitar)
 *     GET  /api/session/:code         -> { offer | answer }     (consultar estado)
 *     POST /api/session/:code         -> { offer | answer }     (responder a una sesión)
 *     DELETE /api/session/:code       -> { ok: true }           (cerrar/eliminar sesión)
 *
 * Persistencia: en memoria. Cada sesión y cada presencia caduca tras 15 min de
 * inactividad. El servidor es sin estado.
 *
 * Despliegue: `node server.js`  -> http://0.0.0.0:8787
 * ==========================================================================*/

const PORT = process.env.PORT || 8787;
const HOST = '0.0.0.0';
const TTL_MS = 15 * 60 * 1000; // 15 minutos

/* ---- Almacén de sesiones (en memoria) ---- */
const sessions = new Map(); // code -> { offer, answer, candidates: [], lastSeen }

/* ---- Almacén de presencia (peers disponibles para conexión automática) ---- */
const peersPresence = new Map(); // peerId -> { sessionId, lastSeen }

function cleanExpired() {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (now - s.lastSeen > TTL_MS) sessions.delete(code);
  }
  for (const [id, p] of peersPresence) {
    if (now - p.lastSeen > TTL_MS) peersPresence.delete(id);
  }
}
setInterval(cleanExpired, 60 * 1000);

function shortCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.getRandomValues(new Uint8Array(5));
  for (const x of b) s += c[x % c.length];
  return s;
}

function shortPeerId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.getRandomValues(new Uint8Array(6));
  for (const x of b) s += c[x % c.length];
  return s;
}

/* ---- Servidor mínimo con polling HTTP ---- */
const http = require('http');
const { URL } = require('url');

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') console.error('[signal] readBody error:', err);
      resolve({});
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Silenciar errores de conexión abrupta del cliente (ECONNRESET, EPIPE)
  req.on('error', (err) => {
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') console.error('[signal] req error:', err);
  });
  res.on('error', (err) => {
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') console.error('[signal] res error:', err);
  });

  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS: la aplicación se sirve desde un origen distinto (p. ej.
  // http://127.0.0.1:8000/index.html) y el servidor de señalización está en
  // localhost:8787. Sin estas cabeceras, los navegadores reales bloquean
  // todas las peticiones fetch (origin != port). Esto es lo que impide
  // "conectar" entre dos ordenadores/peers distintos.
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, corsHeaders));
    res.end(body, (err) => {
      if (err && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') console.error('[signal] send error:', err);
    });
  };

  // Respuesta a peticiones preflight CORS.
  if (req.method === 'OPTIONS') {
    return send(204, {});
  }

  // ---- PRESENCIA / descubrimiento automático ----
  // POST /api/peer -> registrarse como peer disponible (asigna un sessionId)
  if (req.method === 'POST' && url.pathname === '/api/peer') {
    try { await readBody(req); } catch {}
    const peerId = shortPeerId();
    const sessionId = shortCode();
    peersPresence.set(peerId, { sessionId, lastSeen: Date.now() });
    sessions.set(sessionId, { offer: null, answer: null, candidates: [], lastSeen: Date.now() });
    return send(201, { peerId, sessionId });
  }

  // GET /api/peers -> lista de peers disponibles (excluye a quien consulta)
  if (req.method === 'GET' && url.pathname === '/api/peers') {
    const requested = url.searchParams.get('exclude'); // peerId del que consulta
    const list = Array.from(peersPresence.entries())
      .filter(([id]) => id !== requested)
      .map(([id, p]) => ({ peerId: id, sessionId: p.sessionId }));
    return send(200, list);
  }

  // DELETE /api/peer/:peerId -> dar de baja la presencia
  {
    const m = url.pathname.match(/^\/api\/peer\/([A-Z0-9]+)$/i);
    if (m) {
      const peerId = m[1].toUpperCase();
      if (req.method === 'DELETE') {
        const existed = peersPresence.delete(peerId);
        return send(existed ? 200 : 404, { ok: existed });
      }
    }
  }

  // ---- HANDSHAKE offer/answer (polling HTTP) ----
  // POST /api/session -> crear sesión
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const code = shortCode();
    sessions.set(code, { offer: null, answer: null, candidates: [], lastSeen: Date.now() });
    return send(201, { code, sessionId: code });
  }

  // GET /api/session/:code/candidates
  const mCand = url.pathname.match(/^\/api\/session\/([A-Z0-9]+)\/candidates$/i);
  if (mCand) {
    const code = mCand[1].toUpperCase();
    const s = sessions.get(code);
    if (!s) return send(404, { error: 'sesión no encontrada' });

    if (req.method === 'GET') {
      s.lastSeen = Date.now();
      const sender = url.searchParams.get('from');
      const candidates = (s.candidates || [])
        .filter((item) => item.from === sender)
        .map((item) => item.candidate);
      return send(200, { candidates });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!['offerer', 'answerer'].includes(body.from) || !body.candidate || typeof body.candidate !== 'object') {
        return send(400, { error: 'candidato ICE no válido' });
      }
      s.candidates = s.candidates || [];
      s.candidates.push({ from: body.from, candidate: body.candidate });
      s.lastSeen = Date.now();
      return send(200, { ok: true });
    }
  }

  // Ruta /api/session/:code
  const m = url.pathname.match(/^\/api\/session\/([A-Z0-9]+)$/i);
  if (m) {
    const code = m[1].toUpperCase();
    const s = sessions.get(code);

    if (req.method === 'GET') {
      if (!s) return send(404, { error: 'sesión no encontrada' });
      s.lastSeen = Date.now();
      return send(200, { code, offer: s.offer, answer: s.answer, candidates: s.candidates || [] });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!s) return send(404, { error: 'sesión no encontrada' });
      if (body.offer !== undefined) s.offer = body.offer;
      if (body.answer !== undefined) s.answer = body.answer;
      if (body.candidate) {
        s.candidates = s.candidates || [];
        s.candidates.push(body.candidate);
      }
      s.lastSeen = Date.now();
      return send(200, { code, offer: s.offer, answer: s.answer, candidates: s.candidates || [] });
    }

    if (req.method === 'DELETE') {
      sessions.delete(code);
      return send(200, { ok: true });
    }
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(200, { status: 'ok', peers: peersPresence.size });
  }

  return send(404, { error: 'ruta no encontrada' });
});

server.listen(PORT, HOST, () => {
  console.log(`[rummage-signal] Escuchando en http://${HOST}:${PORT}`);
  console.log(`[rummage-signal] API presencia: POST/DELETE /api/peer y GET /api/peers`);
  console.log(`[rummage-signal] API handshake: POST/GET/DELETE /api/session/:code`);
});
