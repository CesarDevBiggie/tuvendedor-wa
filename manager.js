"use strict";
// TuVendedor: administra TODOS los canales (principal incluido) con la misma API.
// Principal permanece en su contenedor original y volumen LocalAuth; la conexión
// se pausa/reanuda mediante sus rutas internas, sin mover archivos de sesión.
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
const PORT = Number(process.env.WA_MANAGER_PORT || "3200");
const STATE_DIR =
  process.env.WA_MANAGER_STATE_DIR || "/var/lib/tuvendedor-wa-manager";
const KEY = String(process.env.TUVENDEDOR_INTERNAL_KEY || "");
const LEGACY = process.env.WA_LEGACY_BRIDGE_URL || "http://tuvendedor_wa:3100";
const API = process.env.TUVENDEDOR_API_URL || "http://market_backend";
const file = path.join(STATE_DIR, "channels.json");
const running = new Map();
const restartTimers = new Map();
const stopping = new Map();
let channels = [];

if (!KEY || !API) {
  console.error("Faltan TUVENDEDOR_INTERNAL_KEY o TUVENDEDOR_API_URL.");
  process.exit(1);
}
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
for (const part of ["auth", "dedupe"])
  fs.mkdirSync(path.join(STATE_DIR, part), { recursive: true, mode: 0o700 });
