"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

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
  // Almacén privado y persistente: requiere bind mount /app/panambi-social-media.
  // No contiene un publicador ni expone URLs de las fotografías.
  const MEDIA_DIR = process.env.PANAMBI_SOCIAL_MEDIA_DIR || "/app/panambi-social-media";
  const EXTENSIONES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
  const carpetaLista = fs.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });

  async function guardarFlyer(media, mime) {
    await carpetaLista;
    const nombre = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}${EXTENSIONES[mime]}`;
    const archivo = path.join(MEDIA_DIR, nombre);
    // Guarda los bytes del archivo recibido de WhatsApp, sin alterar colores ni texto.
    const bytes = Buffer.from(media.data, "base64");
    await fs.writeFile(archivo, bytes, { flag: "wx", mode: 0o600 });
    return { archivo, nombre, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }

  async function guardarRegistro(foto) {
    await carpetaLista;
    const registro = path.join(MEDIA_DIR, `${foto.flyer.nombre}.json`);
    const contenido = {
      nombreFlyer: foto.flyer.nombre,
      sha256: foto.flyer.sha256,
      tipoImagen: foto.flyer.mime,
      fecha: new Date().toISOString(),
      encontrada: foto.encontrada,
      idModelo: foto.idModelo,
      marca: foto.marca,
      modelo: foto.modelo,
      textoPublicacion: foto.textoPublicacion || null,
      estado: foto.encontrada && foto.textoPublicacion ? "BORRADOR_PENDIENTE_APROBACION" : "REVISION",
      publicado: false,
    };
    await fs.writeFile(registro, JSON.stringify(contenido, null, 2), { flag: "wx", mode: 0o600 });
  }

  const MAX_BASE64 = 10_000_000;
  const DURACION_MS = 30 * 60 * 1000;
  const INICIO_MS = Date.now();
  const digitos = (s) => String(s || "").replace(/\D/g, "");
  const telefonoPropio = () => digitos(client.info?.wid?.user);
  const propio = () => String(client.info?.wid?._serialized || "");

  // WhatsApp Web puede representar el chat propio como @c.us o @lid.
  // Para evitar órdenes hacia clientes, exigimos que sea un mensaje
  // enviado por nuestra sesión Y destinado a nuestro propio chat.
  async function esChatPropio(msg) {
    if (msg?.fromMe !== true || !client.info?.wid) return false;

    const identidad = propio();
    const numero = telefonoPropio();
    const destino = String(msg.to || "");
    const remoto = String(msg.id?.remote || "");
    const origen = String(msg.from || "");

    const coincideNumero = (id) => {
      const [usuario, dominio] = String(id).split("@");
      return Boolean(
        numero && usuario &&
        (dominio === "c.us" || dominio === "s.whatsapp.net") &&
        digitos(usuario) === numero
      );
    };
    const coincide = (id) => Boolean(id) && (id === identidad || coincideNumero(id));

    // Identidad clásica, usada en algunas versiones de WhatsApp Web.
    if (destino && coincide(destino)) return true;
    if (!destino && remoto && coincide(remoto)) return true;

    // Un chat consigo mismo puede estar identificado como @lid.
    // Una igualdad estricta entre remitente y destinatario, más
    // fromMe=true, excluye los chats dirigidos a otros contactos.
    if (origen && destino && origen === destino) return true;
    if (!destino && origen && remoto && origen === remoto) return true;

    // Si WhatsApp usa IDs diferentes (@c.us / @lid), verificar
    // que el DESTINATARIO sea el contacto propio antes de autorizar.
    if (destino && typeof client.getContactById === "function") {
      try {
        const contacto = await client.getContactById(destino);
        if (contacto?.isMe === true) return true;
      } catch (error) {
        logger.warn("[PanambiSocial] No se pudo validar destino de chat propio:", error?.message);
      }
    }
    return false; // Siempre falla cerrado si no logramos verificar.
  }

  async function diagnosticarComando(msg) {
    const texto = String(msg?.body || "").trim();
    if (!/^#(?:PUBLICARMOTOS|RESUMEN|CANCELAR)$/i.test(texto)) return;
    const presente = (valor) => Boolean(String(valor || ""));
    logger.log("[PanambiSocial] Comando observado:", {
      comando: texto.toUpperCase(),
      fromMe: msg.fromMe === true,
      tipo: msg.type,
      haySesion: Boolean(client.info?.wid),
      hayDestino: presente(msg.to),
      hayRemoto: presente(msg.id?.remote),
      chatPropio: await esChatPropio(msg),
      listo: Boolean(isReady()),
    });
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

  // Acceso tolerante a serializacion camelCase/PascalCase sin alterar el contrato.
  const campo = (objeto, camel, pascal) => objeto && typeof objeto === "object"
    ? (objeto[camel] ?? objeto[pascal]) : undefined;

  function formatoGuaranies(valor) {
    if (valor === null || valor === undefined || valor === "") return "No disponible";
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) return "No disponible";
    return Math.round(numero).toLocaleString("es-PY");
  }

  function anuncioParaWhatsApp(datos, indice, maximo) {
    const borrador = campo(datos, "borradorComercial", "BorradorComercial");
    const texto = campo(borrador, "textoCompleto", "TextoCompleto");
    if (typeof texto !== "string" || !texto.trim()) {
      return `⚠️ Foto ${indice}/${maximo}: no hay oferta comercial completa para preparar el anuncio. El flyer se guardó para revisión.`;
    }
    // El texto comercial ya lo construyó el backend con precios del catálogo.
    // IDs, diagnósticos, confianza y comparaciones quedan fuera del anuncio.
    return `📸 PUBLICACIÓN ${indice}/${maximo} — VISTA PREVIA\n\n${texto.trim()}\n\n🖼️ Imagen: flyer original recibido.\n📝 Borrador pendiente de tu aprobación. No se publicó nada.`;
  }

  function resumen(lote) {
    if (!lote.fotos.length) return "Todavía no recibí imágenes. Enviá publicidades de motos.";
    const lineas = lote.fotos.map((f, i) =>
      `${i + 1}. ${f.encontrada && f.textoPublicacion ? "📝" : "⚠️"} ${[f.marca, f.modelo].filter(Boolean).join(" ") || f.posibleModelo || "Pendiente"} — ${f.encontrada && f.textoPublicacion ? "borrador preparado" : "requiere revisión"}`
    );
    return `Resumen de ${lote.fotos.length} flyer(s):\n${lineas.join("\n")}\n\nLos flyers originales y sus borradores se guardaron en el servidor. No se publicó nada.`.slice(0, 3400);
  }

  async function procesar(msg) {
    await diagnosticarComando(msg);
    if (!isReady() || !(await esChatPropio(msg))) return;
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

    if (/^#PUBLICARMOTOS$/i.test(texto) && msg.type === "chat") {
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
    if (/^#CANCELAR$/i.test(texto) && msg.type === "chat") {
      if (lote.ocupado) { await avisar("Estoy terminando la imagen actual. Reintentá #CANCELAR."); return; }
      lotes.delete(numero);
      await avisar("Lote cancelado. No se publicó nada.");
      return;
    }
    if (/^#RESUMEN$/i.test(texto) && msg.type === "chat") {
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
    let flyerGuardado = null;
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
      // La imagen se conserva antes del análisis, incluso si Ollama falla.
      const flyer = await guardarFlyer(media, mime);
      flyerGuardado = flyer;
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
      // Los nombres vienen del DTO real de identificar-foto (camelCase por ASP.NET).
      // La imagen NO tiene cuotas extraidas aun: no afirmar coincidencia con el flyer.
      const comercial = campo(datos, "datosComerciales", "DatosComerciales");
      const validacion = campo(datos, "validacionComercial", "ValidacionComercial");
      const financiacion = campo(comercial, "financiacion", "Financiacion");
      const planes = campo(financiacion, "planes", "Planes");
      const marcaDetectada = campo(datos, "marcaDetectada", "MarcaDetectada") ||
        campo(campo(datos, "reconocimiento", "Reconocimiento"), "marcaDetectada", "MarcaDetectada");
      const modeloDetectado = campo(datos, "modeloDetectado", "ModeloDetectado") ||
        campo(campo(datos, "reconocimiento", "Reconocimiento"), "modeloDetectado", "ModeloDetectado");
      const borrador = campo(datos, "borradorComercial", "BorradorComercial");
      const textoPublicacion = campo(borrador, "textoCompleto", "TextoCompleto");
      const foto = {
        flyer: { ...flyer, mime },
        textoPublicacion: typeof textoPublicacion === "string" ? textoPublicacion : null,
        encontrada,
        marca: campo(datos, "marca", "Marca") || "",
        modelo: campo(datos, "modelo", "Modelo") || "",
        idModelo: campo(datos, "idModelo", "IdModelo") ?? null,
        motivo: campo(datos, "motivo", "Motivo") || "Revisión requerida",
        posibleModelo: campo(datos, "posibleModelo", "PosibleModelo") ||
          [marcaDetectada, modeloDetectado].filter(Boolean).join(" "),
        precioPublico: campo(comercial, "precioPublico", "PrecioPublico"),
        requiereRevision: !comercial ||
          campo(validacion, "datosVerificados", "DatosVerificados") !== true ||
          campo(validacion, "cuotaDeImagenVerificada", "CuotaDeImagenVerificada") !== true,
      };
      await guardarRegistro(foto);
      lote.fotos.push(foto);
      const numeroFoto = lote.fotos.length;
      await avisar(encontrada
        ? anuncioParaWhatsApp(datos, numeroFoto, MAX_FOTOS)
        : `⚠️ Foto ${numeroFoto}/${MAX_FOTOS}: ${foto.posibleModelo || "Modelo no identificado"}\n${foto.motivo}. No asigné otra moto por parecido. No se publicó nada.`);
    } catch (error) {
      const status = error?.response?.status;
      logger.error("[PanambiSocial] Error identificando imagen:", status || error?.code || error?.message);
      const detalle = status === 403 ? "Número propio no autorizado en PanambiSocial:AllowedPhones del backend." :
        status === 401 ? "La clave interna del bridge no coincide con la API." :
        "Fallo de identificación (Ollama o API). Revisá logs; no se publicó nada.";
      if (flyerGuardado) logger.warn("[PanambiSocial] Flyer conservado para revisión:", flyerGuardado.nombre);
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
