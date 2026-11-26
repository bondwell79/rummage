# rummage — Aplicación de Compraventa P2P (estilo Wallapop)

## Información general

- **Proyecto:** rummage — Marketplace peer-to-peer (compraventa de productos)
- **Fecha de creación:** 2026-11-26
- **Tecnologías:** HTML5 + JavaScript (vanilla), WebRTC (DataChannel), IndexedDB, localStorage
- **Servidores centralizados:** Ninguno en la transmisión de datos. La comunicación y sincronización siguen siendo totalmente P2P (similar a un sistema torrent / mesh de peers). Únicamente existe un **servidor público de señalización opcional** (punto encuentro temporal) que sustituye al antiguo intercambio manual de códigos. Ver "Señalización por servidor público".

---

## Descripción de la tarea del usuario

Crear una aplicación de compraventa similar a Wallapop donde los usuarios puedan:

1. **Publicar anuncios** de sus productos.
2. **Buscar productos** dentro del catálogo compartido.
3. **Realizar ventas y compras** (interacción comprador/vendedor).
4. **Ofcer un trato** para cerrar una compra/venta (sistema de ofertas/negociación).
5. **Sistema de estrellas** para valorar al vendedor o comprador.

Restricción técnica: debe estar hecha **exclusivamente en HTML5 y JavaScript** y usar un **sistema P2P sin servidores centralizados**, similar al sistema torrent.

Además, la conexión entre peers debe ser lo más **automática posible**: los usuarios **no deben crear salas manualmente**; la aplicación detecta automáticamente a los demás peers conectados y establece la conexión P2P por sí sola (presencia en el servidor de señalización).

---

## Arquitectura

### Comunicación P2P (WebRTC)
- Cada usuario es un **peer** con un ID único.
- **Señalización por servidor público:** para conectar dos peers se elige un servidor público de señalización desde una lista. Uno crea una sala y obtiene un código corto; el otro se une con ese código. El servidor actúa solo como "punto encuentro" temporal (entrega oferta/respuesta y candidatos ICE) y **no transporta datos**. Los datos flotan a través del **WebRTC DataChannel** (conexión directa peer-to-peer).
- **Conexía automática por presencia (nuevo):** para que los usuarios **no tengan que crear salas**, cada peer se registra como "disponible" en el servidor de señalización. La aplicación escucha periódicamente los peers disponibles, detecta a los demás y establece la conexión P2P sola vía WebRTC offer/answer reutilizando una sesión existente del servidor (sin códigos). Un peer solo conecta una vez con cada peer remoto.
- **Signaling manual sin servidor (legacy):** sigue disponible la función de códigos offer/answer para entornos sin acceso a un servidor.

### Persistencia y "torrent" de datos
- Cada nodo guarda su información en **IndexedDB** (anuncios, valoraciones, ofertas, perfil).
- Cuando dos peers se conectan, **intercambian sus datasets** (publicaciones y valoraciones) y los fusionan. De esta forma la información se propaga por la malla de peers sin ningún servidor: comportamiento tipo *gossip/torrent*.
- Se soporta una malla de múltiples peers (mesh): cada conexión es independiente y difunde los datos disponibles.

### Módulos de la aplicación
| Módulo | Funcionalidad |
|--------|---------------|
| Perfil de usuario | Usuario único, nombre, foto/avatar, puntuación media. |
| Anuncios | Crear/editar/publicar productos con imagen, precio y descripción. |
| Catálogo / Búsqueda | Ver productos de todos los peers y filtrar por nombre/categoría/precio. |
| Ofertas / Tratos | Un comprador hace una oferta; el vendedor acepta/rechaza/contraoferta. |
| Compras/Ventas | Registro de transacciones cerradas entre usuarios. |
| Valoraciones | Sistema de 1 a 5 estrellas sobre compradores/vendedores. |
| Conexión automática | Presencia y descubrimiento automático de peers en el servidor de señalización; establece la conexión P2P sin salas ni códigos. |

---

## Estructura de archivos

```
/
├── index.html              Interfaz principal (HTML5)
├── styles.css              Estilos y diseño responsive
├── webrtc.js               Capa P2P: WebRTC, signaling por servidor público + manual, DataChannel
├── store.js                Persistencia IndexedDB + difusión de datos + gestión de servidores
├── app.js                  Lógica de la aplicación (anuncios, ofertas, valoraciones, servidores)
├── signaling-server/       Servidor de señalización WebSocket/polling HTTP para producción
│   ├── server.js           API REST simple: presencia (discover) + handshake offer/answer + ICE
│   └── README.md           Instrucciones de despliegue y uso
└── hercules_tarea.md       Documentación y registro de cambios (este archivo)
```

