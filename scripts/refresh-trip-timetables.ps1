$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskDir=Join-Path $taskRoot '.test-artifacts/gtfs'
New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
Invoke-WebRequest 'https://gtfs.at.govt.nz/gtfs.zip' -OutFile (Join-Path $taskDir 'gtfs.zip') -UseBasicParsing
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip=[IO.Compression.ZipFile]::OpenRead((Join-Path $taskDir 'gtfs.zip'))
try{foreach($taskName in @('feed_info.txt','routes.txt','trips.txt','calendar.txt','calendar_dates.txt','stops.txt','stop_times.txt')){
 [IO.Compression.ZipFileExtensions]::ExtractToFile($taskZip.GetEntry($taskName),(Join-Path $taskDir $taskName),$true)
}}finally{$taskZip.Dispose()}
node (Join-Path $PSScriptRoot 'build-trip-timetables.cjs') $taskDir (Join-Path $taskRoot 'performance/public/timetables')
if($LASTEXITCODE -ne 0){throw 'Timetable compilation failed'}
