// /api/shapes?ids=shapeA,shapeB
// Returns { shapes: { "<shape_id>": [[lat,lon], ...] } } sorted by shape_pt_sequence.
// GTFS shapes are static schedule data, so this caches hard (per-instance + CDN).
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const raw = (req.query.ids ?? req.query.id ?? "").toString().trim();
  if (!raw) return res.status(400).json({ error: "missing ids" });
  const ids = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))].slice(0, 50);

  // IMPORTANT: match the GTFS base/version your existing /api/routes and /api/trips use.
  // AT's GTFS Static API is JSON:API; the shapes resource is /gtfs/v3/shapes/{shapeId}.
  const GTFS_BASE = "https://api.at.govt.nz/gtfs/v3";
  const TTL_MS = 12 * 60 * 60 * 1000;   // 12 h in-instance cache (shapes rarely change)
  const UPSTREAM_TIMEOUT_MS = 8000;

  globalThis.__AT_SHAPES__ ||= new Map(); // shape_id -> { pts, ts }
  const store = globalThis.__AT_SHAPES__;
  const now = Date.now();

  const out = {};
  const need = [];
  for (const id of ids) {
    const c = store.get(id);
    if (c && now - c.ts < TTL_MS) out[id] = c.pts;
    else need.push(id);
  }

  await Promise.all(need.map(async (id) => {
    try {
      const r = await fetchWithTimeout(`${GTFS_BASE}/shapes/${encodeURIComponent(id)}`, {
        headers: { "Ocp-Apim-Subscription-Key": process.env.AT_API_KEY },
        cache: "no-store",
      }, UPSTREAM_TIMEOUT_MS);

      if (!r.ok) { out[id] = store.get(id)?.pts ?? null; return; }

      const j = await r.json();
      const rows = Array.isArray(j?.data) ? j.data : [];
      const pts = rows
        .map(x => { const a = x.attributes || x; return [Number(a.shape_pt_lat), Number(a.shape_pt_lon), Number(a.shape_pt_sequence)]; })
        .filter(p => isFinite(p[0]) && isFinite(p[1]))
        .sort((p, q) => p[2] - q[2])      // sequence is not guaranteed pre-sorted
        .map(p => [p[0], p[1]]);

      store.set(id, { pts, ts: Date.now() });
      out[id] = pts;
    } catch {
      out[id] = store.get(id)?.pts ?? null;
    }
  }));

  // Static data: let the CDN and browser cache it aggressively.
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
  return res.status(200).json({ shapes: out });
}

function fetchWithTimeout(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}
