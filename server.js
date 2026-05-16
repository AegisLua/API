require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const { execFile, execFileSync, spawn } = require("child_process");
const { Resolver } = require("dns").promises;
const { decode } = require(path.join(__dirname, "rbxBinaryParser"));
const { decodeXml, isXmlBuffer } = require(path.join(__dirname, "rbxXmlParser"));

// ─── yt-dlp auto-update + self-reload ────────────────────────────────────────
function checkAndUpdateYtdlp() {
  return new Promise((resolve) => {
    console.log("Checking yt-dlp for updates...");
    execFile("yt-dlp", ["-U"], { timeout: 60000 }, (err, stdout, stderr) => {
      const output = stdout + stderr;
      if (err) {
        console.warn("yt-dlp update check failed (continuing anyway):", err.message);
        return resolve(false);
      }
      const updated =
        /Updated yt-dlp/i.test(output) || /Updating to/i.test(output);
      if (updated) {
        console.log("yt-dlp was updated:", output.trim());
      } else {
        console.log("yt-dlp is already up to date.");
      }
      resolve(updated);
    });
  });
}

async function bootstrap() {
  const wasUpdated = await checkAndUpdateYtdlp();

  if (wasUpdated) {
    console.log("yt-dlp updated - reloading process...");
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, YTDLP_SKIP_UPDATE: "1" },
      detached: false,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  await resolveProxy();
  startServer();
}

if (process.env.YTDLP_SKIP_UPDATE === "1") {
  console.log("(Skipping yt-dlp update check on reloaded process)");
  (async () => {
    await resolveProxy();
    startServer();
  })();
} else {
  bootstrap();
}

// ─── Proxy config ────────────────────────────────────────────────────────────
let activeProxyUrl = null;

// ─── Proxy refresh (with mutex) ───────────────────────────────────────────────
let _proxyRefreshPromise = null;

async function refreshProxy() {
  if (_proxyRefreshPromise) return _proxyRefreshPromise;
  console.warn("Proxy error detected – refreshing proxy...");
  _proxyRefreshPromise = resolveProxy().finally(() => {
    _proxyRefreshPromise = null;
  });
  return _proxyRefreshPromise;
}

function isProxyError(err) {
  const PROXY_CODES = new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
    "ENOTFOUND",    "EPIPE",      "EHOSTUNREACH",
  ]);
  const status = err?.response?.status;
  return (
    PROXY_CODES.has(err?.code) ||
    (status >= 500 && status < 600) ||
    /tunneling socket|proxy/i.test(err?.message ?? "")
  );
}

// Test a candidate proxy by making a real HTTPS request through it.
// Returns the proxy URL if it responds within the timeout, otherwise throws.
// Throwing allows Promise.any() to skip it and wait for a faster winner.
async function testProxy(proxyUrl, timeoutMs = 3000) {
  // Belt-and-suspenders: AbortController cuts the stream even if axios
  // timeout fires late (e.g. slow TLS handshake that stalls after connect).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const agent = new HttpsProxyAgent(proxyUrl);
    const res = await axios.get("https://www.google.com", {
      httpsAgent: agent,
      httpAgent: agent,
      timeout: timeoutMs,
      maxRedirects: 3,
      responseType: "stream",
      signal: controller.signal,
    });
    res.data.destroy(); // discard body immediately
    return proxyUrl;   // success – return the URL so Promise.any can resolve
  } finally {
    clearTimeout(timer);
  }
  // Any error propagates as a rejection, which Promise.any silently skips.
}

