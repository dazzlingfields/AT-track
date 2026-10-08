CREATE TABLE occupancy_samples (
 route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,start_time TEXT NOT NULL,
 vehicle_id TEXT NOT NULL,sample_bucket INTEGER NOT NULL,sample_time REAL NOT NULL,
 occupancy_status INTEGER,occupancy_percentage REAL,
 PRIMARY KEY(route_id,trip_id,service_date,start_time,vehicle_id,sample_bucket)
);
CREATE INDEX occupancy_dates ON occupancy_samples(service_date,route_id);
