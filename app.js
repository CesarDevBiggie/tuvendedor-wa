const fs = require("fs");

const path = require("path");

const dotenv = require("dotenv");

const express = require("express");

const qrcode = require("qrcode-terminal");

const axios = require("axios");

const cors = require("cors");

const { Client, LocalAuth } = require("whatsapp-web.js");

const { registrarSeguimientoRoutes } = require("./seguimiento-routes");

// ============================================================

// ENTORNO: DEVELOPMENT / PRODUCTION

// ============================================================

//

// DESARROLLO:

//   NODE_ENV=development

//   Carga .env.development

//

// PRODUCCION / DOCKER:

//   NODE_ENV=production

//   Carga .env.production si existe.

//   Si Docker ya inyectó las variables con env_file, se respetan.

//

// dotenv NO sobreescribe variables ya existentes.

// ============================================================

const NODE_ENV = String(process.env.NODE_ENV || "development")
  .trim()

  .toLowerCase();

const ES_PRODUCCION = NODE_ENV === "production";

const ARCHIVO_ENV_ESPERADO = ES_PRODUCCION
  ? ".env.production"
  : ".env.development";

let archivoEntornoCargado = null;

const rutaEnvEsperada = path.resolve(
  process.cwd(),

  ARCHIVO_ENV_ESPERADO,
);

if (fs.existsSync(rutaEnvEsperada)) {
  dotenv.config({
    path: rutaEnvEsperada,

    override: false,
  });

  archivoEntornoCargado = ARCHIVO_ENV_ESPERADO;
} else if (!ES_PRODUCCION) {
  // Compatibilidad temporal con el .env anterior en desarrollo.

  const rutaEnvLegacy = path.resolve(
    process.cwd(),

    ".env",
  );

  if (fs.existsSync(rutaEnvLegacy)) {
    dotenv.config({
      path: rutaEnvLegacy,

      override: false,
    });

    archivoEntornoCargado = ".env";
  }
}

// ============================================================

// CONFIGURACION

// ============================================================

const app = express();

const PORT = Number(process.env.PORT || 3100);

const TUVENDEDOR_API_URL = (
  process.env.TUVENDEDOR_API_URL ||
  (ES_PRODUCCION ? "http://market_backend" : "http://localhost:5151")
).replace(/\/$/, "");

const TUVENDEDOR_INTERNAL_KEY = process.env.TUVENDEDOR_INTERNAL_KEY || "";

const WHISPER_URL =
  process.env.WHISPER_URL ||
  (ES_PRODUCCION
    ? "http://tuvendedor_whisper:8001/transcribe"
    : "http://127.0.0.1:8001/transcribe");

const WA_HEADLESS =
  String(process.env.WA_HEADLESS ?? "true").toLowerCase() === "true";

const WA_EXECUTABLE_PATH = String(
  process.env.WA_EXECUTABLE_PATH || (ES_PRODUCCION ? "/usr/bin/chromium" : ""),
).trim();

const WA_CLIENT_ID = String(
  process.env.WA_CLIENT_ID || "tuvendedor-local",
).trim();

const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 130000);

const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 120000);

const WA_MEDIA_DOWNLOAD_ATTEMPTS = Math.max(
  1,
  Number(process.env.WA_MEDIA_DOWNLOAD_ATTEMPTS || 3),
);

const WA_MEDIA_DOWNLOAD_RETRY_MS = Math.max(
  200,
  Number(process.env.WA_MEDIA_DOWNLOAD_RETRY_MS || 900),
);

// Evita responder mensajes sincronizados durante el arranque, pero sin dejar

// al bot "ciego" demasiado tiempo después de quedar listo.

const SEGUNDOS_GRACIA_READY = Number(process.env.WA_READY_GRACE_SECONDS || 2);

const TTL_MENSAJE_PROCESADO_MS = 60 * 60 * 1000;

// Ventana en la que un "Execution context was destroyed" es esperable porque

// WhatsApp Web está navegando para volver a la pantalla de vinculación.

const VENTANA_REAUTENTICACION_MS = 30 * 1000;

if (!TUVENDEDOR_INTERNAL_KEY) {
  console.error(
    `❌ Falta TUVENDEDOR_INTERNAL_KEY para el entorno ${NODE_ENV}.`,
  );

  console.error(
    `   Configurá ${ARCHIVO_ENV_ESPERADO} o inyectá la variable desde Docker.`,
  );

  process.exit(1);
}

if (ES_PRODUCCION && /localhost|127\.0\.0\.1/i.test(TUVENDEDOR_API_URL)) {
  console.error(
    "❌ Configuración inválida: en producción TUVENDEDOR_API_URL no debe apuntar a localhost.",
  );

  console.error("   Dentro de Docker usá: http://market_backend");

  process.exit(1);
}

app.use(cors());

app.use(express.json({ limit: "25mb" }));

// ============================================================

// ESTADO

// ============================================================

let whatsappReady = false;

let procesarMensajesDesde = null;

let esperandoNuevaVinculacion = false;

let ultimoLogoutEn = 0;

let ultimoMotivoDesconexion = null;

let ultimoLogDesconexionEn = 0;

let reinicioProgramado = false;

let cerrandoAplicacion = false;

const PROCESO_INICIADO_EN = Math.floor(Date.now() / 1000);

const mensajesProcesados = new Map();

setInterval(
  () => {
    const limite = Date.now() - TTL_MENSAJE_PROCESADO_MS;

    for (const [id, fecha] of mensajesProcesados.entries()) {
      if (fecha < limite) {
        mensajesProcesados.delete(id);
      }
    }
  },

  10 * 60 * 1000,
).unref();

// ============================================================

// HELPERS DE RECUPERACION

// ============================================================

function esErrorContextoNavegacion(error) {
  const mensaje = String(error?.message || error || "");

  return (
    mensaje.includes("Execution context was destroyed") ||
    mensaje.includes("Cannot find context with specified id") ||
    mensaje.includes("Inspected target navigated or closed")
  );
}

