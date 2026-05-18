"use strict";

// ─── csgPostProcess.js ──────────────────────────────────────────────────────
// Post-processes a decoded RBXM/RBXMX instance tree to handle
// UnionOperation / IntersectOperation / NegateOperation instances.
//
// For each such instance the processor:
//   1. Resolves ChildData / ChildData2 (whichever is a valid RBXM blob) by
//      recursively parsing it inline, and attaches the result as
//      `_childInstances` on the instance.
//   2. Falls back to AssetData if no direct ChildData: that blob is parsed
//      as a PartOperationAsset, and its own ChildData is then extracted.
//   3. Falls back to AssetId if neither blob is present: fetches the
//      PartOperationAsset via the supplied async `fetchAsset(id)` callback.
//   4. Decodes the `Tags` BinaryString on every instance into `_tags`
//      (string[]) so the client can identify `rbxNegated` parts.
//   5. Strips all raw binary properties (ChildData, ChildData2, AssetData,
//      MeshData, MeshData2, PhysicsData, PhysicalConfigData) to keep the
//      JSON lean.
// ─────────────────────────────────────────────────────────────────────────────

const CSG_CLASSES = new Set([
    "UnionOperation",
    "IntersectOperation",
    "NegateOperation",
]);

const BINARY_BLOB_PROPS = [
    "ChildData", "ChildData2",
    "AssetData",
    "MeshData", "MeshData2",
    "PhysicsData", "PhysicalConfigData",
];

// ── Buffer helpers ────────────────────────────────────────────────────────────

/**
 * Convert a property string to a Buffer.
 * - XML parser outputs BinaryString properties as base64 text.
 * - Binary parser outputs String properties as raw latin1 bytes.
 * The regex test discriminates between the two encodings reliably because
 * a real RBXM binary blob contains bytes like 0x89 / 0xFF that cannot appear
 * in base64 text.
 */
function toBuffer(raw) {
    if (!raw || typeof raw !== "string" || raw.length === 0) return null;
    // Try base64 first (XML path)
    try {
        const stripped = raw.replace(/[\r\n\s]/g, "");
        if (/^[A-Za-z0-9+/]+=*$/.test(stripped) && stripped.length > 0) {
            const b64 = Buffer.from(stripped, "base64");
            if (b64.length > 0) return b64;
        }
    } catch (_) {}
    // Fall back to latin1 (binary parser path)
    return Buffer.from(raw, "latin1");
}

function isRbxmBinary(buf) {
    return buf.length >= 8 && buf.slice(0, 8).toString("ascii") === "<roblox!";
}

function isRbxmXml(buf) {
    if (buf.length < 10) return false;
    const head = buf.slice(0, Math.min(buf.length, 512)).toString("utf8").trimStart();
    return head.startsWith("<roblox xmlns")
        || head.startsWith("<roblox\n")
        || head.startsWith("<roblox ");
}

function isCsgPhs(buf) {
    return buf.length >= 6 && buf.slice(0, 6).toString("ascii") === "CSGPHS";
}

/** Attempt to parse a Buffer as binary or XML RBXM. Returns null if invalid. */
function parseBlob(buf, decode, decodeXml) {
    if (!buf || buf.length < 8 || isCsgPhs(buf)) return null;
    if (isRbxmBinary(buf)) {
        try {
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            return decode(ab);
        } catch (e) {
            console.warn("[csgPostProcess] binary parse failed:", e.message);
        }
    } else if (isRbxmXml(buf)) {
        try {
            return decodeXml(buf);
        } catch (e) {
            console.warn("[csgPostProcess] xml parse failed:", e.message);
        }
    }
    return null;
}

/** Resolve ChildData / ChildData2 on `src` into a parsed instance tree. */
function resolveDirectChildData(src, decode, decodeXml) {
    for (const prop of ["ChildData", "ChildData2"]) {
        const buf = toBuffer(src[prop]);
        if (!buf) continue;
        const tree = parseBlob(buf, decode, decodeXml);
        if (tree) return tree;
    }
    return null;
}

/** Walk a root array looking for the first instance with `className`. */
function findInTree(roots, className) {
    for (const inst of roots) {
        if (inst.ClassName === className) return inst;
        const found = findInTree(inst.Children || [], className);
        if (found) return found;
    }
    return null;
}

