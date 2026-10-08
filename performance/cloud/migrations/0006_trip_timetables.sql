CREATE TABLE IF NOT EXISTS trip_timetables (
 route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,
 stops_json TEXT NOT NULL,metadata_json TEXT NOT NULL,captured_at REAL NOT NULL,
 PRIMARY KEY(route_id,service_date,trip_id)
);
CREATE INDEX IF NOT EXISTS trip_events ON events(route_id,service_date,trip_id,start_time);
