# Servidor de señalización rummage

La implementación disponible está en `server.py` y requiere Python 3.10 o posterior, sin dependencias externas. Facilita el descubrimiento temporal de peers y el intercambio de SDP/candidatos ICE para iniciar WebRTC; no recibe el tráfico del DataChannel.

## Ejecución local

Desde la raíz del proyecto:

```bash
python signaling-server/server.py
```

Escucha por defecto en `0.0.0.0:8787`. Se puede cambiar el puerto con la variable de entorno `PORT`. El proceso guarda presencia y sesiones únicamente en memoria; su caducidad predeterminada es de 15 minutos.

## API

| Método y ruta | Descripción |
|---|---|
| `POST /api/peer` | Registrar presencia y crear una sesión de señalización |
| `GET /api/peers?exclude=:peerId` | Consultar peers presentes |
| `DELETE /api/peer/:peerId` | Retirar presencia |
| `POST /api/session` | Crear una sesión |
| `GET /api/session/:code` | Consultar oferta/respuesta |
| `POST /api/session/:code` | Publicar oferta/respuesta |
| `GET /api/session/:code/candidates?from=:role` | Consultar candidatos ICE |
| `POST /api/session/:code/candidates` | Publicar candidatos ICE |
| `GET /health` | Estado básico y cantidad de peers |

## Seguridad

Este servidor mínimo **no está preparado para exponerse directamente a Internet ni para producción**. No ofrece autenticación/autorización, límites de frecuencia o cuotas de recursos, validación completa de esquemas, ni límites de tamaño de solicitudes y candidatos. La API de presencia es pública; CORS abierto no proporciona control de acceso y las sesiones no verifican la identidad de los peers. Los IDs de peer y los códigos de sesión que aparecen en la API no son credenciales de una identidad autenticada.

Para un entorno de pruebas, colócalo detrás de un proxy inverso mantenido, configura HTTPS y límites de conexión/tamaño, monitoriza recursos y restringe el acceso de red. Antes de producción se requiere rediseñar y probar controles de identidad, autorización, validación y antiabuso. El cliente actual incluye una URL predeterminada HTTP en `store.js`; no uses ese endpoint con datos reales.