// Fetch fresh proxies from ProxyScrape and return the FASTEST one that works,
// using Promise.any so we don't wait for slow/hanging candidates.
async function fetchWorkingProxyFromProxyScrape() {
  const PROXYSCRAPE_URL =
    "https://api.proxyscrape.com/v2/?request=getproxies" +
    "&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous";

  console.log("Fetching proxy list from ProxyScrape...");
  let raw;
  try {
    const res = await axios.get(PROXYSCRAPE_URL, {
      timeout: 15000,
      responseType: "text",
    });
    raw = res.data;
  } catch (err) {
    console.error("Failed to fetch ProxyScrape list:", err.message);
    return null;
  }

  const candidates = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(line))
    .map((hostport) => `http://${hostport}`);

  const BATCH = 20;
  console.log(`ProxyScrape returned ${candidates.length} candidates. Racing in batches of ${BATCH}...`);

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    console.log(`Testing batch ${Math.floor(i / BATCH) + 1} (${batch.length} proxies)...`);
    try {
      // Resolves as soon as the fastest proxy in this batch responds.
      const winner = await Promise.any(batch.map((url) => testProxy(url)));
      console.log(`Fastest working ProxyScrape proxy: ${winner}`);
      return winner;
    } catch {
      // Every proxy in this batch failed – try the next batch.
      console.warn(`Batch ${Math.floor(i / BATCH) + 1} failed, trying next batch...`);
    }
  }

  console.warn("No working proxy found in any ProxyScrape candidate.");
  return null;
}

async function resolveProxy() {
  const envProxy = process.env.PROXY_URL;

  if (envProxy) {
    console.log(`Testing configured proxy: ${envProxy}`);
    try {
      await testProxy(envProxy);
      console.log("Configured proxy is working - using it.");
      activeProxyUrl = envProxy;
      return;
    } catch {
      console.warn(`Configured proxy ${envProxy} failed - falling back to ProxyScrape.`);
    }
  }

  const scraped = await fetchWorkingProxyFromProxyScrape();
  if (scraped) {
    activeProxyUrl = scraped;
    return;
  }

  console.warn(
    "WARNING: No working proxy available. Requests will use a direct connection."
  );
}

function shouldBypassProxy(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "drive.iidk.online" || hostname == "files.catbox.moe" || hostname === "cdn.discordapp.com" || hostname === "media.discordapp.net" || hostname === "assets.rbxcdn.com" || hostname === "assetdelivery.roblox.com";
  } catch {
    return false;
  }
}

function makeAxiosConfig(url, extraConfig = {}) {
  const config = {
    responseType: "arraybuffer",
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    timeout: 60000,
    ...extraConfig,
  };
  if (activeProxyUrl && !shouldBypassProxy(url)) {
    config.httpsAgent = new HttpsProxyAgent(activeProxyUrl);
    config.httpAgent  = new HttpsProxyAgent(activeProxyUrl);
  }
  return config;
}

// ─── Security: URL validation ─────────────────────────────────────────────────
const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^100\.64\./,
];

async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }

  const resolver = new Resolver();
  let addresses;
  try {
    addresses = await resolver.resolve(parsed.hostname);
  } catch {
    throw new Error("DNS resolution failed for host: " + parsed.hostname);
  }

  for (const addr of addresses) {
    if (PRIVATE_IP_RANGES.some((re) => re.test(addr))) {
      throw new Error("Requests to private or internal addresses are not allowed");
    }
  }
}

// ─── URL detection ───────────────────────────────────────────────────────────
const YTDLP_HOSTS = [
  /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/,
  /^https?:\/\/(open\.)?spotify\.com\/(track|album|playlist|episode)\//,
  /^https?:\/\/(www\.|vm\.)?tiktok\.com\//,
  /^https?:\/\/(www\.|m\.)?soundcloud\.com\//,
  /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//,
  /^https?:\/\/fb\.watch\//,
  /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//,
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\//,
  /^https?:\/\/(www\.|clips\.)?twitch\.tv\//,
  /^https?:\/\/(www\.|player\.)?vimeo\.com\//,
  /^https?:\/\/(www\.)?dailymotion\.com\/(video|embed\/video)\//,
  /^https?:\/\/[^/]+\.bandcamp\.com\/(track|album)\//,
];

function isYtdlpUrl(url) {
  return YTDLP_HOSTS.some((re) => re.test(url));
}