function esErrorLocalAuthBloqueado(error) {
  const mensaje = String(error?.message || error || "");

  return (
    mensaje.includes("EBUSY") &&
    (mensaje.includes(".wwebjs_auth") ||
      mensaje.includes("session-tuvendedor-local") ||
      mensaje.includes("first_party_sets"))
  );
}

function estamosEnReautenticacion() {
  return (
    esperandoNuevaVinculacion ||
    (ultimoLogoutEn > 0 &&
      Date.now() - ultimoLogoutEn < VENTANA_REAUTENTICACION_MS)
  );
}

function programarReinicio(motivo, demoraMs = 2500) {
  if (reinicioProgramado || cerrandoAplicacion) {
    return;
  }

  reinicioProgramado = true;

  whatsappReady = false;

  procesarMensajesDesde = null;

  console.error("");

  console.error("============================================");

  console.error("🔄 REINICIO NECESARIO");

  console.error("Motivo:", motivo);

  console.error("============================================");

  console.error("");

  setTimeout(() => {
    process.exit(1);
  }, demoraMs).unref();
}

// ============================================================

// WHATSAPP CLIENT

// ============================================================

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: WA_CLIENT_ID,

    rmMaxRetries: 30,
  }),

  // Si WhatsApp Web entra en conflicto con otra pestaña/sesión web,

  // esta instancia intenta conservar el control.

  takeoverOnConflict: true,

  takeoverTimeoutMs: 5000,

  puppeteer: {
    headless: WA_HEADLESS,

    ...(WA_EXECUTABLE_PATH ? { executablePath: WA_EXECUTABLE_PATH } : {}),

    args: [
      "--no-sandbox",

      "--disable-setuid-sandbox",

      "--disable-dev-shm-usage",

      "--no-first-run",

      "--no-default-browser-check",

      "--disable-background-timer-throttling",

      "--disable-backgrounding-occluded-windows",

      "--disable-renderer-backgrounding",
    ],
  },
});

client.on("qr", (qr) => {
  whatsappReady = false;

  procesarMensajesDesde = null;

  esperandoNuevaVinculacion = true;

  console.log("");

  console.log("============================================");

  console.log("📱 QR GENERADO");

  console.log("Escanealo desde WhatsApp > Dispositivos vinculados");

  console.log("============================================");

  console.log("");

  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  esperandoNuevaVinculacion = false;

  console.log("✅ WHATSAPP AUTENTICADO");
});

client.on("loading_screen", (percent, message) => {
  console.log(`⏳ WhatsApp cargando: ${percent}% - ${message}`);
});

client.on("ready", () => {
  whatsappReady = true;

  esperandoNuevaVinculacion = false;

  ultimoMotivoDesconexion = null;

  reinicioProgramado = false;

  procesarMensajesDesde = Math.floor(Date.now() / 1000) + SEGUNDOS_GRACIA_READY;

  console.log("");

  console.log("============================================");

  console.log("✅ WHATSAPP LISTO");

  console.log(`🌐 Backend: ${TUVENDEDOR_API_URL}`);

  console.log(`🎙️ Whisper: ${WHISPER_URL}`);

  console.log("🛡️ Solo responde mensajes entrantes individuales");

  console.log("🛡️ Grupos/estados/broadcast ignorados");

  console.log("🛡️ Mensajes propios e históricos ignorados");

  console.log("============================================");

  console.log("");
});

client.on("auth_failure", (msg) => {
  whatsappReady = false;

  procesarMensajesDesde = null;

  esperandoNuevaVinculacion = true;

  console.error("❌ ERROR DE AUTENTICACION WHATSAPP");

  console.error(msg);

  console.error("📱 Se esperará una nueva vinculación por QR.");
});

client.on("disconnected", (reason) => {
  whatsappReady = false;

  procesarMensajesDesde = null;

  const motivo = String(reason || "DESCONOCIDO");

  const ahora = Date.now();

  // whatsapp-web.js puede emitir LOGOUT más de una vez durante la misma

  // navegación. Evitamos ensuciar el log y, sobre todo, evitamos programar

  // varios cierres/reinicios a la vez.

  const desconexionDuplicada =
    ultimoMotivoDesconexion === motivo && ahora - ultimoLogDesconexionEn < 3000;

  ultimoMotivoDesconexion = motivo;

  ultimoLogDesconexionEn = ahora;

  if (!desconexionDuplicada) {
    console.log("");

    console.log("============================================");

    console.log("⚠️ WHATSAPP DESCONECTADO");

    console.log("Motivo:", motivo);

    console.log("============================================");

    console.log("");
  }

  if (motivo.toUpperCase() === "LOGOUT") {
    // IMPORTANTE:

    // Si el usuario elimina el dispositivo desde el celular, LocalAuth queda

    // invalidado. La propia librería navega nuevamente al flujo de QR.

    // NO cerramos Node aquí: dejamos que aparezca el QR y se vuelva a vincular.

    ultimoLogoutEn = ahora;

    esperandoNuevaVinculacion = true;

    if (!desconexionDuplicada) {
      console.log("📱 La sesión fue cerrada desde WhatsApp.");

      console.log("⏳ Esperando que WhatsApp genere un nuevo QR...");

      console.log("");
    }

    return;
  }

  // Para desconexiones reales distintas de LOGOUT, levantamos una instancia

  // limpia. Más adelante PM2 será quien la inicie automáticamente.

  programarReinicio(`WhatsApp desconectado: ${motivo}`, 3000);
});

// ============================================================

// MENSAJES ENTRANTES

// ============================================================

