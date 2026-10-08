CREATE TABLE station_predictions (
 route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,start_time TEXT NOT NULL,
 stop_id TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,
 event_time REAL NOT NULL,delay_sec REAL,uncertainty REAL,reported_at REAL NOT NULL,captured_at REAL NOT NULL,
 passed_at REAL,invalid INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(route_id,trip_id,service_date,start_time,stop_id,sequence,kind)
);
CREATE INDEX prediction_dates ON station_predictions(service_date,route_id);
CREATE INDEX prediction_pending ON station_predictions(service_date,route_id,trip_id) WHERE passed_at IS NULL AND invalid=0;
