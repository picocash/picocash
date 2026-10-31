#!/usr/bin/env node
// Convert the offline factory scan (tip20-registry.json) into the two KV
// records the Worker expects. (The Node server seeds itself on first boot;
// this script is for Workers KV.) Run `npm run build` first — it imports the
// compiled converter so the two paths cannot drift.
//
//   node scripts/seed-registry.mjs tip20-registry.json registry  > registry.json
//   node scripts/seed-registry.mjs tip20-registry.json meta      > meta.json
//   wrangler kv key put registry --binding RESERVES --path registry.json [--local]
//   wrangler kv key put meta     --binding RESERVES --path meta.json     [--local]
import { readFileSync } from 'node:fs';
import { metaFromScan, registryFromScan } from '../dist/seed.js';

const [, , file, which = 'registry', lastArg] = process.argv;
if (!file) {
  console.error('usage: seed-registry.mjs <tip20-registry.json> [registry|meta] [lastScannedBlock]');
  process.exit(2);
}
const rows = JSON.parse(readFileSync(file, 'utf8'));
process.stdout.write(JSON.stringify(which === 'registry' ? registryFromScan(rows, undefined, lastArg ? Number(lastArg) : undefined) : metaFromScan(rows)));