client.on("message", async (msg) => {
  const textoOriginal = String(msg.body || "").trim();

  console.log("");

  console.log("============================================");

  console.log("📩 MENSAJE ENTRANTE");

  console.log("De:", msg.from);

  console.log("Tipo:", msg.type);

  console.log("Timestamp:", msg.timestamp);

  console.log("Texto:", textoOriginal);

  console.log("============================================");

  if (!debeProcesarse(msg)) {
    return;
  }

  const idMensaje = obtenerIdMensaje(msg);

  if (idMensaje && mensajesProcesados.has(idMensaje)) {
    console.log("⏭️ Ignorado: mensaje duplicado.");

    return;
  }

  if (idMensaje) {
    mensajesProcesados.set(idMensaje, Date.now());
  }

  try {
    const identidad = await obtenerIdentidadCliente(msg);

    if (!identidad.identificador) {
      console.log("⏭️ No se pudo identificar al cliente.");
      return;
    }

    const entrada = await construirEntradaBackend(msg, textoOriginal);

    if (!entrada) {
      console.log(`⏭️ Tipo ${msg.type} no soportado.`);

      return;
    }

    const idPublicacion = extraerIdPublicacion(entrada.mensaje);

    const payload = {
      // Identificador estable de la conversación. Puede ser un LID.
      // El backend lo utiliza para conservar el contexto de la conversación.
      telefono: identidad.identificador,

      // Datos comerciales reales del contacto.
      numeroWhatsapp: identidad.numeroWhatsapp ?? null,
      nombreContacto: identidad.nombreContacto ?? null,

      mensaje: entrada.mensaje,
      idPublicacion: idPublicacion ?? null,
      tipoMensaje: entrada.tipoMensaje,
      mediaBase64: entrada.mediaBase64 ?? null,
      mediaMimeType: entrada.mediaMimeType ?? null,
      mediaNombre: entrada.mediaNombre ?? null,
    };

    console.log("👤 Identificador conversación:", identidad.identificador);
    console.log(
      "📱 Teléfono real:",
      identidad.numeroWhatsapp || "(no resuelto)",
    );
    console.log(
      "🪪 Nombre WhatsApp:",
      identidad.nombreContacto || "(sin nombre)",
    );
    console.log("📨 Tipo backend:", payload.tipoMensaje);

    if (entrada.transcripcion) {
      console.log("🎙️ Transcripción:", entrada.transcripcion);
    }

    console.log("🤖 Consultando TuVendedor Back...");

    const response = await axios.post(
      `${TUVENDEDOR_API_URL}/api/ia/motos/conversacion`,

      payload,

      {
        headers: {
          "Content-Type": "application/json",

          "X-TuVendedor-Internal-Key": TUVENDEDOR_INTERNAL_KEY,
        },

        timeout: BACKEND_TIMEOUT_MS,

        maxBodyLength: Infinity,

        maxContentLength: Infinity,
      },
    );

    const body = response.data;

    const data = body?.Data ?? body?.data;

    const respuesta = data?.respuesta ?? data?.Respuesta;

    // Modo HUMANO: backend puede devolver vacío.

    if (!respuesta || !String(respuesta).trim()) {
      console.log("ℹ️ Backend no indicó respuesta automática.");

      return;
    }

    console.log("🤖 Panambí:", respuesta);

    // Verificamos otra vez el estado porque el backend puede tardar y WhatsApp

    // podría haberse desconectado durante esa espera.

    if (!whatsappReady) {
      console.log(
        "⚠️ La respuesta quedó lista, pero WhatsApp se desconectó antes de enviarla.",
      );

      return;
    }

    await msg.reply(String(respuesta));

    console.log("✅ Respuesta enviada al cliente que escribió.");
  } catch (error) {
    console.error("❌ ERROR PROCESANDO MENSAJE");

    if (error.response) {
      console.error("HTTP:", error.response.status);

      console.error("Backend:", error.response.data);
    } else {
      console.error("Código:", error?.code ?? "(sin código)");

      console.error("Mensaje:", error?.message ?? String(error));

      console.error("Stack:", error?.stack ?? "(sin stack disponible)");
    }

    // Si el error fue provocado por una navegación/desconexión de WhatsApp,

    // no intentamos responder usando un contexto de Chromium ya destruido.

    if (!whatsappReady || esErrorContextoNavegacion(error)) {
      console.log(
        "ℹ️ No se envía contingencia porque WhatsApp está reconectando.",
      );

      return;
    }

    try {
      await msg.reply(
        "Un momentito 😊 Estoy revisando tu consulta. En breve seguimos desde donde quedamos 🙌",
      );
    } catch (replyError) {
      console.error(
        "❌ No se pudo enviar contingencia:",

        replyError?.message || String(replyError),
      );
    }
  }
});

// ============================================================

// CONSTRUIR ENTRADA PARA BACKEND

// ============================================================

async function construirEntradaBackend(msg, textoOriginal) {
  if (msg.type === "chat") {
    if (!textoOriginal) {
      return null;
    }

    return {
      tipoMensaje: "TEXTO",

      mensaje: textoOriginal,
    };
  }

  if (msg.type === "ptt" || msg.type === "audio") {
    const media = await descargarMediaSeguro(msg, "AUDIO");

    if (!media?.data) {
      throw new Error("WhatsApp no permitió descargar el audio.");
    }

    const transcripcion = await transcribirAudio(media);

    if (!transcripcion) {
      throw new Error("No se pudo obtener texto del audio.");
    }

    return {
      tipoMensaje: "AUDIO",

      mensaje: transcripcion,

      transcripcion,
    };
  }

  if (msg.type === "image") {
    const media = await descargarMediaSeguro(msg, "IMAGEN");

    if (!media?.data) {
      throw new Error("WhatsApp no permitió descargar la imagen.");
    }

    return {
      tipoMensaje: "IMAGEN",

      mensaje: textoOriginal,

      mediaBase64: media.data,

      mediaMimeType: media.mimetype,

      mediaNombre: media.filename || `imagen_${Date.now()}`,
    };
  }

  if (msg.type === "document") {
    const media = await descargarMediaSeguro(msg, "DOCUMENTO");

    if (!media?.data) {
      throw new Error("WhatsApp no permitió descargar el documento.");
    }

    return {
      tipoMensaje: "DOCUMENTO",

      mensaje: textoOriginal,

      mediaBase64: media.data,

      mediaMimeType: media.mimetype,

      mediaNombre: media.filename || `documento_${Date.now()}`,
    };
  }

  return null;
}

