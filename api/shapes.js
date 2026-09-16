import { inflateRawSync } from "node:zlib";

// /api/shapes?ids=shapeA,shapeB
// Returns { shapes: { "<shape_id>": [[lat,lon], ...] }, _diag: { "<id>": {...} } }
//
// AT's GTFS v3 REST API does not expose /shapes/{shape_id}, which is why valid train
// shapes returned 404. The complete official GTFS feed does contain shapes.txt, so this
// endpoint reads that file directly from the ZIP. Byte-range requests avoid downloading
// unrelated GTFS files such as stop_times.txt.

const GTFS_ZIP_URL = "https://gtfs.at.govt.nz/gtfs.zip";
const SHAPE_TTL_MS = 12 * 60 * 60 * 1000;
const FEED_TTL_MS = 6 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 25000;
const MAX_IDS = 50;
const ZIP_TAIL_BYTES = 256 * 1024;
const MAX_SHAPES_TEXT_BYTES = 250 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const raw = (req.query.ids ?? req.query.id ?? "").toString().trim();
  if (!raw) return res.status(400).json({ error: "missing ids" });
  const ids = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))].slice(0, MAX_IDS);

  globalThis.__AT_SHAPES__ ||= new Map(); // shape_id -> { pts|null, ts }
  const store = globalThis.__AT_SHAPES__;
  const now = Date.now();
  const shapes = {};
  const diag = {};
  const needed = [];

  for (const id of ids) {
    const cached = store.get(id);
    if (cached && now - cached.ts < SHAPE_TTL_MS) {
      shapes[id] = cached.pts;
      diag[id] = {
        source: "cache",
        cache: "hit",
        status: cached.pts ? 200 : 404,
        points: cached.pts?.length || 0,
      };
    } else {
      needed.push(id);
    }
  }

  if (needed.length) {
    try {
      const feed = await getShapesText();
      const found = extractRequestedShapes(feed.text, needed);
      for (const id of needed) {
        const pts = found.get(id) || null;
        store.set(id, { pts, ts: Date.now() });
        shapes[id] = pts;
        diag[id] = {
          source: "gtfs.zip/shapes.txt",
          cache: feed.cache,
          status: pts ? 200 : 404,
          points: pts?.length || 0,
          ...(pts ? {} : { error: "shape_id not present in the current AT GTFS feed" }),
        };
      }
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      for (const id of needed) {
        const stale = store.get(id)?.pts || null;
        shapes[id] = stale;
        diag[id] = {
          source: stale ? "stale-cache" : "gtfs.zip/shapes.txt",
          cache: stale ? "stale" : "miss",
          status: stale ? 200 : 502,
          points: stale?.length || 0,
          error: message,
        };
      }
    }
  }

  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=21600, stale-while-revalidate=604800");
  return res.status(200).json({ shapes, _diag: diag });
}

async function getShapesText() {
  globalThis.__AT_GTFS_SHAPES_FILE__ ||= { text: null, ts: 0, pending: null };
  const cache = globalThis.__AT_GTFS_SHAPES_FILE__;
  if (cache.text && Date.now() - cache.ts < FEED_TTL_MS) return { text: cache.text, cache: "hit" };
  if (cache.pending) return { text: await cache.pending, cache: "shared" };

  cache.pending = loadZipEntryText(GTFS_ZIP_URL, "shapes.txt")
    .then(text => {
      if (!text.includes("shape_id") || !text.includes("shape_pt_lat")) {
        throw new Error("AT shapes.txt has an unexpected header");
      }
      cache.text = text;
      cache.ts = Date.now();
      return text;
    })
    .finally(() => { cache.pending = null; });

  return { text: await cache.pending, cache: "miss" };
}

// Read one ZIP member. Normally this needs three small HTTP range requests: ZIP tail,
// local-file header, then the compressed shapes.txt bytes. If the origin ignores Range,
// the same code safely falls back to the returned full archive.
async function loadZipEntryText(url, wantedName) {
  const tailResponse = await fetchWithTimeout(url, {
    headers: { Range: `bytes=-${ZIP_TAIL_BYTES}`, "Accept-Encoding": "identity" },
    cache: "no-store",
  }, UPSTREAM_TIMEOUT_MS);
  if (!tailResponse.ok) throw new Error(`AT GTFS download failed: ${tailResponse.status}`);

  const tail = Buffer.from(await tailResponse.arrayBuffer());
  if (tailResponse.status === 200) return extractEntryFromFullZip(tail, wantedName).toString("utf8");

  const contentRange = tailResponse.headers.get("content-range") || "";
  const rangeMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
  if (!rangeMatch) throw new Error("AT GTFS range response omitted Content-Range");
  const tailStart = Number(rangeMatch[1]);
  const totalSize = Number(rangeMatch[3]);
  const eocdAt = findSignatureBackwards(tail, 0x06054b50);
  if (eocdAt < 0) throw new Error("GTFS ZIP end record not found");

  const centralSize = tail.readUInt32LE(eocdAt + 12);
  const centralOffset = tail.readUInt32LE(eocdAt + 16);
  let central;
  if (centralOffset >= tailStart && centralOffset + centralSize <= totalSize) {
    central = tail.subarray(centralOffset - tailStart, centralOffset - tailStart + centralSize);
  } else {
    central = await fetchRange(url, centralOffset, centralOffset + centralSize - 1);
  }

  const entry = findCentralEntry(central, wantedName);
  if (!entry) throw new Error(`${wantedName} not found in AT GTFS ZIP`);

  const headerProbe = await fetchRange(url, entry.localOffset, Math.min(totalSize - 1, entry.localOffset + 4095));
  if (headerProbe.length < 30 || headerProbe.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`Invalid local ZIP header for ${wantedName}`);
  }
  const nameLength = headerProbe.readUInt16LE(26);
  const extraLength = headerProbe.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = await fetchRange(url, dataStart, dataStart + entry.compressedSize - 1);
  return inflateZipMember(compressed, entry.method, entry.uncompressedSize, wantedName).toString("utf8");
}

