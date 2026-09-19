// ============================================================
// FLEETLINK GPS SERVER — YTWL Integration
// ZOESON Solutions · Lusaka, Zambia
// 
// This server connects to the YTWL GPS platform, fetches
// live vehicle tracking data, and serves it to your
// FleetLink dashboard app.
//
// Deploy to Render.com (free) or any Node.js host.
// ============================================================

const http = require('http');
const https = require('https');

// ---------- CONFIGURATION ----------
const PORT = process.env.PORT || 4000;
const YTWL_BASE = process.env.YTWL_API_BASE_URL || 'https://api.ytwl-gps.com';
const YTWL_ACCOUNT = process.env.YTWL_ACCOUNT || '';
const YTWL_PASSWORD = process.env.YTWL_PASSWORD || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';  // Set to your domain in production

// ---------- VEHICLE IMEI MAPPING ----------
const FLEET = {
  '357445101454821': 'AHC 3000 ZM',
  '357445101240196': 'AIG 2585 ZM',
  '357445101236426': 'AIG 2928 ZM',
  '357445101240360': 'AIG 2932 ZM',
  '357445101182802': 'BCH 7393 ZM',
  '357445101182992': 'BCH 7394 ZM',
  '357445101235980': 'BCH 9449 ZM',
  '357445101236525': 'BCH 9450 ZM',
  '357445101259303': 'BCH 9451 ZM',
  '357445101424790': 'BCJ 1726 ZM',
  '357445101432009': 'BCJ 2971 ZM',
  '357445101601546': 'BLE 2153 ZM',
  '357445101236608': 'CAC 9942 ZM'
};

// ---------- STATE ----------
let accessToken = null;
let tokenExpiresAt = 0;
let gpsCache = {};       // {imei: {lat, lng, speed, acc, status, gpsTime, power, ...}}
let lastSyncTime = null;
let syncErrors = 0;

// ---------- HELPERS ----------
function makeRequest(method, url, data) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON: ' + body.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// ---------- YTWL AUTHENTICATION ----------
async function authenticate(retries) {
  if (retries === undefined) retries = 3;
  const now = Math.floor(Date.now() / 1000);
  
  // Return cached token if valid for at least 5 more minutes
  if (accessToken && tokenExpiresAt - now > 300) return accessToken;

  if (!YTWL_ACCOUNT || !YTWL_PASSWORD) {
    throw new Error('YTWL credentials not configured. Set YTWL_ACCOUNT and YTWL_PASSWORD.');
  }

  try {
    const res = await makeRequest('POST', YTWL_BASE + '/api/authorization', {
      account: YTWL_ACCOUNT,
      password: YTWL_PASSWORD,
      time: now
    });

    if (res.code === 0 && res.record && res.record.accessToken) {
      accessToken = res.record.accessToken;
      tokenExpiresAt = now + (res.record.expiresIn || 7200);
      console.log('[AUTH] Token acquired, expires in ' + res.record.expiresIn + 's');
      return accessToken;
    } else {
      throw new Error('Auth failed: code=' + res.code + ' ' + (res.message || ''));
    }
  } catch (err) {
    if (retries > 0) {
      console.warn('[AUTH] Failed, retrying... (' + retries + ' left)');
      await new Promise(r => setTimeout(r, 2000));
      return authenticate(retries - 1);
    }
    throw err;
  }
}

// ---------- FETCH GPS DATA ----------
async function fetchTracking() {
  const token = await authenticate();
  const imeis = Object.keys(FLEET).join(',');
  const url = YTWL_BASE + '/api/tracking/getTracking?accessToken=' + encodeURIComponent(token) + '&imeis=' + encodeURIComponent(imeis);
  
  const res = await makeRequest('GET', url, null);
  
  if (res.code === 0 && Array.isArray(res.data)) {
    return res.data;
  }
  return [];
}

