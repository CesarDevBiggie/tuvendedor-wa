"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Panambi Social - primera etapa: identificación de publicidades desde
 * "Mensaje a ti mismo" en el WhatsApp del bridge.
 * Publica en Meta solamente mediante #PUBLICAR y habilitación explícita en el backend.
 */
function registrarPanambiSocialFotos(client, opciones = {}) {
  const { axios, apiUrl, internalKey, isReady = () => true, logger = console } = opciones;
  if (process.env.PANAMBI_SOCIAL_ENABLED !== "true") {
    logger.log("[PanambiSocial] Deshabilitado (PANAMBI_SOCIAL_ENABLED != true)");
    return;
  }

  const lotes = new Map();
  const PUBLICACION_ACTIVA = process.env.PANAMBI_META_COMMAND_ENABLED === "true";
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

  async function actualizarRegistro(foto, estado, resultados = null) {
    const registro = path.join(MEDIA_DIR, `${foto.flyer.nombre}.json`);
    const contenido = JSON.parse(await fs.readFile(registro, "utf8"));
    contenido.estado = estado;
    contenido.publicado = estado === "PUBLICADO";
    if (resultados) contenido.resultadosMeta = resultados;
    await fs.writeFile(registro, JSON.stringify(contenido, null, 2), { mode: 0o600 });
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
    if (!/^#(?:PUBLICARMOTOS|RESUMEN|SIMULAR|PUBLICAR|CANCELAR)$/i.test(texto)) return;
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
    const textoPublico = campo(borrador, "textoCompleto", "TextoCompleto");
    const textoWhatsApp = campo(borrador, "textoWhatsApp", "TextoWhatsApp");
    const texto = typeof textoWhatsApp === "string" && textoWhatsApp.trim()
      ? textoWhatsApp : textoPublico;
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
    return `Resumen de ${lote.fotos.length} flyer(s):\n${lineas.join("\n")}\n\nLos flyers originales y borradores están guardados. No se publicó nada.\n⚠️ Revisá manualmente precios y cuotas impresos en los flyers; esa comparación no está automatizada.\n${PUBLICACION_ACTIVA ? "Probá #SIMULAR. Para aprobar los importes y publicar definitivamente, enviá #PUBLICAR." : "Publicación WhatsApp todavía deshabilitada."}`.slice(0, 3400);
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
      lote = { inicio: ahora, fotos: [], ocupado: false, resumido: false, publicando: false, ejecutado: false };
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
      lote.resumido = true;
      await avisar(resumen(lote));
      return;
    }
    if (/^#(?:SIMULAR|PUBLICAR)$/i.test(texto) && msg.type === "chat") {
      const simulacion = /^#SIMULAR$/i.test(texto);
      if (!PUBLICACION_ACTIVA) { await avisar("Publicador deshabilitado en el bridge. No se publicó nada."); return; }
      if (lote.ocupado || lote.publicando) { await avisar("El lote está ocupado; no se envió otra publicación."); return; }
      if (lote.ejecutado) { await avisar("Este lote ya fue procesado. No repetiré publicaciones. Iniciá otro con #PUBLICARMOTOS."); return; }
      if (!lote.resumido) { await avisar("Primero revisá el lote mediante #RESUMEN. No se publicó nada."); return; }
      if (!lote.fotos.length || lote.fotos.some(f => !f.encontrada || !f.textoPublicacion || f.textoPublicacion.length > 2200)) {
        await avisar("El lote tiene imágenes sin identificación o textos inválidos. No se publicó nada. Usá #CANCELAR.");
        return;
      }
      lote.publicando = true;
      if (!simulacion) lote.ejecutado = true; // Bloquear repeticiones, incluso cuando falle Meta.
      try {
        for (let i = 0; i < lote.fotos.length; i++) {
          const foto = lote.fotos[i];
          // Reservar la operación en disco antes de contactar servicios externos.
          if (!simulacion) await actualizarRegistro(foto, "PUBLICACION_INICIADA_VERIFICAR_SI_FALLA");
          if (foto.flyer.mime !== "image/jpeg") {
            if (!simulacion) await actualizarRegistro(foto, "ERROR_FORMATO_JPEG_REQUERIDO");
            await avisar(`❌ Flyer ${i + 1}: Instagram requiere JPEG. No se publicó esta imagen.`);
            continue;
          }
          const bytes = await fs.readFile(foto.flyer.archivo);
          const headers = { "X-TuVendedor-Internal-Key": internalKey, "Content-Type": "application/json" };
          const base = String(apiUrl).replace(/\/$/, "");
          const media = await axios.post(`${base}/api/internal/panambi-social/media`, {
            numeroWhatsapp: numero, mediaBase64: bytes.toString("base64")
          }, { headers, timeout: 45000, maxBodyLength: 11_000_000 });
          const imagenUrl = media.data?.imagenUrl;
          if (!imagenUrl) throw new Error("El backend no devolvió URL pública del flyer.");
          const respuesta = await axios.post(`${base}/api/internal/panambi-social/publicar-meta`, {
            numeroWhatsapp: numero, imagenUrl, texto: foto.textoPublicacion,
            facebook: true, instagram: true, simulacion, confirmacion: simulacion ? "" : "PUBLICAR"
          }, { headers, timeout: 120000 });
          const resultados = respuesta.data?.resultados || [];
          const estado = resultados.length === 2 && resultados.every(r => r.exito === true) ? "PUBLICADO" : "PARCIAL_VERIFICAR";
          if (!simulacion) await actualizarRegistro(foto, estado, resultados);
          await avisar(simulacion ? `🧪 Simulación ${i + 1}/${lote.fotos.length}: el backend aceptó el borrador. No se publicó nada. URL del flyer: ${imagenUrl}` : `Flyer ${i + 1}/${lote.fotos.length}: ${resultados.map(r => `${r.red}: ${r.exito ? "✅ publicado" : "❌ error"}${r.idPublicacion ? ` (${r.idPublicacion})` : ""}`).join(" | ") || "Sin resultados"}.`);
        }
      } catch (error) {
        logger.error("[PanambiSocial] Publicación interrumpida:", error?.response?.status || error?.message);
        await avisar("⚠️ Publicación interrumpida. Puede haberse publicado en alguna red. Verificá Facebook e Instagram antes de volver a intentar. Este lote está bloqueado para evitar duplicados.");
      } finally {
        lote.publicando = false;
      }
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
  logger.log("[PanambiSocial] Listener preparado. Publicación por comando:", PUBLICACION_ACTIVA);
}

module.exports = { registrarPanambiSocialFotos };
