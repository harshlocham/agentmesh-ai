#!/usr/bin/env node
const fs = require('fs');
const f = 'packages/services/dist/index.js';
if (!fs.existsSync(f)) { console.error('not found'); process.exit(1); }
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/(['"])(\.\.?\/[^'"\n]+?)(['"])/g, (m, q1, p, q2) => {
    if (!p.startsWith('./') && !p.startsWith('../')) return m;
    if (/\.[a-zA-Z0-9]+$/.test(p)) return m;
    return q1 + p + '.js' + q2;
});
fs.writeFileSync(f, c, 'utf8');
console.log('patched index.js');
