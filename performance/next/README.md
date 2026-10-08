# AT-track combined workspace

## GitHub Pages + Cloudflare

Build the public frontend with `node scripts/build-pages.cjs`. The default target
is `https://dazzlingfields.github.io/AT-track/next/`, using
`https://at-route-performance.dazzlingfields.workers.dev` as its backend. The
output is `dist/pages/`; publish its `next/` directory alongside the existing
Pages root map. Keep the old root files in place. `--base /other-repo/` and
`--backend https://your-worker.workers.dev` support another deployment.

Pages loads the route catalogue from Cloudflare's public `/api/network/routes`.
It returns the collector's existing AT catalogue, with a 60-second browser TTL
and a five-minute edge-cache TTL. Missing or over-one-day-old catalogue data
returns unavailable rather than an empty successful route list. Live vehicles,
trip metadata and departure boards retain the existing AT proxy. Static geometry
is hosted with the frontend. No second collector or database is created.

Performance pages use the same Cloudflare APIs as the original dashboard. The
public live map does not require sign-in. **Connect performance** asks for the
existing admin password, holds it only in memory and sends it over HTTPS to the
configured backend. Reloading requires signing in again. CSV downloads use the
authenticated API too. No dashboard password or AT/Stitch secret is published.
`PAGES_ORIGIN` in Wrangler permits cross-origin reads and authenticated writes
only for the exact Pages origin; all performance APIs retain authentication.

The original cloud-hosted `/next/` and local preview continue to work using
same-origin APIs. Validate the Pages split with `node --test tests/pages-api.test.cjs`
and `node tests/pages-browser.cjs` (after building; Playwright/Chrome required).

The combined app lives at `/next/`. The original performance dashboard stays at
`/`; the original AT-track map files and public site are unchanged. Both dashboard
interfaces use the same API, database, route settings and background collector.
Cloud deployment retains the existing dashboard authentication on every path.

The design was generated with Google Stitch, then adapted to the existing working
map and reporting code. [Stitch design project](https://stitch.withgoogle.com/projects/1922596994311370284)
(screen `3a878206c26445a5bf379a11adf29aef`). The reference uses illustrative data;
the implementation only displays actual feed/API values, with unknown and offline
states labelled. Palette: off-white canvas, navy typography, cobalt actions,
green reported/healthy states, warm warnings. Live network fills the available
viewport beside the desktop navigation or beneath a compact phone navigation bar.
Performance and selected-service details have separate pages, with no report cards,
page headings or footers occupying the live map. A vehicle popup's **View service
details** button opens its details page without losing the map position.

## Run and build

From the repository root:

```powershell
node scripts/build-next.cjs
cd performance
$env:AT_PROXY_URL = 'https://atrealtime.vercel.app'
node server.cjs
```

Open `http://127.0.0.1:3080/next/`. The local server reuses
`performance/data/performance.sqlite`; it does not pull remote D1 history.
Set `PORT` if 3080 is occupied. The normal `npm start`/`pnpm start` command also
builds the workspace. The existing `.env` settings continue to work.

`performance/next/` contains the authored shell, styles, integration and PWA files.
`scripts/build-next.cjs` combines these with the maintained map and performance
frontends into the ignored `performance/public/next/` directory. No credentials
are embedded. Anchors are checked so upstream structural changes fail the build
instead of silently dropping features. Rebuild after changing either original app.
The cloud package's predev/precheck/predeploy hooks rebuild automatically.

## Features and connections

- Live buses, trains, ferries and out-of-service vehicles; map layers, route focus,
  animated positions, fleet details, occupancy rings, bearing arrows, stop search,
  bus hubs, rail stations and scheduled/live departure boards remain in the map.
- A selected vehicle's details page opens its tracked route's performance or matching recorded
  trip instance. Untracked bus/train routes can be added from the service panel.
  Missing start times only select a trip when the instance is unambiguous.
- Route cards and route workspaces show the matching live vehicles. Historical
  date/search/route filters stay on reporting pages.
- Route add/pause/resume, tolerances, date/time/search filters, stop statistics,
  daily rankings, hourly charts, full trip timetables and arrival/departure
  timelines, history pagination, occupancy and filtered CSV export are retained.
- Both Papakura transfer directions retain walking time, direction and matching
  window controls, result filters, station evidence and reported versus estimated
  rates. The three-month retention and collector rules are unchanged.
- The map pauses network polling when a different workspace view is open. Collection
  runs independently on the server or existing Cloudflare Durable Object.
- Installable PWA at `/next/`. Shell, reference files and a bounded tile cache
  support offline use. History/report APIs, live feeds and authentication failures
  are never cached. Offline history displays disconnected status; saved map
  positions do not become fresh live evidence. This service worker has a separate
  scope/cache namespace from the original map.

The embedded map and workspace communicate through checked same-origin messages.
Only the map document can load its external map libraries, imagery and AT proxy;
the shell/report document retains a restricted resource policy. Worker assets are
still served behind the existing dashboard password.

## Validation

```powershell
node --test tests/performance.test.cjs tests/reliability.test.cjs tests/rail.test.cjs tests/transit-data.test.cjs tests/schedule.test.cjs tests/bus-stations.test.cjs
node scripts/build-next.cjs
node tests/workspace-browser.cjs
node tests/performance-browser.cjs
cd performance/cloud
./deploy.ps1 -Check
```

Browser checks require Playwright and Chrome. They use a test database and mocked
AT data and cover 1440, 390 and 320px, actual map-to-trip navigation, wrong-source
messages, map polling visibility, layer chips, historical-filter isolation, all
report views, pause/resume, export, reloads, offline labels and offline PWA shell
reload without caching private APIs. Screenshots go in `.test-artifacts/workspace/`.
The original dashboard's browser suite continues to validate its existing controls.

Deployment uses the existing `performance/cloud/deploy.ps1` workflow. After
publishing, the combined URL is the existing Worker hostname plus `/next/`;
the original dashboard remains at its root. A successful local/dry-run check does
not itself publish the app or verify the remote database.
