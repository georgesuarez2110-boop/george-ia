const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-flash-lite";
const API_BASE = process.env.API_BASE || "https://generativelanguage.googleapis.com/v1beta";
const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;
const LIMIT_PER_MINUTE = 20;

const SYSTEM_PROMPT = `Eres George IA, un asistente de inteligencia artificial amable, claro y directo.
Respondes siempre en el idioma en que te escribe la persona, por defecto en español.
Das respuestas útiles y bien organizadas, sin rodeos. Puedes usar formato Markdown: títulos, listas, negritas y bloques de código con su lenguaje.
Si no sabes algo, lo dices. Si te preguntan quién eres, respondes que eres George IA.
Si te piden una imagen o un dibujo, diles que escriban «crea una imagen de…» o pulsen el botón Imagen.`;

const IMAGE_INSTRUCTIONS = `Eres un ilustrador digital. Crea la imagen pedida como un único archivo SVG.
Reglas: responde solo con el código SVG, sin texto antes ni después y sin bloques de markdown.
Usa xmlns y viewBox="0 0 1024 1024". Cubre todo el lienzo con un fondo (rect o degradado).
Usa formas, degradados lineales y radiales, capas y sombras suaves para dar profundidad y detalle, con una paleta armoniosa.
Sin scripts, sin imágenes externas y sin fuentes externas; si la imagen lleva texto, usa font-family sans-serif.
Mantén el código por debajo de 14000 caracteres.`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const hits = new Map();

function readKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(ROOT, "clave.txt"), "utf8").trim();
  } catch (e) {
    return "";
  }
}

function keyIsValid(key) {
  return key.length > 20 && !key.includes(" ") && !key.toLowerCase().includes("pega");
}

function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > LIMIT_PER_MINUTE;
}

function cleanMessages(input) {
  if (!Array.isArray(input)) return null;
  const list = input
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== ""
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_MESSAGES);
  while (list.length && list[0].role !== "user") list.shift();
  if (!list.length || list[list.length - 1].role !== "user") return null;
  return list;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1000000) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Prohibido");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("No encontrado");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

function toContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
}

function errorMessage(status, detail) {
  const text = detail.toLowerCase();
  if (text.includes("api key not valid") || text.includes("api_key_invalid") || status === 401) {
    return "La API key no es válida. Revisa que la pegaste completa en clave.txt.";
  }
  if (status === 403) return "Esta API key no tiene permiso. Genera una nueva en aistudio.google.com.";
  if (status === 404) return "El modelo no existe. Cambia la variable MODEL.";
  if (status === 429) return "Se alcanzó el límite gratuito por ahora. Espera un momento o intenta más tarde.";
  return "George IA no pudo responder. Intenta de nuevo.";
}

async function handleChat(req, res) {
  if (tooMany(req.socket.remoteAddress)) {
    return sendJson(res, 429, { error: "Demasiados mensajes seguidos. Espera un momento." });
  }

  const key = readKey();
  if (!keyIsValid(key)) {
    return sendJson(res, 500, { error: "Falta tu API key. Abre el archivo clave.txt, pega tu clave y guarda." });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: "Solicitud no válida." });
  }

  let system = SYSTEM_PROMPT;
  let messages;
  let maxTokens = 8192;
  if (body.mode === "image") {
    const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 1000).trim() : "";
    if (!prompt) return sendJson(res, 400, { error: "Describe la imagen que quieres crear." });
    system = IMAGE_INSTRUCTIONS;
    messages = [{ role: "user", content: "Descripción de la imagen: " + prompt }];
    maxTokens = 16384;
  } else {
    messages = cleanMessages(body.messages);
    if (!messages) return sendJson(res, 400, { error: "Mensaje no válido." });
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: toContents(messages),
    generationConfig: { maxOutputTokens: maxTokens }
  });

  const models = MODEL === FALLBACK_MODEL ? [MODEL] : [MODEL, FALLBACK_MODEL];

  try {
    let upstream = null;
    let lastStatus = 0;
    let lastDetail = "";
    for (const model of models) {
      const response = await fetch(`${API_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: payload
      });
      if (response.ok) {
        upstream = response;
        break;
      }
      lastStatus = response.status;
      lastDetail = await response.text();
      console.error("Error de la API:", model, lastStatus, lastDetail.slice(0, 300));
      if (lastStatus !== 404 && lastStatus !== 429) break;
    }

    if (!upstream) {
      return sendJson(res, 502, { error: errorMessage(lastStatus, lastDetail) });
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no"
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let wrote = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          const parts = (event.candidates && event.candidates[0] && event.candidates[0].content && event.candidates[0].content.parts) || [];
          for (const part of parts) {
            if (typeof part.text === "string" && !part.thought) {
              res.write(part.text);
              wrote = true;
            }
          }
        } catch (e) {
          continue;
        }
      }
    }
    if (!wrote) res.write("No pude generar una respuesta. Intenta reformular tu mensaje.");
    res.end();
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "No se pudo conectar con la API. Revisa tu conexión a internet." });
    } else {
      res.end();
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    return handleChat(req, res);
  }
  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res);
  }
  res.writeHead(405);
  res.end();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`El puerto ${PORT} ya está en uso. Cierra la otra ventana de George IA.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`George IA lista en http://localhost:${PORT}`);
  console.log("Deja esta ventana abierta mientras uses George IA.");
});
