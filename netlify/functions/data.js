// netlify/functions/data.js
// Runs as a serverless function on every request to /api/data
// Reads the .dat file from the data/ folder in the repo and returns processed JSON

const fs   = require('fs');
const path = require('path');

// ── DATA PROCESSING ───────────────────────────────────────────────────────────

function satVp(T) {
  return 0.61121 * Math.exp((18.678 - T / 234.5) * (T / (257.14 + T)));
}
function vpdFn(T, RH) {
  return Math.max(0, satVp(T) * (1 - RH / 100));
}
function safeFloat(val) {
  const f = parseFloat(val);
  return (isNaN(f) || !isFinite(f)) ? 0 : f;
}

function parseDat(filepath) {
  const lines  = fs.readFileSync(filepath, 'utf8').split('\n');
  const headers = lines[1].split(',').map(h => h.replace(/"/g, '').trim());

  const col = {};
  headers.forEach((h, i) => col[h] = i);
  const T_i   = col['AirTC']           ?? 3;
  const RH_i  = col['RH']              ?? 4;
  const SLR_i = col['SlrW']            ?? 12;
  const WS_i  = col['WS_kph_S_WVT']    ?? 16;
  const WD_i  = col['WindDir_D1_WVT']  ?? 17;
  const RN_i  = col['Rain_mm_Tot']     ?? 19;
  const BP_i  = col['BP_mB']           ?? 20;

  const daily        = {};
  const sampled      = [];
  const windSectors  = Array.from({length:16}, () => [0,0,0,0,0]);
  let windTotal = 0, windCalms = 0;
  let rowCount  = 0;

  for (let i = 4; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV respecting quoted fields
    const row = [];
    let inQ = false, cur = '';
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { row.push(cur); cur = ''; }
      else { cur += ch; }
    }
    row.push(cur);

    const ts = row[0].replace(/"/g, '').trim();
    if (!ts || ts.length < 10) continue;
    rowCount++;

    const T   = safeFloat(row[T_i]);
    const RH  = safeFloat(row[RH_i]);
    const slr = safeFloat(row[SLR_i]);
    const ws  = safeFloat(row[WS_i]);
    const wd  = safeFloat(row[WD_i]);
    const rn  = safeFloat(row[RN_i]);
    const bp  = safeFloat(row[BP_i]);
    const vpd = vpdFn(T, RH);
    const date = ts.slice(0, 10);

    if (!daily[date]) {
      daily[date] = { T:[], RH:[], slr:[], ws:[], wd:[], rain:0, bp:[], vpd:[] };
    }
    const d = daily[date];
    d.T.push(T); d.RH.push(RH); d.slr.push(slr);
    d.ws.push(ws); d.wd.push(wd); d.rain += rn;
    d.bp.push(bp); d.vpd.push(vpd);

    // 30-min sample (every 60 records at 30s scan)
    if ((rowCount - 1) % 60 === 0) {
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
      const bins   = [0, 2, 6, 12, 20, 999];
      for (let b = 4; b >= 0; b--) {
        if (ws >= bins[b]) { windSectors[sector][b]++; break; }
      }
    }
  }

  // Build daily summaries
  const dailyOut = Object.keys(daily).sort().map(date => {
    const d     = daily[date];
    const tvals = d.T;
    const tmean = tvals.reduce((a,b) => a+b, 0) / tvals.length;
    const gdd5  = Math.max(0, tmean - 5);
    const sunshine = d.slr.filter(v => v >= 120).length * 30 / 3600;
    const meanSlr  = d.slr.reduce((a,b) => a+b, 0) / d.slr.length;
    return {
      date,
      tmin:    +Math.min(...tvals).toFixed(1),
      tmax:    +Math.max(...tvals).toFixed(1),
      tmean:   +tmean.toFixed(2),
      rhmean:  +(d.RH.reduce((a,b)=>a+b,0)/d.RH.length).toFixed(1),
      bpmean:  +(d.bp.reduce((a,b)=>a+b,0)/d.bp.length).toFixed(1),
      rain:    +d.rain.toFixed(1),
      sunshine:+sunshine.toFixed(1),
      cci:     +(1 - Math.min(meanSlr/400, 1)).toFixed(2),
      gdd5:    +gdd5.toFixed(2),
      vpd_mean:+(d.vpd.reduce((a,b)=>a+b,0)/d.vpd.length).toFixed(3),
      vpd_max: +Math.max(...d.vpd).toFixed(3),
      ws_mean: +(d.ws.reduce((a,b)=>a+b,0)/d.ws.length).toFixed(2),
      ws_max:  +Math.max(...d.ws).toFixed(2),
    };
  });

  // Cumulative totals
  let cum5 = 0, cumRain = 0;
  dailyOut.forEach(d => {
    cum5     += d.gdd5;   d.cum_gdd5 = +cum5.toFixed(1);
    cumRain  += d.rain;   d.cum_rain  = +cumRain.toFixed(1);
  });

  // Station metadata from header line 0
  const meta  = lines[0].split(',').map(s => s.replace(/"/g,'').trim());
  const station = {
    serial:   meta[3] || 'unknown',
    firmware: meta[4] || 'unknown',
  };

  return {
    station,
    filename:     path.basename(filepath),
    record_count: rowCount,
    date_start:   dailyOut[0]?.date ?? '',
    date_end:     dailyOut[dailyOut.length-1]?.date ?? '',
    daily:        dailyOut,
    sampled:      sampled.slice(-2000),   // cap for response size
    wind: {
      sectors: windSectors,
      total:   windTotal,
      calms:   windCalms,
      dirs:    ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'],
      bins:    ['<2','2-6','6-12','12-20','>20'],
    },
    latest: sampled[sampled.length - 1] ?? {},
  };
}

// ── HANDLER ───────────────────────────────────────────────────────────────────

exports.handler = async function(event, context) {
  try {
    // Find the .dat file in the data/ folder at repo root
    // __dirname is netlify/functions/, so go up two levels
    const dataDir = path.join(__dirname, '..', '..', 'data');

    if (!fs.existsSync(dataDir)) {
      return { statusCode: 404, body: JSON.stringify({ error: 'data/ folder not found' }) };
    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.dat'));
    if (!files.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No .dat file found in data/' }) };
    }

    // Use the most recently modified .dat file
    const latest = files
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dataDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].name;

    const data = parseDat(path.join(dataDir, latest));

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Cache-Control':               'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data),
    };

  } catch (err) {
    console.error('data function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
