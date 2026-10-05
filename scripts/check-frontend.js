const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
let count = 0;
for (const [, attributes, code] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(attributes) || !code.trim()) continue;
    if (/\btype=["']application\/ld\+json["']/.test(attributes)) {
        JSON.parse(code);
        continue;
    }
    new vm.Script(code, { filename: 'index.html inline script ' + (++count) });
}
for (const file of ['photo-geometry.js', 'face-landmarks.js']) {
    new vm.Script(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), { filename: file });
}
console.log('Frontend: scripts válidos (' + count + ' inline).');
