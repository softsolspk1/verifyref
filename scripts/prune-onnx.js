#!/usr/bin/env node
// scripts/prune-onnx.js - the language model of Module 3.B (src/tools/nli.js) runs on onnxruntime-node, which ships
// native binaries for every platform (about 300 MB) plus onnxruntime-web (about 140 MB, browser builds the server never
// loads). Keeps only this machine's binary so the Vercel function stays under its size limit and the desktop installer
// stays small. Runs after npm install (package.json postinstall, desktop/stage.js).
//   node scripts/prune-onnx.js [node_modules folder]
const fs = require('fs');
const path = require('path');

const NM = path.resolve(process.argv[2] || path.join(__dirname, '..', 'node_modules'));
const rm = p => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); console.log('prune-onnx: removed', path.relative(NM, p)); } };

rm(path.join(NM, 'onnxruntime-web', 'dist'));
const bin = path.join(NM, 'onnxruntime-node', 'bin');
if (fs.existsSync(bin)) for (const napi of fs.readdirSync(bin)) {
  const dir = path.join(bin, napi);
  for (const platform of fs.readdirSync(dir)) {
    if (platform !== process.platform) { rm(path.join(dir, platform)); continue; }
    for (const arch of fs.readdirSync(path.join(dir, platform))) if (arch !== process.arch) rm(path.join(dir, platform, arch));
  }
}
