# Papakura transfer timing audit

Reviewed 7 October 2026. Changes deployed to `at-route-performance.dazzlingfields.workers.dev`.

## How the data reaches the tracker

The existing map and tracker use `https://atrealtime.vercel.app`. The server-side AT key stays in that proxy. The Cloudflare Worker calls its combined realtime endpoint roughly every 20 seconds and saves observations to D1. Collection does not depend on an open browser.

The station timetable comes from `/api/departures`. Its source, `api/departures.js`, queries AT GTFS stop-trips for the relevant service dates and hours, follows bounded pagination, and falls back to a trip's stop-times when a platform record lacks a usable clock time. `schedule-data.js` converts GTFS times to Auckland timestamps, including service times after midnight and daylight-saving boundaries. It keeps partial boards labelled partial rather than inventing missing times.

The tracker groups the 376's station timetable by route, trip ID and service day. Distinct stop sequences establish its first station visit and second station visit. The second visit supplies bus → city train comparisons; the first supplies Pukekohe-bound train → bus comparisons. Arrivals and departures are separate events. The two-minute walk, minimum one minute, and ten-minute reverse-transfer window remain configurable.

## Why Unknown appeared

**Platform 2 was omitted.** The tracker requested Papakura platforms 1 and 3. The supplied stop catalogue identifies platform 2 as `9229-e27fe938`; querying it returned city-bound South City services missing from the archived board. For example, the 17:54, 18:09 and 18:24 services were absent, and some buses were consequently matched to the later 18:39 train. All three platforms are now included, and deployment forces a timetable refresh when that stop list changes.

**The latest popup delay is not historical station timing.** The map selects a relevant stop update and reads its arrival delay, departure delay or trip-level delay. The legacy feed often carries only the latest stop, so the Papakura update disappears when the vehicle advances. A later vehicle delay alone cannot prove when it arrived at Papakura. Both interfaces now use shared stop-selection/delay functions, and the tracker displays current vehicle delays as context.

**Some valid reports were rejected because of timestamp lag.** Fresh train updates contained departure timestamps after the update timestamp but already before the feed header. The old collector rejected all of them. It now accepts these as reports when uncertainty is explicitly zero and the event is already past. Older confirmed events inside a fresh feed are also retained. Old predictions do not become observations merely because the clock passes their forecast time.

**Station forecasts were forgotten.** Fresh Papakura arrival/departure predictions now have a separate archive. A later timestamped stop with a higher sequence confirms that the station was passed. The retained forecast can then supply an estimate; it is never silently converted to a confirmed station event. Skipped/no-data stops invalidate that evidence. Route, trip, service day and start time must match.

**Targets still in the future were shown as Unknown.** They now show Pending. The dashboard also warns when successful collection is more than 2½ minutes behind, and the Worker saves an attempt checkpoint before parsing and ingestion.

## Reading the results

Reported station arrival/departure times take priority. Some missing arrivals can be bounded conservatively using a recorded departure; only conclusions that bound actually proves are classified.

Where exact reports are absent, remembered station forecasts or delays at nearby stops within two sequences can provide labelled estimates. Their timing range has at least one minute of uncertainty and is bounded by available preceding/following events. A range crossing the walking or maximum-wait threshold shows **Close · estimate**. GPS dwell evidence remains another separate estimate source. Each row exposes its timing evidence, missing reports, source and range.

Only reported or conservatively proven connections enter the reported transfer percentage. Estimates remain separate. Missing historical station reports cannot be reconstructed exactly from the current live feed. Some older Unknown rows therefore remain, particularly where neither station nor nearby train timings were captured. The timetable currently supplies departure times; projected arrival estimates explicitly identify that basis.

All history, including remembered predictions, follows the existing three-calendar-month purge.

## Verification

- 82 automated tests passed across the timetable proxy, Auckland time conversion, realtime parsing, route isolation and performance system.
- Regression tests cover platform 2 selection, forecast versus reported timing, timestamp lag, matching later progress, uncertainty corrections, skipped-stop invalidation, retention and local/D1 parity.
- Dashboard interactions and layout passed at 1440, 390 and 320 pixels.
- Live D1 checks confirmed all three platforms in the timetable checkpoint and real 376 station predictions retained and marked passed after later stop reports.
- Live cron logs showed three successful samples per invocation, approximately 44 seconds elapsed, with no exceptions. Successful checkpoints advanced after deployment.

AT field definitions: https://dev-portal.at.govt.nz/realtime-api
