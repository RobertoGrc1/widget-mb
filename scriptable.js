// Configuración 
const URL = "https://tu-app.up.railway.app/saldo";
const KEY = "TU_API_KEY";
const KC_NUM = "telcel_numero", KC_PWD = "telcel_password", KC_CACHE = "telcel_cache";

// Credenciales 
const tieneCred = () => Keychain.contains(KC_NUM) && Keychain.contains(KC_PWD);

async function aviso(titulo, msg) {
  const a = new Alert(); a.title = titulo; a.message = msg; a.addAction("OK");
  await a.present();
}

async function pedirCredenciales() {
  const a = new Alert();
  a.title = "Mi Telcel";
  a.message = "Tus datos se guardan solo en el Llavero de este iPhone y se envían por HTTPS al servidor para consultar tu consumo.";
  a.addTextField("Número (10 dígitos)", Keychain.contains(KC_NUM) ? Keychain.get(KC_NUM) : "");
  a.addSecureTextField("Contraseña", "");
  a.addAction("Guardar");
  a.addCancelAction("Cancelar");
  if (await a.present() === -1) return false;

  const n = a.textFieldValue(0).replace(/\D/g, "");
  const p = a.textFieldValue(1);
  if (n.length !== 10 || p.length < 6) {
    await aviso("Datos inválidos", "El número debe tener 10 dígitos y la contraseña al menos 6 caracteres.");
    return false;
  }
  Keychain.set(KC_NUM, n);
  Keychain.set(KC_PWD, p);
  if (Keychain.contains(KC_CACHE)) Keychain.remove(KC_CACHE);
  return true;
}

function borrarTodo() {
  [KC_NUM, KC_PWD, KC_CACHE].forEach(k => Keychain.contains(k) && Keychain.remove(k));
}

// Consulta al servidor 
async function consultar() {
  const r = new Request(URL);
  r.method = "POST";
  r.headers = { "Content-Type": "application/json", "x-api-key": KEY };
  r.body = JSON.stringify({ numero: Keychain.get(KC_NUM), password: Keychain.get(KC_PWD) });
  r.timeoutInterval = 90;

  const raw = await r.loadString();
  const st = r.response.statusCode;
  let j = {};
  try { j = JSON.parse(raw); } catch {}

  if (st === 200 && j.data) {
    Keychain.set(KC_CACHE, JSON.stringify(j));
    return j;
  }
  const detalle = typeof j.detail === "string" ? j.detail : (st === 422 ? "Datos inválidos" : `Error ${st}`);
  throw new Error(detalle);
}

// Dibujo 
const fmt = mb => mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : Math.round(mb) + " MB";
const colorPct = p => p < 15 ? new Color("#E33B4D") : p < 40 ? new Color("#FFCB31") : new Color("#8CC14B");

function barra(pct, color, w = 130, h = 6) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h); ctx.opaque = false; ctx.respectScreenScale = true;
  const bg = new Path(); bg.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  ctx.addPath(bg); ctx.setFillColor(new Color("#ffffff", 0.2)); ctx.fillPath();
  const fg = new Path(); fg.addRoundedRect(new Rect(0, 0, Math.max(h, w * pct / 100), h), h / 2, h / 2);
  ctx.addPath(fg); ctx.setFillColor(color); ctx.fillPath();
  return ctx.getImage();
}

function texto(w, s, size, color = Color.white(), bold = false) {
  const t = w.addText(s);
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
}

function construirWidget(res, avisoTxt) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#16212C");
  w.setPadding(12, 14, 12, 14);
  w.url = URLScheme.forRunningScript();
  w.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);

  texto(w, "📶 Telcel", 12, new Color("#83CEF6"), true);
  w.addSpacer(4);

  const d = res && res.data;
  if (d && d.paquetes && d.paquetes.length) {
    const p = d.paquetes[0];
    if (d.linea_suspendida) texto(w, "⚠️ Línea suspendida", 11, new Color("#FF6961"), true);

    if (p.ilimitado) {
      texto(w, "Ilimitado", 22, new Color("#66E2FC"), true);
    } else {
      texto(w, fmt(p.disponible_mb), 24, colorPct(p.porcentaje_disponible), true);
      texto(w, `de ${fmt(p.total_mb)} · ${p.porcentaje_disponible}%`, 10, new Color("#C8C8C8"));
      w.addSpacer(4);
      const img = w.addImage(barra(p.porcentaje_disponible, colorPct(p.porcentaje_disponible)));
      img.imageSize = new Size(130, 6);
    }

    w.addSpacer(6);
    if (p.dias_restantes != null) texto(w, `⏳ Paquete: ${p.dias_restantes} días`, 11);
    if (d.saldo != null) texto(w, `💰 $${d.saldo.toFixed(2)} · vence ${d.saldo_vence_texto}`, 10, new Color("#C8C8C8"));

    w.addSpacer();
    const hora = new Date(res.actualizado * 1000)
      .toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
    texto(w, `Act. ${hora}` + (avisoTxt || res.error ? " ⚠️" : ""), 9, new Color("#9fb0e0"));
  } else {
    texto(w, avisoTxt || "Sin datos aún", 11, Color.yellow());
  }
  return w;
}

// Flujo principal 
async function main() {
  // Menú solo al abrirlo en la app
  if (config.runsInApp) {
    if (!tieneCred()) {
      if (!(await pedirCredenciales())) return;
    } else {
      const m = new Alert();
      m.title = "Widget Telcel";
      m.addAction("Ver mi consumo");
      m.addAction("Cambiar número/contraseña");
      m.addDestructiveAction("Borrar mis datos de este iPhone");
      m.addCancelAction("Cancelar");
      const op = await m.present();
      if (op === -1) return;
      if (op === 1 && !(await pedirCredenciales())) return;
      if (op === 2) { borrarTodo(); await aviso("Listo", "Se borraron tus datos de este iPhone."); return; }
    }
  }

  let res = null, avisoTxt = null;
  if (!tieneCred()) {
    avisoTxt = "Toca para configurar tu número";
  } else {
    try {
      res = await consultar();
    } catch (e) {
      avisoTxt = e.message;
      if (Keychain.contains(KC_CACHE)) res = JSON.parse(Keychain.get(KC_CACHE));
      if (config.runsInApp) await aviso("No se pudo actualizar", e.message);
    }
  }

  const w = construirWidget(res, avisoTxt);
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentSmall();
}

await main();
Script.complete();