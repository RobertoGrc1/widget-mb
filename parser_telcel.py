"""Transforma los bloques de respuesta de Telcel"""

import re
from datetime import date

MESES = {
    "enero": 1,
    "febrero": 2,
    "marzo": 3,
    "abril": 4,
    "mayo": 5,
    "junio": 6,
    "julio": 7,
    "agosto": 8,
    "septiembre": 9,
    "octubre": 10,
    "noviembre": 11,
    "diciembre": 12,
}

RE_PAQUETE = re.compile(
    r"^tabs-plans-v2-plan-name-(\d+-\d+-\d+)$"
)  # excluye los "-web-"


def indexar(nodo, out=None):
    """Recorre el árbol de bloques y arma un dict {id: config}."""
    if out is None:
        out = {}
    if isinstance(nodo, dict):
        if "id" in nodo and isinstance(nodo.get("config"), dict):
            out[nodo["id"]] = nodo["config"]
        for hijo in nodo.get("children") or []:
            indexar(hijo, out)
    return out


def _valor(b, bid):
    """Obtiene el valor de un bloque por su identificador."""
    return (b.get(bid) or {}).get("value")


def _visible(b, bid):
    """Indica si el bloque existe y no está oculto."""
    return bid in b and b[bid].get("visibility", True) is not False


def _a_float(txt):
    """Extrae el primer número de un texto y lo convierte a float."""
    if not txt:
        return None
    m = re.search(r"\d[\d,]*\.?\d*", txt)
    return float(m.group().replace(",", "")) if m else None


def _fecha_es(txt, hoy=None):
    """Convierte una fecha en español al año actual o al siguiente si ya pasó."""
    hoy = hoy or date.today()
    m = re.match(r"(\d{1,2}) de (\w+)", (txt or "").strip().lower())
    if not m or m.group(2) not in MESES:
        return None
    f = date(hoy.year, MESES[m.group(2)], int(m.group(1)))
    return f if f >= hoy else date(hoy.year + 1, f.month, f.day)


def _dias_desde_mensaje(cfg):
    """Extrae del mensaje la cantidad de días restantes, si está disponible."""
    texto = "".join(s.get("text", "") for s in (cfg or {}).get("segments", []))
    m = re.search(r"Faltan\s+(\d+)\s+d", texto)
    return int(m.group(1)) if m else None


def _parsear_paquetes(b):
    """Interpreta los bloques de consumo y vigencia de los paquetes."""
    paquetes = []
    for bid in b:
        m = RE_PAQUETE.match(bid)
        if not m:
            continue
        s = m.group(1)
        ilimitado = _visible(
            b, f"tabs-plans-v2-unlimited-content-{s}"
        ) and not _visible(b, f"tabs-plans-v2-limited-content-{s}")

        chart = {
            d.get("key"): d
            for d in (b.get(f"tabs-plans-v2-usage-chart-{s}") or {}).get("data", [])
        }
        disp_kb = chart.get("available", {}).get("value")
        usado_kb = chart.get("used", {}).get("value")
        total_kb = (
            (disp_kb + usado_kb)
            if disp_kb is not None and usado_kb is not None
            else None
        )

        msg_id = (
            f"tabs-plans-v2-unlimited-cutoff-message-{s}"
            if ilimitado
            else f"tabs-plans-v2-limited-cutoff-message-{s}"
        )

        unidad = _valor(b, f"tabs-plans-v2-available-data-unit-{s}") or ""
        texto_disponible = _valor(b, f"tabs-plans-v2-available-data-value-{s}") or ""
        paquetes.append(
            {
                "nombre": _valor(b, bid),
                "ilimitado": ilimitado,
                "disponible_mb": (
                    round(disp_kb / 1024, 1) if disp_kb is not None else None
                ),
                "usado_mb": round(usado_kb / 1024, 1) if usado_kb is not None else None,
                "total_mb": round(total_kb / 1024, 1) if total_kb else None,
                "porcentaje_disponible": (
                    round(disp_kb * 100 / total_kb, 1) if total_kb else None
                ),
                "disponible_texto": f"{texto_disponible} {unidad}".strip(),
                "dias_restantes": _dias_desde_mensaje(b.get(msg_id)),
                "actualizado_telcel": chart.get("available", {}).get("updatedAt"),
            }
        )
    return paquetes


def parsear_home(data: dict) -> dict:
    """Convierte la respuesta de inicio de Telcel a los datos del servicio."""
    b = indexar(data.get("blocks", {}))

    # Si Telcel mostró su tarjeta de error, mejor fallar para no guardar basura
    if _visible(b, "wrapper-error-card-1") or _visible(b, "wrapper-empty-sync-card"):
        raise RuntimeError("Telcel respondió con pantalla de error / sin sincronizar")

    venc_txt = _valor(b, "text-due-value")
    venc = _fecha_es(venc_txt)

    return {
        "plan": _valor(b, "text-plan-name"),
        "saldo_etiqueta": (_valor(b, "text-total-label") or "").rstrip(":"),
        "saldo": _a_float(_valor(b, "text-total-value")),
        "saldo_vence_texto": venc_txt,
        "saldo_vence_iso": venc.isoformat() if venc else None,
        "saldo_dias_restantes": (venc - date.today()).days if venc else None,
        "linea_suspendida": _visible(b, "wrapper-alert-suspension-status-blocked-line"),
        "paquetes": _parsear_paquetes(b),
    }