// ─── Download via yt-dlp ─────────────────────────────────────────────────────
function buildYtdlpArgs(sourceUrl, outputTemplate) {
  const args = [
    "--no-playlist",
    "-x",
    "--audio-format", "best",
    "--audio-quality", "0",
    "-o", outputTemplate,
    "--no-progress",
    "--quiet",
    "--max-filesize", "100m",
  ];

  args.push("--postprocessor-args", "ffmpeg:-map_metadata -1");

  if (activeProxyUrl) {
    args.push("--proxy", activeProxyUrl);
  }

  args.push("--");
  args.push(sourceUrl);
  return args;
}

function downloadViaYtdlp(sourceUrl, outputTemplate) {
  return new Promise((resolve, reject) => {
    const args = buildYtdlpArgs(sourceUrl, outputTemplate);
    console.log(`Running yt-dlp for: ${sourceUrl}`);
    execFile("yt-dlp", args, { timeout: 180000 }, async (err, stdout, stderr) => {
      if (!err) return resolve();

      const isProxyRelated =
        activeProxyUrl &&
        (isProxyError(err) || /502|500|bad gateway|unable to connect|proxy|Sign in to confirm|ECONNREFUSED/i.test(stderr));

      if (isProxyRelated) {
        try {
          await refreshProxy();
          const retryArgs = buildYtdlpArgs(sourceUrl, outputTemplate);
          execFile("yt-dlp", retryArgs, { timeout: 180000 }, (err2, _out, stderr2) => {
            if (err2) return reject(new Error(`yt-dlp failed: ${stderr2 || err2.message}`));
            resolve();
          });
        } catch (refreshErr) {
          reject(new Error(`yt-dlp failed and proxy refresh failed: ${refreshErr.message}`));
        }
        return;
      }

      reject(new Error(`yt-dlp failed: ${stderr || err.message}`));
    });
  });
}

function findYtdlpOutput(base) {
  const tmpDir = path.dirname(base);
  const prefix = path.basename(base);
  const created = fs.readdirSync(tmpDir).find(
    (f) => f.startsWith(prefix) && !/[/\\]/.test(f)
  );
  if (!created) throw new Error("yt-dlp did not produce an output file");
  return path.join(tmpDir, created);
}

// ─── Generic direct download ──────────────────────────────────────────────────
async function downloadUrl(url) {
  try {
    const res = await axios.get(url, makeAxiosConfig(url));
    return res.data;
  } catch (err) {
    if (activeProxyUrl && isProxyError(err)) {
      await refreshProxy();
      const res = await axios.get(url, makeAxiosConfig(url));
      return res.data;
    }
    throw err;
  }
}

async function downloadUrlAsBuffer(url) {
  try {
    const res = await axios.get(url, makeAxiosConfig(url, {responseType: "arraybuffer"}));
    return res.data;
  } catch (err) {
    if (activeProxyUrl && isProxyError(err)) {
      await refreshProxy();
      const res = await axios.get(url, makeAxiosConfig(url, {responseType: "arraybuffer"}));
      return res.data;
    }
    throw err;
  }
}

const ROBLOSECURITY = process.env.ROBLOSECURITY;

// ─── Roblox ID download ──────────────────────────────────────────────────
async function downloadRoblox(id) {
  const url = "https://assetdelivery.roblox.com/v1/asset/";
  const axiosConfig = makeAxiosConfig(url, {
    responseType: "arraybuffer", 
    params: { id }, 
    headers: {
      Cookie: `.ROBLOSECURITY=${ROBLOSECURITY}`,
    }, 
    validateStatus: (status) => status === 404 || (status >= 200 && status < 300)
  })
  try {
    const res = await axios.get(url, axiosConfig);
    if (res.status === 404) { return null; }
    return res.data;
  } catch (err) {
    if (activeProxyUrl && isProxyError(err)) {
      await refreshProxy();
      const res = await axios.get(url, axiosConfig);
      if (res.status === 404) { return null; }
      return res.data;
    }
    throw err;
  }
}

// ─── Temp file helpers ────────────────────────────────────────────────────────
function tempPath(ext) {
  return path.join(os.tmpdir(), `mediaapi_${uuidv4()}${ext}`);
}

function cleanup(...files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

// ─── ffmpeg wrappers ──────────────────────────────────────────────────────────
function toWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(24000)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("error", reject)
      .on("end", resolve)
      .save(outputPath);
  });
}

