# AT route performance

A separate, small app for bus **376** and the **South City (S-C)** train line. No map, vehicle animations or fleet data. It records observed stop events in a database, shows punctuality and daily history, exports CSV, and lets you add or pause routes. The existing map app is unaffected.

## Current Cloudflare deployment

- Dashboard: https://at-route-performance.dazzlingfields.workers.dev
- Worker: `at-route-performance`; one-minute Cron Trigger.
- D1 database: `at-route-performance` (`d9ba0de3-1ac2-4b07-89fb-1897ef84b374`), created in Oceania.
- Live API: `https://atrealtime.vercel.app`, the proxy configured by the map at https://dazzlingfields.github.io/AT-track/.
- Dashboard username: `admin`. The generated password is saved locally in `performance/cloud/.wrangler/dashboard-login.txt`, which is ignored by version control. Cloudflare stores it as the `DASHBOARD_PASSWORD` secret. Do not publish this local file.

The committed Wrangler config targets this deployment. Redeploy from `performance/cloud` with `./deploy.ps1`; it reuses the existing `cf` CLI session in memory when no API token is supplied. `./deploy.ps1 -Check` performs a local bundle check. Credentials are never copied into source or command arguments. Alternatively, an authenticated Wrangler session can use `pnpm run deploy`. Applying existing migrations is safe because Cloudflare records migration history. Other accounts must replace the account/database IDs and create their own resources. No paid plan or custom domain was purchased.

Live checks on 7 October 2026 confirmed an unauthenticated request returns 401, the authenticated dashboard returns 200, and a real collection stores South City stop events in remote D1. Route 376 and S-C are both resolved from the proxy's live catalogue. The private `POST /api/collect` endpoint can perform a startup check using dashboard authentication and JSON content type; it limits manual collection attempts to once per minute. Routine collection uses the Cron Trigger independently of that endpoint.

## Stop performance and Papakura connections

The compact **Overview** shows performance totals, route cards, Papakura transfers directly below those cards, and the latest selected day's most late and most early service. Separate **Service rankings**, **Stops**, **History**, **Transfers** and **Occupancy** views hold the full details. Views can be bookmarked using their URL fragments. Large stop/history tables scroll within their panels.

Search the entire stored observation history by route, stop name/code, trip ID or trip start time. Date selectors use GTFS service dates; recorded-time filters use Auckland civil time, including daylight saving. A time window such as 22:00–02:00 crosses midnight. Times display in 24-hour format. Today/Yesterday shortcuts select a single service date. History is paginated in 200-row pages, and CSV export uses the same search/time filters (without pagination). Reported cancellations retain their route/date totals because cancellations have no measured stop time.

Each day's extreme lists show up to five **distinct trip instances**, using the most late or early measured stop for each trip within the active filters. They search all matching records, including those older than the latest history page. Unknown delays and exact zero delays are excluded from these lists. The displayed stop and scheduled/recorded time provide the evidence behind each ranking. **View service** filters to that trip/date/route and opens its recorded history.

Papakura has separate search controls for a specific transfer date, planned 376 return time window, destination/trip text, and possible/missed/unknown/cancelled result. Leaving the transfer date blank uses the main date range. Result filtering affects the table but preserves the possible/missed rate for the matching date/time/text cohort, so selecting only “Possible” does not manufacture a 100% success rate.

Stop-by-stop results show stop names, measured/unknown observations, on-time percentage, early/late counts, mean delay and earliest/latest delay. Names come from the supplied bus/train stop exports; stable numeric codes match changing AT ID suffixes. Early and late counts in this table mean any negative or positive delay, respectively; the on-time percentage still uses your configured tolerance. The main route/date/arrival-departure filters apply to this table.

After replacing the supplied stop exports, regenerate the compact labels with `node scripts/build-performance-stopnames.cjs` from the repository root, then redeploy.

