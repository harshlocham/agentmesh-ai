#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function walk(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

function fixFile(file) {
  if (!file.endsWith('.js')) return;
  let content = fs.readFileSync(file, 'utf8');
  // Aggressively append .js to repository-relative bare imports like ./repositories/task.repo
  content = content.replace(/(\.\/repositories\/[a-zA-Z0-9_\-\.\/]+)/g, (m) => {
    // Skip if already has an extension
    if (/\.[a-zA-Z0-9]+$/.test(m)) return m;
    return `${m}.js`;
  });

  // Fallback: general relative imports without extension
  content = content.replace(/(from\s+|export\s+\*\s+from\s+)(['"])(\.\.?\/[^'"`]+?)(['"])/g, (m, p1, q1, p2, q2) => {
    if (/\.[a-zA-Z0-9]+$/.test(p2)) return m;
    if (!p2.startsWith('./') && !p2.startsWith('../')) return m;
    return p1 + q1 + p2 + '.js' + q2;
  });
  fs.writeFileSync(file, content, 'utf8');
}

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) {
  console.error('dist folder not found, skip postbuild-fix');
  process.exit(0);
}

walk(dist, fixFile);
console.log('postbuild-fix: updated relative imports in dist');

// Note: do not create extensionless copies; use postbuild-resolve-imports.cjs to rewrite imports to .js
// Clean up any accidental extensionless repository files left behind
const repoDir2 = path.join(dist, 'repositories');
if (fs.existsSync(repoDir2)) {
  for (const entry of fs.readdirSync(repoDir2)) {
    const full = path.join(repoDir2, entry);
    // remove legacy extensionless clones like 'task.repo' or 'message.repo' when .js exists
    if (entry.endsWith('.repo')) {
      const jsPath = full + '.js';
      if (fs.existsSync(jsPath)) {
        try { fs.unlinkSync(full); } catch (_e) { }
      }
    }
  }
}
