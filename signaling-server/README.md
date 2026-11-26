# Servidor de señalización rummage (polling HTTP)

El signaling es el "punto encuentro" que sustituye al antiguo intercambio manual de
códigos. **No transporta datos**: solo entrega oferta/respuesta y candidatos ICE entre
dos peers, que luego se conectan directo vía WebRTC DataChannel.

## Requisitos

- Node.js (>= 14). Solo usa el núcleo (`http`, `url`, `crypto`): **no necesita dependencias**.

## Ejecutar

```bash
node signaling-server/server.js
# -> [rummage-signal] Escuchando en http://0.0.0.0:8787
```

Opciones por variable de entorno:

- `PORT` (por defecto 8787) — puerto de escucha.
- `TTL_MS` (por defecto 900000 = 15 min) — caducidad de cada sesión.

## API (polling HTTP)

| Método y ruta | Descripción | Respuesta |
|---|---|---|
| `POST /api/session` | Crear una sesión (invitar a un peer) | `{ code, sessionId }` |
| `GET  /api/session/:code` | Consultar el estado de una sesión | `{ offer?, answer? }` |
| `POST /api/session/:code` | Entregar/actualizar oferta o respuesta | `{ offer?, answer? }` |
| `DELETE /api/session/:code` | Cerrar la sesión | `{ ok: true }` |
| `GET  /health` | Estado del servidor | `{ status, peers }` |

### Flujo de emparejamiento

1. **A (invitado)** hace `POST /api/session` → recibe un `code` corto.
2. **B (anfitrión)** consulta cada N segundos `GET /api/session/:code`.
3. Cuando B tiene la oferta, responde con `POST /api/session/:code { answer }`.
4. **A** consulta y obtiene la respuesta → se establece la conexión.

## Despliegue como "servidor público"

Cualquier hosting que acepte un backend Node (VPS, Render, Railway, Cyclic, etc.) sirve
esta app. Expón el puerto `PORT` por HTTPS y añade la URL del servidor a la lista de
servidores públicos de la aplicación.

> Consejo: detrás de un proxy inverso (Nginx/Caddy) con una IP fija, un único servidor
> puede servir a miles de pares. No almacena datos de usuario: cada sesión es efímera.