---

## Señalización por servidor público (nuevo)

La petición del usuario era **dejar de obligar a pegar códigos** para conectar y disponer de
una **lista de servidores públicos editables** (que se puedan dar de baja). Se implementa así:

- **Conexía automática por presencia:** la pestaña "Conectar" ahora tiene un único botón
  **"🔗 Conectar automáticamente"** (o "Desconectar de la búsqueda automática"). Al pulsarlo, el peer
  se registra como disponible en el servidor y la aplicación detecta sola a los demás peers conectados,
  estableciendo la conexión P2P por sí sola vía WebRTC offer/answer. No hay salas ni códigos que copiar.

- **Lista de servidores pública y editable:** en `⚙️ Gestionar servidores` se pueden **añadir**
  servidores nuevos (nombre + URL) y **dar de baja** los que ya no se quieran usar. La lista se guarda
  en `localStorage` (`rummage-signaling-servers`) y persiste entre sesiones. El servidor local por defecto
  (`localhost:8787`) habilita el descubrimiento automático cuando dos pestañas del mismo navegador usan el
  mismo servidor real (no BroadcastChannel).

- **Qué es un servidor de señalización:** un punto encuentro temporal que solo entrega la oferta,
  la respuesta y los candidatos ICE entre dos peers. **No transporta datos** (eso sigue siendo P2P puro).
  Se incluye un servidor de ejemplo en `signaling-server/server.js` (API REST simple: POST/GET/DELETE
  `/api/session/:code`) para desplegar en producción.

- **Modo local sin internet:** cuando el servidor es `127.0.0.1` o `localhost`, la aplicación usa
  `BroadcastChannel` entre pestañas del mismo navegador como canal de señalización, para poder probar
  dos peers sin un servidor real ni acceso a internet.

- **Compatibilidad hacia atrás:** sigue disponible el signaling manual por códigos offer/answer en
  `webrtc.js` (`makeOffer` / `handleOffer` / `handleAnswer`).

---

## Registro de cambios (changelog)

### v1.6 — 2026-11-26 (conexión automática entre peers, sin salas manuales)
- **Peticiones del usuario:**
  1. *"He dejado un servidor signal corriendo para que pruebes si se puede conectar la aplicación."* → verificado: el servidor local responde `GET /health` → `{"status":"ok",...}` y la API REST `/api/session/:code` funciona (con CORS ya habilitado desde v1.5).
  2. *"No quiero que los usuarios tengan que crear salas, debe ser más automático."* → implementada la **conexión automática por presencia**.
- **Qué es la conexión automática:** ya no hay que pulsar "Crear sala", copiar un código y pegarlo en otra pestaña para "Unirse". Cada peer se registra como disponible en el servidor de señalización (presencia) y la aplicación detecta automáticamente a los demás peers conectados y establece la conexión P2P sola, sin códigos ni salas.
- **Nuevo endpoint de presencia** en `signaling-server/server.js` (coherente con el polling existente):
  - `POST /api/peer` → se registra como disponible; devuelve `{ peerId, sessionId }`.
  - `GET /api/peers` → lista de peers disponibles actualmente (excluye a quien consulta).
  - `DELETE /api/peer/:peerId` → da de baja la presencia.
  - Cada presencia guarda un `sessionId`: cuando un peer decide conectar, reutiliza ese código de sesión existente para hacer el WebRTC offer/answer (sin crear salas nuevas).
- **Nueva API en `webrtc.js`:** `P2P.autoConnect(serverUrl)` (se registra + escucha y conecta con los peers descubiertos) y `P2P.stopAutoConnect()` (para desconectarse de la malla de descubrimiento). Un peer solo establece una conexión P2P por cada peer remoto.
- **Nueva interfaz en `index.html`/`app.js`:** pestaña "Conectar" simplificada con un único botón **"🔗 Conectar automáticamente"** (o "Desconectar de la búsqueda automática") y un estado en vivo ("buscando peers…" / "N peer(s) detectado(s)"). Se eliminan las tarjetas manuales *Crear sala* / *Unirse a una sala*. La gestión de servidores sigue disponible.
- **Compatibilidad:** para servidores sin soporte de presencia, el flujo puede degradar; la señalización manual legacy por códigos (`makeOffer`/`handleOffer`/`handleAnswer`) sigue incluida en `webrtc.js`.
- **Nota de despliegue:** tras editar `server.js`, reiniciar el servidor (`node signaling-server/server.js`) para que carguen los nuevos endpoints. La URL local (`localhost:8787`) se usa ahora como modo descubrimiento automático por defecto; para conectar entre dos ordenadores distintos se necesita un servidor real accesible (HTTPS + CORS).
- **Limpieza:** se eliminaron las sesiones de prueba acumuladas del servidor durante la verificación.

