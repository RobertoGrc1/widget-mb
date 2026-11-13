import os, re, sys, time, json, hmac, base64, hashlib, secrets, asyncio, logging, traceback
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from playwright.async_api import async_playwright

from parser_telcel import parsear_home

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("telcel")

# ===== Configuración (solo variables del servidor, nada de usuarios) =====
API_KEY = os.environ["API_KEY"]
HEADLESS = os.getenv("HEADLESS", "true").lower() != "false"
CACHE_SEG = int(os.getenv("CACHE_SEG", "600"))  # 10 min por usuario
MAX_LOGINS = int(os.getenv("MAX_LOGINS_SIMULTANEOS", "1"))  # Chromiums a la vez
BLOQUEO_SEG = int(os.getenv("BLOQUEO_SEG", "900"))  # 15 min tras login fallido
INACTIVO_SEG = int(os.getenv("INACTIVO_SEG", "86400"))  # limpiar tras 24 h sin uso

URL_HOME = (
    "https://api.journeys.telcel.wavebybemobi.com/api/components/flow/home"
    "?externalCode=52{num}"
)
LLAVES_TOKEN = ["mitelcel.b2f_access_token", "mitelcel.b2f_crud_access_token"]
JS_TOKEN = f"""() => {{
  for (const k of {json.dumps(LLAVES_TOKEN)}) {{
    const v = sessionStorage.getItem(k);
    if (v) return v.trim().replace(/^"|"$/g, "");
  }}
  return null;
}}"""
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)

PATRON_COOKIES = re.compile(
    r"^\s*(acepto las cookies|acepto|aceptar( todas| todo| cookies| y cerrar)?|entendido|de acuerdo|ok)\s*$",
    re.I,
)
JS_QUITAR_COOKIES = """() => {
  let n = 0;
  document.querySelectorAll('body *').forEach(el => {
    const s = getComputedStyle(el);
    if (!['fixed', 'sticky'].includes(s.position)) return;
    const pista = (el.id || '') + ' ' + String(el.className || '') + ' ' + (el.innerText || '').slice(0, 300);
    if (/cookie/i.test(pista) && !el.querySelector('iframe')) { el.remove(); n++; }
  });
  document.documentElement.style.overflow = 'auto';
  document.body.style.overflow = 'auto';
  return n;
}"""

# ===== Estado en memoria =====
SECRETO = secrets.token_bytes(
    32
)  # cambia en cada arranque; las huellas no sirven fuera del proceso
usuarios: dict[str, dict] = {}
sem_login = asyncio.Semaphore(MAX_LOGINS)


class LoginFallido(Exception):
    pass


class Credenciales(BaseModel):
    numero: str = Field(pattern=r"^\d{10}$")
    password: str = Field(min_length=6, max_length=50)


def enmascarar(num: str) -> str:
    return "******" + num[-4:]


def huella(pwd: str) -> str:
    return hmac.new(SECRETO, pwd.encode(), hashlib.sha256).hexdigest()


def jwt_exp(token: str) -> int:
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        return int(json.loads(base64.urlsafe_b64decode(p)).get("exp", 0))
    except Exception:
        return 0


def usuario(num: str) -> dict:
    if num not in usuarios:
        usuarios[num] = {
            "lock": asyncio.Lock(),
            "huella": None,
            "token": None,
            "exp": 0,
            "data": None,
            "actualizado": 0,
            "fallidos": {},
            "ultimo_uso": 0,
        }
    return usuarios[num]


# ===== Playwright =====
async def cerrar_cookies(page, espera_s=8) -> bool:
    try:
        btn = page.get_by_role("button", name=re.compile(r"acepto las cookies", re.I))
        await btn.first.wait_for(state="visible", timeout=espera_s * 1000)
        await btn.first.click(timeout=3000)
        log.info("Aviso de cookies cerrado (botón Mi Telcel)")
        return True
    except Exception:
        pass
    for frame in page.frames:
        try:
            loc = frame.get_by_role("button", name=PATRON_COOKIES)
            if await loc.count() and await loc.first.is_visible():
                await loc.first.click(timeout=3000)
                return True
        except Exception:
            pass
    try:
        return bool(await page.evaluate(JS_QUITAR_COOKIES))
    except Exception:
        return False


async def encontrar_frame_login(page, timeout_s=30):
    for _ in range(timeout_s * 2):
        for frame in page.frames:
            try:
                if await frame.locator("#sso-input-number").count() > 0:
                    return frame
            except Exception:
                pass
        await asyncio.sleep(0.5)
    raise RuntimeError("Formulario de login no encontrado")


