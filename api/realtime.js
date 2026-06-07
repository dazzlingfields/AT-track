export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Serve the same snapshot for a short window to keep callers in sync.
  const TTL_MS = 9000;                   // shared snapshot lifetime
  const STALE_FALLBACK_MAX_MS = 120000;  // serve stale up to 2 min on errors
  const UPSTREAM_TIMEOUT_MS = 8000;      // abort a hung upstream call (< Vercel 10s)
  const UPSTREAM_URL = "https://api.at.govt.nz/realtime/legacy";

  const now = Date.now();
  globalThis.__AT_CACHE__ ||= { data: null, ts: 0, etag: null };
  globalThis.__AT_PENDING__ ||= null;
  const cache = globalThis.__AT_CACHE__;

  // Fast path: fresh in-instance snapshot.
  if (cache.data && now - cache.ts < TTL_MS) {
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "hit");
    res.setHeader("ETag", cache.etag || "");
    return res.status(200).json(cache.data);
  }

  try {
    // Single-flight: at most one upstream fetch per instance at a time.
    if (!globalThis.__AT_PENDING__) {
      globalThis.__AT_PENDING__ = (async () => {
        const upstreamRes = await fetchWithTimeout(UPSTREAM_URL, {
          headers: { "Ocp-Apim-Subscription-Key": process.env.AT_API_KEY },
          cache: "no-store",
        }, UPSTREAM_TIMEOUT_MS);

        if (!upstreamRes.ok) {
          const body = await safeBody(upstreamRes);
          const err = new Error(`Upstream error: ${upstreamRes.status}`);
          err.status = upstreamRes.status;
          err.body = body;
          err.retryAfter = upstreamRes.headers.get("retry-after") || "";
          throw err;
        }

        const data = await upstreamRes.json();
        cache.data = data;
        cache.ts = Date.now();
        cache.etag = `"rt-${cache.ts}"`; // cheap; no full-payload stringify
        return cache;
      })().finally(() => { globalThis.__AT_PENDING__ = null; });
    }

    const fresh = await globalThis.__AT_PENDING__;
    setSWRHeaders(res, TTL_MS);
    res.setHeader("x-cache", "miss");
    res.setHeader("ETag", fresh.etag || "");
    return res.status(200).json(fresh.data);
  } catch (e) {
    // Prefer slightly stale data over an error.
    if (cache.data && now - cache.ts <= STALE_FALLBACK_MAX_MS) {
      setSWRHeaders(res, TTL_MS);
      res.setHeader("x-cache", "stale-hit");
      res.setHeader("ETag", cache.etag || "");
      if (e?.status) {
        res.setHeader("x-upstream-status", String(e.status));
        if (e.body) res.setHeader("x-upstream-body", truncate(e.body, 160));
      }
      return res.status(200).json(cache.data);
    }

    // No usable cache. If upstream rate-limited us, pass 429 + Retry-After through so
    // the client's existing backoff engages instead of polling straight back.
    if (e?.status === 429) {
      const ra = /^\d+$/.test(String(e.retryAfter)) ? String(e.retryAfter) : "10";
      res.setHeader("Retry-After", ra);
      res.setHeader("Cache-Control", "no-store"); // never CDN-cache an error
      return res.status(429).json({ error: "Upstream rate limited", retryAfter: Number(ra) });
    }

    const status = e?.status ? 502 : 500;
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ error: e?.message || "Proxy error", body: e?.body || "" });
  }
}

// fetch with a hard timeout so a hung AT call can't block awaiters or hit the function limit.
function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}
function setSWRHeaders(res, ttlMs) {
  const sMax = Math.max(1, Math.floor(ttlMs / 1000));
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${sMax}, stale-while-revalidate=60`);
}
async function safeBody(r) { try { return await r.text(); } catch { return ""; } }
function truncate(s, n) { return !s ? "" : s.length > n ? s.slice(0, n) + "…" : s; }
