#!/usr/bin/env node
const fs = require('fs');
const files = [
    'packages/services/dist/task-intelligence.service.js',
    'packages/services/dist/task.service.js',
    'packages/services/dist/index.js'
];
for (const f of files) {
    try {
        if (!fs.existsSync(f)) continue;
        let c = fs.readFileSync(f, 'utf8');
        const before = (c.match(/\.\/repositories\/task\.repo/g) || []).length;
        if (before) {
            c = c.replace(/\.\/repositories\/task\.repo/g, './repositories/task.repo.js');
            fs.writeFileSync(f, c, 'utf8');
            console.log('patched', f);
        } else {
            console.log('no-match', f);
        }
    } catch (err) {
        console.error('err', f, err);
    }
}
