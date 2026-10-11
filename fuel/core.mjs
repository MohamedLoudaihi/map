export const PREFECTURES = [
  ['01','Hokkaido','北海道','hokkaido'],['02','Aomori','青森県','aomori'],['03','Iwate','岩手県','iwate'],['04','Miyagi','宮城県','miyagi'],['05','Akita','秋田県','akita'],['06','Yamagata','山形県','yamagata'],['07','Fukushima','福島県','fukushima'],['08','Ibaraki','茨城県','ibaraki'],['09','Tochigi','栃木県','tochigi'],['10','Gunma','群馬県','gunma'],['11','Saitama','埼玉県','saitama'],['12','Chiba','千葉県','chiba'],['13','Tokyo','東京都','tokyo'],['14','Kanagawa','神奈川県','kanagawa'],['15','Niigata','新潟県','niigata'],['16','Toyama','富山県','toyama'],['17','Ishikawa','石川県','ishikawa'],['18','Fukui','福井県','fukui'],['19','Yamanashi','山梨県','yamanashi'],['20','Nagano','長野県','nagano'],['21','Gifu','岐阜県','gifu'],['22','Shizuoka','静岡県','shizuoka'],['23','Aichi','愛知県','aichi'],['24','Mie','三重県','mie'],['25','Shiga','滋賀県','shiga'],['26','Kyoto','京都府','kyoto'],['27','Osaka','大阪府','osaka'],['28','Hyogo','兵庫県','hyogo'],['29','Nara','奈良県','nara'],['30','Wakayama','和歌山県','wakayama'],['31','Tottori','鳥取県','tottori'],['32','Shimane','島根県','shimane'],['33','Okayama','岡山県','okayama'],['34','Hiroshima','広島県','hiroshima'],['35','Yamaguchi','山口県','yamaguchi'],['36','Tokushima','徳島県','tokushima'],['37','Kagawa','香川県','kagawa'],['38','Ehime','愛媛県','ehime'],['39','Kochi','高知県','kochi'],['40','Fukuoka','福岡県','fukuoka'],['41','Saga','佐賀県','saga'],['42','Nagasaki','長崎県','nagasaki'],['43','Kumamoto','熊本県','kumamoto'],['44','Oita','大分県','oita'],['45','Miyazaki','宮崎県','miyazaki'],['46','Kagoshima','鹿児島県','kagoshima'],['47','Okinawa','沖縄県','okinawa'],
].map(([code,name,japanese,slug])=>({code,name,japanese,slug}));

