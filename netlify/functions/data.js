// netlify/functions/data.js
// Parses Campbell Scientific CR1000 .dat file and returns aggregated JSON.
// Uses running-totals approach for speed — no intermediate arrays.

var fs   = require('fs');
var path = require('path');

var HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
  'Access-Control-Allow-Origin': '*'
};

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

function findFile(name) {
  var candidates = [
    path.join(process.cwd(), 'data', name),
    path.join(__dirname, '..', '..', 'data', name),
    path.join(__dirname, '..', '..', '..', 'data', name)
  ];
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) { /* skip */ }
  }
  return null;
}

function parseDat(filePath) {
  var raw = fs.readFileSync(filePath, 'latin1');
  var pos = 0, nl;

  // ── Line 0: station metadata ──
  nl = raw.indexOf('\n', pos);
  var line0 = raw.substring(pos, nl);
  if (line0.charCodeAt(line0.length - 1) === 13) line0 = line0.substring(0, line0.length - 1);
  pos = nl + 1;

  var meta = line0.split(',');
  var serial   = (meta[3] || '').replace(/"/g, '').trim();
  var firmware  = (meta[4] || '').replace(/"/g, '').trim();

  // ── Line 1: column headers ──
  nl = raw.indexOf('\n', pos);
  var line1 = raw.substring(pos, nl);
  if (line1.charCodeAt(line1.length - 1) === 13) line1 = line1.substring(0, line1.length - 1);
  pos = nl + 1;

  var hdrs = line1.split(',');
  var hdrMap = {};
  for (var h = 0; h < hdrs.length; h++) {
    hdrMap[hdrs[h].replace(/"/g, '').trim()] = h;
  }

  var colTS   = hdrMap['TIMESTAMP'] !== undefined ? hdrMap['TIMESTAMP'] : 0;
  var colT    = hdrMap['AirTC'];
  var colRH   = hdrMap['RH'];
  var colSlr  = hdrMap['SlrW'];
  var colWS   = hdrMap['WS_kph_S_WVT'];
  var colWD   = hdrMap['WindDir_D1_WVT'];
  var colRain = hdrMap['Rain_mm_Tot'];
  var colBP   = hdrMap['BP_mB'];

  // ── Lines 2-3: skip (units + processing type) ──
  nl = raw.indexOf('\n', pos); pos = nl + 1;
  nl = raw.indexOf('\n', pos); pos = nl + 1;

  // ── Process data rows with running totals ──
  var daily = [];
  var sampled = [];
  var recordCount = 0;
  var cumRain = 0, cumGdd5 = 0, cumGdd0 = 0;
  var dateStart = '', dateEnd = '';

  // Wind rose: 16 sectors × 5 speed bins
  var windSectors = [];
  for (var wi = 0; wi < 16; wi++) windSectors[wi] = [0, 0, 0, 0, 0];
  var calms = 0;

  // Daily accumulators
  var curDate = '';
  var dT_sum = 0, dT_count = 0, dT_min = Infinity, dT_max = -Infinity;
  var dRH_sum = 0, dRH_count = 0;
  var dBP_sum = 0, dBP_count = 0;
  var dWS_sum = 0, dWS_count = 0, dWS_max = 0;
  var dSunCount = 0;
  var dRain_sum = 0;
  var dVPD_sum = 0, dVPD_count = 0, dVPD_max = 0;

  var latestTs = '', latestT = 0, latestRH = 0, latestSlr = 0, latestWS = 0, latestBP = 0, latestVPD = 0;

  function finalizeDay() {
    if (dT_count === 0) return;
    var tmean = dT_sum / dT_count;
    var gdd5 = Math.max(0, tmean - 5);
    var gdd0 = Math.max(0, tmean);
    cumRain += dRain_sum;
    cumGdd5 += gdd5;
    cumGdd0 += gdd0;

    daily.push({
      date: curDate,
      tmin: round2(dT_min),
      tmax: round2(dT_max),
      tmean: round2(tmean),
      rhmean: dRH_count > 0 ? round1(dRH_sum / dRH_count) : 0,
      bpmean: dBP_count > 0 ? round1(dBP_sum / dBP_count) : 0,
      rain: round1(dRain_sum),
      cum_rain: round1(cumRain),
      sunshine: round1(dSunCount * 30 / 3600),
      gdd5: round2(gdd5),
      cum_gdd5: round1(cumGdd5),
      gdd0: round2(gdd0),
      cum_gdd0: round1(cumGdd0),
      vpd_mean: dVPD_count > 0 ? round3(dVPD_sum / dVPD_count) : 0,
      vpd_max: round3(dVPD_max),
      ws_mean: dWS_count > 0 ? round2(dWS_sum / dWS_count) : 0,
      ws_max: round1(dWS_max)
    });
  }

  function resetDay(date) {
    curDate = date;
    dT_sum = 0; dT_count = 0; dT_min = Infinity; dT_max = -Infinity;
    dRH_sum = 0; dRH_count = 0;
    dBP_sum = 0; dBP_count = 0;
    dWS_sum = 0; dWS_count = 0; dWS_max = 0;
    dSunCount = 0;
    dRain_sum = 0;
    dVPD_sum = 0; dVPD_count = 0; dVPD_max = 0;
  }

  // ── Main line-by-line loop using indexOf ──
  while (pos < raw.length) {
    nl = raw.indexOf('\n', pos);
    if (nl === -1) nl = raw.length;
    var line = raw.substring(pos, nl);
    pos = nl + 1;

    // Strip CR
    var len = line.length;
    if (len > 0 && line.charCodeAt(len - 1) === 13) {
      line = line.substring(0, len - 1);
      len--;
    }
    if (len < 10) continue;

    var fields = line.split(',');

    // Parse timestamp
    var tsRaw = fields[colTS];
    if (!tsRaw || tsRaw.length < 12) continue;
    var ts = tsRaw.charAt(0) === '"' ? tsRaw.substring(1, tsRaw.length - 1) : tsRaw;
    var dateStr = ts.substring(0, 10);

    // Parse numeric values
    var T    = colT    !== undefined ? parseFloat(fields[colT])    : NaN;
    var rh   = colRH   !== undefined ? parseFloat(fields[colRH])   : NaN;
    var slr  = colSlr  !== undefined ? parseFloat(fields[colSlr])  : NaN;
    var ws   = colWS   !== undefined ? parseFloat(fields[colWS])   : NaN;
    var wd   = colWD   !== undefined ? parseFloat(fields[colWD])   : NaN;
    var rain = colRain !== undefined ? parseFloat(fields[colRain]) : NaN;
    var bp   = colBP   !== undefined ? parseFloat(fields[colBP])   : NaN;

    recordCount++;

    // Track date range
    if (recordCount === 1) dateStart = dateStr;
    dateEnd = dateStr;

    // Day boundary check
    if (dateStr !== curDate) {
      if (curDate !== '') finalizeDay();
      resetDay(dateStr);
    }

    // ── Update daily accumulators ──
    if (!isNaN(T)) {
      dT_sum += T; dT_count++;
      if (T < dT_min) dT_min = T;
      if (T > dT_max) dT_max = T;
    }
    if (!isNaN(rh)) { dRH_sum += rh; dRH_count++; }
    if (!isNaN(bp)) { dBP_sum += bp; dBP_count++; }
    if (!isNaN(ws)) {
      dWS_sum += ws; dWS_count++;
      if (ws > dWS_max) dWS_max = ws;
    }
    if (!isNaN(slr) && slr >= 120) dSunCount++;
    if (!isNaN(rain)) dRain_sum += rain;

    // VPD (Buck equation)
    if (!isNaN(T) && !isNaN(rh)) {
      var es = 0.61121 * Math.exp((18.678 - T / 234.5) * (T / (257.14 + T)));
      var vpd = es * (1 - rh / 100);
      if (vpd < 0) vpd = 0;
      dVPD_sum += vpd; dVPD_count++;
      if (vpd > dVPD_max) dVPD_max = vpd;
    }

    // ── Wind rose ──
    if (!isNaN(ws)) {
      if (ws < 0.5) {
        calms++;
      } else if (!isNaN(wd)) {
        var sector = Math.round(wd / 22.5) % 16;
        var bin = ws < 2 ? 0 : ws < 6 ? 1 : ws < 12 ? 2 : ws < 20 ? 3 : 4;
        windSectors[sector][bin]++;
      }
    }

    // ── Sampled data (every 60th record, cap 500) ──
    if (recordCount % 60 === 0 && sampled.length < 500) {
      var svpd = 0;
      if (!isNaN(T) && !isNaN(rh)) {
        var ses = 0.61121 * Math.exp((18.678 - T / 234.5) * (T / (257.14 + T)));
        svpd = ses * (1 - rh / 100);
        if (svpd < 0) svpd = 0;
      }
      sampled.push({
        ts: ts,
        T: isNaN(T) ? null : round2(T),
        RH: isNaN(rh) ? null : round1(rh),
        slr: isNaN(slr) ? null : round1(slr),
        ws: isNaN(ws) ? null : round2(ws),
        bp: isNaN(bp) ? null : round1(bp),
        vpd: round3(svpd)
      });
    }

    // Track latest valid reading
    latestTs = ts;
    if (!isNaN(T))   latestT   = T;
    if (!isNaN(rh))  latestRH  = rh;
    if (!isNaN(slr)) latestSlr = slr;
    if (!isNaN(ws))  latestWS  = ws;
    if (!isNaN(bp))  latestBP  = bp;
  }

  // Finalize last day
  if (curDate !== '') finalizeDay();

  // Compute latest VPD
  var latEs  = 0.61121 * Math.exp((18.678 - latestT / 234.5) * (latestT / (257.14 + latestT)));
  latestVPD = latEs * (1 - latestRH / 100);
  if (latestVPD < 0) latestVPD = 0;

  return {
    station: { serial: serial, firmware: firmware },
    record_count: recordCount,
    date_start: dateStart,
    date_end: dateEnd,
    daily: daily,
    sampled: sampled,
    wind: {
      sectors: windSectors,
      total: recordCount,
      calms: calms,
      dirs: ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'],
      bins: ['<2','2-6','6-12','12-20','>20']
    },
    latest: {
      ts: latestTs,
      T: round2(latestT),
      RH: round1(latestRH),
      slr: round1(latestSlr),
      ws: round2(latestWS),
      bp: round1(latestBP),
      vpd: round3(latestVPD)
    }
  };
}

exports.handler = async function () {
  try {
    // Try .dat file first
    var datPath = findFile('CR1000_Table1.dat');
    if (datPath) {
      var result = parseDat(datPath);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify(result)
      };
    }

    // Fallback to pre-processed weather.json
    var jsonPath = findFile('weather.json');
    if (jsonPath) {
      var json = fs.readFileSync(jsonPath, 'utf8');
      return { statusCode: 200, headers: HEADERS, body: json };
    }

    return {
      statusCode: 404,
      headers: HEADERS,
      body: JSON.stringify({
        error: 'No data file found. Upload data/CR1000_Table1.dat to the repository.'
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
