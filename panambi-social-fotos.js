"use strict";

/**
 * Panambi Social - primera etapa: identificación de publicidades desde
 * "Mensaje a ti mismo" en el WhatsApp del bridge.
 * No publica en Meta, ni escribe en la base de datos.
 */
function registrarPanambiSocialFotos(client, opciones = {}) {
  const { axios, apiUrl, internalKey, isReady = () => true, logger = console } = opciones;
  if (process.env.PANAMBI_SOCIAL_ENABLED !== "true") {
    logger.log("[PanambiSocial] Deshabilitado (PANAMBI_SOCIAL_ENABLED != true)");
    return;
  }

  const lotes = new Map();
  const vistos = new Map();
  const MAX_FOTOS = 20;
  const MAX_BASE64 = 10_000_000;
  const DURACION_MS = 30 * 60 * 1000;
  const INICIO_MS = Date.now();
  const digitos = (s) => String(s || "").replace(/\D/g, "");
  const idCanonico = (s) => String(s || "").split(":")[0];
  const telefonoPropio = () => digitos(client.info?.wid?.user);
  const propio = () => String(client.info?.wid?._serialized || "");

  // Nunca tratar un mensaje dirigido a un cliente como una orden administrativa.
  // Una coincidencia exclusiva de fromMe no es suficiente.
  function esChatPropio(msg) {
    if (!msg?.fromMe || !client.info?.wid) return false;
    const identidad = propio();
    const destino = String(msg.to || "");
    const remoto = String(msg.id?.remote || "");
    if (!identidad || !destino || !remoto) return false;
    const coincide = (valor) => valor === identidad ||
      (valor.endsWith("@c.us") && identidad.endsWith("@c.us") &&
       idCanonico(valor) === idCanonico(identidad));
    return coincide(destino) && coincide(remoto);
  }

  async function avisar(texto) {
    if (!isReady()) return;
    await client.sendMessage(propio(), `Panambi Social: ${texto}`);
  }

  function registrarVisto(id) {
    const ahora = Date.now();
    for (const [clave, instante] of vistos) {
      if (ahora - instante > DURACION_MS) vistos.delete(clave);
    }
    if (!id || vistos.has(id)) return false;
    vistos.set(id, ahora);
    return true;
  }

  function resumen(lote) {
    if (!lote.fotos.length) return "Todavía no recibí imágenes. Enviá publicidades de motos.";
    const lineas = lote.fotos.map((f, i) => {
      const detalle = f.encontrada
        ? `✅ ${f.marca} ${f.modelo} (ID ${f.idModelo})`
        : `⚠️ Pendiente: ${f.motivo || "No identificado"}`;
      return `${i + 1}. ${detalle}`;
    });
    return `Resumen (${lote.fotos.length} imagen/es):\n${lineas.join("\n")}`.slice(0, 3400);
  }

  async function procesar(msg) {
    if (!isReady() || !esChatPropio(msg)) return;
    if (Number(msg.timestamp || 0) * 1000 < INICIO_MS - 5000) return;
    if (!registrarVisto(String(msg.id?._serialized || ""))) return;
    const ahora = Date.now();
    const numero = telefonoPropio();
    if (numero.length < 9) {
      logger.warn("[PanambiSocial] No se pudo obtener el número de la sesión; se ignora comando.");
      return;
    }
    const texto = String(msg.body || "").trim();
    let lote = lotes.get(numero);

    if (/^#PUBLICARMOTOS$/i.test(text) && msg.type === "chat") {
      if (lote?.ocupado) return;
      lote = { inicio: ahora, fotos: [], ocupado: false };
      lotes.set(numero, lote);
      await avisar("Modo reconocimiento ACTIVADO. Enviá las fotos publicitarias, una por una, sin escribir los modelos. Al terminar, enviá #RESUMEN. #CANCELAR descarta el lote. No se publica nada.");
      return;
    }
    if (!lote) return;
    if (ahora - lote.inicio > DURACION_MS) {
      lotes.delete(numero);
      await avisar("El lote venció (30 minutos). Enviá #PUBLICARMOTOS para iniciar de nuevo.");
      return;
    }
    if (/^#CANCELAR$/i.test(text) && msg.type === "chat") {
      if (lote.ocupado) { await avisar("Estoy terminando la imagen actual. Reintentá #CANCELAR."); return; }
      lotes.delete(numero);
      await avisar("Lote cancelado. No se publicó nada.");
      return;
    }
    if (/^#RESUMEN$/i.test(text) && msg.type === "chat") {
      await avisar(resumen(lote));
      return;
    }
    if (msg.type !== "image") return;
    if (lote.ocupado) {
      await avisar("Estoy analizando la foto anterior. Reenviá esta imagen cuando reciba el resultado.");
      return;
    }
    if (lote.fotos.length >= MAX_FOTOS) {
      await avisar(`Límite de ${MAX_FOTOS} imágenes por lote. Enviá #RESUMEN.`);
      return;
    }
    lote.ocupado = true;
    try {
      if (!internalKey || !apiUrl) throw new Error("API interna no configurada");
      const media = await msg.downloadMedia();
      if (!media?.data) throw new Error("WhatsApp no entregó el archivo de imagen");
      const mime = String(media.mimetype || "").split(";")[0].toLowerCase();
      if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
        await avisar("Formato de imagen no admitido. Usá JPG, PNG o WEBP.");
        return;
      }
      if (media.data.length > MAX_BASE64) {
        await avisar("Imagen demasiado grande. Enviá una versión de menor tamaño.");
        return;
      }
      const response = await axios.post(
        `${String(apiUrl).replace(/\/$/, "")}/api/internal/panambi-social/identificar-foto`,
        { numeroWhatsapp: numero, mediaMimeType: mime, mediaBase64: media.data },
        {
          headers: {
            "Content-Type": "application/json",
            "X-TuVendedor-Internal-Key": internalKey,
          },
          timeout: 145000,
          maxBodyLength: 12_000_000,
          maxContentLength: 2_000_000,
        }
      );
      const datos = response.data?.data || response.data?.Data;
      if (!datos) throw new Error("API no devolvió datos de identificación");
      const encontrada = datos.encontrada === true || datos.Encontrada === true;
      const foto = {
        encontrada,
        marca: datos.marca || datos.Marca || "",
        modelo: datos.modelo || datos.Modelo || "",
        idModelo: datos.idModelo ?? datos.IdModelo ?? null,
        motivo: datos.motivo || datos.Motivo || "Revisión requerida",
      };
      lote.fotos.push(foto);
      await avisar(encontrada
        ? `✅ Identificada: ${foto.marca} ${foto.modelo} (modelo ID ${foto.idModelo}). Foto ${lote.fotos.length}/${MAX_FOTOS}. No se publicó nada.`
        : `⚠️ Foto ${lote.fotos.length}: ${foto.motivo}. No asigné otra moto por parecido. Podés enviar otra imagen.`);
    } catch (error) {
      const status = error?.response?.status;
      logger.error("[PanambiSocial] Error identificando imagen:", status || error?.code || error?.message);
      const detalle = status === 403 ? "Número propio no autorizado en PanambiSocial:AllowedPhones del backend." :
        status === 401 ? "La clave interna del bridge no coincide con la API." :
        "Fallo de identificación (Ollama o API). Revisá logs; no se publicó nada.";
      await avisar(`❌ ${detalle}`);
    } finally {
      lote.ocupado = false;
    }
  }

  client.on("message_create", (msg) => {
    void procesar(msg).catch((error) => {
      logger.error("[PanambiSocial] Error inesperado:", error?.message || String(error));
    });
  });
  logger.log("[PanambiSocial] Listener administrativo preparado. Solo chat propio; sin publicaciones.");
}

module.exports = { registrarPanambiSocialFotos };