The Papakura view compares the **second scheduled 376 visit** with an intended **city-bound South City train**. Default walking time is **2 minutes**, adjustable down to a **1-minute minimum**. These settings are saved in your browser. The live timetable currently shows 376 visits at stop sequence 3 and 31, both at stop 2716; the code discovers distinct sequences per trip rather than hardcoding sequence 31 or counting repeated polls. A lone captured station visit is unclassified instead of being assumed to be the return.

Every five minutes the collector archives Papakura schedules for bus stop 2716 and train platforms 9228/9230. This adds evidence about both bus visits, the intended train, and its destination without polling all stops' timetables. Partial timetable results remain marked partial. Schedules begin accumulating when this feature is deployed, so earlier historical transfers cannot generally be reconstructed. Local key-only mode uses bounded stoptrips queries; proxy mode uses the existing departures endpoint.

For each confirmed return visit, the intended train is the **first scheduled service allowing the chosen walking time**, chosen before checking actual delays. A later observed train never converts a miss of that intended train into a success. The recorded bus arrival plus walking time must be at or before the intended train's recorded departure for an exact **Possible** result. If the arrival is missing but the station departure was captured, departure supplies a conservative upper bound on arrival: a non-negative walking margin proves **Possible**, explicitly labelled conservative. A negative bound remains **Unknown**, because the bus may have arrived earlier. No arrival time is fabricated. The table also shows the train's arrival, departure, signed delay, total gap and spare/short walking margin. Timetable bus station departure is the fallback planned bus time when a scheduled arrival cannot be derived from an observed arrival/delay; it is not relabelled as an observed arrival.

City-bound services are identified from the archived timetable destination (for example “City Centre via Grafton”), not an assumed platform or train vehicle identifier. Direction can be changed to both directions. Transfers use the selected dates independently of the main route and arrival/departure filter. Transfers support up to 31 days per query and include neighbouring service dates when joining overnight events.

Missing origin arrivals without sufficient departure bounds, missing destination departures, ambiguous trip instances and uncaptured schedules remain **Unknown**, excluded from the possible/missed percentage. Train arrivals alone are displayed but do not prove boarding remained possible. Reported cancellations are separate. Future bus returns are not counted as historical attempts. “Possible” estimates the time available; door closure, accessibility needs and whether someone actually boarded are not observed by this feed. Twenty-second sampling can still miss some station events, so always assess measured counts and unknowns alongside the percentage.

The connection selector also supports **Pukekohe-bound South City → 376**, using the first distinct bus station visit. It matches the closest scheduled bus within ±10 minutes (configurable), including planned gaps too short to walk. Actual bus departure must allow the walk and be no more than 10 minutes after recorded train arrival. Long waits count as unavailable connections. Train departure alone cannot prove the maximum wait was satisfied, so those connections remain unknown unless the bound proves the wait was already too long. Exact and conservative evidence counts are shown separately. Missing station events are never inferred from the next stop or from a scheduled time.

Cloud collection now samples roughly every 20 seconds using Durable Object alarms, with a one-minute Cron watchdog, stops on API errors/backoff, and skips overdue samples. Dashboard results refresh each minute while visible. Sampling does not require an open browser and does not purchase a paid plan. More frequent feed calls may use more of the existing AT proxy quota.

## Location evidence and occupancy

The existing combined realtime feed now supplies stop reports and vehicle positions in one request. If it fails (other than rate limiting), collection falls back to trip updates and reports the location error. Route 376 positions are matched by trip and service day, never by vehicle label alone. The station anchor is bus stop 2716 at -37.06495, 174.9463 from the supplied AT stops CSV. Positions older than 120 seconds or in the future are excluded.

Nearby samples (within 600 metres) are archived and used to distinguish the first and second station visits. A GPS dwell requires two different readings 10–90 seconds apart, each within 35 metres of the stop, moving no more than 12 metres between readings. An 80-metre outer boundary and gaps no longer than 90 seconds bound arrival/departure ranges. Timetable proximity and fresh stop progress help identify the visit; ambiguous trip starts, vehicle swaps, multiple dwell episodes and missing timetable visits stay unclassified. A bus passing nearby is not a dwell. GPS station presence does not prove doors opened.

