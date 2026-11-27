# rummage

**rummage** es un prototipo web de compraventa entre personas (P2P). Permite publicar y buscar anuncios, gestionar ofertas y compraventas, valorar a otros usuarios y conversar sobre una compraventa cerrada. No hay una base de datos central de anuncios: cada navegador conserva una copia local y comparte datos con peers conectados. El proyecto **no está aprobado ni preparado para producción**; consulta la evaluación de seguridad antes de desplegarlo.

## Funcionalidades

- Catálogo con búsqueda y filtros por categoría, ciudad y precio.
- Publicación, edición y eliminación de anuncios con precio, descripción e imagen.
- Perfil local con nombre, ciudad y avatar.
- Ofertas, seguimiento de compraventas, valoraciones y chat asociado a una compraventa cerrada.
- Descubrimiento y conexión automática con otros peers mediante un servidor de señalización.
- Sincronización de anuncios, ofertas, mensajes y valoraciones entre peers.

## Arquitectura

La aplicación es HTML, CSS y JavaScript sin framework ni paso de compilación. `index.html` carga la interfaz y los módulos `webrtc.js`, `store.js` y `app.js`.

- `app.js` implementa la interfaz y las acciones de compraventa.
- `store.js` persiste anuncios, valoraciones, ofertas y mensajes en **IndexedDB**. El perfil, el identificador local del peer y la configuración del servidor se guardan en **localStorage**.
- `webrtc.js` descubre peers y establece conexiones WebRTC; el transporte de datos entre navegadores se hace mediante un `RTCDataChannel` llamado `rummage`.
- `signaling-server/server.py` es la implementación disponible del servidor de señalización. Mantiene sesiones y presencia temporalmente en memoria; no guarda el catálogo ni retransmite el tráfico del DataChannel. La señalización sí transporta la oferta/respuesta SDP y candidatos ICE.

## Comunicación entre pares

### 1. Identidad y descubrimiento

Cada perfil de navegador crea un identificador aleatorio y lo conserva en `localStorage` bajo `rummage-peer-id`. Al conectarse, el cliente se registra en el servidor (`POST /api/peer`) y recibe un identificador de presencia y un código de sesión. A continuación consulta `GET /api/peers` cada dos segundos para detectar otros navegadores registrados. La comparación de los identificadores determina de forma consistente qué extremo inicia cada conexión.

### 2. Negociación WebRTC (señalización)

El cliente usa polling HTTP para intercambiar la oferta SDP, la respuesta SDP y los candidatos ICE a través de una sesión (`/api/session`). El peer iniciador crea una `RTCPeerConnection`, genera la oferta y crea el DataChannel; el otro peer devuelve la respuesta. Ambos publican y consultan candidatos ICE para intentar encontrar una ruta de red directa. Se configura el servidor STUN público `stun.l.google.com:19302` para ayudar con NAT.

El servidor de señalización solo facilita este encuentro inicial. Una vez negociada la conexión, los mensajes de la aplicación viajan entre los navegadores por el DataChannel, no por el servidor HTTP. No se configura un servidor TURN: si la red o el NAT impiden una ruta directa, la conexión puede fallar.

Para pruebas locales, la aplicación también admite `BroadcastChannel` como transporte de señalización entre pestañas del mismo navegador cuando se usa `localhost` o `127.0.0.1`.

### 3. Sincronización y persistencia

Al abrirse el DataChannel, cada peer anuncia su ID y después envía una instantánea dirigida. Las modificaciones posteriores vuelven a difundir una instantánea a los canales abiertos. El receptor fusiona los registros en IndexedDB y reenvía los cambios recibidos; así los datos pueden propagarse entre peers conectados. Los anuncios y las ofertas se comparan por revisión y fecha de actualización; valoraciones y mensajes se incorporan por identificador único.

Las instantáneas grandes se dividen en fragmentos de 8 KiB, se reconstruyen en el destino y están limitadas a 64 MiB por transferencia. Los tratos y mensajes de chat se filtran por el ID declarado del peer y su participación; ese ID no está autenticado. El catálogo y las valoraciones se difunden a los peers conectados. Si un navegador no está conectado, conserva sus datos localmente y no recibe cambios hasta que vuelva a conectarse con algún peer que los tenga.

## Ejecución

Sirve el directorio raíz como archivos estáticos con cualquier servidor web. No hay dependencias de frontend ni comando de build. Para conectar navegadores en equipos distintos, la aplicación necesita acceso a un servidor de señalización alcanzable por ambos. El cliente toma la URL del primer servidor de `Store.getSignalingServers()` en `store.js`; actualmente hay una URL predeterminada definida en ese archivo.

