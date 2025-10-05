export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const UPSTREAM_URL = "https://api.at.govt.nz/gtfs/v3/routes";
  const TTL_MS = 45 * 60 * 1000;       // 30 minutes fresh
  const STALE_FALLBACK_MS = 6 * 60 * 60 * 1000; // up to 6 hours stale on failures

  const now = Date.now();
  globalThis.__AT_ROUTES_CACHE__ ||= { data: null, ts: 0, etag: null };
  globalThis.__AT_ROUTES_PENDING__ ||= null;
  const cache = globalThis.__AT_ROUTES_CACHE__;

  if (cache.data && now - cache.ts < TTL_MS) {
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "hit");
    return res.status(200).json(cache.data);
  }

  try {
    if (!globalThis.__AT_ROUTES_PENDING__) {
      globalThis.__AT_ROUTES_PENDING__ = (async () => {
        const r = await fetch(UPSTREAM_URL, {
          headers: { "Ocp-Apim-Subscription-Key": process.env.AT_API_KEY },
          cache: "no-store",
        });

        if (r.status === 403 || r.status === 429) {
          const body = await safeBody(r);
          const err = new Error(`Upstream error: ${r.status}`);
          err.status = r.status; err.body = body;
          throw err;
        }
        if (!r.ok) {
          const body = await safeBody(r);
          const err = new Error(`Upstream error: ${r.status}`);
          err.status = r.status; err.body = body;
          throw err;
        }

        const data = await r.json();
        cache.data = data;
        cache.ts = Date.now();
        cache.etag = `"routes-${cache.ts}-${JSON.stringify(data).length}"`;
        return cache;
      })().finally(() => { globalThis.__AT_ROUTES_PENDING__ = null; });
    }

    const fresh = await globalThis.__AT_ROUTES_PENDING__;
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "miss");
    res.setHeader("ETag", fresh.etag || "");
    return res.status(200).json(fresh.data);
  } catch (e) {
    if (cache.data && now - cache.ts <= STALE_FALLBACK_MS) {
      setSWRHeaders(res, TTL_MS);
      res.setHeader("x-cache", "stale-hit");
      if (e?.status) {
        res.setHeader("x-upstream-status", String(e.status));
        if (e.body) res.setHeader("x-upstream-body", truncate(e.body, 160));
      }
      return res.status(200).json(cache.data);
    }
    const status = e?.status ? 502 : 500;
    return res.status(status).json({ error: e?.message || "Proxy error", body: e?.body || "" });
  }
}

function setSWRHeaders(res, ttlMs) {
  const sMax = Math.max(1, Math.floor(ttlMs / 1000));
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${sMax}, stale-while-revalidate=600`);
}
async function safeBody(r) { try { return await r.text(); } catch { return ""; } }
function truncate(s, n) { return !s ? "" : s.length > n ? s.slice(0, n) + "…" : s; }