**Likely possible / likely missed · GPS** results are separate estimates and excluded from the reported transfer percentage. Timing ranges that straddle the walking or maximum-wait limit stay unknown. Official stop events take precedence. The station watch shows each active 376's distance from the bus stop and position timestamp; stale sightings are labelled last seen. GPS collection starts with this update and cannot recover missed historical positions.

The **Occupancy** view records one fresh vehicle reading per five-minute bucket per trip for every tracked active route, deduplicating repeated snapshots. It shows the most common reported category and the distribution of readings by route and day. Categories are not a linear scale and are never averaged into invented percentages or passenger counts. When the feed supplies numeric occupancy percentages, the view averages within each trip, then equally across trips with percentage data. Missing categories and no-data reports remain unknown; not-accepting/not-boardable reports are separate from measured fullness. Date, route, civil-time and route/trip/vehicle search filters apply; stop names and arrival/departure selection do not measure vehicle occupancy. GPS samples and occupancy readings share the three-calendar-month purge.

Sources: https://dev-portal.at.govt.nz/realtime-api and https://gtfs.org/documentation/realtime/reference/.

## Recommended hosting: Cloudflare Workers + D1

Use the **Workers Free** plan initially. Workers serves the dashboard, a one-minute Cron Trigger samples at roughly 0, 20 and 40 seconds, and D1 retains history independently of your browser. A free `workers.dev` URL is enough; no domain or always-on computer is required.

Current published allowances are 100,000 Worker requests/day, 5 million D1 rows read/day, 100,000 D1 rows written/day and 5 GB total D1 storage. Index updates also count as writes. Free Workers have a 10 ms CPU budget per invocation. Quotas are shared with other projects on your account. This deployment targets the free tier; actual feed size, route volume, dashboard usage and accumulated history determine whether it stays within those limits. Check Metrics after deploying and adding routes. On the Free plan, exceeding D1 limits causes collection/query failures rather than automatic paid overages. If needed, Workers Paid starts at $5 USD/month, with further usage charges possible.

The collector uses one bulk event insert and one bulk cancellation insert, ignores unchanged duplicate events, caches the route catalogue for an hour, and backs off on upstream rate limits. Reports aggregate in SQL rather than downloading the entire database. The cloud dashboard refreshes reports every five minutes to reduce reads; its collector continues every minute. Applying filters refreshes immediately. Avoid leaving broad year-long reports open continuously. CSV exports are limited to 10,000 events in the cloud; narrow the date range if needed.

Pricing and limits sources (checked 7 October 2026):

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/

### Deploy

Prerequisites: a Cloudflare account and either an AT API key with **Realtime and GTFS API** access, or the URL of your existing deployed AT map (which already provides `/api/routes` and `/api/tripupdates`). No key is included in this source.

From PowerShell, in this project's `performance/cloud` directory:

```powershell
npx wrangler login
npx wrangler d1 create at-route-performance
```

For a new account, copy the returned `database_id` and your account ID into `wrangler.toml`, replacing this deployment's IDs. Then:

```powershell
npx wrangler d1 migrations apply at-route-performance --remote
npx wrangler secret put AT_API_KEY
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler deploy
```

Wrangler prompts for each secret; do not paste keys into tracked files. Use an ASCII dashboard password (HTTP Basic auth). Open the deployment URL and sign in with username **admin** and that password. Authentication protects both the dashboard and its route configuration. The API key remains in the Worker; it is never sent to the browser. Cron collection does not require a dashboard login. Cron Trigger changes may take several minutes to propagate.

This cloud project now pins Wrangler 4.147.0 for repeatable deployments. Run `pnpm install` once in `performance/cloud`, then use `pnpm exec wrangler` instead of `npx wrangler` above. `pnpm run check` validates the bundle, `pnpm run migrate` applies remote migrations, and `pnpm run deploy` publishes the Worker. The pnpm configuration permits only the required esbuild/workerd native build scripts. Sampled Cloudflare logs and traces are enabled for diagnosing collection failures.