Para ejecutar el servidor de señalización de Python en desarrollo:

```bash
python signaling-server/server.py
```

El servidor escucha en `0.0.0.0:8787` por defecto y admite cambiar el puerto mediante `PORT`. Este servidor HTTP mínimo es solo para desarrollo/pruebas; no debe exponerse directamente a Internet. Para cualquier despliegue de prueba usa un proxy inverso con TLS y límites de recursos.

## Seguridad y preparación para producción

**Estado de esta revisión: no listo para producción.** Esta es una revisión estática del código, no una auditoría independiente, prueba de penetración ni garantía de seguridad. No hay suite automatizada de pruebas ni análisis de dependencias configurados.

Bloqueos observados en el código actual:

- `store.js` configura como servidor predeterminado `http://94.143.137.242:8080`. La señalización viaja sin TLS y puede ser observada o alterada en tránsito. Desde una web servida por HTTPS, el navegador además puede bloquear esas peticiones como contenido mixto. No despliegues ni uses ese endpoint para datos reales.
- El servidor de señalización no implementa autenticación, autorización, límites de frecuencia, cuotas de sesiones/peers, ni límites de tamaño de solicitudes/candidatos. `Access-Control-Allow-Origin: *` permite llamadas desde cualquier origen y **CORS no es un control de acceso**. La API tampoco ofrece una identidad de peer verificable; los códigos de presencia no autentican a sus titulares.
- La conexión automática acepta peers del servidor público. Un peer puede hacerse pasar por otro, enviar datos falsos y provocar consumo de CPU, memoria o almacenamiento local. El límite de 64 MiB es por transferencia, no una cuota agregada por peer o conexión.
- WebRTC cifra el transporte del DataChannel con DTLS, pero no resuelve la autenticidad de las personas ni evita contenido malicioso del peer. Alias, fotos, anuncios, ofertas y valoraciones no son verificados. No uses el sistema para pagos ni transacciones de valor como si tuviera protección de una plataforma de confianza.
- La aplicación guarda datos en el navegador y no ofrece recuperación, borrado remoto ni controles de acceso por cuenta. Los datos compartidos pueden permanecer en otros navegadores incluso después de borrarlos localmente.

Medidas aplicadas en esta revisión: las imágenes de anuncios/perfiles recibidas se limitan a formatos raster embebidos, se escapan al insertarlas en HTML y se rechazan las cargas locales de más de 5 MiB; los campos textuales del trato se escapan y los tratos se incluyen solo en la instantánea dirigida a un ID participante. Se eliminó el envío inicial de datos antes de recibir un ID y el servidor dejó de imprimir códigos de sesión en stdout. Esto reduce riesgos concretos, pero no elimina la suplantación ni convierte la sincronización P2P en un límite de seguridad.

Antes de una salida real, como mínimo:

- Sustituye el endpoint HTTP codificado por una configuración de despliegue explícita con HTTPS y valida el certificado; sirve también la web exclusivamente por HTTPS.
- Endurece el servidor: límites de tamaño y concurrencia, cuotas y rate limiting, validación estricta de esquema y tamaño de cada SDP/candidato, expiración y limpieza, y métricas/alertas sin registrar datos privados.
- Define un modelo de identidad y autorización criptográficamente verificable; no confíes en el `peerId` anunciado por un cliente para decidir quién puede leer o modificar tratos y mensajes.
- Restringe CORS a los orígenes publicados cuando sea posible, añade cabeceras de seguridad (incluida una CSP compatible con la página), y despliega detrás de infraestructura mantenida con TLS, firewall y protección contra abuso.
- Añade pruebas automatizadas de protocolo, validación de mensajes, sincronización/privacidad y regresión XSS; ejecuta análisis de dependencias y una auditoría independiente antes de aceptar datos de usuarios.
- Revisa privacidad, retención, moderación, protección al consumidor y obligaciones legales aplicables al mercado donde se publique.

## Límites del modelo

- Los datos se almacenan en los navegadores de los usuarios, no en un repositorio central. La disponibilidad depende de que algún peer que tenga los datos se conecte y los comparta.
- La presencia y las sesiones del servidor se guardan en memoria y caducan tras 15 minutos desde su última actualización. El cliente registra la presencia una vez y no envía heartbeats, por lo que una entrada de presencia puede caducar aunque la página siga abierta.
- No hay servidor TURN; algunas redes pueden impedir establecer la conexión P2P.
- La aplicación no implementa cuentas o autenticación centralizadas. El identificador local distingue peers, pero no constituye por sí mismo una verificación de identidad.