export const FUEL_NAMES = {regular:'Regular',premium:'Premium',diesel:'Diesel'};
export function safeUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
export function validCoordinates(station) {
  return typeof station.latitude === 'number' && typeof station.longitude === 'number' && Number.isFinite(station.latitude) && Number.isFinite(station.longitude) && station.latitude >= -90 && station.latitude <= 90 && station.longitude >= -180 && station.longitude <= 180;
}
export function validStation(s) {
  return s && typeof s.id === 'string' && typeof s.name === 'string' && s.name.trim().length > 0 && PREFECTURES.some(p=>p.code===s.prefectureCode) && validCoordinates(s) && s.latitude >= 20 && s.latitude <= 47 && s.longitude >= 122 && s.longitude <= 155;
}
export function ageDays(date, now=Date.now()) {
  const time=Date.parse(date); return Number.isFinite(time) ? Math.max(0,(now-time)/86400000) : Infinity;
}
export function pickQuote(station, fuel, type='all', maxAge='14', now=Date.now()) {
  const raw=station.prices?.[fuel];
  const quotes=Array.isArray(raw)?raw:raw?[raw]:[];
  const valid=quotes.filter(q=>q && typeof q.yen==='number' && Number.isFinite(q.yen) && q.yen>=20 && q.yen<=400 && typeof q.reportedAt==='string' && Number.isFinite(Date.parse(q.reportedAt)) && Date.parse(q.reportedAt)<=now+86400000 && (type==='all'||q.priceType===type) && (maxAge==='all'||ageDays(q.reportedAt,now)<=Number(maxAge)));
  // Keep the newest quote of each payment type before comparing those types.
  const newest=new Map();
  for(const quote of valid) { const key=quote.priceType||'unknown'; if(!newest.has(key)||Date.parse(quote.reportedAt)>Date.parse(newest.get(key).reportedAt)) newest.set(key,quote); }
  return [...newest.values()].sort((a,b)=>a.yen-b.yen||Date.parse(b.reportedAt)-Date.parse(a.reportedAt))[0]||null;
}
export function distanceKm(a,b) {
  if(!a||!b||!validCoordinates(a)||!validCoordinates(b)) return null;
  const r=x=>x*Math.PI/180, dlat=r(b.latitude-a.latitude),dlon=r(b.longitude-a.longitude);
  const h=Math.sin(dlat/2)**2+Math.cos(r(a.latitude))*Math.cos(r(b.latitude))*Math.sin(dlon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
export function googleLinks(station, origin=null) {
  // Searching by station name and address helps Google resolve the correct entrance.
  const query=`${station.name} ${station.address||''} Japan`;
  const destination=validCoordinates(station)?`${station.latitude},${station.longitude}`:query;
  const params=new URLSearchParams({api:'1',destination,travelmode:'driving'});
  if(origin&&validCoordinates(origin)) params.set('origin',`${origin.latitude},${origin.longitude}`);
  return {map:`https://www.google.com/maps?q=${encodeURIComponent(destination)}&output=embed&hl=en&z=15`,directions:`https://www.google.com/maps/dir/?${params}`,search:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`};
}
export function filterStations(stations,state,now=Date.now()) {
  const query=(state.search||'').trim().toLocaleLowerCase();
  return stations.filter(s=>s.prefectureCode===state.prefecture && (!query||`${s.name} ${s.nameJa||''} ${s.address} ${s.brand||''}`.toLocaleLowerCase().includes(query)) && (!state.onlyFavorites||state.favorites.has(s.id)))
    .map(station=>({station,quote:pickQuote(station,state.fuel,state.priceType,state.maxAge,now),distance:distanceKm(state.location,station)}))
    .sort((a,b)=>{
      if(state.sort==='name') return a.station.name.localeCompare(b.station.name,'ja');
      if(state.sort==='distance'&&state.location) return (a.distance??Infinity)-(b.distance??Infinity)||a.station.name.localeCompare(b.station.name,'ja');
      return (a.quote?.yen??Infinity)-(b.quote?.yen??Infinity)||((b.quote?Date.parse(b.quote.reportedAt):0)-(a.quote?Date.parse(a.quote.reportedAt):0))||a.station.name.localeCompare(b.station.name,'ja');
    });
}
export function mergeStations(priced,osm) {
  const result=priced.filter(validStation).map(s=>({...s,prices:s.prices||{}}));
  // Cross-source IDs differ. Suppress near-identical OSM entries rather than duplicate a pump.
  for(const station of osm.filter(validStation)) if(!result.some(s=>s.id===station.id||distanceKm(s,station)<0.12)) result.push({...station,prices:station.prices||{}});
  return result;
}
export function overpassQuery(code) {
  if(!PREFECTURES.some(p=>p.code===code)) throw new Error('Unknown prefecture');
  return `[out:json][timeout:45];area["ISO3166-2"="JP-${code}"]["boundary"="administrative"]->.pref;nwr["amenity"="fuel"](area.pref);out center tags;`;
}
export function parseOverpass(payload,code) {
  if(!Array.isArray(payload?.elements)) throw new Error('Unexpected station response');
  return payload.elements.filter(e=>e&&['node','way','relation'].includes(e.type)&&Number.isInteger(e.id)&&e.id>0&&!['private','no','military'].includes(e.tags?.access)&&!['disused','abandoned','demolished'].some(key=>e.tags?.[key]==='yes')).map(e=>{
    const t=e.tags||{}, coord=e.center||e;
    const address=t['addr:full']||[t['addr:province'],t['addr:city'],t['addr:suburb'],t['addr:quarter'],t['addr:street'],t['addr:housenumber']].filter(Boolean).join(' ');
    return {id:`osm-${e.type}-${e.id}`,name:t.name||t['name:en']||t.brand||t.operator||'Gas station',brand:t.brand||'',address:address||`${PREFECTURES.find(p=>p.code===code).japanese} · address not listed`,prefectureCode:code,latitude:coord.lat,longitude:coord.lon,sourceUrl:`https://www.openstreetmap.org/${e.type}/${e.id}`,prices:{}};
  }).filter(validStation);
}