function toPng(inputPath, outputPath, maxScale) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters(
        `scale='if(gt(iw,ih),min(${maxScale},iw),-2)':'if(gt(ih,iw),min(${maxScale},ih),-2)'`
      )
      .frames(1)
      .format("image2")
      .outputOptions(["-vcodec", "png"])
      .on("error", reject)
      .on("end", resolve)
      .save(outputPath);
  });
}

// ─── Per-IP rate limiter ──────────────────────────────────────────────────────
const RATE_LIMIT_MS = 1000;
const rateLimitMap = new Map();

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const last = rateLimitMap.get(ip) ?? 0;

  if (now - last < RATE_LIMIT_MS) {
    const retryAfter = ((RATE_LIMIT_MS - (now - last)) / 1000).toFixed(2);
    res.set("Retry-After", retryAfter);
    return res.status(429).json({ error: "Rate limit exceeded. Max 1 request per second per IP." });
  }

  rateLimitMap.set(ip, now);

  for (const [key, ts] of rateLimitMap) {
    if (now - ts > RATE_LIMIT_MS) rateLimitMap.delete(key);
  }

  next();
}

// ─── Server ───────────────────────────────────────────────────────────────────
function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use((req, res, next) => {
    if (req.path.startsWith("/gifsplit/file")) {
      return next(); // skip limiter
    }
    rateLimitMiddleware(req, res, next);
  });

  app.get("/wavify", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing ?url parameter" });

    try {
      await assertSafeUrl(url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const useYtdlp = isYtdlpUrl(url);

    let inputPath, outputPath;
    try {
      if (useYtdlp) {
        console.log(`yt-dlp download: ${url}`);
        const ytBase = tempPath("");
        await downloadViaYtdlp(url, ytBase + ".%(ext)s");
        inputPath = findYtdlpOutput(ytBase);
      } else {
        console.log(`Direct download: ${url}`);
        const buffer = await downloadUrl(url);
        const ext = path.extname(new URL(url).pathname) || ".tmp";
        inputPath = tempPath(ext);
        fs.writeFileSync(inputPath, buffer);
      }

      outputPath = tempPath(".wav");
      await toWav(inputPath, outputPath);

      const wavBuffer = fs.readFileSync(outputPath);
      res.set({
        "Content-Type": "audio/wav",
        "Content-Disposition": 'attachment; filename="audio.wav"',
        "Content-Length": wavBuffer.length,
      });
      res.send(wavBuffer);
    } catch (err) {
      console.error("/wavify error:", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      cleanup(inputPath, outputPath);
    }
  });

  app.get("/pngify", async (req, res) => {
    const { url, maxscale } = req.query;
    if (!url) return res.status(400).json({ error: "Missing ?url parameter" });

    const maxScale = parseInt(maxscale, 10) || 512;
    if (maxScale <= 0 || maxScale > 16384)
      return res.status(400).json({ error: "maxscale must be between 1 and 16384" });

    try {
      await assertSafeUrl(url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let inputPath, outputPath;
    try {
      console.log(`Downloading image: ${url}`);
      const buffer = await downloadUrl(url);

      inputPath = tempPath(".tmp");
      fs.writeFileSync(inputPath, buffer);

      outputPath = tempPath(".png");
      await toPng(inputPath, outputPath, maxScale);

      const pngBuffer = fs.readFileSync(outputPath);
      res.set({
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="image.png"',
        "Content-Length": pngBuffer.length,
      });
      res.send(pngBuffer);
    } catch (err) {
      console.error("/pngify error:", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      cleanup(inputPath, outputPath);
    }
  });

  app.get("/rbxm", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url parameter" });

    let buffer;
    try {
      const assetIdMatch = url.match(/^rbxassetid:\/\/(\d+)$/i);
      if (assetIdMatch) {
        const id = parseInt(assetIdMatch[1]);
        if (isNaN(id) || id <= 0)
          return res.status(400).json({ error: "ID must be a positive integer" });
        console.log(`Downloading RBXM by ID: ${id}`);
        buffer = await downloadRoblox(id);
      } else if (url.startsWith("https://") || url.startsWith("http://")) {
        try {
          await assertSafeUrl(url);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        console.log(`Downloading RBXM by URL: ${url}`);
        buffer = await downloadUrlAsBuffer(url);
      } else {
        return res.status(400).json({ error: "url must be a rbxassetid:// or http(s):// URL" });
      }

      if (!buffer) return res.status(404).json({ error: "Asset not found" });

      let decoded;
      if (isXmlBuffer(buffer)) {
        decoded = decodeXml(buffer);
      } else {
        const arrayBuffer = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        );
        decoded = decode(arrayBuffer);
      }
 
      if (!decoded || typeof decoded !== "object")
        return res.status(500).json({ error: "Failed to decode RBXM/RBXMX data" });
 
      return res.status(200).json(decoded);
    } catch (err) {
      console.error("/rbxm error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── /gifsplit temp file store ───────────────────────────────────────────────
  const gifsplitStore = new Map();
  const GIFSPLIT_TTL_MS = 5 * 60 * 1000;

  function registerGifsplitFiles(token, gifPath, wavPath) {
    const timer = setTimeout(() => {
      const entry = gifsplitStore.get(token);
      if (entry) {
        cleanup(entry.gifPath, entry.wavPath);
        gifsplitStore.delete(token);
        console.log(`gifsplit ${token} expired and cleaned up`);
      }
    }, GIFSPLIT_TTL_MS);

    gifsplitStore.set(token, { gifPath, wavPath, timer });
  }

  function consumeGifsplitFile(token, type) {
    const entry = gifsplitStore.get(token);
    if (!entry) return null;
    if (entry[`${type}Served`]) return null;

    entry[`${type}Served`] = true;
    const filePath = type === "gif" ? entry.gifPath : entry.wavPath;

    const onSent = () => {
      cleanup(filePath);

      const bothSent = entry.gifServed && entry.wavServed;
      if (bothSent) {
        clearTimeout(entry.timer);
        gifsplitStore.delete(token);
        console.log(`gifsplit ${token} fully consumed and cleaned up`);
      }
    };

    return { filePath, onSent };
  }

  function toTrimmedWav(inputPath, outputPath, maxSecs) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([`-t ${maxSecs}`])
        .audioChannels(1)
        .audioFrequency(24000)
        .audioCodec("pcm_s16le")
        .format("wav")
        .on("error", reject)
        .on("end", resolve)
        .save(outputPath);
    });
  }

  function toTrimmedGif(inputPath, outputPath, maxSecs, maxScale) {
    return new Promise((resolve, reject) => {
      const paletteFile = tempPath(".png");

      const scaleFilter =
        `scale='if(gt(iw,ih),min(${maxScale},iw),-2)':'if(gt(ih,iw),min(${maxScale},ih),-2)'`;

      const pass1 = ffmpeg(inputPath)
        .inputOptions([`-t ${maxSecs}`])
        .videoFilters([`fps=8`, scaleFilter, `palettegen`])
        .frames(1)
        .outputOptions(["-update", "1"])
        .on("error", (err) => { cleanup(paletteFile); reject(err); })
        .on("end", () => {
          ffmpeg(inputPath)
            .inputOptions([`-t ${maxSecs}`])
            .input(paletteFile)
            .complexFilter([
              `[0:v]fps=8,${scaleFilter}[x];[x][1:v]paletteuse`
            ])
            .outputOptions(["-loop", "0"])
            .on("error", (err) => { cleanup(paletteFile); reject(err); })
            .on("end", () => { cleanup(paletteFile); resolve(); })
            .save(outputPath);
        })
        .save(paletteFile);
    });
  }

  app.get("/gifsplit", async (req, res) => {
    const { url, maxscale } = req.query;
    if (!url) return res.status(400).json({ error: "Missing ?url parameter" });

    const maxScale = parseInt(maxscale, 10) || 512;
    if (maxScale <= 0 || maxScale > 16384)
      return res.status(400).json({ error: "maxscale must be between 1 and 16384" });

    try {
      await assertSafeUrl(url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const MAX_SECS = 60;

    let inputPath, gifPath, wavPath;
    try {
      const useYtdlp = isYtdlpUrl(url);

      if (useYtdlp) {
        console.log(`gifsplit: yt-dlp download for ${url}`);
        const ytBase = tempPath("");
        await new Promise((resolve, reject) => {
          const args = [
            "--no-playlist",
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4",
            "-o", ytBase + ".%(ext)s",
            "--no-progress",
            "--quiet",
            "--max-filesize", "100m",
          ];
          if (activeProxyUrl) args.push("--proxy", activeProxyUrl);
          args.push("--");
          args.push(url);
          execFile("yt-dlp", args, { timeout: 180000 }, (err, _stdout, stderr) => {
            if (err) return reject(new Error(`yt-dlp failed: ${stderr || err.message}`));
            resolve();
          });
        });
        inputPath = findYtdlpOutput(ytBase);
      } else {
        console.log(`gifsplit: direct download ${url}`);
        const buffer = await downloadUrl(url);
        const ext = path.extname(new URL(url).pathname) || ".mp4";
        inputPath = tempPath(ext);
        fs.writeFileSync(inputPath, buffer);
      }

      gifPath = tempPath(".gif");
      wavPath = tempPath(".wav");

      console.log(`gifsplit: encoding gif + wav (max ${MAX_SECS}s, maxscale=${maxScale})`);
      await Promise.all([
        toTrimmedGif(inputPath, gifPath, MAX_SECS, maxScale),
        toTrimmedWav(inputPath, wavPath, MAX_SECS),
      ]);

      const token = uuidv4();
      registerGifsplitFiles(token, gifPath, wavPath);

      const expiresAt = new Date(Date.now() + GIFSPLIT_TTL_MS).toISOString();
      const base = `${req.protocol}://${req.get("host")}`;

      res.json({
        gif: `${base}/gifsplit/file/${token}/gif`,
        wav: `${base}/gifsplit/file/${token}/wav`,
        expires_at: expiresAt,
        note: "Files are deleted immediately after being downloaded, or after 5 minutes - whichever comes first.",
      });
    } catch (err) {
      console.error("/gifsplit error:", err.message);
      cleanup(inputPath, gifPath, wavPath);
      res.status(500).json({ error: err.message });
    } finally {
      cleanup(inputPath);
    }
  });

  app.get("/gifsplit/file/:token/:type", (req, res) => {
    const { token, type } = req.params;
    if (type !== "gif" && type !== "wav")
      return res.status(400).json({ error: "type must be gif or wav" });

    const result = consumeGifsplitFile(token, type);
    if (!result) return res.status(404).json({ error: "File not found or already downloaded" });

    const { filePath, onSent } = result;
    const contentType = type === "gif" ? "image/gif" : "audio/wav";
    const filename    = type === "gif" ? "output.gif" : "audio.wav";

    res.set({
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    res.sendFile(filePath, (err) => {
      if (err) console.error(`gifsplit sendFile error (${token}/${type}):`, err.message);
      onSent();
    });
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`mediaapi listening on port ${PORT}`);
    if (!activeProxyUrl)
      console.warn("No working proxy - requests will use a direct connection");
  });

  // ─── Periodic proxy health check (every 30 minutes) ───────────────────────
  const PROXY_PING_INTERVAL_MS = 30 * 60 * 1000;

  setInterval(async () => {
    console.log("Proxy ping check triggered...");
    if (!activeProxyUrl) {
      console.log("No active proxy - attempting to find one...");
      await resolveProxy();
      return;
    }
    try {
      await testProxy(activeProxyUrl, 5000);
      console.log(`Proxy ping OK: ${activeProxyUrl}`);
    } catch {
      console.warn(`Proxy ping failed for ${activeProxyUrl} - refreshing...`);
      await refreshProxy();
      console.log(`Proxy after refresh: ${activeProxyUrl ?? "none (direct)"}`);
    }
  }, PROXY_PING_INTERVAL_MS).unref();
}