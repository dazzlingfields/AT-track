Vehicle tracking for Auckland Transport vehicles using the AT API. Bus types are from a JSON file, not all will be available. Data is from Australia bus fleet lists

Station and bus-stop popups show the next six services within an hour, with route,
destination, platform/bay, Auckland time and a countdown. Click a train station,
bus interchange, or an individual bus stop (visible from zoom 16). The original map
and the combined `/next/` map use the same board.

Exact stop predictions are labelled Live. Recent upstream stop delays, or a fresh
trip-level delay, can be applied to the same service day's timetable and are labelled
Estimated. Upstream stop reports must be at most five minutes old and their trip
update at most two minutes old. Passed visits, cancellations, skipped/no-data stops,
wrong service dates and offline/stale reports cannot generate these estimates.
Times are departures unless marked Arrives; an arrival is not presented as a
confirmed departure. Timetable-only services remain Scheduled.

The average is the signed delay of the displayed upcoming services with known live
or estimated delays, including zero and early running. Its coverage and estimate
count are shown. Unknown delays and cancellations are excluded; this is not a
historical station punctuality average. No extra performance login is needed.

Timetables load only for the open stop/station, use every platform in batches of up
to eight, and refresh at most once a minute. Partial failures and offline state are
shown explicitly. `schedule-data.js` also preserves separate scheduled arrivals and
departures when the proxy supplies them; older proxy responses remain compatible.

Verification: `node --test tests/schedule.test.cjs tests/transit-data.test.cjs
tests/bus-stations.test.cjs tests/rail.test.cjs` and, with Playwright and Chrome,
`node tests/browser-smoke.cjs`. The latter checks 1440, 390 and 320 pixel widths.
Rebuild the combined map using `node scripts/build-pages.cjs` and copy the generated
map assets into `next/live/` with `next/sw.js` when publishing to GitHub Pages.