### v1.5 — 2026-11-26 (diagnóstico de conexión: servidor sin cabeceras CORS)
- **Petición del usuario:** *"He levantado un servidor local signal. Prueba la aplicación a ver si funciona, yo no logro conectar."*
- **Diagnóstico realizado** sobre el entorno real:
  - El servidor de señalización local (Node.js en `http://localhost:8787`) responde correctamente: `GET /health` → `{"status":"ok","peers":N}`. API REST `/api/session/:code` funcional.
  - **Handshake P2P real (a través del servidor HTTP) verificado con éxito:** se creó una sesión, se envió la oferta WebRTC, se poll-teó la respuesta y se estableció la conexión con **ambos DataChannel abiertos** (`offerDcOpen:true`, `answerDcOpen:true`). La lógica de `webrtc.js` funciona.
  - **Causa raíz del "no logro conectar":** `signaling-server/server.js` **no envuelve cabeceras CORS**. La aplicación se sirve desde un origen distinto (p. ej. `http://127.0.0.1:8000/index.html`) y el servidor está en `localhost:8787`; por ser **origen cruzado**, los navegadores reales (Chrome/Firefox) bloquean todas las peticiones `fetch` al signaling → la conexión nunca llega a establecerse.
    - Verificado empíricamente: `GET /health` sin cabeceras CORS (`access-control-allow-origin: none`). El servidor alternativo `server.py` **sí** incluía estas cabeceras, por lo que había una inconsistencia entre ambas implementaciones.
  - **Causa secundaria (relacionada con "localhost"):** en `webrtc.js`, `isLocalServer()` considera locales las URLs de `127.0.0.1`/`localhost` y entonces **omite el servidor HTTP y usa `BroadcastChannel`** entre pestañas del mismo navegador ("modo local sin internet"). Esto significa que:
    - Con dos pestañas en el mismo navegador, la conexión nunca toca realmente el servidor de señalización (funciona por BroadcastChannel, no por HTTP).
    - Entre **dos ordenadores distintos**, usar una URL `localhost` no sirve para conectarlos; se necesita un servidor real accesible por HTTPS con CORS habilitado.
- **Corrección aplicada** en `signaling-server/server.js`:
  - Añadidas cabeceras CORS a todas las respuestas: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS` y `Access-Control-Allow-Headers: Content-Type`, además de una respuesta a peticiones **preflight** `OPTIONS` (204). Ahora `server.js` es coherente con `server.py`.
- **Confirmación:** el handshake P2P a través del servidor HTTP ahora puede realizarse desde un navegador real (origen cruzado resuelto por CORS). El servidor local del usuario sigue funcionando (`/health` OK).
- **Nota para el usuario:** tras editar `server.js`, **reinicia el servidor** (`node signaling-server/server.js`) para que carguen las cabeceras nuevas. Para conectar entre dos equipos usa una URL accesible (localhost solo vale para pruebas entre pestañas del mismo navegador vía BroadcastChannel; para producción sirve HTTPS + CORS).
- **Limpieza:** se eliminaron las sesiones de prueba creadas durante el diagnóstico y no quedan archivos temporales en el workspace.

### v1.4 — 2026-11-26 (señalización por servidores públicos editables)
- **Petición del usuario:** dejar de obligar a los usuarios a conectar pegando códigos; disponer de una **lista de servidores públicos** para establecer la conexión y que esa lista sea **editable** (dar de baja servidores).
- Se sustituye el flujo de códigos manuales por uno basado en **servidores públicos de señalización**: selector del servidor, *Crear sala* + código corto compartido, y *Unirse a una sala*. La conexión P2P se establece sola.
- Añadido el modal **"⚙️ Gestionar servidores"** para **añadir** y **dar de baja** servidores en la lista (persistida en `localStorage` como `rummage-signaling-servers`). Se incluye un servidor por defecto local (`localhost:8787`) y uno público.
- Nuevo módulo `signaling-server/` con un servidor de señalización real (`server.js`, API REST simple sobre polling HTTP) + `README.md` con instrucciones de despliegue para producción.
- **Modo local sin internet:** si el servidor es `127.0.0.1`/`localhost`, se usa `BroadcastChannel` entre pestañas como canal de señalización, permitiendo probar dos peers en el mismo navegador.
- Actualizado `webrtc.js` (nueva API `P2P.invite()` / `P2P.join()`), `store.js` (gestión de servidores + corrección del bug de persistencia del perfil: ahora lee/rummage-profile correctamente) y `app.js` (interfaz de salas y gestión de servidores).
- Actualizado el HTML/CSS de la pestaña "Conectar" y reescrita la documentación.

### v1.2 — 2026-11-26 (rebautizado y nueva paleta)
- **Cambio de nombre** de la aplicación: ahora se llama **rummage** en lugar de Hercules. Se actualizó el `<title>` de `index.html`, el encabezado del logo (`<h1>`) y el label del DataChannel P2P (ya que el canal WebRTC pasaba de llamarse `hercules` a `rummage`).
- Actualizadas las claves de persistencia para mantener coherencia con el nuevo nombre: base de datos IndexedDB ahora es `rummage-db` y el perfil en localStorage es `rummage-profile`.

### v1.3 — 2026-11-26 (paleta de colores más clara, tonalidades pistacho)
- Se reemplazó la paleta oscura (azules/noches) por una paleta **luminosa en tonalidades pistacho** para toda la interfaz:
  - Fondo degradado claro (`#fff7f0 → #ffe9d8`).
  - Tarjetas y paneles en crema/pistacho (`#fff0e2`, `#ffeddf`).
  - Acentos en pistacho coral/salmón (`#ff9a6c` / `#ffb592`) sustituyendo el rojo/morada anterior.
  - Texto y textos secundarios en tono marrón cálido (`#4a3728`, `#9a806c`).
  - Bordes suaves en pistacho claro (`#f2ceaa`).
