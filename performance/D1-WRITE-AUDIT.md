# D1 write reduction and trip endpoints

Reviewed and deployed 8 October 2026 to `at-route-performance.dazzlingfields.workers.dev`. Deployment version: `8bbb4bc4-583f-4a2c-88b6-b4ab752eba79`. Post-deployment checks were omitted at the user's request.

Subsequently checked at the user's request on 8 October: production collector checkpoints advanced from 13:56:50 to 13:59:10 Auckland time with no collector errors, 20-second collection configured and the lease released to zero. Live cron logs used the deployed version and completed without exceptions. Unauthenticated website access correctly returned 401. A production archived trip produced a first-stop departure 35 seconds late and final-stop arrival 5 seconds late using the endpoint summary logic. Authenticated frontend rendering was not checked because no signed-in browser session was available. The upstream Papakura timetable checkpoint was partial. Full-day write savings remain unmeasured.

## Write overhead

The Cloudflare collector runs every 20 seconds: up to 4,320 polls per day. Stop events already skip unchanged updates, occupancy uses five-minute buckets, and trip timetables are archived once per route/trip/service date. Batching reduces query overhead but does not reduce the number of rows D1 counts as written.

The recurring overhead was in the `state` table:

- Each successful poll wrote three collector checkpoints. The intermediate checkpoint repeated information that the final checkpoint could save. There are now two: the attempt and the final result, preserving evidence of interrupted collection.
- `setState` used `INSERT OR REPLACE`. It now updates the existing value on conflict and skips identical JSON, keeping the indexed key in place.
- Each poll inserted and deleted a lease. It now retains that row, acquires it atomically when expired, and releases it by updating its unindexed value to zero. The owner check remains, and release is attempted even if saving the final checkpoint fails.

Conservative planning estimate at continuous 20-second polling: removing one checkpoint saves at least 4,320 table writes/day; keeping the lease avoids approximately 8,640 table/index writes/day. Together these target roughly 13,000 fewer billed rows/day, before additional savings from replacing state replacements with updates. This is an estimate from the schema and collection rate, not a measured production reduction. Actual savings depend on successful poll counts and D1's returned metadata. Transport writes and daily history deletion still vary with service volume.

Successful collection now logs `d1_collection_usage.rowsWritten`, summed from D1 response metadata for collection writes, without writing another metrics row to D1. Daily retention runs separately. Worker log sampling still applies; use D1 Row Metrics to confirm the full-day result after deployment.

The 20-second sampling rate, raw arrival/departure events, corrections, station predictions, GPS evidence and occupancy sampling are preserved. There is no schema migration or historical data deletion in this change.

Cloudflare counts table and relevant index writes, and its free allowance resets at 00:00 UTC (1 pm Auckland during NZ daylight saving, noon during standard time), rather than on a rolling 24-hour window: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Trip endpoint timing

The trip detail API and both dashboard versions now summarize departure at the first scheduled stop and arrival at the final scheduled stop. Signed delays show early, exactly on time, or late. The existing timing rules use reported delay when supplied and the archived timetable when calculating a missing delay.

Endpoints are identified from the archived full timetable and matched by stop code and sequence, with the selected trip start time filtering reports. This keeps repeated visits on loop trips and separate instances of the same trip distinct. Intermediate observations are never substituted for missing endpoint evidence. Missing observations show Not captured or Pending; missing full timetables show Timetable unavailable. Cancelled services retain their cancellation status.

## Validation

- 43 performance tests passed, covering local/D1 SQL parity, two checkpoints per successful poll, reusable leases, unchanged-state suppression, corrections, trip instances, loops, missing endpoints and cancellations.
- Combined dashboard browser checks cover 1440, 390 and 320 pixel widths, including the two endpoint summaries.
- Wrangler deployment dry run passed and production deployment completed. Full-day production metrics remain outstanding; no post-deployment checks were run at the user's request.