// ============================================================

// WHISPER LOCAL

// ============================================================

async function transcribirAudio(media) {
  console.log("🎙️ Transcribiendo audio localmente...");

  const response = await axios.post(
    WHISPER_URL,

    {
      data: media.data,

      mimetype: media.mimetype || "audio/ogg",
    },

    {
      timeout: WHISPER_TIMEOUT_MS,

      maxBodyLength: Infinity,

      maxContentLength: Infinity,
    },
  );

  return String(response.data?.text || "").trim();
}

// ============================================================

// FILTROS DE SEGURIDAD

// ============================================================

function debeProcesarse(msg) {
  if (!whatsappReady) {
    console.log("⏭️ Ignorado: WhatsApp aún no está listo.");

    return false;
  }

  if (!procesarMensajesDesde) {
    console.log("⏭️ Ignorado: protección inicial activa.");

    return false;
  }

  const ahora = Math.floor(Date.now() / 1000);

  if (ahora < procesarMensajesDesde) {
    console.log("⏭️ Ignorado: sincronización inicial.");

    return false;
  }

  if (
    msg.timestamp &&
    (msg.timestamp < PROCESO_INICIADO_EN ||
      msg.timestamp < procesarMensajesDesde)
  ) {
    console.log("⏭️ Ignorado: mensaje histórico.");

    return false;
  }

  if (msg.fromMe) {
    console.log("⏭️ Ignorado: mensaje propio.");

    return false;
  }

  if (!msg.from) {
    console.log("⏭️ Ignorado: sin remitente.");

    return false;
  }

  if (msg.from.endsWith("@g.us")) {
    console.log("⏭️ Ignorado: mensaje de grupo.");

    return false;
  }

  if (msg.from === "status@broadcast" || msg.from.includes("@broadcast")) {
    console.log("⏭️ Ignorado: estado/broadcast.");

    return false;
  }

  const tiposPermitidos = new Set([
    "chat",

    "ptt",

    "audio",

    "image",

    "document",
  ]);

  if (!tiposPermitidos.has(msg.type)) {
    console.log(`⏭️ Ignorado: tipo ${msg.type}.`);

    return false;
  }

  return true;
}

// ============================================================

// COMPATIBILIDAD WHATSAPP WEB 2.3000.x / CHATS @lid

// ============================================================