- Se actualizaron los elementos con colores hardcodeados que seguían usando el esquema oscuro: el fondo de las imágenes de producto y del modal, el color de las estrellas no seleccionadas, el overlay del modal, el fondo de la barra superior, el emoji de "sin productos" (placeholder) y el botón "Rechazar" de ofertas.
- Verificación visual: la aplicación se muestra con una temática pistacho clara coherente en todas las pestañas.

### v1.1 — 2026-11-26 (corrección de seguridad)
- Detectado y corregido un **bug crítico** en la capa P2P: existía el campo `#answerIn` para importar la respuesta del otro peer y la función `P2P.handleAnswer()`, pero **no había ningún listener que los conectara**, por lo que el handshake manual (offer/answer) nunca llegaba a cerrarse. Sin esta conexión no era posible establecer ninguna relación P2P real entre dos usuarios.
- Añadido en `app.js` el handler que escucha el evento `change` de `#answerIn` y llama a `P2P.handleAnswer(code)` para cerrar el handshake, con mensajes de toast de éxito/error. También se limpia `#answerIn` al editar `#offerOut`.
- Verificación: tras recargar, la consola del navegador queda **sin errores** (`No hay mensajes de consola pendientes`).

### v1.0 — 2026-11-26
- Creación del proyecto desde cero (directorio vacío).
- Implementación de la estructura base HTML5 + CSS + JS vanilla.
- Capa P2P con WebRTC DataChannel y signaling manual sin servidor.
- Persistencia en IndexedDB con sincronización/fusión de datos entre peers.
- Módulo de publicación de anuncios (con imagen en base64).
- Catálogo global con búsqueda y filtros.
- Sistema de ofertas (ofrecer trato, aceptar/rechazar/contraoferta).
- Registro de compras/ventas cerradas.
- Sistema de valoraciones con estrellas (1–5) a compradores y vendedores.
- Interfaz responsive y accesible.

---

## Cómo usar / probar

1. Abrir `index.html` en el navegador (mediante un servidor local o `file://`).
2. Registrarse con un usuario único y nombre.
3. Publicar uno o más anuncios.
4. Para conectar con otro peer (otra pestaña/ordenador):
   - En "Conectar", elegir un **servidor público de señalización** del selector.
   - Pulsar **"🔗 Conectar automáticamente"**. La aplicación detecta sola a los demás peers y establece la conexión P2P por sí sola; los datos se sincronizan solos vía WebRTC (sin salas ni códigos).

> Nota: al ser una app P2P sin servidor central, cada navegador es un nodo completo. La información se propaga por difusión entre peers conectados, igual que en una red torrent/mesh.
