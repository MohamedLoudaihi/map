# Station location data

`public/data/stations.json` contains a small factual Okinawa bootstrap sample of OpenStreetMap fuel stations, accessed through Mapcarta's OSM feature pages. Every record includes its original OSM object URL and the page used to verify its coordinates. Coordinates have the five-decimal precision published by those pages; names and brands may be out of date. This sample is not a complete list of Okinawa stations.

Location data is © OpenStreetMap contributors, licensed under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Keep the [OpenStreetMap attribution](https://www.openstreetmap.org/copyright) visible when displaying it and retain attribution when redistributing the dataset. No map images, photos, or descriptive Mapcarta prose are included.

Refresh Okinawa using standard-library Python:

```sh
python3 scripts/refresh_stations.py
```

The refresher makes one prefecture query and, only on failure, tries one fallback Overpass server. It rejects incomplete or empty responses, limits responses to 8 MiB and at most 25,000 elements, excludes explicitly private or disused stations, and atomically replaces the file only after validation. It records retrieval time, not a station's last verified operating date. OpenStreetMap coverage can still be incomplete after a successful refresh.

To generate another prefecture snapshot explicitly, use a two-digit Japanese prefecture code (`01`–`47`) and a separate output path:

```sh
python3 scripts/refresh_stations.py --prefecture-code 13 --output public/data/tokyo-stations.json
```

The query used by both scheduled ingestion and browser prefecture lookups is:

```overpass
[out:json][timeout:60][maxsize:8388608];
area["ISO3166-2"="JP-47"]["admin_level"="4"]->.pref;
nwr["amenity"="fuel"](area.pref);
out center tags;
```

Replace `47` with the selected prefecture's two-digit code. Browser lookups should be initiated by user selection, cached, and capped at one query plus one fallback, never an automatic sweep of all 47 prefectures. Way and relation positions use Overpass's centre; node positions use their latitude and longitude.

OpenStreetMap supplies locations rather than current pump prices. The `prices` field stays empty; do not fill it with prefecture averages, extrapolations, or invented values. The app's separately sourced quote feed must retain its original observation timestamp, source URL, fuel grade, and price conditions.