// ---------- SYNC LOOP ----------
async function syncGps() {
  try {
    const data = await fetchTracking();
    
    data.forEach(t => {
      gpsCache[t.imei] = {
        imei: t.imei,
        reg: FLEET[t.imei] || 'UNKNOWN',
        lat: t.lat,
        lng: t.lng,
        speed: t.speed || 0,
        course: t.course || 0,
        acc: t.acc || 0,
        status: t.status || 'Offline',
        power: t.power || 0,
        gpsTime: t.gpsTime || null,
        todayKm: t.todayDistance || t.todaysDistance || 0,
        drivingMins: t.drivingTime || 0,
        parkingMins: t.parkingTime || 0,
        overspeed: t.overspeedCount || 0,
        updatedAt: new Date().toISOString()
      };
    });

    lastSyncTime = new Date().toISOString();
    syncErrors = 0;
    console.log('[SYNC] ' + data.length + '/' + Object.keys(FLEET).length + ' vehicles updated at ' + lastSyncTime);
  } catch (err) {
    syncErrors++;
    console.error('[SYNC ERROR] ' + err.message + ' (errors: ' + syncErrors + ')');
    // Don't clear cache — serve stale data (offline-first)
  }
}

// ---------- GPS HEALTH ----------
function gpsHealth(gpsTime) {
  if (!gpsTime) return { health: 'RED', minutesOffline: 999999 };
  const diff = Math.floor((Date.now() - new Date(gpsTime).getTime()) / 60000);
  if (diff < 15) return { health: 'GREEN', minutesOffline: diff };
  if (diff <= 120) return { health: 'AMBER', minutesOffline: diff };
  return { health: 'RED', minutesOffline: diff };
}

// ---------- HTTP SERVER ----------
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ---------- MAIN ENDPOINT ----------
  if (url === '/api/v1/fleet/gps' || url === '/api/v1/fleet/gps-dashboard') {
    const vehicles = Object.keys(FLEET).map(imei => {
      const g = gpsCache[imei] || {};
      const h = gpsHealth(g.gpsTime);
      return {
        reg: FLEET[imei],
        imei: imei,
        lat: g.lat || null,
        lng: g.lng || null,
        speed: g.speed || 0,
        acc: g.acc || 0,
        status: g.status || 'Offline',
        power: g.power || 0,
        gpsTime: g.gpsTime || null,
        todayKm: g.todayKm || 0,
        drivingMins: g.drivingMins || 0,
        parkingMins: g.parkingMins || 0,
        overspeed: g.overspeed || 0,
        gpsHealth: h.health,
        minutesOffline: h.minutesOffline,
        updatedAt: g.updatedAt || null
      };
    });

    const online = vehicles.filter(v => v.gpsHealth === 'GREEN').length;
    const stale = vehicles.filter(v => v.gpsHealth === 'AMBER').length;
    const offline = vehicles.filter(v => v.gpsHealth === 'RED').length;

    res.writeHead(200);
    res.end(JSON.stringify({
      summary: {
        total: vehicles.length,
        online: online,
        stale: stale,
        offline: offline,
        lastSync: lastSyncTime,
        syncErrors: syncErrors
      },
      vehicles: vehicles
    }));
    return;
  }

  // ---------- HEALTH CHECK ----------
  if (url === '/health' || url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      service: 'FleetLink GPS Server',
      vehicles: Object.keys(FLEET).length,
      lastSync: lastSyncTime,
      syncErrors: syncErrors,
      tokenValid: accessToken && tokenExpiresAt > Math.floor(Date.now() / 1000)
    }));
    return;
  }

  // ---------- 404 ----------
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found. Use /api/v1/fleet/gps' }));
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log('');
  console.log('==============================================');
  console.log('  FLEETLINK GPS SERVER');
  console.log('  ZOESON Solutions · Lusaka, Zambia');
  console.log('  Port: ' + PORT);
  console.log('  Vehicles: ' + Object.keys(FLEET).length);
  console.log('  API: ' + YTWL_BASE);
  console.log('==============================================');
  console.log('');
  
  // First sync immediately
  syncGps();
  
  // Then every 60 seconds
  setInterval(syncGps, 60000);
});
