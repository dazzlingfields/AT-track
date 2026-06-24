/* AT Realtime Map — service worker
 *
 * Goals:
 *   1. Installable, offline-capable app shell.
 *   2. The large reference data (bus_routes.geojson ~7 MB, frequent_routes.geojson,
 *      stop CSVs, rail GeoJSON) is cached so it loads instantly and works offline,
 *      while still picking up service-change updates you commit.
 *   3. Map tiles get a capped runtime cache for snappy panning + light offline use.
 *   4. The realtime API is NEVER cached — live data always goes to the network.
 *
 * Update workflow: bump CACHE_VERSION when you want every client to drop old caches
 * and re-fetch the shell. Data files self-update via stale-while-revalidate, so a new
 * geojson commit is picked up on the next load or two without a version bump.
 */
const CACHE_VERSION = "v1";
const SHELL_CACHE = `at-shell-${CACHE_VERSION}`;
const DATA_CACHE  = `at-data-${CACHE_VERSION}`;
const TILE_CACHE  = `at-tiles-${CACHE_VERSION}`;
const TILE_MAX_ENTRIES = 500;

// Core shell — cached up-front on install so the app boots offline.
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./script.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "https://unpkg.com/leaflet@1.7.1/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.7.1/dist/leaflet.js",
  "https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js",
];

// Host of the realtime proxy — must always hit the network.
const REALTIME_HOST = "atrealtime.vercel.app";

// Tile hosts get the capped runtime cache.
const TILE_HOSTS = [
  "basemaps.cartocdn.com",
  "server.arcgisonline.com",
  "tile.openstreetmap.org",
];

const isTile = (url) => TILE_HOSTS.some((h) => url.hostname.endsWith(h));
const isData = (url) =>
  url.origin === self.location.origin &&
  /\.(geojson|csv)$/i.test(url.pathname);
const isShell = (url) =>
  SHELL_ASSETS.includes(url.href) ||
  (url.origin === self.location.origin &&
    /\.(html|js|css|webmanifest|png|ico)$/i.test(url.pathname)) ||
  url.hostname.endsWith("unpkg.com") ||
  url.hostname.endsWith("cdn.jsdelivr.net");

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // reload to bypass the HTTP cache so we precache the freshest shell
      await Promise.allSettled(
        SHELL_ASSETS.map((u) => cache.add(new Request(u, { cache: "reload" })))
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, DATA_CACHE, TILE_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// Let the page trigger an immediate activation after an update.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Realtime API: never cache.
  if (url.hostname.endsWith(REALTIME_HOST)) return;

  if (isTile(url)) { event.respondWith(tileFirst(req)); return; }
  if (isData(url)) { event.respondWith(staleWhileRevalidate(req, DATA_CACHE)); return; }
  if (isShell(url)) { event.respondWith(staleWhileRevalidate(req, SHELL_CACHE)); return; }
  // Everything else: default to the network.
});

// Serve from cache immediately, refresh in the background for next time.
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

// Tiles: cache-first with a simple FIFO cap so storage doesn't grow unbounded.
async function tileFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) {
      cache.put(req, res.clone()).then(() => trimCache(TILE_CACHE, TILE_MAX_ENTRIES)).catch(() => {});
    }
    return res;
  } catch {
    return cached || Response.error();
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // Delete the oldest entries (insertion order) down to the cap.
  for (let i = 0; i < keys.length - maxEntries; i++) await cache.delete(keys[i]);
}