If `npx` is unavailable in the Codex bundled runtime, replace `npx wrangler` in these commands with `pnpm --config.node-linker=hoisted dlx wrangler`. The hoisted layout avoids missing transitive dependencies with this runtime's pnpm installation. A local bundle check is `pnpm --config.node-linker=hoisted dlx wrangler deploy --dry-run --outdir .wrangler/dry-run`; it does not publish or create resources.

If reusing the existing map proxy instead of an AT key, run `npx wrangler secret put AT_PROXY_URL` with the map's origin URL (no `/api` suffix), and omit the `AT_API_KEY` step. This shares the existing key and proxy caching, but collection then depends on that deployment's availability and quota. Deploy this tracker as its own Worker, not as another page in the map's static hosting.

For local Cloudflare development, create `performance/cloud/.dev.vars` with `AT_API_KEY` (or `AT_PROXY_URL`) and `DASHBOARD_PASSWORD`, apply the migration with `--local`, and run `npx wrangler dev --test-scheduled`. Invoke `http://localhost:8787/__scheduled?cron=*+*+*+*+*` to test a scheduled run. Never expose that development endpoint publicly.

Back up D1 with `npx wrangler d1 export at-route-performance --remote --output=backup.sql`. History is retained for **three calendar months**. Daily cleanup deletes stop observations, cancellations, station schedules, station GPS samples, remembered station predictions and occupancy readings with Auckland service dates earlier than the cutoff. Month ends are clamped correctly (31 May → 28/29 February). Records on the cutoff date stay until the following day. Cleanup runs from the existing cloud cron independently of feed success, and from local polling; it also applies to paused routes. Route configuration and collection state remain intact. The deletion and success checkpoint are transactional, and failures are retried. Export history before expiry if you want to keep it longer. Deleting cloud data or resetting its database discards history. Cloud and local databases are independent.

## Free local alternative

Node.js **24+**, no npm dependencies, no hosting subscription. The computer must stay awake and the process must remain running to collect. When stopped, it preserves the database but cannot record the missed interval.

```powershell
cd performance
Copy-Item .env.example .env
# Edit .env: set AT_API_KEY or AT_PROXY_URL.
node --env-file-if-exists=.env server.cjs
```

Open **http://127.0.0.1:3080**. The dashboard works before credentials are set and shows “Setup needed”; it never inserts demo data. The collector polls every 20 seconds. Change `POLL_SECONDS` to increase that interval. SQLite history is in `performance/data/performance.sqlite`, independent of browser storage. Stop the process before copying that file for a consistent backup.

`npm start` is an equivalent shortcut when npm is installed.

The local server binds to loopback because it has no login. Keep that default; use the password-protected cloud deployment for internet access. `DB_PATH` can place history on a persistent local disk; this is preferable to a live cloud-synced folder for a running SQLite database. `HOST` and `PORT` are configurable for controlled local deployments.

## What the numbers mean

- Default on-time window: **1 minute early through 5 minutes late, inclusive**. This is an adjustable analysis setting, not a claim about AT's official standard. Changing it recalculates stored delay measurements. Preferences are saved in that browser.
- One observation is one **arrival or departure at a stop**, identified by tracked route, service date, trip ID, trip start time, stop ID, stop sequence and event type. Arrivals and departures are separate; the dashboard defaults to arrivals. It does not count every poll as a separate service.
- Reported delay comes directly from AT. Scheduled time is derived as reported event time minus delay. Missing delays stay **unknown** and are excluded from the percentage and average. Zero is a valid delay.
- The collector records only timestamped stop events that have occurred. Future predictions and delay-only updates are not archived as observed performance. Feed headers older than two minutes, skipped/no-data stops and deleted entities are excluded. A fresh feed may carry an older confirmed event, which is retained; an old prediction never becomes a confirmed event merely because time passes. Corrections to an event update its measurement.
- AT says arrival/departure fields are populated when a vehicle enters/leaves a stop. These are feed-reported events, not independently verified stopwatch measurements: https://dev-portal.at.govt.nz/realtime-api
- Percentages are over **measured stop events**, not whole trips. Observed trip counts are shown separately. Long trips with more observed stops contribute more events. Events do not describe every scheduled service; missed reports are not classified as on time or cancelled.
- Reported cancellations are deduplicated by trip instance and counted separately. Missing trips are not assumed cancelled. Arrival/departure filters do not change cancellation counts.
- Service dates and clock displays use **Pacific/Auckland**. Feed `start_date` determines the service day, including services after midnight. If omitted, the report timestamp's Auckland date is the fallback.
- The legacy feed may only expose the latest stop event. Polling can miss intermediate stops, especially the 20-second cloud sampling. Collection failures are visible; there is no retrospective backfill from the live feed.

