"use strict";

// ─── rbxmWorker.js ────────────────────────────────────────────────────────────
// Runs in a worker_threads worker. Receives a downloaded RBXM/RBXMX buffer and
// performs all CPU-intensive work (decode, CSG post-process, sanitize) off the
// main event loop so other API routes stay responsive.
// ─────────────────────────────────────────────────────────────────────────────

const { workerData, parentPort } = require("worker_threads");
const path = require("path");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { decode } = require(path.join(__dirname, "rbxBinaryParser"));
const { decodeXml, isXmlBuffer } = require(path.join(__dirname, "rbxXmlParser"));
const { processCSGOperations } = require(path.join(__dirname, "csgPostProcess"));

const { bufferData, proxyUrl, roblosecurity } = workerData;

// ─── Lightweight download helper for CSG sub-asset fetching ──────────────────

const BYPASS_HOSTS = new Set([
  "drive.iidk.online",
  "files.catbox.moe",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "assets.rbxcdn.com",
  "assetdelivery.roblox.com",
]);

function shouldBypassProxy(url) {
  try {
    return BYPASS_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function makeAgent() {
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

function axiosCfg(url, extra = {}) {
  const cfg = {
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    timeout: 60000,
    responseType: "arraybuffer",
    ...extra,
  };
  if (proxyUrl && !shouldBypassProxy(url)) {
    const agent = makeAgent();
    cfg.httpsAgent = agent;
    cfg.httpAgent = agent;
  }
  return cfg;
}

async function fetchAsset(id) {
  const url = "https://assetdelivery.roblox.com/v1/asset/";
  const cfg = axiosCfg(url, {
    params: { id },
    headers: { Cookie: `.ROBLOSECURITY=${roblosecurity}` },
    validateStatus: (s) => s === 404 || (s >= 200 && s < 300),
  });
  const res = await axios.get(url, cfg);
  if (res.status === 404) return null;
  return res.data;
}

// ─── Sanitizer (mirrors server.js logic) ─────────────────────────────────────

const MAX_SOURCE_LEN = 8_000_000;

function isSpamSource(src) {
  const sampleSize = Math.min(500, src.length);
  const step = Math.max(1, Math.floor(src.length / sampleSize));
  const counts = {};
  let sampled = 0;
  for (let i = 0; i < src.length && sampled < sampleSize; i += step, sampled++) {
    const ch = src[i];
    counts[ch] = (counts[ch] || 0) + 1;
    if (counts[ch] / sampleSize > 0.95) return true;
  }
  return false;
}

function sanitizeInstances(instances) {
  if (!Array.isArray(instances)) return;
  for (const inst of instances) {
    if (typeof inst.Source === "string") {
      if (inst.Source.length > MAX_SOURCE_LEN || isSpamSource(inst.Source)) {
        inst.Source = "warn('Source removed by aegis_api: too large or spam. Scr name: '..script.Name);";
      }
    }
    if (Array.isArray(inst.Children)) sanitizeInstances(inst.Children);
    if (Array.isArray(inst._childInstances)) sanitizeInstances(inst._childInstances);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const buffer = Buffer.from(bufferData);

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

    if (!decoded || typeof decoded !== "object") {
      parentPort.postMessage({ error: "Failed to decode RBXM/RBXMX data" });
      return;
    }

    await processCSGOperations(decoded, decode, decodeXml, fetchAsset);
    sanitizeInstances(decoded);

    parentPort.postMessage({ result: decoded });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
})();
