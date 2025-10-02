export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const key = (s) => (s || "").trim();
  const idsParam = (req.query.ids || "").toString();
  const ids = [...new Set(idsParam.split(",").map((x) => key(x)).filter(Boolean))];

  if (ids.length === 0) return ok(res, { data: [] }, 5);

  const now = Date.now();
  const PER_ID_TTL_MS = 30 * 60 * 1000;     // 30 minutes fresh per trip
  const STALE_FALLBACK_MS = 60 * 60 * 1000; // 60 minutes stale window
  const MAX_CONCURRENCY = 4;

  // Global per id caches and inflight dedupe
  globalThis.__AT_TRIPS_CACHE__ ||= new Map();   // id -> { data, ts }
  globalThis.__AT_TRIPS_PENDING__ ||= new Map(); // id -> Promise
  const cache = globalThis.__AT_TRIPS_CACHE__;
  const pending = globalThis.__AT_TRIPS_PENDING__;

  // Serve any fresh cached items immediately, but continue to fetch missing or stale ones
  const freshHits = [];
  const toFetch = [];
  for (const id of ids) {
    const c = cache.get(id);
    if (c && now - c.ts < PER_ID_TTL_MS) {
      // immediate hit
      if (c.data?.data?.attributes) freshHits.push(c.data.data);
      else if (c.data?.attributes)   freshHits.push(c.data);
      else if (Array.isArray(c.data?.data)) freshHits.push(...c.data.data);
    } else {
      toFetch.push(id);
    }
  }

  // Background refresh for stale or missing
  const results = [...freshHits]; // start with cached
  let i = 0;

  const fetchOne = async (id) => {
    // dedupe
    if (pending.has(id)) return pending.get(id);
    const p = (async () => {
      const url = `https://api.at.govt.nz/gtfs/v3/trips/${encodeURIComponent(id)}`;
      const r = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": process.env.AT_API_KEY },
        cache: "no-store",
      });

      if (r.status === 403 || r.status === 429) {
        const body = await safeBody(r);
        const old = cache.get(id);
        if (old && now - old.ts <= STALE_FALLBACK_MS) return old.data;
        const err = new Error(`Upstream error: ${r.status}`); err.status = r.status; err.body = body; throw err;
      }
      if (!r.ok) {
        const body = await safeBody(r);
        if (r.status === 404) return null; // missing
        const err = new Error(`Upstream error: ${r.status}`); err.status = r.status; err.body = body; throw err;
      }

      const data = await r.json(); // { data: { id, attributes } }
      cache.set(id, { data, ts: Date.now() });
      return data;
    })().finally(() => pending.delete(id));
    pending.set(id, p);
    return p;
  };

  const runNext = async () => {
    while (i < toFetch.length) {
      const id = toFetch[i++];
      try {
        const tripObj = await fetchOne(id);
        if (tripObj?.data?.attributes) results.push(tripObj.data);
        else if (Array.isArray(tripObj?.data)) results.push(...tripObj.data);
        else if (tripObj?.attributes) results.push(tripObj);
      } catch (e) {
        res.setHeader("x-trip-error", (e?.message || "").slice(0, 120));
      }
    }
  };
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, toFetch.length) }, runNext);
  await Promise.all(workers);

  // Return normalized shape { data: [ { attributes... } ] }
  return ok(res, { data: results.filter(Boolean) }, 10);
}

function ok(res, payload, ttlSeconds) {
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${Math.max(1, ttlSeconds)}, stale-while-revalidate=60`);
  return res.status(200).json(payload);
}
async function safeBody(r) { try { return await r.text(); } catch { return ""; } }