if (fs.existsSync(file)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    channels = Array.isArray(parsed)
      ? parsed.filter((c) => /^[a-z0-9_-]{1,40}$/i.test(c.id))
      : [];
  } catch (err) {
    console.error(
      "Registro de canales ilegible. No se inicia para proteger las sesiones:",
      err.message,
    );
    process.exit(1);
  }
}
function save() {
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(channels, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function autorizado(req, res, next) {
  const provided = Buffer.from(
    String(req.headers["x-tuvendedor-internal-key"] || ""),
  );
  const expected = Buffer.from(KEY);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  )
    return res.status(401).json({ success: false, message: "No autorizado" });
  next();
}
app.use(autorizado);
function url(c) {
  return `http://127.0.0.1:${c.port}`;
}
function getChannel(req, res) {
  const c = channels.find((x) => x.id === req.params.id);
  if (!c) {
    res.status(404).json({ success: false, message: "Canal no encontrado" });
    return null;
  }
  return c;
}
function start(c) {
  if (c.operativo === false || running.has(c.id)) return;
  if (stopping.has(c.id)) {
    stopping.get(c.id).then(() => start(c));
    return;
  }
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(c.port),
    WA_CLIENT_ID: c.id,
    WA_CHANNEL_ID: c.id,
    WA_AUTH_DATA_PATH: path.join(STATE_DIR, "auth"),
    WA_FOLLOWUP_DEDUPE_FILE: path.join(STATE_DIR, "dedupe", `${c.id}.json`),
    WA_AUTORESPONDER_ENABLED: c.activo ? "true" : "false",
    WA_CONTROLLED_BY_MANAGER: "true",
    WA_DISABLE_ERROR_FALLBACK: "true",
    TUVENDEDOR_API_URL: API,
    WA_READY_GRACE_SECONDS: "5",
  };
  const proc = spawn(process.execPath, [path.join(__dirname, "app.js")], {
    cwd: __dirname,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  running.set(c.id, proc);
  console.log(
    `Canal ${c.id}: PID ${proc.pid}, puerto ${c.port}, IA ${c.activo}`,
  );
  proc.on("exit", (code, signal) => {
    if (running.get(c.id) !== proc) return;
    running.delete(c.id);
    console.warn(`Canal ${c.id}: salió ${code} ${signal}`);
    const t = setTimeout(() => {
      restartTimers.delete(c.id);
      if (c.operativo !== false && !running.has(c.id)) start(c);
    }, 10000);
    restartTimers.set(c.id, t);
  });
}
function stop(c) {
  const t = restartTimers.get(c.id);
  if (t) {
    clearTimeout(t);
    restartTimers.delete(c.id);
  }
  if (stopping.has(c.id)) return stopping.get(c.id);
  const proc = running.get(c.id);
  if (!proc) return Promise.resolve();
  // Evitamos abrir otro Chromium contra el mismo LocalAuth antes de que cierre.
  running.delete(c.id);
  const espera = new Promise((resolve) => {
    let terminado = false;
    const fin = () => {
      if (!terminado) {
        terminado = true;
        resolve();
      }
    };
    proc.once("exit", fin);
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_) {
        /* Puede haber terminado */
      }
      // No forzamos start hasta recibir exit, salvo que el proceso no exista.
    }, 11000);
    timeout.unref();
    proc.once("exit", () => clearTimeout(timeout));
    if (!proc.kill("SIGTERM")) fin();
  });
  const pending = espera.finally(() => stopping.delete(c.id));
  stopping.set(c.id, pending);
  return pending;
}
function restart(c) {
  if (c.operativo === false) return;
  void stop(c).then(() => start(c));
}
async function remote(c, route) {
  try {
    const r = await axios.get(url(c) + route, {
      timeout: 2500,
      headers: { "X-TuVendedor-Internal-Key": KEY },
    });
    return r.data;
  } catch {
    return null;
  }
}
async function legacy() {
  try {
    const r = await axios.get(LEGACY.replace(/\/$/, "") + "/admin/estado", {
      timeout: 3000,
      headers: { "X-TuVendedor-Internal-Key": KEY },
    });
    const info = r.data;
    if (!info?.success)
      throw new Error("El bridge principal no habilitó la administración");
    const operativo = info.operativo !== false;
    return {
      id: "principal",
      nombre: "WhatsApp principal",
      principal: true,
      editable: true,
      controlable: true,
      puedeQr: true,
      operativo,
      activo: info.atencionAutomatica === true && operativo,
      listo: Boolean(info.listo) && operativo,
      numero: info.numero || null,
      estado: !operativo
        ? "DESCONECTADO_MANUAL"
        : info.listo
          ? "CONECTADO"
          : info.esperandoQr
            ? "ESPERANDO_QR"
            : "INICIANDO",
      motivoDesconexion: info.motivoDesconexion || null,
      ultimoError: info.ultimoError || null,
    };
  } catch {
    return {
      id: "principal",
      nombre: "WhatsApp principal",
      principal: true,
      editable: false,
      controlable: false,
      puedeQr: false,
      operativo: true,
      activo: false,
      listo: false,
      numero: null,
      estado: "SIN_ACCESO",
      motivoDesconexion:
        "El bridge principal todavía no está actualizado o no responde.",
    };
  }
}
app.get("/api/channels", async (req, res) => {
  const [first, ...others] = await Promise.all([
    legacy(),
    ...channels.map(async (c) => {
      const operativo = c.operativo !== false;
      const info = operativo ? await remote(c, "/admin/estado") : null;
      if (info?.numero && c.numero !== info.numero) {
        c.numero = info.numero;
        save();
      }
      return {
        id: c.id,
        nombre: c.nombre,
        principal: false,
        editable: true,
        controlable: true,
        operativo,
        activo: info?.atencionAutomatica === true && c.activo === true,
        listo: Boolean(info?.listo),
        numero: info?.numero || c.numero || null,
        estado: !operativo
          ? "DESCONECTADO_MANUAL"
          : info?.listo
            ? "CONECTADO"
            : info?.esperandoQr
              ? "ESPERANDO_QR"
              : "INICIANDO",
        motivoDesconexion: info?.motivoDesconexion || null,
      };
    }),
  ]);
  res.json({ success: true, data: [first, ...others] });
});
app.post("/api/channels", (req, res) => {
  const nombre = String(req.body?.nombre || "").trim();
  if (nombre.length < 3 || nombre.length > 65)
    return res
      .status(400)
      .json({
        success: false,
        message: "Ingresá un nombre de 3 a 65 caracteres.",
      });
  if (channels.length >= 5)
    return res
      .status(409)
      .json({
        success: false,
        message: "Máximo 5 canales adicionales para esta instalación.",
      });
  const id = "wa" + crypto.randomBytes(8).toString("hex");
  const port = 3300 + Math.max(0, ...channels.map((x) => x.port - 3299));
  const nuevo = {
    id,
    nombre,
    port,
    activo: false,
    operativo: true,
    creado: new Date().toISOString(),
  };
  channels.push(nuevo);
  save();
  start(nuevo);
  res
    .status(201)
    .json({
      success: true,
      data: { id, nombre, activo: false },
      message: "Canal creado en modo pruebas. Esperá el QR.",
    });
});
function qrSvg(cadena) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(cadena);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const size = count + margin * 2;
  const rects = ['<rect width="100%" height="100%" fill="#fff"/>'];
  for (let y = 0; y < count; y++)
    for (let x = 0; x < count; x++)
      if (qr.isDark(y, x))
        rects.push(
          `<rect x="${x + margin}" y="${y + margin}" width="1" height="1" fill="#111827"/>`,
        );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}
