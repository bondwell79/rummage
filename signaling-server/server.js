/* ============================================================================
 * rummage — Servidor de señalización P2P (polling HTTP)
 * ==========================================================================
 * Este es el "servidor público" que sustituye al intercambio manual de códigos.
 * No transporta datos: solo hace de punto encuentro temporal para el handshake
 * WebRTC (oferta/respuesta y candidatos ICE). Los datos siguen fluyendo directo
 * entre peers vía WebRTC DataChannel.
 *
 * API (polling HTTP, funciona tras cualquier servidor con un backend mínimo):
 *   POST /api/session           -> { code, sessionId }   (crear sesión = invitar)
 *   GET  /api/session/:code     -> { offer | answer }    (consultar estado)
 *   POST /api/session/:code     -> { offer | answer }    (responder a una sesión)
 *   DELETE /api/session/:code                  (cerrar/eliminar sesión)
 *
 * Persistencia: IndexedDB en el navegador del servidor (guardia sin estado).
 * Cada sesión caduca tras 15 min de inactividad.
 *
 * Despliegue: `node server.js`  -> http://0.0.0.0:8787
 * ==========================================================================*/

const PORT = process.env.PORT || 8787;
const HOST = '0.0.0.0';
const TTL_MS = 15 * 60 * 1000; // 15 minutos

/* ---- Almacén de sesiones (en memoria + persistencia opcional) ---- */
const sessions = new Map(); // code -> { offer, answer, lastSeen }

function cleanExpired() {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (now - s.lastSeen > TTL_MS) sessions.delete(code);
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
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
  };

  // POST /api/session -> crear sesión
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const code = shortCode();
    sessions.set(code, { offer: null, answer: null, lastSeen: Date.now() });
    return send(201, { code, sessionId: code });
  }

  // Ruta /api/session/:code
  const m = url.pathname.match(/^\/api\/session\/([A-Z0-9]+)$/i);
  if (m) {
    const code = m[1].toUpperCase();
    const s = sessions.get(code);

    if (req.method === 'GET') {
      if (!s) return send(404, { error: 'sesión no encontrada' });
      s.lastSeen = Date.now();
      return send(200, { code, offer: s.offer, answer: s.answer });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!s) return send(404, { error: 'sesión no encontrada' });
      if (body.offer !== undefined) s.offer = body.offer;
      if (body.answer !== undefined) s.answer = body.answer;
      s.lastSeen = Date.now();
      return send(200, { code, offer: s.offer, answer: s.answer });
    }

    if (req.method === 'DELETE') {
      sessions.delete(code);
      return send(200, { ok: true });
    }
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(200, { status: 'ok', peers: sessions.size });
  }

  return send(404, { error: 'ruta no encontrada' });
});

server.listen(PORT, HOST, () => {
  console.log(`[rummage-signal] Escuchando en http://${HOST}:${PORT}`);
  console.log(`[rummage-signal] API: POST/GET/DELETE /api/session/:code`);
});
