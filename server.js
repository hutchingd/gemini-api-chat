import {
  server,
  logger,
  http,
  cookieJar,
} from "@exocore/multi";
import {
  GeminiClient,
  ConversationMetadata,
  fetchAndUpload,
  AuthError,
  checkCookies,
  importCookiesFromRaw,
  clearCookiesFile,
  loadIntoCookieJar,
} from "./src/index.js";
import { modules } from "./src/index.js";
import { IMAGE_TOOL_ID } from "./src/core/constants.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.join(__dirname, "images");
if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });
const DOCS_HTML = readFileSync(
  path.join(__dirname, "src/static/index.html"),
  "utf8",
);

const PORT = process.env.PORT ?? 8080;
const app = server.create({
  port:         PORT,
  prettyPrint:  true,
  jiglet:       'EXOCORE',
  cors:         true,
  helmet:       true,
  bodyParser:   true,
  cookieParser: true,
  compression:  true,
  rateLimit: {
    enabled:  true,
    windowMs: 15 * 60 * 1000,
    max:      100,
    message:  'Too many requests',
  },
});

let _client = null;
let _initLock = null;

async function getClient() {
  if (_client?.initialized) return _client;
  if (_initLock) return _initLock;
  _initLock = (async () => {
    const c = new GeminiClient();
    await c.init();
    _client = c;
    return c;
  })().finally(() => {
    _initLock = null;
  });
  return _initLock;
}

async function resetClient() {
  await _client?.close().catch(() => {});
  _client = null;
  _initLock = null;
  cookieJar.clear();
}

function buildMetadata(q) {
  const cid = q.cid ?? "",
    rid = q.rid ?? "",
    rcid = q.rcid ?? "";
  return cid || rid ? new ConversationMetadata({ cid, rid, rcid }) : null;
}

function parseUrls(raw) {
  return raw
    ? raw
        .split(/[\s,]+/)
        .filter((u) => u.startsWith("http://") || u.startsWith("https://"))
    : [];
}


