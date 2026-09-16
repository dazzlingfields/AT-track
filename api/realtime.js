export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Realtime cache settings
  const TTL_MS = 5000;                    // 5 seconds fresh
  const STALE_FALLBACK_MAX_MS = 30000;   // 30 seconds stale fallback
  const UPSTREAM_TIMEOUT_MS = 8000;

  const UPSTREAM_URL =
    "https://api.at.govt.nz/realtime/legacy";

  const now = Date.now();

  globalThis.__AT_CACHE__ ||= {
    data: null,
    ts: 0,
    etag: null
  };

  globalThis.__AT_PENDING__ ||= null;

  const cache = globalThis.__AT_CACHE__;

  // Fresh cache hit
  if (
    cache.data &&
    now - cache.ts < TTL_MS
  ) {
    setRealtimeHeaders(res, TTL_MS);

    res.setHeader("x-cache", "hit");
    res.setHeader("ETag", cache.etag || "");

    return res.status(200).json(cache.data);
  }

  try {
    // Single-flight request
    if (!globalThis.__AT_PENDING__) {
      globalThis.__AT_PENDING__ = (async () => {
        const upstreamRes = await fetchWithTimeout(
          UPSTREAM_URL,
          {
            headers: {
              "Ocp-Apim-Subscription-Key":
                process.env.AT_API_KEY
            },
            cache: "no-store"
          },
          UPSTREAM_TIMEOUT_MS
        );

        if (!upstreamRes.ok) {
          const body = await safeBody(upstreamRes);

          const err = new Error(
            `Upstream error: ${upstreamRes.status}`
          );

          err.status = upstreamRes.status;
          err.body = body;
          err.retryAfter =
            upstreamRes.headers.get("retry-after") || "";

          throw err;
        }

        const data = await upstreamRes.json();

        cache.data = data;
        cache.ts = Date.now();
        cache.etag = `"rt-${cache.ts}"`;

        return cache;
      })().finally(() => {
        globalThis.__AT_PENDING__ = null;
      });
    }

    const fresh = await globalThis.__AT_PENDING__;

    setRealtimeHeaders(res, TTL_MS);

    res.setHeader("x-cache", "miss");
    res.setHeader("ETag", fresh.etag || "");

    return res.status(200).json(fresh.data);

  } catch (e) {
    // Use recent cached data if AT temporarily fails
    if (
      cache.data &&
      now - cache.ts <= STALE_FALLBACK_MAX_MS
    ) {
      setRealtimeHeaders(res, TTL_MS);

      res.setHeader("x-cache", "stale-hit");

      if (e?.status) {
        res.setHeader(
          "x-upstream-status",
          String(e.status)
        );
      }

      if (e?.body) {
        res.setHeader(
          "x-upstream-body",
          truncate(e.body, 160)
        );
      }

      return res.status(200).json(cache.data);
    }

    // Rate limited
    if (e?.status === 429) {
      const retryAfter =
        /^\d+$/.test(String(e.retryAfter))
          ? String(e.retryAfter)
          : "10";

      res.setHeader(
        "Retry-After",
        retryAfter
      );

      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );

      return res.status(429).json({
        error: "Upstream rate limited",
        retryAfter: Number(retryAfter)
      });
    }

    const status = e?.status ? 502 : 500;

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    return res.status(status).json({
      error: e?.message || "Proxy error",
      body: e?.body || ""
    });
  }
}


// Short CDN cache for realtime data
function setRealtimeHeaders(res, ttlMs) {
  const sMax = Math.max(
    1,
    Math.floor(ttlMs / 1000)
  );

  res.setHeader(
    "Cache-Control",
    `public, max-age=0, s-maxage=${sMax}`
  );
}


// Timeout protection for AT requests
function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();

  const id = setTimeout(
    () => ctrl.abort(),
    timeoutMs
  );

  return fetch(url, {
    ...opts,
    signal: ctrl.signal
  }).finally(() => {
    clearTimeout(id);
  });
}


async function safeBody(r) {
  try {
    return await r.text();
  } catch {
    return "";
  }
}


function truncate(s, n) {
  if (!s) return "";

  return s.length > n
    ? s.slice(0, n) + "…"
    : s;
}