Adding routes matches their route code against the AT catalogue, including bus/train mode. `S-C` is the default South City code. Exact GTFS route ID is an optional override for unusual codes; versioned IDs may change after timetable updates. Pausing stops new collection but keeps existing history. Route catalogue coverage and actual trip-update schema need confirmation against your authenticated live feed after deployment.

## Verification

```powershell
node --test tests/performance.test.cjs
```

Run that command from the repository root. Tests cover route isolation, object/list feeds, stale/future data, deduplication, corrected delays, cancellation/unknown denominators, persisted history, local API protections, and the cloud schema/SQL/authentication. They use fixture feeds and a SQLite-backed D1 adapter; they do not spend AT quota or deploy to Cloudflare.

With Playwright and Chrome available, `node tests/performance-browser.cjs` checks desktop and 390/320 pixel layouts, route addition, pause/resume, filtering and changed on-time windows. It uses an in-memory fixture database and saves screenshots in `.test-artifacts/performance/`; that data is never inserted into your real history.

## Trip explorer

Open **Trip explorer**, choose a tracked route and service date, then select a departure. Search accepts clock times, destinations or trip IDs. The compact stop timeline shows every scheduled stop in sequence, separate scheduled and reported arrival/departure times, each event's early/late result, and reported time at the stop when both events were captured. Repeat station visits stay separate. “Not captured” is missing evidence; “Pending” is a future scheduled event. Services without reports remain selectable. Service ranking links open this view. Papakura transfer rows link to each bus and train trip, preserving their respective service dates.

Full schedules come from AT's official public GTFS ZIP, compiled into route-specific static assets for all 200 bus/train route codes in the current feed. Adding a supported tracked route therefore needs no separate timetable deployment. The existing realtime feed supplies observed timings; the timetable never fabricates actual arrivals. Reported delay has priority; if absent and an exact GTFS schedule exists, lateness is calculated against it. Without a GTFS timetable, only captured stops are shown and any schedule derived from event time minus reported delay is labelled.

The collector archives each captured trip's full timetable once in local SQLite or cloud D1. An existing snapshot is preserved across feed/deployment changes and follows the same three-month retention. Viewing a scheduled trip also saves its snapshot. The APIs are `/api/trips?route=1&date=2026-10-07` and `/api/trip?route=1&date=2026-10-07&trip=...&start=...`; start time separates observed trip instances. Both cloud endpoints require the existing dashboard login.

Generated assets are ignored by Git and rebuilt from `https://gtfs.at.govt.nz/gtfs.zip` using `scripts/refresh-trip-timetables.ps1`. The deployment script builds missing assets and refreshes them when older than seven days. For local use or a fresh checkout, run the refresh script before starting the server. Timetables are bundled, so routine collection does not download the large ZIP or query AT once per stop. They are refreshed at deployment, rather than automatically from the running Worker; deploy a refreshed bundle when AT publishes timetable changes. The current source feed covers 17 September–31 December 2026. Service calendars and exception dates determine which departures are listed on a selected day.

## Papakura timing evidence (collector)

The timetable comes from the existing AT proxy’s GTFS stop-trips endpoint (with trip stop-times as a fallback). All three Papakura platforms are queried, including platform 2 (`9229-e27fe938`). Each 376 trip is grouped by service day and trip ID; its first distinct station stop sequence is used for train → bus, and its second for bus → city train. Arrivals and departures are kept separately.