function formatCookieHeaderObj(cookies) {
  return Object.entries(cookies || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function extractImageUrls(obj, out = []) {
  if (!obj) return out;
  if (typeof obj === "string") {
    if (/^https?:\/\//.test(obj) && (obj.includes("googleusercontent") || obj.includes("gg-dl") || /\.(jpg|jpeg|png|webp)/i.test(obj))) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) { for (const x of obj) extractImageUrls(x, out); return out; }
  if (typeof obj === "object") { for (const v of Object.values(obj)) extractImageUrls(v, out); return out; }
  return out;
}

app.get("/images/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const fp = path.join(IMAGE_DIR, name);
  if (!existsSync(fp)) { res.status(404).end(); return; }
  const ext = path.extname(name).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  res.setHeader("Content-Type", type);
  res.end(readFileSync(fp));
});

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(DOCS_HTML);
});

app.get("/api/gemini/health", async (_req, res) => {
  const ck = checkCookies();
  res.json(
    http.ok({
      status: "ok",
      client_ready: !!_client?.initialized,
      cookies_valid: ck.valid,
      cookies_path: ck.path,
      jar_size: ck.jar_size,
      providers: Object.keys(modules),
    }),
  );
});

app.get("/api/gemini/cookies", async (_req, res) => {
  res.json(http.ok(checkCookies()));
});

app.post("/api/gemini/cookies", async (req, res) => {
  const raw =
    typeof req.body === "string"
      ? req.body
      : typeof req.body?.raw === "string"
        ? req.body.raw
        : JSON.stringify(req.body ?? "");

  if (!raw.trim()) {
    res.status(400).json(http.err("missing body — paste raw cookie string"));
    return;
  }

  const result = importCookiesFromRaw(raw);
  if (!result.ok) {
    res.status(400).json(http.err(result.error));
    return;
  }

  await resetClient();
  res.json(http.ok(result));
});

app.delete("/api/gemini/cookies", async (_req, res) => {
  await resetClient();
  res.json(http.ok(clearCookiesFile()));
});

app.get("/api/gemini/chat", async (req, res) => {
  const { ask, chat, upload } = req.query;
  const prompt = ask || chat || "";
  const urls = parseUrls(upload ?? "");
  const toolId = req.query.image !== undefined ? IMAGE_TOOL_ID : (req.query.tool ? Number(req.query.tool) : null);

  if (!prompt && !urls.length && !toolId) {
    res
      .status(400)
      .json(http.err("provide ?ask=<message> or ?upload=<url>&chat=<message>"));
    return;
  }

  let client;
  try {
    client = await getClient();
  } catch (e) {
    const code = e instanceof AuthError ? 401 : 503;
    res.status(code).json(http.err(e.message));
    return;
  }

  try {
    const metadata = buildMetadata(req.query);
    let fileData = null;

    if (urls.length) {
      const items = await Promise.all(
        urls.map((u) => fetchAndUpload(u, client)),
      );
      const valid = items.filter(Boolean);
      if (valid.length) fileData = valid;
      else logger.warn("chat: all uploads failed — text-only");
    }

    const response = await client.send(
      prompt || (toolId === IMAGE_TOOL_ID ? "Generate an image." : "Describe and explain these files."),
      { metadata, fileData, toolId },
    );
    const meta = response.metadata;

    const remoteUrls = [...new Set(extractImageUrls(response))];
    const localImages = [];
    let cookieHeader = formatCookieHeaderObj(client.getCookies());
    try {
      const cj = JSON.parse(readFileSync(path.join(__dirname, "cookies.json"), "utf8"));
      const arr = Array.isArray(cj) ? cj : (cj.cookies || []);
      const full = arr.map(c => `${c.name}=${c.value}`).join("; ");
      if (full.length > cookieHeader.length) cookieHeader = full;
    } catch (e) { console.error("cookie read err", e.message); }
    for (const u of remoteUrls) {
      try {
        let target = u;
        let r = null;
        for (let hop = 0; hop < 6; hop++) {
          r = await axios.get(target, { responseType: "arraybuffer", timeout: 30_000, maxRedirects: 0, validateStatus: () => true, headers: { Cookie: cookieHeader, "User-Agent": "Mozilla/5.0", "Referer": "https://gemini.google.com/", "Origin": "https://gemini.google.com", "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" } });
          if (r.status >= 300 && r.status < 400 && r.headers.location) {
            target = new URL(r.headers.location, target).href;
            continue;
          }
          break;
        }
        if (!r || r.status >= 400) throw new Error(`HTTP ${r ? r.status : "no response"}`);
        const ext = (u.match(/\.(jpg|jpeg|png|webp)/i)?.[1] || "jpg").toLowerCase().replace("jpeg", "jpg");
        const name = `${crypto.randomUUID()}.${ext}`;
        writeFileSync(path.join(IMAGE_DIR, name), Buffer.from(r.data));
        const _host = (req.headers && req.headers.host) ? req.headers.host : "localhost:8099";
        localImages.push(`${req.protocol || "http"}://${_host}/images/${name}`);
      } catch (e) {
        logger.warn(`image download failed: ${e.message}`);
      }
    }
    const images = localImages.length ? localImages : remoteUrls;
    res.json({
      msg: response.text ?? response.candidates?.[0]?.text ?? "",
      cid: meta?.cid ?? "",
      rid: meta?.rid ?? "",
      rcid: meta?.rcid ?? "",
      images,
    });
  } catch (e) {
    logger.error(`chat: ${e.message}`);
    res.status(e instanceof AuthError ? 401 : 500).json(http.err(e.message));
  }
});

await new Promise((resolve) => app.listen(PORT, resolve));

loadIntoCookieJar();
logger.info(`gemini-web on :${PORT}`);
logger.info(`providers: ${Object.keys(modules).join(", ")}`);

try {
  await getClient();
  logger.info("client: warm-up done");
} catch (e) {
  logger.warn(
    `client: warm-up failed — POST /api/gemini/cookies to fix. (${e.message})`,
  );
}
