#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function walk(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...walk(full));
        else files.push(full);
    }
    return files;
}

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) {
    console.error('dist folder not found');
    process.exit(1);
}

const files = walk(dist).filter((f) => f.endsWith('.js'));
for (const f of files) {
    let content = fs.readFileSync(f, 'utf8');
    let changed = false;
    content = content.replace(/(['"])(\.\.?\/[^'"\n]+?)(['"])/g, (m, q1, p, q2) => {
        // keep protocol-like and package imports
        if (!p.startsWith('./') && !p.startsWith('../')) return m;
        if (/\.[a-zA-Z0-9]+$/.test(p)) return m;
        changed = true;
        return q1 + p + '.js' + q2;
    });
    if (changed) {
        fs.writeFileSync(f, content, 'utf8');
        console.log('patched', f);
    }
}
console.log('done');
