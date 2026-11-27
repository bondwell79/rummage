"""
rummage — Servidor de señalización P2P (polling HTTP)
==========================================================================
Este es el "servidor público" que sustituye al intercambio manual de códigos.
No transporta datos: solo hace de encuentro temporal para el handshake WebRTC
(oferta/respuesta y candidatos ICE). Los datos siguen fluyendo directo entre
peers vía WebRTC DataChannel.

Despliegue: `python3 server.py` -> http://0.0.0.0:8787
"""

import json
import os
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", 8787))
HOST = "0.0.0.0"
TTL_SEC = 15 * 60  # 15 minutos

# Almacenes en memoria y bloqueo para seguridad entre hilos
sessions = {}        # code -> {"offer": ..., "answer": ..., "candidates": [], "lastSeen": float}
peers_presence = {}  # peerId -> {"sessionId": str, "lastSeen": float}
lock = threading.Lock()


def clean_expired():
    """Elimina sesiones y peers inactivos cada 60 segundos."""
    while True:
        time.sleep(60)
        now = time.time()
        with lock:
            expired_sessions = [c for c, s in sessions.items() if now - s["lastSeen"] > TTL_SEC]
            for c in expired_sessions:
                del sessions[c]

            expired_peers = [pid for pid, p in peers_presence.items() if now - p["lastSeen"] > TTL_SEC]
            for pid in expired_peers:
                del peers_presence[pid]


def short_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(5))


def short_peer_id() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


class SignalingHandler(BaseHTTPRequestHandler):
    def _send(self, status_code: int, payload: dict | list):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def _read_json(self) -> dict:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            return {}
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def log_message(self, format, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            pass

    # ---- CORS Preflight ----
    def do_OPTIONS(self):
        self._send(204, {})

    # ---- GET ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # GET /api/peers
        if path == "/api/peers":
            excluded = query.get("exclude", [None])[0]
            with lock:
                peers_list = [
                    {"peerId": pid, "sessionId": p["sessionId"]}
                    for pid, p in peers_presence.items()
                    if pid != excluded
                ]
            return self._send(200, peers_list)

        # GET /api/session/:code
        m_session = re.match(r"^/api/session/([A-Z0-9]+)$", path, re.IGNORECASE)
        if m_session:
            code = m_session.group(1).upper()
            with lock:
                s = sessions.get(code)
                if not s:
                    print(f"[signal] GET session {code} -> 404 not found")
                    return self._send(404, {"error": "sesión no encontrada"})
                s["lastSeen"] = time.time()
                has_offer = s["offer"] is not None
                has_answer = s["answer"] is not None
                print(f"[signal] GET session {code} -> offer={has_offer} answer={has_answer}")
                return self._send(200, {"code": code, "offer": s["offer"], "answer": s["answer"], "candidates": s.get("candidates", [])})

        # GET /api/session/:code/candidates
        m_cand = re.match(r"^/api/session/([A-Z0-9]+)/candidates$", path, re.IGNORECASE)
        if m_cand and self.command == "GET":
            code = m_cand.group(1).upper()
            sender = query.get("from", [None])[0]
            with lock:
                s = sessions.get(code)
                if not s:
                    return self._send(404, {"error": "sesión no encontrada"})
                s["lastSeen"] = time.time()
                candidates = [item["candidate"] for item in s.get("candidates", []) if item.get("from") == sender]
                return self._send(200, {"candidates": candidates})

        # GET /health
        if path == "/health":
            with lock:
                count = len(peers_presence)
            return self._send(200, {"status": "ok", "peers": count})

        return self._send(404, {"error": "ruta no encontrada"})

    # ---- POST ----
    def do_POST(self):
        path = urlparse(self.path).path

        # POST /api/peer
        if path == "/api/peer":
            self._read_json()  # Consumir cuerpo si existe
            peer_id = short_peer_id()
            session_id = short_code()
            with lock:
                peers_presence[peer_id] = {"sessionId": session_id, "lastSeen": time.time()}
                sessions[session_id] = {"offer": None, "answer": None, "candidates": [], "lastSeen": time.time()}
            return self._send(201, {"peerId": peer_id, "sessionId": session_id})

        # POST /api/session
        if path == "/api/session":
            code = short_code()
            with lock:
                sessions[code] = {"offer": None, "answer": None, "candidates": [], "lastSeen": time.time()}
            return self._send(201, {"code": code, "sessionId": code})

        # POST /api/session/:code
        m_session = re.match(r"^/api/session/([A-Z0-9]+)$", path, re.IGNORECASE)
        if m_session:
            code = m_session.group(1).upper()
            body = self._read_json()
            with lock:
                s = sessions.get(code)
                if not s:
                    return self._send(404, {"error": "sesión no encontrada"})
                if "offer" in body:
                    s["offer"] = body["offer"]
                    print(f"[signal] POST offer -> session {code}")
                if "answer" in body:
                    s["answer"] = body["answer"]
                    print(f"[signal] POST answer -> session {code}")
                if "candidate" in body:
                    s.setdefault("candidates", []).append(body["candidate"])
                s["lastSeen"] = time.time()
                return self._send(200, {"code": code, "offer": s["offer"], "answer": s["answer"], "candidates": s.get("candidates", [])})

        # POST /api/session/:code/candidates
        m_cand = re.match(r"^/api/session/([A-Z0-9]+)/candidates$", path, re.IGNORECASE)
        if m_cand:
            code = m_cand.group(1).upper()
            body = self._read_json()
            sender = body.get("from")
            if sender not in ("offerer", "answerer") or not isinstance(body.get("candidate"), dict):
                return self._send(400, {"error": "candidato ICE no válido"})
            with lock:
                s = sessions.get(code)
                if not s:
                    return self._send(404, {"error": "sesión no encontrada"})
                s.setdefault("candidates", []).append({"from": sender, "candidate": body["candidate"]})
                s["lastSeen"] = time.time()
                return self._send(200, {"ok": True})

        return self._send(404, {"error": "ruta no encontrada"})

    # ---- DELETE ----
    def do_DELETE(self):
        path = urlparse(self.path).path

        # DELETE /api/peer/:peerId
        m_peer = re.match(r"^/api/peer/([A-Z0-9]+)$", path, re.IGNORECASE)
        if m_peer:
            peer_id = m_peer.group(1).upper()
            with lock:
                existed = peers_presence.pop(peer_id, None) is not None
            return self._send(200 if existed else 404, {"ok": existed})

        # DELETE /api/session/:code
        m_session = re.match(r"^/api/session/([A-Z0-9]+)$", path, re.IGNORECASE)
        if m_session:
            code = m_session.group(1).upper()
            with lock:
                sessions.pop(code, None)
            return self._send(200, {"ok": True})

        return self._send(404, {"error": "ruta no encontrada"})


if __name__ == "__main__":
    # Iniciar el hilo demonio para limpiar sesiones caducadas
    cleaner = threading.Thread(target=clean_expired, daemon=True)
    cleaner.start()

    server = ThreadingHTTPServer((HOST, PORT), SignalingHandler)
    print(f"[rummage-signal] Escuchando en http://{HOST}:{PORT}")
    print("[rummage-signal] API presencia: POST/DELETE /api/peer y GET /api/peers")
    print("[rummage-signal] API handshake: POST/GET/DELETE /api/session/:code")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[rummage-signal] Servidor detenido.")
        server.server_close()
