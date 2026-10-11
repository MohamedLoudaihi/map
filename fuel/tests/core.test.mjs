import test from 'node:test';
import assert from 'node:assert/strict';
import {pickQuote,filterStations,googleLinks,parseOverpass,mergeStations,overpassQuery} from '../core.mjs';

const now=Date.parse('2026-10-11T00:00:00Z');
const station={id:'source-1',name:'Station <script>',address:'Naha',prefectureCode:'47',latitude:26.21,longitude:127.68,prices:{regular:[
  {yen:145,reportedAt:'2026-09-01T00:00:00Z',priceType:'cash'},
  {yen:169,reportedAt:'2026-10-10T00:00:00Z',priceType:'cash'},
  {yen:161,reportedAt:'2026-10-10T00:00:00Z',priceType:'member'},
  {yen:150,reportedAt:'2026-10-10T00:00:00Z',priceType:'unknown'},
]}};
test('compare newest quotes, keep cash separate from membership and unknown payment',()=>{
  assert.equal(pickQuote(station,'regular','cash','all',now).yen,169);
  assert.equal(pickQuote(station,'regular','member','14',now).yen,161);
  assert.equal(pickQuote(station,'regular','all','14',now).yen,150);
  assert.equal(pickQuote(station,'diesel','all','14',now),null);
});
test('ignore expired, malformed and future price reports',()=>{
  const s={...station,prices:{regular:[{yen:150,priceType:'cash',reportedAt:'2026-01-01'}, {yen:1,reportedAt:'2026-10-10'}, {yen:151,reportedAt:'2030-01-01'}, {yen:150,reportedAt:'garbage'}]}};
  assert.equal(pickQuote(s,'regular','all','7',now),null);
});
test('fuel-specific relative age overrides a newer source page update',()=>{
  const s={...station,prices:{regular:[{yen:150,reportedAt:'2026-10-10T00:00:00Z',priceType:'unknown',sourceAgeDays:21,collectedAt:'2026-10-10T00:00:00Z'}]}};
  assert.equal(pickQuote(s,'regular','all','14',now),null);
  assert.equal(pickQuote(s,'regular','all','30',now).yen,150);
});
test('unpriced stations remain usable, prefectures and favorites are respected',()=>{
  const other={...station,id:'other',prefectureCode:'13'},unknown={...station,id:'unknown',prices:{}};
  const state={prefecture:'47',fuel:'regular',priceType:'cash',maxAge:'14',sort:'price',favorites:new Set(['unknown']),onlyFavorites:false};
  assert.deepEqual(filterStations([unknown,other,station],state,now).map(r=>r.station.id),['source-1','unknown']);
  assert.deepEqual(filterStations([unknown,station],{...state,onlyFavorites:true},now).map(r=>r.station.id),['unknown']);
});
test('Google route retains destination and optional location, uses encoded query',()=>{
  const links=googleLinks(station,{latitude:26.2,longitude:127.7});
  const route=new URL(links.directions);
  assert.equal(route.searchParams.get('destination'),'26.21,127.68');
  assert.equal(route.searchParams.get('origin'),'26.2,127.7');
  assert.equal(new URL(links.map).searchParams.get('q'),'26.21,127.68');
  assert.ok(links.search.includes('%3Cscript%3E'));
});
test('OSM parsing uses actual coordinates and rejects malformed elements',()=>{
  const rows=parseOverpass({elements:[{type:'node',id:10,lat:26.2,lon:127.7,tags:{name:'Pump','addr:city':'Naha'}},{type:'way',id:11,center:{lat:26.3,lon:127.8},tags:{brand:'ENEOS'}},{type:'node',id:12,tags:{name:'No coordinates'}}]},'47');
  assert.equal(rows.length,2);assert.equal(rows[0].sourceUrl,'https://www.openstreetmap.org/node/10');assert.deepEqual(rows[0].prices,{});
  assert.throws(()=>overpassQuery('47"; bad code'));
});
test('overlapping source coordinates are merged without copying quotes onto nearby pumps',()=>{
  const osm={...station,id:'osm-node-1',prices:{}};
  assert.equal(mergeStations([station],[osm]).length,1);
  assert.equal(mergeStations([station],[{...osm,latitude:26.3}]).length,2);
});
