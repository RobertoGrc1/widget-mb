// Widget Mi Telcel para Scriptable

// Configuración

const URL = "https://tu-app.up.railway.app/saldo";
const KEY = "TU_API_KEY";

// Qué mostrar (pon false lo que no quieras ver)
const MOSTRAR = {
  usados: true, // "3.42 GB de 3.56 GB"
  vencimiento: true, // "20 nov · 8 días"
  ritmoDiario: true, // "~18 MB/día" para que te alcance
  saldo: true, // "$9.12"
  otrosPaquetes: true, // solo en el widget grande
  botonActualizar: true, // botón ↻ en mediano y grande
};

// Umbrales: % disponible y días para el vencimiento
const U = { rojo: 15, amarillo: 40, diasAlerta: 2, alertaNotifPct: 10 };
const REFRESCO_MIN = 20;

// El widget reutiliza la última consulta si tiene menos de estos minutos
const CACHE_MIN = 15;
// Toques repetidos a "Actualizar" dentro de estos segundos no vuelven a consultar
const ESPERA_MANUAL_SEG = 30;

const KC_NUM = "telcel_numero";
const KC_PWD = "telcel_password";
const KC_CACHE = "telcel_cache";
const KC_NOTIF = "telcel_notif_enviada";

// Colores
const C = {
  fondo: Color.dynamic(new Color("#F2F2F7"), new Color("#1C1C1E")),
  tarjeta: Color.dynamic(new Color("#FFFFFF"), new Color("#2C2C2E")),
  texto: Color.dynamic(new Color("#000000"), new Color("#FFFFFF")),
  secundario: Color.dynamic(
    new Color("#3C3C43", 0.65),
    new Color("#EBEBF5", 0.65),
  ),
  terciario: Color.dynamic(
    new Color("#3C3C43", 0.4),
    new Color("#EBEBF5", 0.4),
  ),
  separador: Color.dynamic(
    new Color("#3C3C43", 0.18),
    new Color("#EBEBF5", 0.16),
  ),
  acento: Color.dynamic(new Color("#007AFF"), new Color("#0A84FF")),
  botonFondo: Color.dynamic(
    new Color("#007AFF", 0.12),
    new Color("#0A84FF", 0.24),
  ),
};

const TONO = {
  verde: {
    txt: Color.dynamic(new Color("#248A3D"), new Color("#30D158")),
    fondo: Color.dynamic(
      new Color("#34C759", 0.14),
      new Color("#30D158", 0.18),
    ),
  },
  amarillo: {
    txt: Color.dynamic(new Color("#B25000"), new Color("#FFD60A")),
    fondo: Color.dynamic(
      new Color("#FF9500", 0.14),
      new Color("#FFD60A", 0.16),
    ),
  },
  rojo: {
    txt: Color.dynamic(new Color("#D70015"), new Color("#FF453A")),
    fondo: Color.dynamic(
      new Color("#FF3B30", 0.12),
      new Color("#FF453A", 0.18),
    ),
  },
  cian: {
    txt: Color.dynamic(new Color("#0071A4"), new Color("#64D2FF")),
    fondo: Color.dynamic(
      new Color("#32ADE6", 0.14),
      new Color("#64D2FF", 0.18),
    ),
  },
};

// Gráficos: escala continua según % disponible
const ESCALA = [
  [0, "#FF3B30"], // rojo
  [U.rojo, "#FF9500"], // naranja
  [U.amarillo, "#FFCC00"], // amarillo
  [70, "#34C759"], // verde
  [100, "#34C759"],
];
const CIAN_GRAFICO = new Color("#32ADE6");
const PISTA = new Color("#8E8E93", 0.24);

// Credenciales
const tieneCred = () => Keychain.contains(KC_NUM) && Keychain.contains(KC_PWD);

function leerRespaldo() {
  if (!Keychain.contains(KC_CACHE)) return null;
  try {
    return JSON.parse(Keychain.get(KC_CACHE));
  } catch {
    return null;
  }
}

// Milisegundos desde que se guardó la última consulta exitosa
function edadCache(cache) {
  return cache && cache._guardado ? Date.now() - cache._guardado : Infinity;
}

async function aviso(titulo, msg) {
  const a = new Alert();
  a.title = titulo;
  a.message = msg;
  a.addAction("OK");
  await a.present();
}