/**
 * Decode the null-terminated tag list stored in the Tags property.
 * Returns a plain string array, e.g. ["rbxNegated"].
 * Handles both base64 (XML) and raw latin1 (binary) encodings.
 */
function decodeTags(raw) {
    if (!raw || typeof raw !== "string") return [];
    let bytes;
    // Try base64 first (XML BinaryString encoding)
    try {
        const stripped = raw.replace(/[\r\n\s]/g, "");
        if (/^[A-Za-z0-9+/]+=*$/.test(stripped)) {
            bytes = Buffer.from(stripped, "base64").toString("latin1");
        }
    } catch (_) {}
    if (!bytes) bytes = raw; // fallback: binary parser already gave us latin1
    return bytes.split("\0").map(t => t.trim()).filter(t => t.length > 0);
}

/** Strip raw binary blob properties that are no longer useful. */
function stripBinaryProps(inst) {
    for (const p of BINARY_BLOB_PROPS) delete inst[p];
}

// ── Core walker ───────────────────────────────────────────────────────────────

async function processInstance(inst, decode, decodeXml, fetchAsset) {
    // Recurse into regular children first (depth-first)
    for (const child of (inst.Children || [])) {
        await processInstance(child, decode, decodeXml, fetchAsset);
    }

    // Decode Tags on every instance (not just CSG classes)
    if (inst.Tags) {
        inst._tags = decodeTags(inst.Tags);
        delete inst.Tags;
    }

    if (!CSG_CLASSES.has(inst.ClassName)) {
        stripBinaryProps(inst);
        return;
    }

    // ── 1. Try ChildData / ChildData2 directly on the instance ───────────────
    let childTree = resolveDirectChildData(inst, decode, decodeXml);

    // ── 2. Try AssetData (contains a PartOperationAsset blob) ────────────────
    if (!childTree) {
        const buf = toBuffer(inst.AssetData);
        if (buf) {
            const assetTree = parseBlob(buf, decode, decodeXml);
            if (assetTree) {
                const poa = findInTree(assetTree, "PartOperationAsset");
                if (poa) {
                    childTree = resolveDirectChildData(poa, decode, decodeXml);
                }
            }
        }
    }

    // ── 3. Try fetching via AssetId (uploaded unions) ─────────────────────────
    if (!childTree && inst.AssetId && typeof fetchAsset === "function") {
        const raw = String(inst.AssetId);
        const match = raw.match(/(\d+)/);
        const id = match ? parseInt(match[1]) : null;
        if (id && id > 0) {
            try {
                const assetBuf = await fetchAsset(id);
                if (assetBuf) {
                    const buf = Buffer.isBuffer(assetBuf)
                        ? assetBuf
                        : Buffer.from(assetBuf);
                    const assetTree = parseBlob(buf, decode, decodeXml);
                    if (assetTree) {
                        const poa = findInTree(assetTree, "PartOperationAsset");
                        if (poa) {
                            childTree = resolveDirectChildData(poa, decode, decodeXml);
                        } else {
                            // The blob itself may already be the ChildData tree
                            childTree = assetTree;
                        }
                    }
                }
            } catch (e) {
                console.warn(`[csgPostProcess] AssetId ${id} fetch failed:`, e.message);
            }
        }
    }

    // ── 4. Recurse into child tree and attach ─────────────────────────────────
    if (childTree) {
        for (const root of childTree) {
            await processInstance(root, decode, decodeXml, fetchAsset);
        }
        inst._childInstances = childTree;
    }

    // AssetId is left on the instance so the client knows it exists if needed.
    stripBinaryProps(inst);
}

/**
 * Walk the decoded instance tree and resolve all CSG operations.
 *
 * @param {object[]} roots     - Root instances from either parser.
 * @param {Function} decode    - rbxBinaryParser.decode
 * @param {Function} decodeXml - rbxXmlParser.decodeXml
 * @param {Function} [fetchAsset] - async (id: number) => Buffer | null
 */
async function processCSGOperations(roots, decode, decodeXml, fetchAsset) {
    for (const root of roots) {
        await processInstance(root, decode, decodeXml, fetchAsset);
    }
}

module.exports = { processCSGOperations };
