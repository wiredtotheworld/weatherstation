// netlify/functions/data.js
// Serves pre-processed weather.json — no parsing, just file read + response

const fs   = require('fs');
const path = require('path');

exports.handler = async function() {
  try {
    // Try to find weather.json in the data/ folder
    const candidates = [
      path.join(process.cwd(), 'data', 'weather.json'),
      path.join(__dirname, '..', '..', 'data', 'weather.json'),
      path.join(__dirname, '..', '..', '..', 'data', 'weather.json'),
    ];

    const found = candidates.find(c => {
      try { return fs.existsSync(c); } catch(e) { return false; }
    });

    if (!found) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          error: 'weather.json not found. Run build.py locally and commit data/weather.json',
          tried: candidates,
          cwd: process.cwd(),
          dirname: __dirname
        })
      };
    }

    const json = fs.readFileSync(found, 'utf8');

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Cache-Control':               'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
      body: json,
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