function asegurarIdSerializadoMensaje(msg) {
  const id = msg?.id;

  if (!id || typeof id !== "object") {
    return null;
  }

  if (id._serialized) {
    return id._serialized;
  }

  const serializado =
    id.$1 ||
    (typeof id.fromMe !== "undefined" && id.remote && id.id
      ? `${id.fromMe}_${id.remote}_${id.id}`
      : null);

  if (!serializado) {
    return null;
  }

  try {
    id._serialized = serializado;
  } catch {
    try {
      msg.id = {
        ...id,

        _serialized: serializado,
      };
    } catch {
      return null;
    }
  }

  return serializado;
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limpiarBase64Media(valor) {
  const texto = String(valor || "").trim();

  if (!texto) {
    return "";
  }

  const indiceBase64 = texto.indexOf(";base64,");

  const soloBase64 =
    indiceBase64 >= 0
      ? texto.substring(indiceBase64 + ";base64,".length)
      : texto;

  return soloBase64.replace(/\s+/g, "");
}

function normalizarMimeType(valor) {
  return String(valor || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function inferirMimeImagenDesdeBase64(base64) {
  try {
    const cabecera = Buffer.from(base64.slice(0, 64), "base64");

    if (
      cabecera.length >= 3 &&
      cabecera[0] === 0xff &&
      cabecera[1] === 0xd8 &&
      cabecera[2] === 0xff
    ) {
      return "image/jpeg";
    }

    if (
      cabecera.length >= 8 &&
      cabecera[0] === 0x89 &&
      cabecera[1] === 0x50 &&
      cabecera[2] === 0x4e &&
      cabecera[3] === 0x47
    ) {
      return "image/png";
    }

    if (
      cabecera.length >= 12 &&
      cabecera.toString("ascii", 0, 4) === "RIFF" &&
      cabecera.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }

    return null;
  } catch {
    return null;
  }
}

function normalizarMediaDescargada(media, tipo) {
  const data = limpiarBase64Media(media?.data);

  if (!data) {
    throw new Error(`WhatsApp no devolvió datos para el archivo ${tipo}.`);
  }

  let mimetype = normalizarMimeType(media?.mimetype);

  if (tipo === "IMAGEN" && !mimetype) {
    mimetype = inferirMimeImagenDesdeBase64(data) || "";
  }

  if (tipo === "IMAGEN" && !mimetype.startsWith("image/")) {
    throw new Error(
      `La media recibida como imagen no tiene un MIME de imagen válido (${mimetype || "sin MIME"}).`,
    );
  }

  const padding = data.match(/=*$/)?.[0]?.length ?? 0;
  const bytesAprox = Math.max(0, Math.floor((data.length * 3) / 4) - padding);

  return {
    ...media,
    data,
    mimetype,
    bytesAprox,
  };
}

async function descargarMediaSeguro(msg, tipo) {
  const serializado = asegurarIdSerializadoMensaje(msg);

  console.log(`🧩 ID media ${tipo}:`, serializado || "(sin id serializado)");

  if (!serializado) {
    console.error("❌ No se pudo reconstruir el ID serializado del mensaje.");

    console.error("ID recibido:", JSON.stringify(msg?.id ?? null));

    throw new Error(
      "No se pudo identificar el mensaje multimedia de WhatsApp.",
    );
  }

  let ultimoError = null;

  for (let intento = 1; intento <= WA_MEDIA_DOWNLOAD_ATTEMPTS; intento += 1) {
    try {
      const mediaCruda = await msg.downloadMedia();
      const media = normalizarMediaDescargada(mediaCruda, tipo);

      console.log(
        `✅ Media ${tipo} descargada desde WhatsApp` +
          (intento > 1 ? ` en intento ${intento}` : ""),
      );

      console.log("📦 MIME:", media.mimetype || "(sin MIME)");

      console.log(
        "📦 Tamaño aproximado:",
        `${(media.bytesAprox / 1024 / 1024).toFixed(2)} MB`,
      );

      return media;
    } catch (error) {
      ultimoError = error;

      const esUltimoIntento = intento >= WA_MEDIA_DOWNLOAD_ATTEMPTS;

      console.error(
        `⚠️ downloadMedia falló para ${tipo} (intento ${intento}/${WA_MEDIA_DOWNLOAD_ATTEMPTS})`,
      );

      console.error("Error:", error?.message || String(error));

      if (
        esUltimoIntento ||
        !whatsappReady ||
        esErrorContextoNavegacion(error)
      ) {
        break;
      }

      await esperar(WA_MEDIA_DOWNLOAD_RETRY_MS * intento);
    }
  }

  console.error(`❌ No se pudo descargar la media ${tipo}.`);
  console.error("ID recibido:", JSON.stringify(msg?.id ?? null));
  console.error(
    "Error final:",
    ultimoError?.stack || ultimoError?.message || String(ultimoError),
  );

  throw ultimoError || new Error(`No se pudo descargar la media ${tipo}.`);
}

function obtenerIdMensaje(msg) {
  try {
    return asegurarIdSerializadoMensaje(msg);
  } catch {
    return null;
  }
}

function normalizarNumeroWhatsapp(valor) {
  if (!valor) {
    return null;
  }

  const numero = String(valor)
    .replace("@c.us", "")
    .replace("@s.whatsapp.net", "")
    .replace(/\D/g, "");

  return numero || null;
}

function normalizarIdentificadorWhatsapp(valor) {
  if (!valor) {
    return null;
  }

  return (
    String(valor)
      .replace("@c.us", "")
      .replace("@s.whatsapp.net", "")
      .replace("@lid", "")
      .trim() || null
  );
}

function telefonoPareceReal(numero, identificador) {
  const limpio = normalizarNumeroWhatsapp(numero);

  if (!limpio) {
    return false;
  }

  if (limpio.length < 8 || limpio.length > 15) {
    return false;
  }

  const esLid = String(identificador || "").endsWith("@lid");

  const idLimpio = normalizarIdentificadorWhatsapp(identificador);

  if (esLid && idLimpio && limpio === idLimpio) {
    return false;
  }

  return true;
}

async function resolverTelefonoDesdeContacto(contacto, identificador) {
  if (!contacto) {
    return null;
  }

  const idContacto = String(contacto?.id?._serialized || "").trim();

  if (idContacto.endsWith("@c.us") || idContacto.endsWith("@s.whatsapp.net")) {
    const numero = normalizarNumeroWhatsapp(idContacto);

    if (telefonoPareceReal(numero, identificador)) {
      return numero;
    }
  }

  if (contacto?.number) {
    const numero = normalizarNumeroWhatsapp(contacto.number);

    if (telefonoPareceReal(numero, identificador)) {
      return numero;
    }
  }

  if (typeof contacto.getFormattedNumber === "function") {
    try {
      const formateado = await contacto.getFormattedNumber();

      const numero = normalizarNumeroWhatsapp(formateado);

      if (telefonoPareceReal(numero, identificador)) {
        return numero;
      }
    } catch (error) {
      console.log(
        "ℹ️ No se pudo obtener número formateado:",
        error?.message || String(error),
      );
    }
  }

  return null;
}

async function resolverTelefonoRealDesdeLid(idWhatsapp) {
  if (!idWhatsapp || !String(idWhatsapp).endsWith("@lid")) {
    return null;
  }

  if (typeof client.getContactLidAndPhone !== "function") {
    console.log(
      "⚠️ whatsapp-web.js no expone getContactLidAndPhone(); el teléfono real quedará pendiente.",
    );
    return null;
  }

  const candidatos = [
    String(idWhatsapp),
    normalizarIdentificadorWhatsapp(idWhatsapp),
  ].filter(Boolean);

  for (const candidato of candidatos) {
    try {
      const resultado = await client.getContactLidAndPhone([candidato]);

      const numero = normalizarNumeroWhatsapp(resultado?.[0]?.pn ?? null);

      if (telefonoPareceReal(numero, idWhatsapp)) {
        return numero;
      }
    } catch (error) {
      console.log(
        `ℹ️ LID -> teléfono no resuelto con ${candidato}:`,
        error?.message || String(error),
      );
    }
  }

  return null;
}

async function obtenerIdentidadCliente(msg) {
  const idWhatsapp = String(msg.from || "").trim();

  const identificador = normalizarIdentificadorWhatsapp(idWhatsapp);

  let numeroWhatsapp = null;
  let nombreContacto = null;
  let contacto = null;

  try {
    contacto = await msg.getContact();

    nombreContacto =
      contacto?.pushname || contacto?.name || contacto?.shortName || null;

    numeroWhatsapp = await resolverTelefonoDesdeContacto(contacto, idWhatsapp);
  } catch (error) {
    console.log(
      "ℹ️ No se pudo obtener el contacto de WhatsApp:",
      error?.message || String(error),
    );
  }

  if (
    !numeroWhatsapp &&
    (idWhatsapp.endsWith("@c.us") || idWhatsapp.endsWith("@s.whatsapp.net"))
  ) {
    const numero = normalizarNumeroWhatsapp(idWhatsapp);

    if (telefonoPareceReal(numero, identificador)) {
      numeroWhatsapp = numero;
    }
  }

  if (!numeroWhatsapp && idWhatsapp.endsWith("@lid")) {
    numeroWhatsapp = await resolverTelefonoRealDesdeLid(idWhatsapp);
  }

  return {
    identificador,
    numeroWhatsapp,
    nombreContacto,
    idWhatsapp,
  };
}

async function obtenerIdentidadChat(chat) {
  const idWhatsapp = String(chat?.id?._serialized || "").trim();

  const identificador = normalizarIdentificadorWhatsapp(idWhatsapp);

  let numeroWhatsapp = null;
  let nombreContacto = chat?.name || null;

  let contacto = null;

  try {
    contacto = await chat.getContact();

    nombreContacto =
      contacto?.pushname ||
      contacto?.name ||
      contacto?.shortName ||
      nombreContacto;

    numeroWhatsapp = await resolverTelefonoDesdeContacto(contacto, idWhatsapp);
  } catch (error) {
    console.log(
      `ℹ️ Contacto no disponible para ${idWhatsapp}:`,
      error?.message || String(error),
    );
  }

  if (
    !numeroWhatsapp &&
    (idWhatsapp.endsWith("@c.us") || idWhatsapp.endsWith("@s.whatsapp.net"))
  ) {
    const numero = normalizarNumeroWhatsapp(idWhatsapp);

    if (telefonoPareceReal(numero, identificador)) {
      numeroWhatsapp = numero;
    }
  }

  if (!numeroWhatsapp && idWhatsapp.endsWith("@lid")) {
    numeroWhatsapp = await resolverTelefonoRealDesdeLid(idWhatsapp);
  }

  return {
    identificador,
    numeroWhatsapp,
    nombreContacto,
    idWhatsapp,
  };
}

function textoMensajeParaSincronizacion(msg) {
  const body = String(msg?.body || "").trim();

  if (body) {
    return body;
  }

  switch (msg?.type) {
    case "image":
      return "[Imagen]";
    case "video":
      return "[Video]";
    case "audio":
    case "ptt":
      return "[Audio]";
    case "document":
      return "[Documento]";
    default:
      return null;
  }
}

function fechaDesdeTimestampWhatsapp(timestamp) {
  if (!timestamp) {
    return null;
  }

  return new Date(Number(timestamp) * 1000);
}

function extraerIdPublicacion(texto) {
  if (!texto) {
    return null;
  }

  // Formato actual del frontend: [TV_PRODUCTO:123]
  // También conserva compatibilidad con links/rutas y referencias TV-123.

  const match = String(texto).match(
    /(?:\[TV_PRODUCTO\s*:\s*|share\/producto\/|producto\/|TV-)(\d+)\]?/i,
  );

  if (!match?.[1]) {
    return null;
  }

  const id = Number(match[1]);

  return Number.isInteger(id) && id > 0 ? id : null;
}

async function resolverIdentidadPorIdentificador(identificadorEntrada) {
  const identificador = normalizarIdentificadorWhatsapp(identificadorEntrada);

  if (!identificador) {
    return {
      identificadorExterno: "",
      numeroWhatsapp: null,
      nombreContacto: null,
      error: "Identificador vacío.",
    };
  }

  let numeroWhatsapp = null;
  let nombreContacto = null;
  let ultimoError = null;

  const candidatos = [
    String(identificadorEntrada || "").trim(),
    `${identificador}@lid`,
    `${identificador}@c.us`,
    identificador,
  ].filter(Boolean);

  const candidatosUnicos = [...new Set(candidatos)];

  for (const candidato of candidatosUnicos) {
    if (numeroWhatsapp) {
      break;
    }

    if (typeof client.getContactLidAndPhone === "function") {
      try {
        const resultado = await client.getContactLidAndPhone([candidato]);

        const item = resultado?.[0] ?? null;

        const numero = normalizarNumeroWhatsapp(item?.pn ?? null);

        if (telefonoPareceReal(numero, `${identificador}@lid`)) {
          numeroWhatsapp = numero;
        }
      } catch (error) {
        ultimoError = error?.message || String(error);
      }
    }

    if (!numeroWhatsapp) {
      try {
        const idContacto = candidato.includes("@")
          ? candidato
          : `${candidato}@c.us`;

        const contacto = await client.getContactById(idContacto);

        if (contacto) {
          nombreContacto =
            contacto?.pushname ||
            contacto?.name ||
            contacto?.shortName ||
            nombreContacto;

          const numero = await resolverTelefonoDesdeContacto(
            contacto,
            idContacto,
          );

          if (telefonoPareceReal(numero, `${identificador}@lid`)) {
            numeroWhatsapp = numero;
          }
        }
      } catch (error) {
        ultimoError = ultimoError || error?.message || String(error);
      }
    }
  }

  if (!numeroWhatsapp && /^595\\d{8,10}$/.test(identificador)) {
    numeroWhatsapp = identificador;
  }

  if (numeroWhatsapp && !nombreContacto) {
    try {
      const contacto = await client.getContactById(`${numeroWhatsapp}@c.us`);

      nombreContacto =
        contacto?.pushname || contacto?.name || contacto?.shortName || null;
    } catch {
      // El teléfono ya está resuelto; el nombre es opcional.
    }
  }

  return {
    identificadorExterno: identificador,
    numeroWhatsapp,
    nombreContacto,
    error: numeroWhatsapp ? null : ultimoError,
  };
}

// ============================================================
// SINCRONIZACION CRM DESDE LA SESION ACTIVA DE WHATSAPP
// ============================================================

function validarClaveInterna(req, res) {
  const key = String(req.headers["x-tuvendedor-internal-key"] || "");

  if (!TUVENDEDOR_INTERNAL_KEY || key !== TUVENDEDOR_INTERNAL_KEY) {
    res.status(401).json({
      success: false,
      message: "No autorizado.",
    });

    return false;
  }

  return true;
}

function rangoDiaParaguay(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ""))) {
    return null;
  }

  const inicioMs = Date.parse(`${fecha}T00:00:00-03:00`);

  if (!Number.isFinite(inicioMs)) {
    return null;
  }

  return {
    inicio: Math.floor(inicioMs / 1000),

    fin: Math.floor(inicioMs / 1000) + 24 * 60 * 60,
  };
}