async def _login_async(num: str, pwd: str):
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=HEADLESS,
            args=["--disable-dev-shm-usage", "--disable-gpu"],
        )
        try:
            page = await (
                await browser.new_context(locale="es-MX", user_agent=UA)
            ).new_page()
            await page.goto("https://www.mitelcel.com/", timeout=60000)
            await cerrar_cookies(page)

            frame = await encontrar_frame_login(page)
            await frame.locator("#sso-input-number").click()
            await frame.locator("#sso-input-number").press_sequentially(num, delay=60)
            await frame.locator("#sso-input-password").click()
            await frame.locator("#sso-input-password").press_sequentially(pwd, delay=60)
            await frame.locator("#sso-input-password").press("Tab")
            await frame.wait_for_function(
                "() => !document.querySelector('#sso-submit').disabled", timeout=15000
            )
            await frame.locator("#sso-submit").click()

            for _ in range(60):
                try:
                    token = await page.evaluate(JS_TOKEN)
                except Exception:
                    token = None
                if token:
                    return token
                await asyncio.sleep(1)
            return None
        finally:
            await browser.close()


def _correr_login_en_hilo(num: str, pwd: str):
    loop = (
        asyncio.ProactorEventLoop()
        if sys.platform == "win32"
        else asyncio.new_event_loop()
    )
    try:
        return loop.run_until_complete(_login_async(num, pwd))
    finally:
        loop.close()


async def login(num: str, pwd: str) -> str:
    async with sem_login:
        log.info("Login para %s", enmascarar(num))
        token = await asyncio.to_thread(_correr_login_en_hilo, num, pwd)
    if not token:
        raise LoginFallido(
            "No se pudo iniciar sesión (contraseña incorrecta, captcha o código SMS)"
        )
    log.info(
        "Login OK para %s (token vence en %s min)",
        enmascarar(num),
        round((jwt_exp(token) - time.time()) / 60),
    )
    return token


async def consultar(num: str, token: str):
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(
            URL_HOME.format(num=num),
            headers={
                "authorization": f"Bearer {token}",
                "accept": "application/json",
                "user-agent": UA,
            },
        )
    if r.status_code in (401, 403):
        return None
    r.raise_for_status()
    return r.json()


# ===== API =====
async def limpieza():
    while True:
        await asyncio.sleep(3600)
        limite = time.time() - INACTIVO_SEG
        for num in [
            n
            for n, u in usuarios.items()
            if u["ultimo_uso"] < limite and not u["lock"].locked()
        ]:
            usuarios.pop(num, None)


@asynccontextmanager
async def lifespan(app):
    tarea = asyncio.create_task(limpieza())
    yield
    tarea.cancel()


app = FastAPI(lifespan=lifespan)


def resp(u, desde_cache, error=None):
    return {
        "data": u["data"],
        "actualizado": u["actualizado"],
        "desde_cache": desde_cache,
        "error": error,
    }


@app.post("/saldo")
async def saldo(cred: Credenciales, x_api_key: str | None = Header(None)):
    if x_api_key != API_KEY:
        raise HTTPException(401, "API key inválida")

    num, h = cred.numero, huella(cred.password)
    u = usuario(num)

    async with u["lock"]:  # evita logins duplicados del mismo número
        ahora = time.time()
        u["ultimo_uso"] = ahora

        if u["fallidos"].get(h, 0) > ahora:
            raise HTTPException(429, "Login fallido reciente; espera unos minutos")

        mismo = u["huella"] is not None and hmac.compare_digest(u["huella"], h)

        # 1) Dato reciente y la contraseña coincide → respuesta inmediata
        if mismo and u["data"] and ahora - u["actualizado"] < CACHE_SEG:
            return resp(u, True)

        try:
            data = None
            # 2) Token vigente → consulta directa
            if mismo and u["token"] and u["exp"] > ahora + 60:
                data = await consultar(num, u["token"])

            # 3) Sin token, token vencido o contraseña distinta → login
            if data is None:
                try:
                    token = await login(num, cred.password)
                except LoginFallido:
                    u["fallidos"][h] = ahora + BLOQUEO_SEG
                    raise
                u.update(token=token, exp=jwt_exp(token), huella=h, data=None)
                mismo = True
                data = await consultar(num, token)
                if data is None:
                    raise RuntimeError("Telcel rechazó el token recién obtenido")

            u["data"] = parsear_home(data)
            u["actualizado"] = int(time.time())
            return resp(u, False)

        except LoginFallido as e:
            raise HTTPException(401, str(e))
        except Exception as e:
            log.error("Fallo para %s:\n%s", enmascarar(num), traceback.format_exc())
            if mismo and u["data"]:
                return resp(u, True, error=type(e).__name__)  # último dato bueno
            raise HTTPException(502, "No se pudo consultar Telcel")


@app.get("/health")
async def health():
    return {"ok": True, "usuarios_activos": len(usuarios)}
