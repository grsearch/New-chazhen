'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : (target.endsWith('.js') ? [target] : []);
  });
}

const files = [...filesUnder('src'), ...filesUnder('scripts'), ...filesUnder('test')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax check passed: ${files.length} files`);
