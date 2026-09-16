export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const key = (s) => (s || "").trim();

  const idsParam = (
    req.query.ids || ""
  ).toString();

  const ids = [
    ...new Set(
      idsParam
        .split(",")
        .map((x) => key(x))
        .filter(Boolean)
    )
  ];

  if (ids.length === 0) {
    return ok(res, { data: [] }, 5);
  }

  const now = Date.now();

  // Trip metadata cache
  const PER_ID_TTL_MS = 5 * 60 * 1000;
  const STALE_FALLBACK_MS = 30 * 60 * 1000;

  const UPSTREAM_TIMEOUT_MS = 8000;
  const MAX_CONCURRENCY = 4;

  // Per-trip caches
  globalThis.__AT_TRIPS_CACHE__ ||= new Map();
  globalThis.__AT_TRIPS_PENDING__ ||= new Map();

  const cache = globalThis.__AT_TRIPS_CACHE__;
  const pending = globalThis.__AT_TRIPS_PENDING__;

  const freshHits = [];
  const toFetch = [];

  // Check cache
  for (const id of ids) {
    const c = cache.get(id);

    if (
      c &&
      now - c.ts < PER_ID_TTL_MS
    ) {
      if (c.data?.data?.attributes) {
        freshHits.push(c.data.data);
      } else if (c.data?.attributes) {
        freshHits.push(c.data);
      } else if (
        Array.isArray(c.data?.data)
      ) {
        freshHits.push(...c.data.data);
      }
    } else {
      toFetch.push(id);
    }
  }

  const results = [...freshHits];

  let i = 0;


  const fetchOne = async (id) => {
    // Deduplicate requests for same trip
    if (pending.has(id)) {
      return pending.get(id);
    }

    const p = (async () => {
      const url =
        `https://api.at.govt.nz/gtfs/v3/trips/${encodeURIComponent(id)}`;

      const r = await fetchWithTimeout(
        url,
        {
          headers: {
            "Ocp-Apim-Subscription-Key":
              process.env.AT_API_KEY
          },
          cache: "no-store"
        },
        UPSTREAM_TIMEOUT_MS
      );

      // Forbidden / rate limited
      if (
        r.status === 403 ||
        r.status === 429
      ) {
        const body = await safeBody(r);

        const old = cache.get(id);

        if (
          old &&
          now - old.ts <= STALE_FALLBACK_MS
        ) {
          return old.data;
        }

        const err = new Error(
          `Upstream error: ${r.status}`
        );

        err.status = r.status;
        err.body = body;

        throw err;
      }

      // Other errors
      if (!r.ok) {
        const body = await safeBody(r);

        // Missing trip
        if (r.status === 404) {
          return null;
        }

        const err = new Error(
          `Upstream error: ${r.status}`
        );

        err.status = r.status;
        err.body = body;

        throw err;
      }

      const data = await r.json();

      // Save successful response
      cache.set(id, {
        data,
        ts: Date.now()
      });

      return data;

    })().finally(() => {
      pending.delete(id);
    });

    pending.set(id, p);

    return p;
  };


  const runNext = async () => {
    while (i < toFetch.length) {
      const id = toFetch[i++];

      try {
        const tripObj =
          await fetchOne(id);

        if (
          tripObj?.data?.attributes
        ) {
          results.push(
            tripObj.data
          );

        } else if (
          Array.isArray(
            tripObj?.data
          )
        ) {
          results.push(
            ...tripObj.data
          );

        } else if (
          tripObj?.attributes
        ) {
          results.push(
            tripObj
          );
        }

      } catch (e) {
        res.setHeader(
          "x-trip-error",
          (e?.message || "")
            .slice(0, 120)
        );
      }
    }
  };


  const workers = Array.from(
    {
      length: Math.min(
        MAX_CONCURRENCY,
        toFetch.length
      )
    },
    runNext
  );

  await Promise.all(workers);

  return ok(
    res,
    {
      data: results.filter(Boolean)
    },
    5
  );
}


// Upstream timeout
function fetchWithTimeout(
  url,
  opts,
  timeoutMs
) {
  const ctrl =
    new AbortController();

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


// Response cache headers
function ok(
  res,
  payload,
  ttlSeconds
) {
  res.setHeader(
    "Cache-Control",
    `public, max-age=0, s-maxage=${Math.max(
      1,
      ttlSeconds
    )}`
  );

  return res
    .status(200)
    .json(payload);
}


async function safeBody(r) {
  try {
    return await r.text();
  } catch {
    return "";
  }
}
