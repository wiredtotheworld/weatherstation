
bash
cat /home/claude/stockwell-live/netlify/functions/data.js
Output
// netlify/functions/data.js
// Fast version - avoids per-character CSV parsing, processes ~93k rows quickly

const fs   = require('fs');
const path = require('path');

function satVp(T)      { return 0.61121 * Math.exp((18.678 - T/234.5) * (T/(257.14+T))); }
function vpdFn(T, RH)  { return Math.max(0, satVp(T) * (1 - RH/100)); }
function sf(v)         { const f = parseFloat(v); return (isNaN(f)||!isFinite(f)) ? 0 : f; }

function parseDat(filepath) {
  const text  = fs.readFileSync(filepath, 'latin1');  // latin1 is faster than utf8 for ASCII data
  const lines = text.split('\n');

  // Header row is line index 1
  const headers = lines[1].split(',').map(h => h.replace(/"/g,'').trim());
  const col = {};
  headers.forEach((h,i) => col[h] = i);

  const Ti   = col['AirTC']          !== undefined ? col['AirTC']          : 3;
  const RHi  = col['RH']             !== undefined ? col['RH']             : 4;
  const SLRi = col['SlrW']           !== undefined ? col['SlrW']           : 12;
  const WSi  = col['WS_kph_S_WVT']   !== undefined ? col['WS_kph_S_WVT']  : 16;
  const WDi  = col['WindDir_D1_WVT'] !== undefined ? col['WindDir_D1_WVT']: 17;
  const RNi  = col['Rain_mm_Tot']    !== undefined ? col['Rain_mm_Tot']    : 19;
  const BPi  = col['BP_mB']          !== undefined ? col['BP_mB']          : 20;

  const daily       = {};
  const sampled     = [];
  const windSectors = [[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],
                       [0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],
                       [0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],
                       [0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]];
  let windTotal = 0, windCalms = 0, rowCount = 0;

  // Data starts at line 4. Use simple split — CR1000 files don't have commas in values.
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 20) continue;

    const row = line.split(',');
    if (row.length < 21) continue;

    // Timestamp is first field, may be quoted
    const ts = row[0].replace(/"/g,'').trim();
    if (ts.length < 10) continue;

    rowCount++;
    const T   = sf(row[Ti]);
    const RH  = sf(row[RHi]);
    const slr = sf(row[SLRi]);
    const ws  = sf(row[WSi]);
    const wd  = sf(row[WDi]);
    const rn  = sf(row[RNi]);
    const bp  = sf(row[BPi]);
    const vpd = vpdFn(T, RH);
    const date = ts.slice(0, 10);

    // Daily accumulation
    if (!daily[date]) {
      daily[date] = { T:0, T2:0, RH:0, slr:0, ws:0, rain:0, bp:0, vpd:0,
                      Tmin:999, Tmax:-999, wsMax:0, vpdMax:0,
                      sunCount:0, count:0 };
    }
    const d = daily[date];
    d.count++;
    d.T   += T;   d.RH  += RH;  d.slr += slr;
    d.ws  += ws;  d.rain += rn; d.bp  += bp;
    d.vpd += vpd;
    if (T   < d.Tmin)   d.Tmin   = T;
    if (T   > d.Tmax)   d.Tmax   = T;
    if (ws  > d.wsMax)  d.wsMax  = ws;
    if (vpd > d.vpdMax) d.vpdMax = vpd;
    if (slr >= 120)     d.sunCount++;

    // 30-min sample (every 60 records)
    if (rowCount % 60 === 1) {
      sampled.push({ ts, T:+T.toFixed(2), RH:+RH.toFixed(1),
                     slr:+slr.toFixed(1), ws:+ws.toFixed(2),
                     bp:+bp.toFixed(1), vpd:+vpd.toFixed(3) });
    }

    // Wind rose
    windTotal++;
    if (ws < 0.5) {
      windCalms++;
    } else {
      const sector = Math.round((wd + 11.25) / 22.5) % 16;
      const b = ws >= 20 ? 4 : ws >= 12 ? 3 : ws >= 6 ? 2 : ws >= 2 ? 1 : 0;
      windSectors[sector][b]++;
    }
  }

  // Build daily summaries
  const dailyOut = Object.keys(daily).sort().map(date => {
    const d  = daily[date];
    const n  = d.count;
    const tmean   = d.T / n;
    const sunshine = d.sunCount * 30 / 3600;
    const meanSlr  = d.slr / n;
    return {
      date,
      tmin:    +d.Tmin.toFixed(1),
      tmax:    +d.Tmax.toFixed(1),
      tmean:   +tmean.toFixed(2),
      rhmean:  +(d.RH/n).toFixed(1),
      bpmean:  +(d.bp/n).toFixed(1),
      rain:    +d.rain.toFixed(1),
      sunshine:+sunshine.toFixed(1),
      cci:     +(1 - Math.min(meanSlr/400, 1)).toFixed(2),
      gdd5:    +Math.max(0, tmean-5).toFixed(2),
      vpd_mean:+(d.vpd/n).toFixed(3),
      vpd_max: +d.vpdMax.toFixed(3),
      ws_mean: +(d.ws/n).toFixed(2),
      ws_max:  +d.wsMax.toFixed(2),
    };
  });

  // Cumulative totals
  let cum5 = 0, cumRain = 0;
  dailyOut.forEach(d => {
    cum5     += d.gdd5;  d.cum_gdd5 = +cum5.toFixed(1);
    cumRain  += d.rain;  d.cum_rain  = +cumRain.toFixed(1);
  });

  // Station metadata
  const meta = lines[0].split(',').map(s => s.replace(/"/g,'').trim());

  return {
    station:      { serial: meta[3]||'unknown', firmware: meta[4]||'unknown' },
    filename:     path.basename(filepath),
    record_count: rowCount,
    date_start:   dailyOut[0]  ? dailyOut[0].date  : '',
    date_end:     dailyOut[dailyOut.length-1] ? dailyOut[dailyOut.length-1].date : '',
    daily:        dailyOut,
    sampled:      sampled.slice(-2000),
    wind: {
      sectors: windSectors, total: windTotal, calms: windCalms,
      dirs:    ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'],
      bins:    ['<2','2-6','6-12','12-20','>20'],
    },
    latest: sampled.length ? sampled[sampled.length-1] : {},
  };
}

exports.handler = async function(event, context) {
  try {
    // Debug: try multiple candidate paths to find data/
    const candidates = [
      path.join(process.cwd(), 'data'),
      path.join(__dirname, '..', '..', 'data'),
      path.join(__dirname, '..', '..', '..', 'data'),
      '/var/task/data',
      '/opt/build/repo/data',
    ];
    const found = candidates.find(c => { try { return fs.existsSync(c); } catch(e){ return false; } });
    if (!found) {
      return respond(404, {
        error: 'data/ folder not found',
        debug: { cwd: process.cwd(), dirname: __dirname, tried: candidates }
      });
    }
    const dataDir = found;

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.dat'));
    if (!files.length) {
      return respond(404, { error: 'No .dat file found in data/' });
    }

    const latest = files
      .map(f => ({ name:f, mtime: fs.statSync(path.join(dataDir,f)).mtimeMs }))
      .sort((a,b) => b.mtime - a.mtime)[0].name;

    const data = parseDat(path.join(dataDir, latest));
    return respond(200, data);

  } catch(err) {
    console.error('data function error:', err);
    return respond(500, { error: err.message, stack: err.stack });
  }
};

function respond(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}  for (let i = 4; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 20) continue;

    const row = line.split(',');
    if (row.length < 21) continue;

    // Timestamp is first field, may be quoted
    const ts = row[0].replace(/"/g,'').trim();
    if (ts.length < 10) continue;

    rowCount++;
    const T   = sf(row[Ti]);
    const RH  = sf(row[RHi]);
    const slr = sf(row[SLRi]);
    const ws  = sf(row[WSi]);
    const wd  = sf(row[WDi]);
    const rn  = sf(row[RNi]);
    const bp  = sf(row[BPi]);
    const vpd = vpdFn(T, RH);
    const date = ts.slice(0, 10);

    // Daily accumulation
    if (!daily[date]) {
      daily[date] = { T:0, T2:0, RH:0, slr:0, ws:0, rain:0, bp:0, vpd:0,
                      Tmin:999, Tmax:-999, wsMax:0, vpdMax:0,
                      sunCount:0, count:0 };
    }
    const d = daily[date];
    d.count++;
    d.T   += T;   d.RH  += RH;  d.slr += slr;
    d.ws  += ws;  d.rain += rn; d.bp  += bp;
    d.vpd += vpd;
    if (T   < d.Tmin)   d.Tmin   = T;
    if (T   > d.Tmax)   d.Tmax   = T;
    if (ws  > d.wsMax)  d.wsMax  = ws;
    if (vpd > d.vpdMax) d.vpdMax = vpd;
    if (slr >= 120)     d.sunCount++;

    // 30-min sample (every 60 records)
    if (rowCount % 60 === 1) {
      sampled.push({ ts, T:+T.toFixed(2), RH:+RH.toFixed(1),
                     slr:+slr.toFixed(1), ws:+ws.toFixed(2),
                     bp:+bp.toFixed(1), vpd:+vpd.toFixed(3) });
    }

    // Wind rose
    windTotal++;
    if (ws < 0.5) {
      windCalms++;
    } else {
      const sector = Math.round((wd + 11.25) / 22.5) % 16;
      const b = ws >= 20 ? 4 : ws >= 12 ? 3 : ws >= 6 ? 2 : ws >= 2 ? 1 : 0;
      windSectors[sector][b]++;
    }
  }

  // Build daily summaries
  const dailyOut = Object.keys(daily).sort().map(date => {
    const d  = daily[date];
    const n  = d.count;
    const tmean   = d.T / n;
    const sunshine = d.sunCount * 30 / 3600;
    const meanSlr  = d.slr / n;
    return {
      date,
      tmin:    +d.Tmin.toFixed(1),
      tmax:    +d.Tmax.toFixed(1),
      tmean:   +tmean.toFixed(2),
      rhmean:  +(d.RH/n).toFixed(1),
      bpmean:  +(d.bp/n).toFixed(1),
      rain:    +d.rain.toFixed(1),
      sunshine:+sunshine.toFixed(1),
      cci:     +(1 - Math.min(meanSlr/400, 1)).toFixed(2),
      gdd5:    +Math.max(0, tmean-5).toFixed(2),
      vpd_mean:+(d.vpd/n).toFixed(3),
      vpd_max: +d.vpdMax.toFixed(3),
      ws_mean: +(d.ws/n).toFixed(2),
      ws_max:  +d.wsMax.toFixed(2),
    };
  });

  // Cumulative totals
  let cum5 = 0, cumRain = 0;
  dailyOut.forEach(d => {
    cum5     += d.gdd5;  d.cum_gdd5 = +cum5.toFixed(1);
    cumRain  += d.rain;  d.cum_rain  = +cumRain.toFixed(1);
  });

  // Station metadata
  const meta = lines[0].split(',').map(s => s.replace(/"/g,'').trim());

  return {
    station:      { serial: meta[3]||'unknown', firmware: meta[4]||'unknown' },
    filename:     path.basename(filepath),
    record_count: rowCount,
    date_start:   dailyOut[0]  ? dailyOut[0].date  : '',
    date_end:     dailyOut[dailyOut.length-1] ? dailyOut[dailyOut.length-1].date : '',
    daily:        dailyOut,
    sampled:      sampled.slice(-2000),
    wind: {
      sectors: windSectors, total: windTotal, calms: windCalms,
      dirs:    ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'],
      bins:    ['<2','2-6','6-12','12-20','>20'],
    },
    latest: sampled.length ? sampled[sampled.length-1] : {},
  };
}

exports.handler = async function(event, context) {
  try {
    const dataDir = path.join(__dirname, '..', '..', 'data');

    if (!fs.existsSync(dataDir)) {
      return respond(404, { error: 'data/ folder not found' });
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.dat'));
    if (!files.length) {
      return respond(404, { error: 'No .dat file found in data/' });
    }

    const latest = files
      .map(f => ({ name:f, mtime: fs.statSync(path.join(dataDir,f)).mtimeMs }))
      .sort((a,b) => b.mtime - a.mtime)[0].name;

    const data = parseDat(path.join(dataDir, latest));
    return respond(200, data);

  } catch(err) {
    console.error('data function error:', err);
    return respond(500, { error: err.message, stack: err.stack });
  }
};

function respond(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