app.post("/crm/resolver-identidades", async (req, res) => {
  if (!validarClaveInterna(req, res)) {
    return;
  }

  if (!whatsappReady) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp todavía no está listo.",
      data: [],
    });
  }

  const identificadores = Array.isArray(req.body?.identificadores)
    ? req.body.identificadores
    : [];

  const normalizados = [
    ...new Set(
      identificadores
        .map((item) => normalizarIdentificadorWhatsapp(item))
        .filter(Boolean),
    ),
  ].slice(0, 500);

  const data = [];
  let errores = 0;

  for (const identificador of normalizados) {
    try {
      const identidad = await resolverIdentidadPorIdentificador(identificador);

      if (!identidad.numeroWhatsapp) {
        errores++;
      }

      data.push(identidad);
    } catch (error) {
      errores++;

      data.push({
        identificadorExterno: identificador,
        numeroWhatsapp: null,
        nombreContacto: null,
        error: error?.message || String(error),
      });
    }
  }

  return res.status(200).json({
    success: true,
    cantidad: data.length,
    errores,
    data,
  });
});

app.get("/crm/chats-dia", async (req, res) => {
  if (!validarClaveInterna(req, res)) {
    return;
  }

  if (!whatsappReady) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp todavía no está listo.",
      data: [],
    });
  }

  const fecha = String(req.query.fecha || "").trim();

  const rango = rangoDiaParaguay(fecha);

  if (!rango) {
    return res.status(400).json({
      success: false,
      message: "Fecha inválida. Usá YYYY-MM-DD.",
      data: [],
    });
  }

  try {
    const chats = await client.getChats();

    const data = [];
    let errores = 0;

    for (const chat of chats || []) {
      const idWhatsapp = String(chat?.id?._serialized || "").trim();

      if (
        !idWhatsapp ||
        idWhatsapp.endsWith("@g.us") ||
        idWhatsapp.includes("@broadcast") ||
        idWhatsapp === "status@broadcast"
      ) {
        continue;
      }

      try {
        const mensajes = await chat.fetchMessages({
          limit: 120,
        });

        const mensajesDia = (mensajes || [])
          .filter(
            (mensaje) =>
              Number(mensaje?.timestamp) >= rango.inicio &&
              Number(mensaje?.timestamp) < rango.fin,
          )
          .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

        if (!mensajesDia.length) {
          continue;
        }

        const mensajesCliente = mensajesDia.filter(
          (mensaje) => !mensaje.fromMe,
        );

        const respuestas = mensajesDia.filter((mensaje) => mensaje.fromMe);

        const ultimoCliente = mensajesCliente.at(-1) || null;

        const ultimaRespuesta = respuestas.at(-1) || null;

        const ultimaInteraccion = mensajesDia.at(-1);

        const identidad = await obtenerIdentidadChat(chat);

        if (!identidad.identificador) {
          errores++;
          continue;
        }

        data.push({
          identificadorExterno: identidad.identificador,

          numeroWhatsapp: identidad.numeroWhatsapp,

          nombreContacto: identidad.nombreContacto,

          ultimoMensajeCliente: textoMensajeParaSincronizacion(ultimoCliente),

          ultimaRespuesta: textoMensajeParaSincronizacion(ultimaRespuesta),

          fechaUltimoMensajeCliente: fechaDesdeTimestampWhatsapp(
            ultimoCliente?.timestamp,
          ),

          fechaUltimaRespuesta: fechaDesdeTimestampWhatsapp(
            ultimaRespuesta?.timestamp,
          ),

          fechaUltimaInteraccion: fechaDesdeTimestampWhatsapp(
            ultimaInteraccion?.timestamp,
          ),

          cantidadMensajesDia: mensajesDia.length,
        });
      } catch (errorChat) {
        errores++;

        console.log(
          `ℹ️ No se pudo sincronizar chat ${idWhatsapp}:`,
          errorChat?.message || String(errorChat),
        );
      }
    }

    return res.status(200).json({
      success: true,
      fecha,
      cantidad: data.length,
      errores,
      data,
    });
  } catch (error) {
    console.error("❌ Error obteniendo chats de WhatsApp:", error);

    return res.status(500).json({
      success: false,
      message:
        error?.message || "No se pudieron obtener los chats de WhatsApp.",
      data: [],
    });
  }
});

