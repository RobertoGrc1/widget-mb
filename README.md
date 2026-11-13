# widget-mb

Servicio personal para consultar saldo y consumo de Mi Telcel desde un widget de Scriptable en iOS. El backend usa FastAPI; Playwright inicia sesión en **Mi Telcel**
y HTTPX consulta los datos de la cuenta. `parser_telcel.py` transforma la respuesta del proveedor en un formato sencillo para el widget.

> Proyecto independiente, no afiliado ni respaldado por Telcel. La autenticación y las interfaces del proveedor pueden cambiar y afectar su funcionamiento.

## Contenido

- [widget-mb](#widget-mb)
  - [Contenido](#contenido)
  - [Cómo funciona](#cómo-funciona)
  - [Requisitos](#requisitos)
  - [Ejecución con Docker](#ejecución-con-docker)
  - [Ejecución local con Python](#ejecución-local-con-python)
  - [API](#api)
    - [`POST /saldo`](#post-saldo)
    - [`GET /health`](#get-health)
  - [Configuración](#configuración)
  - [Widget de Scriptable](#widget-de-scriptable)
  - [Estructura](#estructura)

## Cómo funciona

```text
Widget de Scriptable
        │ HTTPS: POST /saldo + x-api-key
        ▼
FastAPI (main.py)
        │
        ├── Playwright inicia sesión en Mi Telcel y obtiene el token
        ├── HTTPX consulta los datos de la cuenta
        └── parser_telcel.py convierte la respuesta para el widget
```

El servicio mantiene en memoria el token, una huella HMAC de la contraseña y el último resultado por número. Las respuestas recientes se reutilizan durante el
tiempo configurado en `CACHE_SEG`. Si una actualización falla y hay datos anteriores para las mismas credenciales, el servicio puede devolverlos e indicar
el error en la respuesta.

El estado no es persistente: al reiniciar el proceso se pierde la caché y se requiere una nueva sesión. Por este motivo, el contenedor se ejecuta con un solo
worker. Varias réplicas tampoco comparten estado.

## Requisitos

- Docker (recomendado para ejecutar el servicio con Chromium), o Python 3.10 o posterior.
- Una cuenta Mi Telcel.
- Una clave propia para proteger la API mediante el encabezado `x-api-key`.
- Para el cliente opcional: iPhone con la app Scriptable.

## Ejecución con Docker

Desde la raíz del repositorio:

```bash
docker build -t widget-mb .
docker run --rm -p 8000:8000 \
  -e API_KEY="reemplaza-por-una-clave-segura" \
  widget-mb
```

El servicio quedará disponible en `http://localhost:8000`. La variable `API_KEY` es obligatoria. Usa la misma clave al llamar a `/saldo`.

Comprueba que el servicio está activo:

```bash
curl http://localhost:8000/health
```

## Ejecución local con Python

Instala las dependencias y el navegador de Playwright:

```bash
python -m venv .venv
```

Activa el entorno virtual y continúa:

```bash
# macOS / Linux
source .venv/bin/activate

# Windows PowerShell
# .\.venv\Scripts\Activate.ps1

python -m pip install -r requirements.txt
python -m playwright install chromium
```

Configura `API_KEY` en el entorno y arranca un solo worker:

```bash
# macOS / Linux
export API_KEY="reemplaza-por-una-clave-segura"

# Windows PowerShell
# $env:API_KEY = "reemplaza-por-una-clave-segura"

python -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
```

FastAPI también publica la documentación interactiva en `/docs` y `/redoc`.

## API

### `POST /saldo`

Requiere la clave configurada en `API_KEY`:

```http
x-api-key: <tu-clave>
Content-Type: application/json
```

Cuerpo:

```json
{
  "numero": "5512345678",
  "password": "<contraseña de Mi Telcel>"
}
```

`numero` debe contener 10 dígitos. `password` debe tener entre 6 y 50 caracteres.

La respuesta contiene los datos normalizados de saldo y paquetes:

```json
{
  "data": {
    "plan": "Nombre del plan",
    "saldo_etiqueta": "Saldo disponible",
    "saldo": 100.0,
    "saldo_vence_texto": "21 de noviembre",
    "saldo_vence_iso": "2026-11-21",
    "saldo_dias_restantes": 8,
    "linea_suspendida": false,
    "paquetes": [
      {
        "nombre": "Paquete de datos",
        "ilimitado": false,
        "disponible_mb": 1536.0,
        "usado_mb": 512.0,
        "total_mb": 2048.0,
        "porcentaje_disponible": 75.0,
        "disponible_texto": "1.5 GB",
        "dias_restantes": 10,
        "actualizado_telcel": null
      }
    ]
  },
  "actualizado": 1795000000,
  "desde_cache": false,
  "error": null
}
```

`actualizado` es una marca de tiempo Unix en segundos. Algunos valores pueden ser `null` si Telcel no los incluye.
Si se devuelve un resultado anterior tras un fallo de actualización, `desde_cache` será `true` y `error` indicará el tipo
de error.

Respuestas de error habituales:

| Estado | Significado                                                 |
| ------ | ----------------------------------------------------------- |
| `401`  | Clave de API inválida o no se pudo iniciar sesión.          |
| `422`  | El cuerpo no cumple el formato requerido.                   |
| `429`  | Hay un bloqueo temporal tras un inicio de sesión fallido.   |
| `502`  | No fue posible consultar o procesar la respuesta de Telcel. |

### `GET /health`

Endpoint de comprobación que devuelve el estado del servicio y el número de usuarios cuyos datos están actualmente en memoria:

```json
{
  "ok": true,
  "usuarios_activos": 1
}
```

## Configuración

| Variable                 | Requerida | Predeterminado | Descripción                                                                  |
| ------------------------ | --------- | -------------- | ---------------------------------------------------------------------------- |
| `API_KEY`                | Sí        | —              | Secreto requerido en el encabezado `x-api-key` de `/saldo`.                  |
| `HEADLESS`               | No        | `true`         | Ejecuta Chromium sin interfaz gráfica. Solo el valor `false` lo desactiva.   |
| `CACHE_SEG`              | No        | `600`          | Vigencia de la caché por usuario, en segundos.                               |
| `MAX_LOGINS_SIMULTANEOS` | No        | `1`            | Máximo de inicios de sesión simultáneos con Chromium.                        |
| `BLOQUEO_SEG`            | No        | `900`          | Duración del bloqueo tras un inicio de sesión fallido, en segundos.          |
| `INACTIVO_SEG`           | No        | `86400`        | Tiempo sin actividad antes de eliminar el estado de un usuario, en segundos. |

## Widget de Scriptable

`scriptable.js` contiene el cliente para iOS. Antes de usarlo, configura:

- `URL`: dirección HTTPS del servicio, terminada en `/saldo`.
- `KEY`: el mismo valor configurado en `API_KEY` en el servidor.

El script guarda el número y la contraseña en el Llavero de iOS mediante Scriptable y los envía al backend para consultar la cuenta.

## Estructura

```text
.
├── main.py           # API FastAPI, autenticación, caché y cliente HTTP
├── parser_telcel.py  # Conversión de la respuesta de Telcel
├── scriptable.js     # Cliente del widget para iOS
├── Dockerfile        # Imagen con Playwright/Chromium
├── log_config.json   # Configuración de logging para Uvicorn
├── requirements.txt  # Dependencias de Python
├── railway.toml      # Configuración de despliegue en Railway
└── README.md
```
