CREATE TABLE station_schedules (
 route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,
 stop_id TEXT NOT NULL,stop_code TEXT NOT NULL,sequence INTEGER NOT NULL,
 scheduled_time REAL NOT NULL,destination TEXT NOT NULL,pickup_type INTEGER NOT NULL,
 seen_at REAL NOT NULL,
 PRIMARY KEY(route_id,trip_id,service_date,stop_code,sequence)
);
CREATE INDEX station_schedule_dates ON station_schedules(service_date,route_id);
