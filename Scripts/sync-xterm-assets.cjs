#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const resourcesDir = path.join(projectRoot, 'Sources', 'codigo-editor', 'Resources');

const assets = [
  {
    source: path.join(projectRoot, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
    target: path.join(resourcesDir, 'xterm.min.js')
  },
  {
    source: path.join(projectRoot, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
    target: path.join(resourcesDir, 'xterm-addon-fit.min.js')
  },
  {
    source: path.join(projectRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
    target: path.join(resourcesDir, 'xterm.css')
  }
];

function copyAsset({ source, target }) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing asset at ${source}`);
  }
  fs.copyFileSync(source, target);
  console.log(`Copied ${path.relative(projectRoot, source)} -> ${path.relative(projectRoot, target)}`);
}

function ensureResourcesDirectory() {
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }
}

function removeLegacyDirectory() {
  const legacyDir = path.join(resourcesDir, 'xterm');
  if (!fs.existsSync(legacyDir)) {
    return;
  }
  fs.rmSync(legacyDir, { recursive: true, force: true });
}

ensureResourcesDirectory();
assets.forEach(copyAsset);
removeLegacyDirectory();