app.get("/resolver-telefonos", async (req, res) => {
  if (!validarClaveInterna(req, res)) {
    return;
  }

  if (!whatsappReady) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp todavía no está listo.",
      data: [],
    });
  }

  try {
    const chats = await client.getChats();

    const data = [];
    let errores = 0;

    for (const chat of chats || []) {
      const idWhatsapp = String(chat?.id?._serialized || "").trim();

      if (
        !idWhatsapp ||
        idWhatsapp.endsWith("@g.us") ||
        idWhatsapp.includes("@broadcast")
      ) {
        continue;
      }

      try {
        const identidad = await obtenerIdentidadChat(chat);

        if (identidad.identificador && identidad.numeroWhatsapp) {
          data.push({
            identificadorExterno: identidad.identificador,

            telefono: identidad.numeroWhatsapp,

            nombreContacto: identidad.nombreContacto,
          });
        }
      } catch (errorChat) {
        errores++;

        console.log(
          `ℹ️ Teléfono no resuelto para ${idWhatsapp}:`,
          errorChat?.message || String(errorChat),
        );
      }
    }

    return res.status(200).json({
      success: true,
      cantidad: data.length,
      errores,
      data,
    });
  } catch (error) {
    console.error("❌ Error resolviendo teléfonos:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "No se pudieron resolver los teléfonos.",
      data: [],
    });
  }
});

// ============================================================

// DIAGNOSTICO

// ============================================================

app.get("/", (req, res) => {
  res.status(200).json({
    servicio: "TuVendedor WhatsApp Bridge",

    whatsappReady,

    esperandoNuevaVinculacion,

    ultimoMotivoDesconexion,

    backend: TUVENDEDOR_API_URL,

    whisper: WHISPER_URL,
  });
});

