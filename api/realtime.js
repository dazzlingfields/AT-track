export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Serve the same snapshot for a short window to keep all users in sync
  const TTL_MS = 9000;                   // shared snapshot lifetime 9s
  const STALE_FALLBACK_MAX_MS = 120000;  // serve stale up to 2 min on errors
  const UPSTREAM_URL = "https://api.at.govt.nz/realtime/legacy";

  const now = Date.now();
  globalThis.__AT_CACHE__ ||= { data: null, ts: 0, etag: null };
  globalThis.__AT_PENDING__ ||= null;
  const cache = globalThis.__AT_CACHE__;

  if (cache.data && now - cache.ts < TTL_MS) {
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "hit");
    return res.status(200).json(cache.data);
  }

  try {
    if (!globalThis.__AT_PENDING__) {
      globalThis.__AT_PENDING__ = (async () => {
        const upstreamRes = await fetch(UPSTREAM_URL, {
          headers: { "Ocp-Apim-Subscription-Key": process.env.AT_API_KEY },
          cache: "no-store",
        });

        if (upstreamRes.status === 403 || upstreamRes.status === 429) {
          const body = await safeBody(upstreamRes);
          const err = new Error(`Upstream error: ${upstreamRes.status}`);
          err.status = upstreamRes.status; err.body = body;
          throw err;
        }
        if (!upstreamRes.ok) {
          const body = await safeBody(upstreamRes);
          const err = new Error(`Upstream error: ${upstreamRes.status}`);
          err.status = upstreamRes.status; err.body = body;
          throw err;
        }

        const data = await upstreamRes.json();
        cache.data = data;
        cache.ts = Date.now();
        cache.etag = `"rt-${cache.ts}-${JSON.stringify(data).length}"`;
        return cache;
      })().finally(() => { globalThis.__AT_PENDING__ = null; });
    }

    const fresh = await globalThis.__AT_PENDING__;
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "miss");
    res.setHeader("ETag", fresh.etag || "");
    return res.status(200).json(fresh.data);
  } catch (e) {
    if (cache.data && now - cache.ts <= STALE_FALLBACK_MAX_MS) {
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
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${sMax}, stale-while-revalidate=60`);
}
async function safeBody(r) { try { return await r.text(); } catch { return ""; } }
function truncate(s, n) { return !s ? "" : s.length > n ? s.slice(0, n) + "…" : s; }
