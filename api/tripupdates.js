// /api/tripupdates  -> GTFS-RT trip updates (schedule delays).
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const TTL_MS = 9000;
  const STALE_FALLBACK_MAX_MS = 120000;
  const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_URL = "https://api.at.govt.nz/gtfs/v3/tripupdates";

  const now = Date.now();
  globalThis.__AT_TU_CACHE__ ||= { data: null, ts: 0, etag: null };
  globalThis.__AT_TU_PENDING__ ||= null;
  const cache = globalThis.__AT_TU_CACHE__;

  if (cache.data && now - cache.ts < TTL_MS) {
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "hit");
    res.setHeader("ETag", cache.etag || "");
    return res.status(200).json(cache.data);
  }

  try {
    if (!globalThis.__AT_TU_PENDING__) {
      globalThis.__AT_TU_PENDING__ = (async () => {
   const r = await fetchWithTimeout(UPSTREAM_URL, {
  headers: { 
    "Ocp-Apim-Subscription-Key": process.env.AT_API_KEY,
    "Accept": "application/json"
  },
  cache: "no-store",
}, UPSTREAM_TIMEOUT_MS);
        if (!r.ok) {
          const body = await safeBody(r);
          const err = new Error(`Upstream error: ${r.status}`);
          err.status = r.status; err.body = body;
          err.retryAfter = r.headers.get("retry-after") || "";
          throw err;
        }
        const data = await r.json();
        cache.data = data;
        cache.ts = Date.now();
        cache.etag = `"tu-${cache.ts}"`;
        return cache;
      })().finally(() => { globalThis.__AT_TU_PENDING__ = null; });
    }

    const fresh = await globalThis.__AT_TU_PENDING__;
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "miss");
    res.setHeader("ETag", fresh.etag || "");
    return res.status(200).json(fresh.data);
  } catch (e) {
    if (cache.data && now - cache.ts <= STALE_FALLBACK_MAX_MS) {
      setSWRHeaders(res, TTL_MS);
      res.setHeader("x-cache", "stale-hit");
      if (e?.status) res.setHeader("x-upstream-status", String(e.status));
      return res.status(200).json(cache.data);
    }
    if (e?.status === 429) {
      const ra = /^\d+$/.test(String(e.retryAfter)) ? String(e.retryAfter) : "10";
      res.setHeader("Retry-After", ra);
      res.setHeader("Cache-Control", "no-store");
      return res.status(429).json({ error: "Upstream rate limited", retryAfter: Number(ra) });
    }
    const status = e?.status ? 502 : 500;
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ error: e?.message || "Proxy error", body: e?.body || "" });
  }
}

function fetchWithTimeout(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}
function setSWRHeaders(res, ttlMs) {
  const sMax = Math.max(1, Math.floor(ttlMs / 1000));
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${sMax}, stale-while-revalidate=10`);
}
async function safeBody(r) { try { return await r.text(); } catch { return ""; } }