Fresh station predictions are remembered before the feed moves on. A later timestamped stop with a higher sequence confirms that the station was passed; it does not make the earlier forecast an exact arrival. These remembered forecasts, or delays at adjacent stops within two sequences, can supply an explicitly labelled timing estimate with at least a one-minute uncertainty range. Estimates, GPS evidence and confirmed station reports are shown separately. Estimates never enter the measured transfer percentage. A timing range crossing the walking/wait limit is labelled Close · estimate. Future target departures remain Pending; missing historical evidence remains Unknown.

The current vehicle delay list uses the same shared stop-selection and delay fallback logic as the map popup. That latest delay is useful context, but cannot establish an earlier station arrival by itself. The timetable supplies departure times; a projected arrival using it is labelled as such rather than pretending that a separate scheduled arrival was supplied.

AT static timetable data is supplied by Auckland Transport under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This tracker compiles it into route assets and dated trip snapshots; the original source is [AT GTFS](https://at.govt.nz/about-us/at-data-sources/general-transit-feed-specification).

### Untracked train fallback

Bus → train can produce a timetable conclusion when the intended train has no station arrival/departure report, provided the second 376 station visit has a recorded departure and neither trip instance is ambiguous or cancelled. Recorded bus arrival is used if present; otherwise departure is the latest arrival bound. The scheduled train departure minus that bus timing must allow the selected walk (default two minutes, minimum one). Results are labelled Likely possible / likely missed · timetable and counted separately from the measured rate. This applies the user’s assumption that trains do not leave early. A likely miss is conditional: a late train or earlier unrecorded bus arrival can change the outcome. Existing recorded train evidence takes priority, and train → bus still needs its own timing evidence.

## Route-first navigation and collection recovery

The report API includes 24 hourly buckets over the complete filtered history, independent of the 200-row display limit. Route buckets use scheduled stop time in Auckland (reported time only when a schedule is absent), with measured/unknown counts, early/on-time/late counts, average signed delay and distinct trip instances. The current tolerance settings determine punctuality; rates are over stop events rather than whole trips. Empty hours have a null average, never an invented zero. Local SQLite and cloud D1 use the same definitions, including daylight-saving changes and overnight service dates.

Transfer hourly buckets use the scheduled second bus visit for bus → train, and scheduled train arrival for train → bus. Reported conclusions, estimates, unknowns, pending services and cancellations have separate counts. Date, search and time filters select the underlying history; the result-status filter only changes the displayed connection list, so selecting successful connections cannot inflate the chart's success rate. These additive API fields support the current charts and a later replacement layout without changing collection or storage.

Route cards now open a single route workspace: performance totals, early/late services, service selection and the stop timeline. Stop averages, daily performance, observations and occupancy expand in place. The main navigation is Your routes / Papakura connections; older report tools remain under More tools. Route URLs such as `#route-1` preserve the chosen route on reload.

On 7 October, live tail logs confirmed `exceededCpu` terminating scheduled Worker collection and stranding its lease/checkpoint. Collection now runs in a SQLite-backed Durable Object (`PerformanceCollector`) with a recurring 20-second alarm. A minute cron only ensures the alarm remains scheduled. Alarms rearm before external work, preserve API backoff, and retain the existing D1 lease and event deduplication. Stop-report success is saved immediately after ingestion, before optional enrichment. The dashboard and history still use the same Worker and D1 database. No paid plan was purchased. The Durable Object holds only scheduler state; history retains the existing three-month purge.

Cloudflare currently provides SQLite-backed Durable Objects on Free, with a 30-second CPU allowance per alarm, 100,000 requests/day and 13,000 GB-seconds/day; quotas are shared with other account usage. This collector uses about 4,320 alarms and 1,440 watchdog requests per day, with no always-open connections. References: https://developers.cloudflare.com/durable-objects/platform/limits/ and https://developers.cloudflare.com/durable-objects/platform/pricing/.