async function pedirCredenciales() {
  const a = new Alert();
  a.title = "Mi Telcel";
  a.message =
    "Tus datos se guardan solo en el Llavero de este iPhone y se envían por HTTPS al servidor para consultar tu consumo.";
  a.addTextField(
    "Número (10 dígitos)",
    Keychain.contains(KC_NUM) ? Keychain.get(KC_NUM) : "",
  );
  a.addSecureTextField("Contraseña", "");
  a.addAction("Guardar");
  a.addCancelAction("Cancelar");
  if ((await a.present()) === -1) return false;

  const n = a.textFieldValue(0).replace(/\D/g, "");
  const p = a.textFieldValue(1);
  if (n.length !== 10 || p.length < 6) {
    await aviso(
      "Datos inválidos",
      "El número debe tener 10 dígitos y la contraseña al menos 6 caracteres.",
    );
    return false;
  }
  Keychain.set(KC_NUM, n);
  Keychain.set(KC_PWD, p);
  if (Keychain.contains(KC_CACHE)) Keychain.remove(KC_CACHE);
  if (Keychain.contains(KC_NOTIF)) Keychain.remove(KC_NOTIF);
  return true;
}

function borrarTodo() {
  [KC_NUM, KC_PWD, KC_CACHE, KC_NOTIF].forEach(
    (k) => Keychain.contains(k) && Keychain.remove(k),
  );
}

// Notificaciones
async function verificarNotificacion(res) {
  const d = res && res.data;
  const p = d && d.paquetes && d.paquetes[0];
  if (!p || p.ilimitado || p.porcentaje_disponible == null) return;

  const pct = p.porcentaje_disponible;
  if (pct <= U.alertaNotifPct) {
    if (!Keychain.contains(KC_NOTIF)) {
      const n = new Notification();
      n.title = "Te quedan pocos datos";
      n.body = `Queda ${Math.round(pct)}% (${fmt(p.disponible_mb)}) de ${p.nombre || "tu paquete"}.`;
      n.sound = "default";
      n.openURL = URLScheme.forRunningScript();
      await n.schedule();
      Keychain.set(KC_NOTIF, String(Date.now()));
    }
  } else if (Keychain.contains(KC_NOTIF)) {
    Keychain.remove(KC_NOTIF);
  }
}

// Consulta
async function consultar() {
  const r = new Request(API_URL);
  r.method = "POST";
  r.headers = { "Content-Type": "application/json", "x-api-key": KEY };
  r.body = JSON.stringify({
    numero: Keychain.get(KC_NUM),
    password: Keychain.get(KC_PWD),
  });
  r.timeoutInterval = 90;

  const raw = await r.loadString();
  const st = r.response.statusCode;
  let j = {};
  try {
    j = JSON.parse(raw);
  } catch {}

  if (st === 200 && j.data) {
    j._guardado = Date.now();
    Keychain.set(KC_CACHE, JSON.stringify(j));
    return j;
  }
  throw new Error(
    typeof j.detail === "string"
      ? j.detail
      : st === 422
        ? "Datos inválidos"
        : `Error ${st}`,
  );
}

// Formato y estado
function partesMB(mb) {
  if (mb == null) return { valor: "—", unidad: "" };
  if (mb >= 1024) {
    const gb = mb / 1024;
    return { valor: gb >= 10 ? gb.toFixed(1) : gb.toFixed(2), unidad: "GB" };
  }
  return { valor: String(Math.round(mb)), unidad: "MB" };
}

function fmt(mb) {
  const x = partesMB(mb);
  return `${x.valor} ${x.unidad}`.trim();
}

const dinero = (v) => `$${Number(v).toFixed(2)}`;
const textoDias = (n) => (n === 0 ? "hoy" : n === 1 ? "1 día" : `${n} días`);
const textoVence = (n) => (n === 0 ? "Vence hoy" : `Vence en ${textoDias(n)}`);
const pctPaquete = (p) => (p.ilimitado ? 100 : (p.porcentaje_disponible ?? 0));

function fechaEnDias(n) {
  const f = new Date();
  f.setDate(f.getDate() + n);
  return f
    .toLocaleDateString("es-MX", { day: "numeric", month: "short" })
    .replace(".", "");
}

// Cuánto puedes usar por día para que te alcance hasta el vencimiento
function ritmo(p) {
  if (p.ilimitado || p.disponible_mb == null || !p.dias_restantes) return null;
  return p.disponible_mb / Math.max(1, p.dias_restantes);
}

