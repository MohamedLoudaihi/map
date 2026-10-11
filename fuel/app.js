import {PREFECTURES,FUEL_NAMES,safeUrl,ageDays,pickQuote,googleLinks,filterStations,mergeStations,overpassQuery,parseOverpass} from './core.mjs';

const $=id=>document.getElementById(id);
const storage={get(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}},set(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}};
const saved=storage.get('fuel-finder-preferences',{});
const state={prefecture:PREFECTURES.some(p=>p.code===saved.prefecture)?saved.prefecture:'47',fuel:FUEL_NAMES[saved.fuel]?saved.fuel:'regular',priceType:['all','cash','member','unknown'].includes(saved.priceType)?saved.priceType:'all',maxAge:['7','14','30','all'].includes(saved.maxAge)?saved.maxAge:'14',sort:'price',search:'',location:null,favorites:new Set(storage.get('fuel-finder-favorites',[])),onlyFavorites:false,selectedId:null,stations:[],prices:[],osm:[],dataTime:null,priceError:null,stationError:null,loading:false};
let lastRows=[], requestSerial=0, mapKey='', toastTimer;
const formatTime=date=>Number.isFinite(Date.parse(date))?new Intl.DateTimeFormat('en',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'Asia/Tokyo'}).format(new Date(date))+' JST':'Not available';
const priceLabel=quote=>quote?`¥${quote.yen.toLocaleString('en')}`:'—';
const paymentLabel=quote=>({cash:'Cash',member:'Member price',unknown:'Payment not specified'}[quote?.priceType]||'Payment not specified');
function toast(message){$('toast').textContent=message;$('toast').hidden=false;$('toast').classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').classList.remove('is-visible');$('toast').hidden=true;},5500);}
function textNode(tag,text,className){const e=document.createElement(tag);e.textContent=text;if(className)e.className=className;return e;}
function savePreferences(){storage.set('fuel-finder-preferences',{prefecture:state.prefecture,fuel:state.fuel,priceType:state.priceType,maxAge:state.maxAge});}
function showBanner(message){$('error-banner').textContent=message||'';$('error-banner').hidden=!message;}

$('prefecture').replaceChildren(...PREFECTURES.map(p=>{const option=document.createElement('option');option.value=p.code;option.textContent=`${p.name} · ${p.japanese}`;return option;}));
for(const [id,key] of [['prefecture','prefecture'],['fuel','fuel'],['price-type','priceType'],['max-age','maxAge'],['sort','sort']]){
  $(id).value=state[key];
  $(id).addEventListener('change',()=>{if(key==='sort'&&$(id).value==='distance'&&!state.location){$(id).value=state.sort;toast('Choose Near me and allow location access to sort by distance.');return;}state[key]=$(id).value;savePreferences();if(key==='prefecture'){state.selectedId=null;loadRegion();}else render();});
}
$('search').addEventListener('input',()=>{state.search=$('search').value;render();});
$('favorites-button').addEventListener('click',()=>{state.onlyFavorites=!state.onlyFavorites;$('favorites-button').setAttribute('aria-pressed',String(state.onlyFavorites));render();});
$('refresh-button').addEventListener('click',()=>loadData(true));
$('guide-button').addEventListener('click',()=>$('guide-dialog').showModal());
$('close-guide').addEventListener('click',()=>$('guide-dialog').close());
$('guide-dialog').addEventListener('click',e=>{if(e.target===$('guide-dialog'))$('guide-dialog').close();});
for(const view of ['list','map']) $('view-'+view).addEventListener('click',()=>{document.body.dataset.mobileView=view;for(const v of ['list','map'])$('view-'+v).setAttribute('aria-pressed',String(v===view));});
$('locate-button').addEventListener('click',()=>{
  if(!navigator.geolocation){toast('Your browser does not support location. You can still search by station or city.');return;}
  $('locate-button').disabled=true;
  navigator.geolocation.getCurrentPosition(position=>{
    state.location={latitude:position.coords.latitude,longitude:position.coords.longitude};state.sort='distance';$('sort').value='distance';$('locate-button').disabled=false;$('locate-button').setAttribute('aria-pressed','true');render();toast('Sorted by straight-line distance. Google Maps calculates your driving route.');
  },error=>{$('locate-button').disabled=false;toast(error.code===1?'Location access was declined. Allow location in your browser to sort nearby stations.':'Your location could not be found. Try again or search by city.');},{enableHighAccuracy:false,timeout:12000,maximumAge:300000});
});

async function fetchJson(url,timeout=20000){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);try{const response=await fetch(url,{cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error(`HTTP ${response.status}`);return await response.json();}finally{clearTimeout(timer);}}
async function loadData(refresh=false){
  state.loading=true;$('refresh-button').disabled=true;$('data-status').textContent='Checking published reports…';
  const outcomes=await Promise.allSettled([fetchJson('./public/data/prices.json'),fetchJson('./public/data/stations.json')]);
  const [prices,stations]=outcomes;
  if(prices.status==='fulfilled'&&Array.isArray(prices.value.stations)){
    state.prices=prices.value.stations;state.dataTime=prices.value.generatedAt;state.priceError=null;storage.set('fuel-finder-prices-cache',prices.value);
  }else{
    const cache=storage.get('fuel-finder-prices-cache',null);if(cache&&Array.isArray(cache.stations)){state.prices=cache.stations;state.dataTime=cache.generatedAt;}
    state.priceError='Price reports could not be refreshed. Any saved prices retain their original dates.';
  }
  if(stations.status==='fulfilled'&&Array.isArray(stations.value.stations))state.osm=stations.value.stations;
  state.loading=false;$('refresh-button').disabled=false;await loadRegion(refresh);
  if(refresh)toast('Checked the latest published data. Source reports refresh through the daily GitHub workflow.');
}
async function loadRegion(force=false){
  const serial=++requestSerial,code=state.prefecture;
  state.stationError=null;
  const bundled=state.osm.filter(s=>s.prefectureCode===code);
  const cached=storage.get('fuel-finder-region-'+code,null);
  const freshCache=Array.isArray(cached?.stations)&&Date.now()-Date.parse(cached.generatedAt)<86400000*2;
  const local=Array.isArray(cached?.stations)?cached.stations:bundled;
  state.stations=mergeStations(state.prices.filter(s=>s.prefectureCode===code),local||[]);render();
  // The published Okinawa snapshot loads instantly. Other prefectures use OSM live.
  if(!force&&(freshCache||bundled.length||state.prices.some(s=>s.prefectureCode===code)))return;
  $('data-status').textContent='Finding stations in '+PREFECTURES.find(p=>p.code===code).name+'…';
  try{
    const response=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:new URLSearchParams({data:overpassQuery(code)}),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const payload=await response.json();if(payload.remark)throw new Error('Incomplete map response');
    const found=parseOverpass(payload,code);
    if(serial!==requestSerial)return;
    storage.set('fuel-finder-region-'+code,{generatedAt:new Date().toISOString(),stations:found});
    state.stations=mergeStations(state.prices.filter(s=>s.prefectureCode===code),found);
  }catch(error){if(serial!==requestSerial)return;state.stationError='The station map service is unavailable. Saved stations are still shown; try Refresh or search directly in Google Maps.';}
  if(serial===requestSerial)render();
}

function render(){
  lastRows=filterStations(state.stations,state);
  const quoted=lastRows.filter(r=>r.quote);
  const minimum=quoted.reduce((best,r)=>!best||r.quote.yen<best.yen?r.quote:best,null);
  $('stat-cheapest').textContent=priceLabel(minimum);
  $('stat-count').textContent=String(quoted.length);
  $('stat-updated').textContent=state.dataTime?new Intl.DateTimeFormat('en',{month:'short',day:'numeric',timeZone:'Asia/Tokyo'}).format(new Date(state.dataTime)):'—';
  $('stat-cheapest').title=minimum?`${FUEL_NAMES[state.fuel]}, ${paymentLabel(minimum)}, source updated ${formatTime(minimum.reportedAt)}`:'No matching price reports';
  $('stat-updated').title=state.dataTime?`Published snapshot: ${formatTime(state.dataTime)}. Each price has its own update time.`:'No snapshot available';
  $('results-count').textContent=`${lastRows.length} stations · ${quoted.length} matching prices`;
  if($('favorites-count')){$('favorites-count').textContent=String(state.favorites.size);$('favorites-count').hidden=state.favorites.size===0;}
  if($('results-subtitle'))$('results-subtitle').textContent=quoted.length?'Prices with a source and date. Select a station to see its Google map.':state.prefecture==='47'?'No prices match these filters. Station maps and directions are still available.':'Station maps for this prefecture are available. The initial price feed covers Okinawa.';
  const outdated=state.dataTime&&ageDays(state.dataTime)>2;
  $('data-status').textContent=state.priceError?'Saved reports · refresh unavailable':outdated?'Older published snapshot · check report dates':state.prices.length?'Community reports · refreshed daily':'Station maps available · no price reports';
  $('guide-feed-status').textContent=state.prices.length?`GasMap: ${state.prices.length} Okinawa stations in the published snapshot. Collected ${formatTime(state.dataTime)}. Report dates and availability differ by station and fuel. Other prefectures currently have station maps and source links.`:'No price feed loaded. Maps and directions still work.';
  showBanner([state.priceError,state.stationError,outdated?'This published snapshot is more than 2 days old. Check each source before travelling.':null].filter(Boolean).join(' '));
  $('empty-state').hidden=lastRows.length>0;
  if(!lastRows.length){$('empty-state').replaceChildren(textNode('h3',state.onlyFavorites?'No saved stations here.':'No stations match this search.'),textNode('p',state.onlyFavorites?'Save a station with the heart button, or turn off Saved stations.':state.search?'Try a city, station name, or a broader search.':'Try Refresh to load station data, or open Google Maps below.'));const link=textNode('a','Search stations in Google Maps','button');link.href=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('gas stations '+PREFECTURES.find(p=>p.code===state.prefecture).japanese)}`;link.target='_blank';link.rel='noopener noreferrer';$('empty-state').append(link);}
  const list=document.createDocumentFragment();
  for(const row of lastRows.slice(0,300))list.append(stationCard(row,minimum));
  if(lastRows.length>300)list.append(textNode('p','Showing the first 300 stations. Search by city or name to narrow the list.','list-note'));
  $('results-list').replaceChildren(list);
  if(!lastRows.some(r=>r.station.id===state.selectedId))state.selectedId=lastRows[0]?.station.id||null;
  for(const card of $('results-list').children)card.classList.toggle('is-selected',card.dataset.stationId===state.selectedId);
  renderMap(lastRows.find(r=>r.station.id===state.selectedId));
}
function stationCard({station,quote,distance},minimum){
  const card=textNode('article','','station-card');card.dataset.stationId=station.id;
  const top=textNode('div','','station-topline');
  const brand=textNode('span',station.brand||(/ENEOS/i.test(station.name)?'ENEOS':/apollostation/i.test(station.name)?'apollostation':'Gas station'),'station-badge');top.append(brand);
  if(quote&&minimum&&quote.yen===minimum.yen){const badge=textNode('span','Lowest reported','station-badge best-price-badge');top.append(badge);}
  const favorite=textNode('button',state.favorites.has(station.id)?'♥':'♡','favorite-button');favorite.type='button';favorite.setAttribute('aria-label',(state.favorites.has(station.id)?'Unsave ':'Save ')+station.name);favorite.setAttribute('aria-pressed',String(state.favorites.has(station.id)));favorite.addEventListener('click',()=>{if(state.favorites.has(station.id))state.favorites.delete(station.id);else state.favorites.add(station.id);storage.set('fuel-finder-favorites',[...state.favorites]);render();});top.append(favorite);card.append(top);
  const name=textNode('button',station.name,'station-name');name.type='button';name.setAttribute('aria-label','Show '+station.name+' on map');name.addEventListener('click',()=>{state.selectedId=station.id;render();});card.append(name,textNode('p',station.address||'Address not listed','station-address'));
  const mid=textNode('div','','station-meta');
  const price=textNode('div','','station-price');price.append(textNode('strong',priceLabel(quote)),textNode('span',quote?' / L':' Price unavailable'));if(quote&&ageDays(quote.reportedAt)>7)price.classList.add('is-old');mid.append(price);
  if(distance!==null)mid.append(textNode('span',`${distance<1?distance.toFixed(1):distance.toFixed(0)} km · straight-line`,'station-distance'));card.append(mid);
  const footer=textNode('div','','station-footer');
  const info=textNode('div','','station-report');
  if(quote){info.append(textNode('span',paymentLabel(quote)),textNode('span',`${quote.timestampKind==='source-update'?'Source updated':'Reported'} ${formatTime(quote.reportedAt)}${ageDays(quote.reportedAt)>7?' · older report':''}`));}else{const raw=pickQuote(station,state.fuel,'all','all');info.append(textNode('span',raw?'No price matches these filters':'No published '+FUEL_NAMES[state.fuel].toLowerCase()+' price'),textNode('span',raw?'Try a longer age limit or all payment types.':'Check the price source before travelling.'));}footer.append(info);
  const actions=textNode('div','','station-actions');const route=textNode('a','Directions ↗','directions-link');route.href=googleLinks(station,state.location).directions;route.target='_blank';route.rel='noopener noreferrer';actions.append(route);footer.append(actions);card.append(footer);return card;
}
function renderMap(row){
  $('map-state').hidden=Boolean(row);
  if(!row){$('map-title').textContent='Choose a station';$('map-address').textContent='Its Google map and directions will appear here.';$('map-price').textContent='';$('map-report').textContent='';$('map-directions').hidden=true;$('map-source').hidden=true;if(mapKey){$('map-frame').src='about:blank';mapKey='';}return;}
  const {station,quote}=row,links=googleLinks(station,state.location);
  if(mapKey!==station.id){$('map-frame').src=links.map;mapKey=station.id;}
  $('map-title').textContent=station.name;$('map-address').textContent=station.address;
  $('map-price').textContent=quote?`${priceLabel(quote)}/L · ${FUEL_NAMES[state.fuel]}`:'Price unavailable';
  $('map-report').textContent=quote?`${paymentLabel(quote)} · ${quote.timestampKind==='source-update'?'Source updated':'Reported'} ${formatTime(quote.reportedAt)}`:'Price unknown. Check the source or station before travelling.';
  $('map-directions').hidden=false;$('map-directions').href=links.directions;
  $('map-directions').removeAttribute('aria-disabled');
  $('map-source').hidden=false;$('map-source').href=safeUrl(quote?.sourceUrl)||safeUrl(station.sourceUrl)||links.search;$('map-source').textContent=station.id.startsWith('gasmap')?'View price source ↗':'View station source ↗';
}
render();loadData();
