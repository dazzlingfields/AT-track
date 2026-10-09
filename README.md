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

Desktop station selections open a side panel; smaller screens use a compact map popup.
The station average is the signed delay of measured arrivals over the past seven
Auckland calendar days, including early running and zero. Only routes tracked in
Performance have history; the sample count, routes and dates show the coverage.
The public aggregate endpoint caches one network snapshot for all stations and
requires no performance login. Unknown delays are excluded.

The Strand, Frankton, Rotokauri and Huntly use static intercity timetables without
AT departure queries. Pukekohe and Puhinui retain metro boards alongside Te Huia.
Timetables in intercity-data.js were checked 9 October 2026 against the official
[Te Huia booklet](https://www.tehuiatrain.co.nz/assets/Te-Huia/TeHuiaBooklet.pdf),
[closures](https://www.tehuiatrain.co.nz/timetables/) and
[Northern Explorer timetable](https://www.greatjourneysnz.com/scenic-trains/northern-explorer-train/timetable/).
Published running days, public holidays and Christmas closures are included.
Times are scheduled, not live predictions; review this file when operators change them.

Train carriage counts are shown only when a fresh vehicle report supplies a complete
GTFS multi_carriage_details list. The current public AT feed does not supply it;
vehicle labels and nearby trains are not treated as evidence of a six-car train.
Vehicle details and station platform codes are collapsed to keep the main information
clear. Bus interchange icons stay anchored to their actual coordinates at every zoom.

Timetables load only for the open stop/station, use every platform in batches of up
to eight, and refresh at most once a minute. Partial failures and offline state are
shown explicitly. `schedule-data.js` also preserves separate scheduled arrivals and
departures when the proxy supplies them; older proxy responses remain compatible.

Verification: `node --test tests/station-panel.test.cjs tests/schedule.test.cjs tests/transit-data.test.cjs
tests/bus-stations.test.cjs tests/rail.test.cjs` and, with Playwright and Chrome,
`node tests/browser-smoke.cjs`. The latter checks 1440, 390 and 320 pixel widths.
Rebuild the combined map using `node scripts/build-pages.cjs` and copy the generated
map assets into `next/live/` with `next/sw.js` when publishing to GitHub Pages.
