CREATE TABLE station_positions (
 route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,start_time TEXT NOT NULL,
 vehicle_id TEXT NOT NULL,vehicle_label TEXT NOT NULL,position_time REAL NOT NULL,
 latitude REAL NOT NULL,longitude REAL NOT NULL,distance REAL NOT NULL,progress_sequence INTEGER,
 PRIMARY KEY(route_id,trip_id,service_date,start_time,vehicle_id,position_time)
);
CREATE INDEX station_position_dates ON station_positions(service_date,route_id);