function tonoPct(pct) {
  return pct < U.rojo
    ? TONO.rojo
    : pct < U.amarillo
      ? TONO.amarillo
      : TONO.verde;
}

function tonoPaquete(p) {
  return p.ilimitado ? TONO.cian : tonoPct(p.porcentaje_disponible ?? 100);
}

function colorDias(n) {
  return n <= U.diasAlerta
    ? TONO.rojo.txt
    : n <= 5
      ? TONO.amarillo.txt
      : C.texto;
}

function estado(p, d) {
  if (d && d.linea_suspendida)
    return { txt: "Línea suspendida", tono: TONO.rojo };
  if (p.ilimitado) return { txt: "Datos ilimitados", tono: TONO.cian };
  const pct = p.porcentaje_disponible ?? 100;
  if (pct < U.rojo) return { txt: "Te quedan pocos datos", tono: TONO.rojo };
  if (p.dias_restantes != null && p.dias_restantes <= U.diasAlerta)
    return { txt: "Tu paquete vence pronto", tono: TONO.amarillo };
  if (pct < U.amarillo) return { txt: "Cuida tus datos", tono: TONO.amarillo };
  return { txt: "Vas bien", tono: TONO.verde };
}

// Color continuo verde -> amarillo -> naranja -> rojo
function hexRGB(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbHex(rgb) {
  return (
    "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
  );
}

function colorFluido(pct) {
  const v = Math.max(0, Math.min(100, pct));
  for (let i = 1; i < ESCALA.length; i++) {
    const [p1, c1] = ESCALA[i - 1];
    const [p2, c2] = ESCALA[i];
    if (v <= p2) {
      const t = p2 === p1 ? 0 : (v - p1) / (p2 - p1);
      const a = hexRGB(c1);
      const b = hexRGB(c2);
      return new Color(rgbHex(a.map((x, k) => x + (b[k] - x) * t)));
    }
  }
  return new Color(ESCALA[ESCALA.length - 1][1]);
}

const colorGrafico = (p) =>
  p.ilimitado ? CIAN_GRAFICO : colorFluido(p.porcentaje_disponible ?? 100);

// Ancho aproximado del widget según el iPhone (para las barras)
function anchoWidget(familia) {
  const s = Device.screenSize();
  const sw = Math.min(s.width, s.height);
  const tabla = [
    [428, 170, 364],
    [414, 169, 360],
    [390, 158, 338],
    [375, 155, 329],
    [0, 141, 292],
  ];
  const f = tabla.find((t) => sw >= t[0]);
  return familia === "small" ? f[1] : f[2];
}

// URL del script con parámetros, sin duplicar "?"
function urlScript(params) {
  const base = URLScheme.forRunningScript();
  const sep = base.includes("?") ? "&" : "?";
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return base + sep + q;
}

// Dibujo
function anillo(pct, color, tam, grosor, pista = PISTA) {
  const ctx = new DrawContext();
  ctx.size = new Size(tam, tam);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const c = tam / 2;
  const r = (tam - grosor) / 2;
  const punto = (g) => {
    const a = ((g - 90) * Math.PI) / 180;
    return new Point(c + r * Math.cos(a), c + r * Math.sin(a));
  };
  const arco = (hasta, col) => {
    const pasos = Math.max(2, Math.ceil(hasta / 2));
    const pts = [];
    for (let i = 0; i <= pasos; i++) pts.push(punto((hasta * i) / pasos));
    const path = new Path();
    path.addLines(pts);
    ctx.addPath(path);
    ctx.setStrokeColor(col);
    ctx.setLineWidth(grosor);
    ctx.strokePath();
  };
  const tapa = (g, col) => {
    const q = punto(g);
    ctx.setFillColor(col);
    ctx.fillEllipse(
      new Rect(q.x - grosor / 2, q.y - grosor / 2, grosor, grosor),
    );
  };

  arco(360, pista);
  if (pct > 0) {
    const g = Math.max(4, (360 * Math.min(pct, 100)) / 100);
    arco(g, color);
    tapa(0, color);
    tapa(g, color);
  }
  return ctx.getImage();
}

function barra(pct, color, ancho, alto, pista = PISTA) {
  const ctx = new DrawContext();
  ctx.size = new Size(ancho, alto);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const rr = (w, col) => {
    const p = new Path();
    p.addRoundedRect(new Rect(0, 0, w, alto), alto / 2, alto / 2);
    ctx.addPath(p);
    ctx.setFillColor(col);
    ctx.fillPath();
  };
  rr(ancho, pista);
  if (pct > 0) rr(Math.max(alto, (ancho * Math.min(pct, 100)) / 100), color);
  return ctx.getImage();
}

// Componentes
function texto(stack, s, font, color, escala) {
  const t = stack.addText(String(s));
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  if (escala) t.minimumScaleFactor = escala;
  return t;
}

// Texto en su propia fila, alineado a la izquierda
function linea(stack, s, font, color, escala) {
  const r = stack.addStack();
  const t = texto(r, s, font, color, escala);
  r.addSpacer();
  return t;
}

function centrado(stack, s, font, color, escala) {
  const r = stack.addStack();
  r.addSpacer();
  const t = texto(r, s, font, color, escala);
  r.addSpacer();
  return t;
}

function icono(stack, nombre, color, tam, semibold = false) {
  const sym = SFSymbol.named(nombre);
  if (!sym) return null;
  sym.applyFont(semibold ? Font.semiboldSystemFont(tam) : Font.systemFont(tam));
  const img = stack.addImage(sym.image);
  img.imageSize = new Size(tam, tam);
  img.tintColor = color;
  return img;
}

// Fila: ícono + etiqueta a la izquierda, valor a la derecha
function fila(stack, simbolo, etiqueta, valor, colorValor = C.texto) {
  const r = stack.addStack();
  r.centerAlignContent();
  const caja = r.addStack();
  caja.size = new Size(14, 13);
  caja.centerAlignContent();
  icono(caja, simbolo, C.secundario, 10);
  r.addSpacer(4);
  texto(r, etiqueta, Font.regularSystemFont(11), C.secundario);
  r.addSpacer(8);
  r.addSpacer();
  texto(r, valor, Font.semiboldSystemFont(11), colorValor, 0.7);
  return r;
}

function chipEstado(stack, e) {
  const r = stack.addStack();
  const s = r.addStack();
  s.centerAlignContent();
  s.backgroundColor = e.tono.fondo;
  s.cornerRadius = 8;
  s.setPadding(2, 7, 2, 8);
  texto(s, "●", Font.systemFont(7), e.tono.txt);
  s.addSpacer(4);
  texto(s, e.txt, Font.semiboldSystemFont(11), e.tono.txt, 0.7);
  r.addSpacer();
  return r;
}

function botonActualizar(stack, url, conTexto) {
  const b = stack.addStack();
  b.url = url;
  b.backgroundColor = C.botonFondo;
  b.centerAlignContent();
  if (conTexto) {
    b.cornerRadius = 11;
    b.setPadding(4, 9, 4, 10);
    icono(b, "arrow.clockwise", C.acento, 10, true);
    b.addSpacer(4);
    texto(b, "Actualizar", Font.semiboldSystemFont(11), C.acento);
  } else {
    b.size = new Size(24, 24);
    b.cornerRadius = 12;
    icono(b, "arrow.clockwise", C.acento, 11, true);
  }
  return b;
}

function tarjeta(stack) {
  const t = stack.addStack();
  t.backgroundColor = C.tarjeta;
  t.cornerRadius = 14;
  t.setPadding(10, 12, 10, 12);
  return t;
}

function encabezado(stack, o = {}) {
  const h = stack.addStack();
  h.centerAlignContent();
  icono(h, "antenna.radiowaves.left.and.right", C.acento, 12, true);
  h.addSpacer(5);
  texto(h, "Telcel", Font.semiboldSystemFont(13), C.acento);
  h.addSpacer();
  if (o.derecha)
    texto(h, o.derecha, Font.mediumSystemFont(11), C.secundario, 0.7);
  if (o.colorPunto) {
    if (o.derecha) h.addSpacer(6);
    texto(h, "●", Font.systemFont(9), o.colorPunto);
  }
  if (o.url) {
    h.addSpacer(8);
    botonActualizar(h, o.url, true);
  }
  if (o.iconoRefresco) {
    h.addSpacer(6);
    icono(h, "arrow.clockwise", C.terciario, 11, true);
  }
  return h;
}

function pie(stack, res, desactualizado) {
  const f = stack.addStack();
  f.centerAlignContent();
  if (!res || !res.actualizado) return f;

  const color = desactualizado ? TONO.amarillo.txt : C.terciario;
  icono(
    f,
    desactualizado ? "exclamationmark.triangle.fill" : "clock",
    color,
    9,
  );
  f.addSpacer(4);
  texto(
    f,
    desactualizado ? "Sin actualizar · hace " : "Actualizado hace ",
    Font.regularSystemFont(10),
    color,
  );
  const fe = f.addDate(new Date(res.actualizado * 1000));
  fe.applyRelativeStyle();
  fe.font = Font.regularSystemFont(10);
  fe.textColor = color;
  fe.lineLimit = 1;
  return f;
}

function anilloConTexto(padre, p, o) {
  const {
    tam,
    grosor,
    num,
    colorTexto = C.texto,
    colorUnidad = C.secundario,
    pista = PISTA,
    etiqueta = true,
    colorAnillo,
    desactualizado = false,
  } = o;

  const s = padre.addStack();
  s.size = new Size(tam, tam);
  s.backgroundImage = anillo(
    pctPaquete(p),
    colorAnillo || colorGrafico(p),
    tam,
    grosor,
    pista,
  );
  s.layoutVertically();
  s.addSpacer();

  const x = p.ilimitado
    ? { valor: "∞", unidad: "" }
    : partesMB(p.disponible_mb);
  centrado(
    s,
    x.valor,
    Font.boldRoundedSystemFont(num),
    desactualizado ? C.secundario : colorTexto,
    0.5,
  );
  if (x.unidad)
    centrado(
      s,
      x.unidad,
      Font.semiboldRoundedSystemFont(Math.round(num * 0.45)),
      colorUnidad,
    );
  if (etiqueta)
    centrado(
      s,
      p.ilimitado ? "ilimitado" : "te quedan",
      Font.regularSystemFont(Math.round(num * 0.38)),
      C.terciario,
    );

  s.addSpacer();
  return s;
}

function filasDatos(p, d, claves) {
  const r = ritmo(p);
  const n = p.dias_restantes;
  let saldoTxt = d.saldo != null ? dinero(d.saldo) : null;
  if (saldoTxt && claves.includes("saldoConVence") && d.saldo_vence_texto)
    saldoTxt += ` · vence ${d.saldo_vence_texto}`;

  const todas = {
    usados:
      MOSTRAR.usados && !p.ilimitado && p.total_mb
        ? [
            "chart.bar.fill",
            "Usados",
            `${fmt(p.usado_mb)} de ${fmt(p.total_mb)}`,
            C.texto,
          ]
        : null,
    vence:
      MOSTRAR.vencimiento && n != null
        ? [
            "calendar",
            "Vence",
            `${fechaEnDias(n)} · ${textoDias(n)}`,
            colorDias(n),
          ]
        : null,
    ritmo:
      MOSTRAR.ritmoDiario && r != null
        ? ["speedometer", "Puedes usar", `~${fmt(r)}/día`, C.texto]
        : null,
    saldo:
      MOSTRAR.saldo && saldoTxt
        ? ["dollarsign.circle", d.saldo_etiqueta || "Saldo", saldoTxt, C.texto]
        : null,
  };
  return claves
    .map((k) => todas[k === "saldoConVence" ? "saldo" : k])
    .filter(Boolean);
}

// Anillo + nombre + estado + filas (mediano y grande)
function cuerpo(stack, res, d, p, o) {
  const b = stack.addStack();
  b.centerAlignContent();

  anilloConTexto(b, p, {
    tam: o.anillo,
    grosor: o.grosor,
    num: o.num,
    desactualizado: o.desactualizado,
  });
  b.addSpacer(14);

  const col = b.addStack();
  col.layoutVertically();

  const t = col.addStack();
  t.centerAlignContent();
  texto(
    t,
    p.nombre || d.plan || "Mi paquete",
    Font.semiboldSystemFont(14),
    C.texto,
    0.7,
  );
  t.addSpacer();
  if (o.urlBoton) {
    t.addSpacer(6);
    botonActualizar(t, o.urlBoton, false);
  }

  col.addSpacer(o.urlBoton ? 1 : 3);
  chipEstado(col, estado(p, d));
  col.addSpacer(7);

  filasDatos(p, d, o.filas).forEach((f, i) => {
    if (i > 0) col.addSpacer(o.espacioFilas ?? 3);
    fila(col, ...f);
  });

  if (o.conPie) {
    col.addSpacer(6);
    pie(col, res, o.desactualizado);
  }
  return b;
}

function paqueteEnLista(stack, q, anchoBarra) {
  const r = stack.addStack();
  r.centerAlignContent();
  texto(r, q.nombre || "Paquete", Font.semiboldSystemFont(12), C.texto, 0.7);
  if (q.dias_restantes != null) {
    const cd = colorDias(q.dias_restantes);
    r.addSpacer(6);
    texto(
      r,
      `· ${textoDias(q.dias_restantes)}`,
      Font.regularSystemFont(11),
      cd === C.texto ? C.terciario : cd,
    );
  }
  r.addSpacer();
  texto(
    r,
    q.ilimitado ? "Ilimitado" : `${fmt(q.disponible_mb)} de ${fmt(q.total_mb)}`,
    Font.mediumSystemFont(11),
    C.secundario,
    0.7,
  );

  stack.addSpacer(5);
  const rb = stack.addStack();
  const img = rb.addImage(barra(pctPaquete(q), colorGrafico(q), anchoBarra, 6));
  img.imageSize = new Size(anchoBarra, 6);
  rb.addSpacer();
}

function tarjetaSaldo(stack, d) {
  const t = tarjeta(stack);
  t.layoutVertically();

  const r1 = t.addStack();
  r1.centerAlignContent();
  icono(r1, "dollarsign.circle.fill", C.acento, 15);
  r1.addSpacer(6);
  texto(r1, d.saldo_etiqueta || "Saldo", Font.semiboldSystemFont(13), C.texto);
  r1.addSpacer();
  texto(r1, dinero(d.saldo), Font.boldRoundedSystemFont(17), C.texto);

  if (d.saldo_vence_texto) {
    t.addSpacer(2);
    const dias =
      d.saldo_dias_restantes != null
        ? ` · ${textoDias(d.saldo_dias_restantes)}`
        : "";
    linea(
      t,
      `Vence el ${d.saldo_vence_texto}${dias}`,
      Font.regularSystemFont(11),
      C.secundario,
      0.8,
    );
  }
  return t;
}

// Widgets de pantalla de inicio
function chico(w, res, d, p, desactualizado) {
  w.setPadding(14, 14, 14, 14);
  encabezado(w, {
    colorPunto: desactualizado ? TONO.amarillo.txt : estado(p, d).tono.txt,
    iconoRefresco: tieneCred(),
  });

  w.addSpacer();
  const f = w.addStack();
  f.addSpacer();
  anilloConTexto(f, p, { tam: 86, grosor: 9, num: 22, desactualizado });
  f.addSpacer();
  w.addSpacer();

  const pi = w.addStack();
  pi.centerAlignContent();
  pi.addSpacer();
  if (p.dias_restantes != null) {
    const cd = colorDias(p.dias_restantes);
    const col = cd === C.texto ? C.secundario : cd;
    icono(pi, "calendar", col, 10);
    pi.addSpacer(4);
    texto(
      pi,
      textoVence(p.dias_restantes),
      Font.semiboldSystemFont(11),
      col,
      0.8,
    );
  } else {
    const e = estado(p, d);
    texto(pi, e.txt, Font.semiboldSystemFont(11), e.tono.txt, 0.7);
  }
  pi.addSpacer();
}

function mediano(w, res, d, p, desactualizado, urlActualizar) {
  w.setPadding(14, 14, 14, 16);
  cuerpo(w, res, d, p, {
    anillo: 106,
    grosor: 11,
    num: 26,
    filas: ["usados", "vence", "ritmo", "saldo"],
    espacioFilas: 2,
    conPie: true,
    urlBoton: MOSTRAR.botonActualizar && tieneCred() ? urlActualizar : null,
    desactualizado,
  });
}

function grande(w, res, d, p, desactualizado, urlActualizar, avisoTxt) {
  w.setPadding(16, 16, 16, 16);
  const anchoUtil = anchoWidget("large") - 32;
  const otros = MOSTRAR.otrosPaquetes ? (d.paquetes || []).slice(1, 3) : [];
  const conTarjetaSaldo =
    MOSTRAR.saldo && d.saldo != null && otros.length === 0;

  encabezado(w, {
    derecha: d.plan,
    url: MOSTRAR.botonActualizar && tieneCred() ? urlActualizar : null,
  });
  w.addSpacer(12);

  // "Usados" está en la tarjeta de abajo; el saldo va en fila o en tarjeta según espacio
  const filas = ["vence", "ritmo"];
  if (!conTarjetaSaldo) filas.push("saldoConVence");
  if (p.ilimitado || !p.total_mb) filas.unshift("usados");

  cuerpo(w, res, d, p, {
    anillo: 104,
    grosor: 11,
    num: 26,
    filas,
    conPie: false,
    desactualizado,
  });

  if (!p.ilimitado && p.total_mb) {
    w.addSpacer(12);
    const t = tarjeta(w);
    t.layoutHorizontally();
    t.centerAlignContent();
    const cols = [
      ["Incluidos", fmt(p.total_mb), C.texto],
      ["Usados", fmt(p.usado_mb), C.texto],
      ["Te quedan", fmt(p.disponible_mb), tonoPaquete(p).txt],
    ];
    t.addSpacer();
    cols.forEach(([et, val, col], i) => {
      if (i > 0) {
        const div = t.addStack();
        div.size = new Size(1, 28);
        div.backgroundColor = C.separador;
        t.addSpacer();
      }
      const c = t.addStack();
      c.layoutVertically();
      centrado(c, et, Font.regularSystemFont(10), C.secundario);
      c.addSpacer(2);
      centrado(c, val, Font.boldRoundedSystemFont(15), col, 0.6);
      t.addSpacer();
    });
  }

  if (otros.length) {
    w.addSpacer(10);
    linea(w, "Otros paquetes", Font.semiboldSystemFont(12), C.secundario);
    otros.forEach((q) => {
      w.addSpacer(8);
      paqueteEnLista(w, q, anchoUtil);
    });
  }

  if (conTarjetaSaldo) {
    w.addSpacer(10);
    tarjetaSaldo(w, d);
  }

  w.addSpacer();
  const f = pie(w, res, desactualizado);
  if (avisoTxt) {
    f.addSpacer(6);
    texto(f, avisoTxt, Font.regularSystemFont(10), TONO.amarillo.txt, 0.7);
  }
}

// Pantalla bloqueada (iOS 16+)
function lockCircular(w, p) {
  w.addAccessoryWidgetBackground = true;
  const s = w.addStack();
  s.addSpacer();
  anilloConTexto(s, p, {
    tam: 58,
    grosor: 6,
    num: 16,
    colorTexto: Color.white(),
    colorUnidad: new Color("#FFFFFF", 0.75),
    pista: new Color("#FFFFFF", 0.3),
    etiqueta: false,
    colorAnillo: Color.white(),
  });
  s.addSpacer();
}

function lockRect(w, p) {
  const blanco = Color.white();
  const tenue = new Color("#FFFFFF", 0.75);

  const r1 = w.addStack();
  r1.centerAlignContent();
  icono(r1, "antenna.radiowaves.left.and.right", blanco, 11, true);
  r1.addSpacer(4);
  texto(
    r1,
    p.ilimitado ? "Ilimitado" : fmt(p.disponible_mb),
    Font.boldRoundedSystemFont(15),
    blanco,
  );
  if (!p.ilimitado && p.porcentaje_disponible != null) {
    r1.addSpacer(4);
    texto(
      r1,
      `${Math.round(p.porcentaje_disponible)}%`,
      Font.mediumSystemFont(12),
      tenue,
    );
  }
  r1.addSpacer();

  if (!p.ilimitado) {
    w.addSpacer(3);
    const img = w.addImage(
      barra(pctPaquete(p), blanco, 150, 5, new Color("#FFFFFF", 0.3)),
    );
    img.imageSize = new Size(150, 5);
  }
  if (p.dias_restantes != null) {
    w.addSpacer(3);
    linea(w, textoVence(p.dias_restantes), Font.systemFont(11), tenue);
  }
}

function lockInline(w, p) {
  const sym = SFSymbol.named("antenna.radiowaves.left.and.right");
  if (sym) w.addImage(sym.image);
  const dias =
    p.dias_restantes != null ? ` · ${textoDias(p.dias_restantes)}` : "";
  w.addText(
    p.ilimitado ? `Ilimitado${dias}` : `${fmt(p.disponible_mb)}${dias}`,
  );
}

// Sin datos
function sinDatos(w, familia, avisoTxt) {
  const msg = avisoTxt || "Sin datos aún";

  if (familia === "accessoryInline") {
    w.addText(msg);
    return;
  }
  if (familia.startsWith("accessory")) {
    linea(w, "Mi Telcel", Font.boldSystemFont(12), Color.white());
    const t = linea(
      w,
      msg,
      Font.systemFont(10),
      new Color("#FFFFFF", 0.75),
      0.6,
    );
    t.lineLimit = 2;
    return;
  }

  w.setPadding(14, 14, 14, 14);
  encabezado(w);
  w.addSpacer();
  const r = w.addStack();
  r.centerAlignContent();
  icono(r, "exclamationmark.triangle.fill", TONO.amarillo.txt, 18);
  r.addSpacer(8);
  const t = texto(r, msg, Font.semiboldSystemFont(13), C.texto, 0.7);
  t.lineLimit = 3;
  w.addSpacer();
}

// Construcción
function construirWidget(familia, res, avisoTxt) {
  const w = new ListWidget();
  const urlActualizar = urlScript({ actualizar: "1", tam: familia });

  // Chico: tocarlo actualiza. Mediano/grande: botón ↻ actualiza, el resto abre el menú.
  w.url =
    familia === "small" && tieneCred()
      ? urlActualizar
      : URLScheme.forRunningScript();
  w.refreshAfterDate = new Date(Date.now() + REFRESCO_MIN * 60000);
  if (!familia.startsWith("accessory")) w.backgroundColor = C.fondo;

  const d = res && res.data;
  const p = d && d.paquetes && d.paquetes[0];
  if (!p) {
    sinDatos(w, familia, avisoTxt);
    return w;
  }

  const desactualizado = !!avisoTxt;

  switch (familia) {
    case "small":
      chico(w, res, d, p, desactualizado);
      break;
    case "large":
    case "extraLarge":
      grande(w, res, d, p, desactualizado, urlActualizar, avisoTxt);
      break;
    case "accessoryCircular":
      lockCircular(w, p);
      break;
    case "accessoryRectangular":
      lockRect(w, p);
      break;
    case "accessoryInline":
      lockInline(w, p);
      break;
    default:
      mediano(w, res, d, p, desactualizado, urlActualizar);
  }
  return w;
}

// Flujo principal
async function main() {
  const qp = args.queryParameters || {};
  const enWidget = config.runsInWidget || config.runsInAccessoryWidget;
  const desdeBoton = config.runsInApp && qp.actualizar === "1";
  let familia = config.widgetFamily || qp.tam || "medium";

  // forzar = consultar aunque haya datos recientes guardados
  let forzar = false;

  if (config.runsInApp) {
    if (!tieneCred()) {
      if (!(await pedirCredenciales())) return;
      forzar = true;
    } else if (desdeBoton) {
      // Botón ↻: funciona como "Actualizar ahora", sin mostrar el menú
      forzar = true;
    } else {
      const m = new Alert();
      m.title = "Widget Telcel";
      m.message = "Elige una opción o administra tu cuenta.";
      [
        "Actualizar ahora",
        "Vista previa: chico",
        "Vista previa: mediano",
        "Vista previa: grande",
        "Cambiar número/contraseña",
      ].forEach((x) => m.addAction(x));
      m.addDestructiveAction("Borrar mis datos de este iPhone");
      m.addCancelAction("Cancelar");

      const op = await m.present();
      if (op === -1) return;
      if (op === 5) {
        borrarTodo();
        await aviso("Listo", "Se borraron tus datos de este iPhone.");
        return;
      }
      if (op === 4 && !(await pedirCredenciales())) return;
      forzar = op === 0 || op === 4;
      familia = ["medium", "small", "medium", "large", "medium"][op];
    }
  }

  let res = null;
  let avisoTxt = null;

  if (!tieneCred()) {
    avisoTxt = "Toca para configurar tu número";
  } else {
    const cache = leerRespaldo();
    const edad = edadCache(cache);
    const usarCache = forzar
      ? edad < ESPERA_MANUAL_SEG * 1000 // evita doble toque
      : edad < CACHE_MIN * 60000; // widget o vista previa con datos recientes

    if (usarCache) {
      res = cache;
    } else {
      // Una sola petición
      try {
        res = await consultar();
        await verificarNotificacion(res);
      } catch (e) {
        avisoTxt = e.message;
        res = cache;
        if (config.runsInApp) await aviso("No se pudo actualizar", e.message);
      }
    }
  }

  const w = construirWidget(familia, res, avisoTxt);

  // setWidget solo dentro del widget; en la app, vista previa
  if (enWidget) {
    Script.setWidget(w);
  } else {
    const vista = familia.startsWith("accessory") ? "medium" : familia;
    const wv = vista === familia ? w : construirWidget(vista, res, avisoTxt);
    if (vista === "small") await wv.presentSmall();
    else if (vista === "large" || vista === "extraLarge")
      await wv.presentLarge();
    else await wv.presentMedium();
  }
}

await main();
Script.complete();
