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

  function fichaComercialWhatsApp(datos, indice, maximo) {
    const comercial = campo(datos, "datosComerciales", "DatosComerciales");
    const financiacion = campo(comercial, "financiacion", "Financiacion");
    const validacion = campo(datos, "validacionComercial", "ValidacionComercial");
    const planes = campo(financiacion, "planes", "Planes");
    const marca = campo(datos, "marca", "Marca") || "";
    const modelo = campo(datos, "modelo", "Modelo") || "";
    const idModelo = campo(datos, "idModelo", "IdModelo");
    const confianza = Number(campo(datos, "confianza", "Confianza"));
    const lineas = [
      `🏍️ PANAMBI SOCIAL — FOTO ${indice}/${maximo}`,
      "✅ Moto identificada",
      `Marca: ${marca}`,
      `Modelo: ${modelo}`,
      `ID del modelo: ${idModelo ?? "No disponible"}`,
    ];
    if (Number.isFinite(confianza) && confianza >= 0 && confianza <= 1) {
      lineas.push(`Reconocimiento visual: ${Math.round(confianza * 100)} %`);
    }
    lineas.push("", "💰 INFORMACIÓN DEL CATÁLOGO");
    if (!comercial) {
      lineas.push("⚠️ Oferta comercial no disponible o no verificada.");
    } else {
      const precio = campo(comercial, "precioPublico", "PrecioPublico");
      const contado = campo(comercial, "precioContadoFinal", "PrecioContadoFinal");
      lineas.push(`Precio público: Gs. ${formatoGuaranies(precio)}`);
      if (contado !== undefined && contado !== null) {
        lineas.push(`Precio contado: Gs. ${formatoGuaranies(contado)}`);
      }
      const cilindrada = campo(comercial, "cilindrada", "Cilindrada");
      if (cilindrada) lineas.push(`Cilindrada: ${cilindrada}`);
      lineas.push("", "💳 PLANES DE FINANCIACIÓN");
      if (Array.isArray(planes) && planes.length) {
        for (const plan of planes.slice(0, 6)) {
          const codigo = campo(plan, "codigoPlan", "CodigoPlan") || "Sin código";
          const cantidad = campo(plan, "cantidadCuotas", "CantidadCuotas");
          const importe = campo(plan, "importeCuota", "ImporteCuota");
          const entrega = campo(plan, "entregaInicial", "EntregaInicial");
          const parte = [`${codigo}`, cantidad ? `${cantidad} cuotas` : null,
            `Gs. ${formatoGuaranies(importe)}`].filter(Boolean).join(" · ");
          lineas.push(`• ${parte}`);
          if (Number(entrega) > 0) lineas.push(`  Entrega: Gs. ${formatoGuaranies(entrega)}`);
        }
        if (planes.length > 6) lineas.push(`… y ${planes.length - 6} plan(es) más`);
      } else {
        lineas.push("Sin planes de financiación verificados.");
      }
      const promo = campo(financiacion, "tienePromocionVigente", "TienePromocionVigente");
      lineas.push(promo === true ? "Promoción: informada como vigente por catálogo" :
        "Promoción: no se confirmó una vigente en esta oferta");
    }
    lineas.push("", "📸 PRECIO IMPRESO EN LA IMAGEN");
    lineas.push("Todavía no extraído ni comparado automáticamente.");
    lineas.push("", "⚠️ VALIDACIÓN COMERCIAL");
    const advertencia = campo(validacion, "advertencia", "Advertencia");
    if (advertencia) lineas.push(String(advertencia));
    else lineas.push("Revisión de imagen pendiente; no publicar con precios no verificados.");
    lineas.push("", "🚫 No se publicó nada.");
    return lineas.join("\n").slice(0, 3400);
  }

  function resumen(lote) {
    if (!lote.fotos.length) return "Todavía no recibí imágenes. Enviá publicidades de motos.";
    const lineas = lote.fotos.map((f, i) => {
      const detalle = f.encontrada
        ? `✅ ${f.marca} ${f.modelo} (ID ${f.idModelo})${f.precioPublico ? ` · Precio público Gs. ${formatoGuaranies(f.precioPublico)}` : " · oferta sin verificar"}${f.requiereRevision ? " · ⚠️ revisión comercial" : ""}`
        : `⚠️ ${f.posibleModelo || "Modelo pendiente"}: ${f.motivo || "No identificado"}`;
      return `${i + 1}. ${detalle}`;
    });
    return `Resumen (${lote.fotos.length} imagen/es):\n${lineas.join("\n")}`.slice(0, 3400);
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
      const foto = {
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
      lote.fotos.push(foto);
      const numeroFoto = lote.fotos.length;
      await avisar(encontrada
        ? fichaComercialWhatsApp(datos, numeroFoto, MAX_FOTOS)
        : `⚠️ Foto ${numeroFoto}/${MAX_FOTOS}: ${foto.posibleModelo || "Modelo no identificado"}\n${foto.motivo}. No asigné otra moto por parecido. No se publicó nada.`);
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