async function fetchRange(url, start, end) {
  const response = await fetchWithTimeout(url, {
    headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" },
    cache: "no-store",
  }, UPSTREAM_TIMEOUT_MS);
  if (!response.ok) throw new Error(`AT GTFS range failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status === 200) {
    if (bytes.length <= end - start) throw new Error("AT GTFS server ignored an unusable range request");
    return bytes.subarray(start, end + 1);
  }
  return bytes;
}

function extractEntryFromFullZip(zip, wantedName) {
  const eocdAt = findSignatureBackwards(zip, 0x06054b50);
  if (eocdAt < 0) throw new Error("GTFS ZIP end record not found");
  const centralSize = zip.readUInt32LE(eocdAt + 12);
  const centralOffset = zip.readUInt32LE(eocdAt + 16);
  const entry = findCentralEntry(zip.subarray(centralOffset, centralOffset + centralSize), wantedName);
  if (!entry) throw new Error(`${wantedName} not found in AT GTFS ZIP`);
  if (zip.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP header for ${wantedName}`);
  const nameLength = zip.readUInt16LE(entry.localOffset + 26);
  const extraLength = zip.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = zip.subarray(start, start + entry.compressedSize);
  return inflateZipMember(compressed, entry.method, entry.uncompressedSize, wantedName);
}

function findCentralEntry(central, wantedName) {
  let offset = 0;
  while (offset + 46 <= central.length) {
    if (central.readUInt32LE(offset) !== 0x02014b50) break;
    const method = central.readUInt16LE(offset + 10);
    const compressedSize = central.readUInt32LE(offset + 20);
    const uncompressedSize = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const localOffset = central.readUInt32LE(offset + 42);
    const name = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === wantedName || name.endsWith(`/${wantedName}`)) {
      return { method, compressedSize, uncompressedSize, localOffset };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function inflateZipMember(compressed, method, expectedSize, name) {
  if (expectedSize > MAX_SHAPES_TEXT_BYTES) throw new Error(`${name} exceeds the safe extraction limit`);
  let data;
  if (method === 0) data = compressed;
  else if (method === 8) data = inflateRawSync(compressed);
  else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
  if (expectedSize && data.length !== expectedSize) throw new Error(`Truncated ${name} in AT GTFS ZIP`);
  return data;
}

function findSignatureBackwards(buffer, signature) {
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

function extractRequestedShapes(text, requestedIds) {
  const wanted = new Set(requestedIds.map(String));
  const rows = new Map();
  for (const id of wanted) rows.set(id, []);

  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) throw new Error("AT shapes.txt is empty");
  const header = parseCsvLine(text.slice(0, firstBreak).replace(/\r$/, "")).map(normalizeHeader);
  const idCol = header.indexOf("shapeid");
  const latCol = header.indexOf("shapeptlat");
  const lonCol = header.indexOf("shapeptlon");
  const seqCol = header.indexOf("shapeptsequence");
  if (idCol < 0 || latCol < 0 || lonCol < 0 || seqCol < 0) throw new Error("AT shapes.txt is missing required columns");

  let start = firstBreak + 1;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (!line) continue;

    // shape_id is the first GTFS column in AT's feed. Avoid parsing every coordinate row
    // fully unless it belongs to one of the IDs requested by this API call.
    const quickId = idCol === 0 ? firstCsvField(line) : null;
    if (quickId !== null && !wanted.has(quickId)) continue;
    const fields = parseCsvLine(line);
    const id = fields[idCol];
    if (!wanted.has(id)) continue;
    const lat = Number(fields[latCol]);
    const lon = Number(fields[lonCol]);
    const seq = Number(fields[seqCol]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(seq)) rows.get(id).push([lat, lon, seq]);
  }

  const result = new Map();
  for (const [id, points] of rows) {
    if (points.length >= 2) result.set(id, points.sort((a, b) => a[2] - b[2]).map(p => [p[0], p[1]]));
  }
  return result;
}

function firstCsvField(line) {
  if (line[0] !== '"') {
    const comma = line.indexOf(",");
    return comma < 0 ? line : line.slice(0, comma);
  }
  let value = "";
  for (let i = 1; i < line.length; i++) {
    if (line[i] !== '"') { value += line[i]; continue; }
    if (line[i + 1] === '"') { value += '"'; i++; continue; }
    return value;
  }
  return value;
}

function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { value += '"'; i++; }
        else quoted = false;
      } else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { fields.push(value); value = ""; }
    else value += char;
  }
  fields.push(value);
  return fields;
}

function normalizeHeader(value) { return value.replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}