app.get("/estado", (req, res) => {
  res.status(200).json({
    whatsappReady,

    esperandoNuevaVinculacion,

    numero: client.info?.wid?._serialized ?? null,

    nombre: client.info?.pushname ?? null,

    backend: TUVENDEDOR_API_URL,

    whisper: WHISPER_URL,

    mensajesProcesados: mensajesProcesados.size,

    ultimoMotivoDesconexion,
  });
});

// ============================================================

// INICIAR

// ============================================================

console.log("");

console.log("🚀 Iniciando TuVendedor WhatsApp...");

console.log(`🧭 Entorno: ${NODE_ENV}`);

console.log(
  `⚙️ Configuración: ${
    archivoEntornoCargado || "variables del proceso/Docker"
  }`,
);

console.log(`🌐 Backend: ${TUVENDEDOR_API_URL}`);

console.log(`🎙️ Whisper: ${WHISPER_URL}`);

console.log(
  `🌍 Chromium: ${WA_EXECUTABLE_PATH || "administrado por Puppeteer"}`,
);

console.log(`💬 WhatsApp Client ID: ${WA_CLIENT_ID}`);

console.log("🛡️ El bot sólo responderá mensajes entrantes individuales.");

console.log("");

client.initialize().catch((error) => {
  if (esErrorContextoNavegacion(error) && estamosEnReautenticacion()) {
    console.log(
      "ℹ️ WhatsApp cambió de pantalla durante la re-vinculación; esperando QR/ready...",
    );

    return;
  }

  console.error("❌ Error inicializando WhatsApp:", error);

  programarReinicio(
    `Error inicializando WhatsApp: ${error?.message || String(error)}`,
  );
});

// Ruta interna: el backend programa y autoriza los seguimientos.
// El bridge solo envía cuando WhatsApp está listo.
registrarSeguimientoRoutes({
  app,
  client,
  internalKey: TUVENDEDOR_INTERNAL_KEY,
  isReady: () => whatsappReady,
});

const server = app.listen(PORT, "0.0.0.0", () => {
  const hostLog = ES_PRODUCCION ? "0.0.0.0" : "localhost";

  console.log(`🌐 Bridge escuchando en http://${hostLog}:${PORT}`);
});

// ============================================================

// CIERRE LIMPIO DEL PROCESO

// ============================================================

async function cerrarAplicacion(signal) {
  if (cerrandoAplicacion) {
    return;
  }

  cerrandoAplicacion = true;

  whatsappReady = false;

  procesarMensajesDesde = null;

  console.log("");

  console.log("============================================");

  console.log(`🛑 Cerrando TuVendedor WhatsApp (${signal})`);

  console.log("============================================");

  console.log("");

  try {
    await new Promise((resolve) => {
      server.close(() => resolve());

      setTimeout(resolve, 1500).unref();
    });
  } catch {
    // No bloqueamos el cierre por Express.
  }

  try {
    // destroy() cierra Chromium pero conserva LocalAuth.

    // NO usamos logout() aquí porque logout elimina la sesión.

    await client.destroy();

    console.log("✅ Cliente WhatsApp cerrado correctamente.");
  } catch (error) {
    console.log(
      "⚠️ El cliente WhatsApp ya estaba cerrado:",

      error?.message || String(error),
    );
  }

  setTimeout(() => {
    process.exit(0);
  }, 300).unref();
}

process.on("SIGINT", () => {
  cerrarAplicacion("SIGINT");
});

process.on("SIGTERM", () => {
  cerrarAplicacion("SIGTERM");
});

// ============================================================

// PROTECCION PARA PUPPETEER / LOCALAUTH EN WINDOWS

// ============================================================

process.on("unhandledRejection", (reason) => {
  const mensaje = String(reason?.message || reason || "");

  // Durante LOGOUT la propia librería navega de la sesión anterior a la

  // pantalla de QR. Puppeteer puede reportar que el contexto anterior fue

  // destruido. En ese escenario NO debemos matar el proceso porque justamente

  // necesitamos que permanezca vivo para mostrar el nuevo QR.

  if (esErrorContextoNavegacion(reason) && estamosEnReautenticacion()) {
    console.log("");

    console.log(
      "ℹ️ Navegación interna de WhatsApp durante re-vinculación; se continúa esperando el QR.",
    );

    console.log("");

    return;
  }

  console.error("");

  console.error("❌ UNHANDLED REJECTION");

  console.error(mensaje);

  console.error("");

  if (esErrorLocalAuthBloqueado(reason)) {
    console.error("⚠️ Windows mantiene bloqueado un archivo de LocalAuth.");

    programarReinicio("Archivo LocalAuth bloqueado por Windows (EBUSY)", 3000);

    return;
  }

  if (esErrorContextoNavegacion(reason)) {
    // Fuera de un logout/re-vinculación, este error suele indicar que Chromium

    // navegó o perdió el contexto inesperadamente. Reiniciar es más seguro que

    // dejar un proceso aparentemente vivo pero incapaz de recibir mensajes.

    programarReinicio("Chromium perdió el contexto de WhatsApp Web", 2500);

    return;
  }

  programarReinicio(`Unhandled rejection: ${mensaje}`, 2500);
});

process.on("uncaughtException", (error) => {
  const mensaje = String(error?.message || error || "");

  if (esErrorContextoNavegacion(error) && estamosEnReautenticacion()) {
    console.log("");

    console.log(
      "ℹ️ Navegación interna de WhatsApp durante re-vinculación; proceso conservado.",
    );

    console.log("");

    return;
  }

  console.error("");

  console.error("❌ ERROR NO CONTROLADO");

  console.error(error);

  console.error("");

  if (esErrorLocalAuthBloqueado(error)) {
    programarReinicio("Archivo LocalAuth bloqueado por Windows (EBUSY)", 3000);

    return;
  }

  programarReinicio(`Excepción no controlada: ${mensaje}`, 2500);
});
