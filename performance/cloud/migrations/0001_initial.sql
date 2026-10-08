CREATE TABLE routes (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('bus','train')), route_id TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, UNIQUE(mode,code));
CREATE TABLE events (route_id INTEGER NOT NULL, trip_id TEXT NOT NULL, service_date TEXT NOT NULL, start_time TEXT NOT NULL, stop_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, event_time REAL NOT NULL, scheduled_time REAL, delay_sec REAL, reported_at REAL NOT NULL, PRIMARY KEY(route_id,trip_id,service_date,start_time,stop_id,sequence,kind));
CREATE INDEX event_dates ON events(service_date,route_id,kind);
CREATE TABLE cancellations (route_id INTEGER NOT NULL, trip_id TEXT NOT NULL, service_date TEXT NOT NULL, start_time TEXT NOT NULL, reported_at REAL NOT NULL, PRIMARY KEY(route_id,trip_id,service_date,start_time));
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO routes (code,name,mode) VALUES ('376','Route 376','bus'),('S-C','South City','train');
INSERT INTO state VALUES ('initialized','true');
