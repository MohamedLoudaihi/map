# Okinawa Fuel Finder

A mobile-friendly fuel finder built for GitHub Pages. Compare the lowest available reported prices in Okinawa, choose any Japanese prefecture to find stations, and open a station in an embedded Google Map or get driving directions.

The app uses real public source data. Prices are online reports and source updates, so their dates and payment conditions matter. Each price shows its original source timestamp and a source link. The current price feed covers **Okinawa**; other prefectures have station maps and directions but no connected price feed yet. Unknown prices stay unavailable.

## Put it on GitHub Pages

1. Sign in to GitHub as `MohamedLoudaihi` and create a **public** repository named **okinawa-fuel-finder**. Use `main` as the default branch.
2. Unzip the supplied project and upload its contents into the repository root. Include the hidden **.github/workflows/deploy-pages.yml** file. The root should contain `index.html`, `app.js`, `package.json`, `public/`, and `.github/`; avoid adding an extra enclosing folder.
3. Open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Open **Actions → Deploy Pages → Run workflow** and run it on `main`. This fetches current source reports, checks the project, and publishes the site. If GitHub asks to enable workflows, enable them first.
5. When the deployment succeeds, open **https://mohamedloudaihi.github.io/okinawa-fuel-finder/**. The actual address is also shown under **Settings → Pages** and in the successful workflow deployment.

The project is ready to publish; a repository and deployment must be created before that URL works. GitHub Pages hosting for a public repository does not require a paid plan. No API keys, database, server, or npm dependencies are needed.

If you prefer the command line, create the empty repository first, then run these commands from the unzipped project folder:

```sh
git init -b main
git add .
git commit -m "Add Okinawa Fuel Finder"
git remote add origin https://github.com/MohamedLoudaihi/okinawa-fuel-finder.git
git push -u origin main
```

Then complete steps 3–5 above. GitHub authentication uses your existing Git credentials.

## Using the app

- Okinawa opens by default. Select a prefecture, fuel grade, payment type, or maximum report age.
- Sort by lowest reported price, name, or distance. **Use my location** asks your browser for location access; nearby distances are straight-line estimates. Google Maps calculates the driving route.
- Select a station to see its Google Map. **Directions** opens the Google Maps app or website. **View price source** lets you check the original quote before travelling.
- Save favorite stations with the heart button. Favorites, preferences, and fallback snapshots are stored in your browser.
- **Refresh** checks the latest published price snapshot and refreshes mapped stations. Source price collection runs in GitHub Actions; clicking Refresh does not scrape price websites in your browser.

## Price updates and coverage

The bundled price snapshot comes from [GasMap](https://gasmap.jp/), an Okinawa fuel-price service. The refresh script collects factual station details and publicly displayed price quotes. It preserves source timestamps instead of treating download time as the time a pump price was observed. Payment type is shown as unknown when the source does not establish cash or member conditions. Regular, premium, and diesel quotes appear only when available from the source.

The **Deploy Pages** workflow refreshes price reports once daily, scheduled for **06:15 JST**. GitHub may delay scheduled runs. You can run it manually anytime. A push to `main` publishes the committed snapshot; manual and scheduled runs fetch source reports before publishing. Refreshed files are included in the deployed artifact; the workflow does not create repository commits.

GitHub can disable scheduled workflows in public repositories after 60 days without repository activity. If updates stop, open **Actions → Deploy Pages** and re-enable the workflow, then run it manually.

If a source request or validation fails, the script preserves the last committed snapshot and the workflow displays a warning. Report timestamps and stale-data notices remain visible. Because each run starts with repository data, a failed future run falls back to that committed snapshot, not the previous deployment's newer artifact. You can refresh locally and commit the resulting JSON files to update that fallback.

Prices can change between reports. The lowest reported price depends on your selected fuel, payment type, report age, and station search; coverage is incomplete. Check the source and station conditions before driving. This app does not provide instantaneous pump telemetry or guarantee the price available when you arrive.

Stations use [OpenStreetMap](https://www.openstreetmap.org/copyright) data under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Okinawa has a bundled snapshot; selecting other prefectures loads mapped stations from the public Overpass service and caches them locally. Map coverage and service availability vary. Map records do not supply fuel prices. The daily workflow does not repeatedly download all of Japan; its manual **refresh_stations** option updates only the Okinawa snapshot.

Embedded Google Maps and Google Maps directions work without an application API key. Internet access and access to the relevant third-party services are required. Those services process requests under their own terms and privacy policies; your current location is included in Google Maps directions when you choose to use it.

## Run and maintain locally

Use Node.js 20 or newer and Python 3.10 or newer. There is no dependency-install step.

```sh
npm run dev
```

Open **http://localhost:8000**. Serve the project over HTTP; opening `index.html` directly from disk prevents module and data loading in many browsers.

```sh
npm test
npm run refresh:prices
npm run refresh:stations
npm run build
```

`npm run build` writes only browser assets and data snapshots to `dist/`, including `.nojekyll`. All asset and snapshot URLs are relative, so the site also works at a GitHub repository subpath. To preview the build, run `python3 -m http.server 8000 --directory dist`.

To update the bundled station snapshot for a different prefecture, run `python3 scripts/refresh_stations.py --prefecture-code 13` for Tokyo, for example. The default is `47` for Okinawa. Ordinary prefecture selection in the app does not require rebuilding.

The core filtering and route tests run with Node's built-in test runner. Feed-parser and snapshot tests use Python's standard-library unittest. Neither test suite needs a live source request.

## Project files

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Interface and browser behavior |
| `core.mjs` | Filtering, price selection, routes, and station normalization |
| `public/data/prices.json` | Published price reports with source dates |
| `public/data/stations.json` | Bundled OpenStreetMap station snapshot |
| `scripts/refresh_prices.py` | Validate and refresh public price reports |
| `scripts/refresh_stations.py` | Refresh a single prefecture's mapped stations |
| `scripts/build.mjs` | Copy the static site to `dist/` |
| `.github/workflows/deploy-pages.yml` | Test, refresh, and publish to GitHub Pages |

Software is MIT licensed. Third-party data and services retain their respective licenses and terms; GasMap price quotes are attributed through source links and are not relicensed as MIT data.