app.get("/api/channels/:id/qr", async (req, res) => {
  let info;
  if (req.params.id === "principal") {
    try {
      const rr = await axios.get(LEGACY.replace(/\/$/, "") + "/admin/qr", {
        timeout: 2500,
        headers: { "X-TuVendedor-Internal-Key": KEY },
      });
      info = { qr: rr.data?.qr, listo: rr.data?.listo };
    } catch {
      return res
        .status(503)
        .json({
          success: false,
          message:
            "El bridge principal no responde. Actualizá su app.js para mostrar el QR en pantalla.",
        });
    }
  } else {
    const c = getChannel(req, res);
    if (!c) return;
    if (c.operativo === false)
      return res
        .status(409)
        .json({
          success: false,
          message:
            "El canal está desconectado temporalmente. Conectalo para mostrar su QR.",
        });
    info = await remote(c, "/admin/qr");
  }
  if (!info)
    return res
      .status(503)
      .json({
        success: false,
        message:
          "El canal está iniciándose. Volvé a intentar en unos segundos.",
      });
  if (info.listo)
    return res.json({
      success: true,
      data: { listo: true, imagen: null },
      message: "Este número ya está vinculado.",
    });
  if (!info.qr)
    return res
      .status(202)
      .json({
        success: true,
        data: { listo: false, imagen: null },
        message: "Esperando que WhatsApp genere un QR.",
      });
  const svg = qrSvg(info.qr);
  return res.json({
    success: true,
    data: {
      listo: false,
      imagen:
        "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
    },
  });
});
async function principalPost(ruta, res, method, body) {
  try {
    const resp = await axios({
      method,
      url: LEGACY.replace(/\/$/, "") + ruta,
      data: body,
      timeout: 15000,
      headers: { "X-TuVendedor-Internal-Key": KEY },
    });
    return res.status(resp.status).json(resp.data);
  } catch (err) {
    return res.status(err.response?.status || 503).json({
      success: false,
      message:
        err.response?.data?.message ||
        "El bridge principal todavía no admite esta operación o no responde. No se modificó su configuración.",
    });
  }
}
app.put("/api/channels/:id/attention", async (req, res) => {
  if (typeof req.body?.activo !== "boolean")
    return res
      .status(400)
      .json({ success: false, message: "activo debe ser booleano" });
  if (req.params.id === "principal")
    return principalPost("/admin/attention", res, "PUT", {
      activo: req.body.activo,
    });
  const c = getChannel(req, res);
  if (!c) return;
  if (c.operativo === false)
    return res
      .status(409)
      .json({
        success: false,
        message:
          "Conectá primero el número. Por seguridad la IA quedará pausada.",
      });
  const deseado = req.body.activo;
  // Persistimos la intención antes de responder. Verificamos el estado REAL del bridge.
  c.activo = deseado;
  save();
  let confirmado = false;
  try {
    const respuesta = await axios.put(
      url(c) + "/admin/attention",
      { activo: deseado },
      { timeout: 3500, headers: { "X-TuVendedor-Internal-Key": KEY } },
    );
    confirmado =
      respuesta.data?.success === true &&
      respuesta.data?.data?.activo === deseado;
  } catch (e) {
    console.warn(
      `Canal ${c.id}: sin confirmación de pausa/activación: ${e.message}`,
    );
  }
  if (!confirmado) {
    if (!deseado) {
      await stop(c); // FALLA SEGURA: no responder si el bridge no confirma la pausa.
      // El canal permanece configurado como operativo y volverá con IA pausada.
      start(c);
      return res
        .status(202)
        .json({
          success: true,
          data: { id: c.id, activo: false, confirmado: false },
          message:
            "IA pausada por seguridad. Reiniciando bridge sin respuestas; verificá el estado antes de usarlo.",
        });
    }
    // Activación: nunca informar éxito si el bridge todavía no la confirmó.
    c.activo = false;
    save();
    return res
      .status(503)
      .json({
        success: false,
        message:
          "No fue posible confirmar la activación de la IA. Permanece pausada.",
      });
  }
  return res.json({
    success: true,
    data: { id: c.id, activo: deseado, confirmado: true },
    message: deseado
      ? "IA activada y confirmada por el bridge."
      : "IA pausada y confirmada por el bridge.",
  });
});
app.post("/api/channels/:id/connection", (req, res) => {
  if (typeof req.body?.conectar !== "boolean")
    return res
      .status(400)
      .json({ success: false, message: "conectar debe ser booleano" });
  if (req.params.id === "principal")
    return principalPost("/admin/connection", res, "POST", {
      conectar: req.body.conectar,
    });
  const c = getChannel(req, res);
  if (!c) return;
  const conectar = req.body.conectar;
  if (conectar) {
    if (c.operativo !== true) {
      c.operativo = true;
      c.activo = false;
      save();
      start(c);
    }
    return res.json({
      success: true,
      data: { operativo: true, activo: c.activo },
      message:
        "Conexión iniciándose. Panambí permanece pausado; si la sesión expiró, escaneá el QR.",
    });
  }
  if (c.operativo !== false) {
    c.operativo = false;
    c.activo = false;
    save();
    stop(c);
  }
  return res.json({
    success: true,
    data: { operativo: false, activo: false },
    message:
      "Canal desconectado temporalmente. Se conserva su vinculación para reconectarlo sin QR mientras WhatsApp la mantenga válida.",
  });
});
app.post("/api/channels/:id/logout", async (req, res) => {
  if (req.params.id === "principal")
    return principalPost("/admin/logout", res, "POST", null);
  const c = getChannel(req, res);
  if (!c) return;
  if (c.operativo === false)
    return res
      .status(409)
      .json({
        success: false,
        message: "Conectá el canal primero para cerrar sesión en WhatsApp.",
      });
  const info = await remote(c, "/admin/estado");
  if (!info?.listo)
    return res
      .status(409)
      .json({
        success: false,
        message:
          "WhatsApp no está conectado. Esperá la conexión antes de cerrar sesión.",
      });
  // Desactivar el autoreinicio ANTES de desvincular para no abrir un navegador
  // mientras whatsapp-web.js limpia LocalAuth.
  c.operativo = false;
  c.activo = false;
  save();
  try {
    const r = await axios.post(
      url(c) + "/admin/logout",
      {},
      { timeout: 20000, headers: { "X-TuVendedor-Internal-Key": KEY } },
    );
    stop(c);
    return res.json({
      success: true,
      message:
        r.data?.message ||
        "Sesión cerrada. Para volver a vincular el número, pulsá Conectar y escaneá el QR.",
    });
  } catch (e) {
    stop(c);
    return res
      .status(e.response?.status || 503)
      .json({
        success: false,
        message:
          e.response?.data?.message ||
          "No se pudo confirmar el cierre de sesión. El canal quedó detenido y con Panambí pausado; no se borraron manualmente credenciales.",
      });
  }
});
app.post("/api/channels/:id/restart", (req, res) => {
  if (req.params.id === "principal")
    return principalPost("/admin/restart", res, "POST", {});
  const c = getChannel(req, res);
  if (!c) return;
  if (c.operativo === false)
    return res
      .status(409)
      .json({
        success: false,
        message: "El canal está desconectado. Utilizá Conectar.",
      });
  restart(c);
  res.json({
    success: true,
    message: "Reiniciando sesión. Las credenciales vinculadas se conservarán.",
  });
});
for (const c of channels) start(c);
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(
    `Administrador WA en :${PORT}, ${channels.length} canales registrados.`,
  ),
);
function shutdown() {
  for (const t of restartTimers.values()) clearTimeout(t);
  for (const p of running.values()) p.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
