// /api/shapes?ids=shapeA,shapeB
// Returns { shapes: { "<shape_id>": [[lat,lon], ...] }, _diag: { "<id>": {...} } }
// GTFS shapes are static, so this caches hard (per-instance + CDN).
//
// Debugging: open /api/shapes?ids=<a real shape_id> in a browser and read _diag.
// If status is 404, AT's GTFS v3 does not expose /shapes/{id} and we must switch to the
// static GTFS zip as the shape source (ask and I'll provide that variant).
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const raw = (req.query.ids ?? req.query.id ?? "").toString().trim();
  if (!raw) return res.status(400).json({ error: "missing ids" });
  const ids = [...new Set(raw.split(",").map(s => s.trim()).filter(Boolean))].slice(0, 50);

  // Must match the base/version your /api/routes and /api/trips proxies use.
  const GTFS_BASE = "https://api.at.govt.nz/gtfs/v3";
  const TTL_MS = 12 * 60 * 60 * 1000;   // 12 h in-instance
  const UPSTREAM_TIMEOUT_MS = 9000;
  const MAX_PAGES = 40;                 // safety cap if AT paginates shape points

  globalThis.__AT_SHAPES__ ||= new Map(); // shape_id -> { pts, ts }
  const store = globalThis.__AT_SHAPES__;
  const now = Date.now();

  const out = {};
  const diag = {};
  const need = [];
  for (const id of ids) {
    const c = store.get(id);
    if (c && now - c.ts < TTL_MS) { out[id] = c.pts; diag[id] = { cache: "hit", points: c.pts ? c.pts.length : 0 }; }
    else need.push(id);
  }

  await Promise.all(need.map(async (id) => {
    const d = { cache: "miss", status: null, points: 0, pages: 0 };
    try {
      const rows = [];
      let url = `${GTFS_BASE}/shapes/${encodeURIComponent(id)}`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const r = await fetchWithTimeout(url, {
          headers: { "Ocp-Apim-Subscription-Key": process.env.AT_API_KEY },
          cache: "no-store",
        }, UPSTREAM_TIMEOUT_MS);
        d.status = r.status;
        d.pages = page + 1;
        if (!r.ok) { d.error = (await safeBody(r)).slice(0, 160); break; }
        const j = await r.json();
        const data = Array.isArray(j?.data) ? j.data
                   : (j?.data ? [j.data] : (Array.isArray(j) ? j : []));
        for (const x of data) {
          const a = x?.attributes || x || {};
          const lat = Number(a.shape_pt_lat ?? a.lat);
          const lon = Number(a.shape_pt_lon ?? a.lon);
          const seq = Number(a.shape_pt_sequence ?? a.sequence ?? 0);
          if (isFinite(lat) && isFinite(lon)) rows.push([lat, lon, seq]);
        }
        url = j?.links?.next || null; // follow JSON:API pagination if present
      }

      const pts = rows.sort((p, q) => p[2] - q[2]).map(p => [p[0], p[1]]);
      d.points = pts.length;
      if (pts.length >= 2) { store.set(id, { pts, ts: Date.now() }); out[id] = pts; }
      else { out[id] = store.get(id)?.pts ?? null; }
    } catch (e) {
      d.error = String(e?.message || e).slice(0, 160);
      out[id] = store.get(id)?.pts ?? null;
    }
    diag[id] = d;
  }));

  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
  return res.status(200).json({ shapes: out, _diag: diag });
}

function fetchWithTimeout(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}
async function safeBody(r) { try { return await r.text(); } catch { return ""; } }
