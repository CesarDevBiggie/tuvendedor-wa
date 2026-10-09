const fs = require("fs");
const path = require("path");

function registrarSeguimientoRoutes({ app, client, internalKey, isReady }) {
  if (!app || !client || typeof isReady !== "function") {
    throw new Error(
      "Configuración inválida para las rutas de seguimiento WhatsApp.",
    );
  }

  const archivoDedupe = String(
    process.env.WA_FOLLOWUP_DEDUPE_FILE ||
      path.resolve(
        process.cwd(),
        ".wwebjs_auth",
        "tuvendedor-followup-sent.json",
      ),
  );

  const enviados = cargarDedupe(archivoDedupe);
  const enProceso = new Set();

  app.post("/crm/enviar-seguimiento", async (req, res) => {
    const key = String(req.headers["x-tuvendedor-internal-key"] || "");

    if (!internalKey || key !== internalKey) {
      return res.status(401).json({
        success: false,
        message: "No autorizado.",
      });
    }

    if (!isReady()) {
      return res.status(503).json({
        success: false,
        message: "WhatsApp todavía no está listo.",
      });
    }

    const idEnvio = Number(req.body?.idEnvio);
    const telefono = normalizarNumeroWhatsapp(req.body?.telefono);
    const mensaje = String(req.body?.mensaje || "").trim();

    if (!Number.isSafeInteger(idEnvio) || idEnvio <= 0) {
      return res.status(400).json({
        success: false,
        message: "idEnvio inválido.",
      });
    }

    if (!telefono || telefono.length < 8 || telefono.length > 15) {
      return res.status(400).json({
        success: false,
        message: "Número de WhatsApp inválido.",
      });
    }

    if (!mensaje || mensaje.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "El mensaje debe tener entre 1 y 1000 caracteres.",
      });
    }

    const clave = String(idEnvio);

    // Idempotencia: si el backend reintenta el mismo IdEnvio después de
    // perder una respuesta HTTP, devolvemos el resultado anterior sin
    // mandar el mensaje otra vez.
    if (enviados.has(clave)) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        messageId: enviados.get(clave)?.messageId || null,
      });
    }

    if (enProceso.has(clave)) {
      return res.status(409).json({
        success: false,
        message: "Ese seguimiento ya se está enviando.",
      });
    }

    enProceso.add(clave);

    try {
      let chatId = null;

      if (typeof client.getNumberId === "function") {
        const numberId = await client.getNumberId(telefono);
        chatId = numberId?._serialized || numberId?.id?._serialized || null;
      }

      if (!chatId) {
        return res.status(404).json({
          success: false,
          message: "El número no está disponible como contacto de WhatsApp.",
        });
      }

      const resultado = await client.sendMessage(chatId, mensaje);

      const messageId = resultado?.id?._serialized || resultado?.id?.id || null;

      enviados.set(clave, {
        messageId,
        sentAt: new Date().toISOString(),
      });

      guardarDedupe(archivoDedupe, enviados);

      console.log(
        `✅ Seguimiento automático enviado. IdEnvio=${idEnvio}, destino=${ocultarNumero(telefono)}`,
      );

      return res.status(200).json({
        success: true,
        duplicate: false,
        messageId,
      });
    } catch (error) {
      console.error(
        `❌ Error enviando seguimiento automático. IdEnvio=${idEnvio}`,
        error?.message || String(error),
      );

      return res.status(500).json({
        success: false,
        message:
          error?.message || "No se pudo enviar el seguimiento por WhatsApp.",
      });
    } finally {
      enProceso.delete(clave);
    }
  });
}

function normalizarNumeroWhatsapp(valor) {
  if (!valor) {
    return null;
  }

  const numero = String(valor).replace(/\D/g, "");
  return numero || null;
}

function ocultarNumero(numero) {
  if (!numero || numero.length <= 4) {
    return "****";
  }

  return `${"*".repeat(Math.max(0, numero.length - 4))}${numero.slice(-4)}`;
}

function cargarDedupe(archivo) {
  const mapa = new Map();

  try {
    if (!fs.existsSync(archivo)) {
      return mapa;
    }

    const contenido = JSON.parse(fs.readFileSync(archivo, "utf8"));

    for (const item of Array.isArray(contenido) ? contenido : []) {
      if (item?.idEnvio) {
        mapa.set(String(item.idEnvio), {
          messageId: item.messageId || null,
          sentAt: item.sentAt || null,
        });
      }
    }
  } catch (error) {
    console.error(
      "⚠️ No se pudo leer la deduplicación de seguimientos:",
      error?.message || String(error),
    );
  }

  return mapa;
}

function guardarDedupe(archivo, mapa) {
  try {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });

    const items = [...mapa.entries()]
      .map(([idEnvio, valor]) => ({
        idEnvio,
        messageId: valor?.messageId || null,
        sentAt: valor?.sentAt || null,
      }))
      .sort((a, b) =>
        String(b.sentAt || "").localeCompare(String(a.sentAt || "")),
      )
      .slice(0, 5000);

    fs.writeFileSync(archivo, JSON.stringify(items, null, 2), "utf8");

    // Recortamos también el Map en memoria.
    if (mapa.size > 5000) {
      mapa.clear();
      for (const item of items) {
        mapa.set(String(item.idEnvio), {
          messageId: item.messageId,
          sentAt: item.sentAt,
        });
      }
    }
  } catch (error) {
    // No bloqueamos el envío ya realizado. El backend conserva además su
    // auditoría. Este log permite detectar si el volumen persistente falta.
    console.error(
      "⚠️ No se pudo persistir la deduplicación de seguimientos:",
      error?.message || String(error),
    );
  }
}

module.exports = {
  registrarSeguimientoRoutes,
};
