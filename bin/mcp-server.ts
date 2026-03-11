#!/usr/bin/env node --experimental-strip-types

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`[gated-docs] Node.js 22+ required (you have ${process.versions.node}). Install: brew install node\n`);
  process.exit(1);
}

import '../src/mcp/server.ts';
