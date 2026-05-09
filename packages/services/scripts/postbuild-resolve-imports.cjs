#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function walk(dir) {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files = files.concat(walk(full));
        else files.push(full);
    }
    return files;
}

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) {
    console.error('dist not found');
    process.exit(0);
}

const jsFiles = walk(dist).filter(f => f.endsWith('.js'));
let changedCount = 0;
for (const file of jsFiles) {
    let content = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    const regex = /(from\s+|export\s+\*\s+from\s+)(['"])(\.\.?\/[^'"\n]+?)(['"])/g;
    let m;
    let localChanged = false;
    const replacements = [];
    while ((m = regex.exec(content)) !== null) {
        const fullMatch = m[0];
        const prefix = m[1];
        const quote = m[2];
        const spec = m[3];
        const endQuote = m[4];
        const targetJs = path.resolve(dir, spec + '.js');
        if (fs.existsSync(targetJs)) {
            const newSpec = spec + '.js';
            replacements.push({ start: m.index, end: m.index + fullMatch.length, text: prefix + quote + newSpec + endQuote });
            localChanged = true;
        }
    }
    if (localChanged) {
        // apply replacements from end to start
        replacements.sort((a, b) => b.start - a.start);
        for (const r of replacements) {
            content = content.slice(0, r.start) + r.text + content.slice(r.end);
        }
        fs.writeFileSync(file, content, 'utf8');
        changedCount++;
        console.log('patched imports in', file);
    }
}
console.log('postbuild-resolve-imports: patched files:', changedCount);
