'use strict';

/**
 * index.js — platform-aware loader for the compiled native addon.
 *
 * After `npm run build` (napi-rs), this resolves to the correct
 * .node binary for the current platform/arch. If the binary hasn't
 * been built yet, it throws a clear error pointing at the build command.
 */

const { existsSync } = require('fs');
const { join } = require('path');

function loadBinding() {
  const candidates = [
    'zcash_tipbot_native.linux-x64-gnu.node',
    'zcash_tipbot_native.darwin-x64.node',
    'zcash_tipbot_native.darwin-arm64.node',
    'zcash_tipbot_native.node', // single-target debug build
  ];

  for (const file of candidates) {
    const fullPath = join(__dirname, file);
    if (existsSync(fullPath)) {
      return require(fullPath);
    }
  }

  throw new Error(
    'Native Zcash addon not built. Run:\n' +
    '  cd native && npm install && npm run build\n' +
    'Requires Rust >= 1.85 (edition 2024). See native/README.md.'
  );
}

module.exports = loadBinding();
