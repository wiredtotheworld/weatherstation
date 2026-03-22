// netlify/functions/images.js
// Returns list of image paths from public/images/

const fs   = require('fs');
const path = require('path');

exports.handler = async function() {
  try {
    const imgDir = path.join(__dirname, '..', '..', 'public', 'images');
    if (!fs.existsSync(imgDir)) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: '[]' };
    }
    const exts = new Set(['.jpg','.jpeg','.png','.gif','.webp']);
    const imgs = fs.readdirSync(imgDir)
      .filter(f => exts.has(path.extname(f).toLowerCase()))
      .sort()
      .map(f => '/images/' + f);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(imgs),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
