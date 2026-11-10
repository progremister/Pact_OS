/**
 * Prints a text summary of a V8 `.cpuprofile` (produced by `node --cpu-prof`).
 * Shows the hottest functions by self time and by total (inclusive) time.
 *
 * Usage: node scratch/summarize-cpuprofile.mjs <file.cpuprofile> [topN]
 */
import fs from 'node:fs';
import path from 'node:path';

const [file, topArg] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scratch/summarize-cpuprofile.mjs <file.cpuprofile> [topN]');
  process.exit(1);
}
const topN = Number(topArg ?? 12);
const profile = JSON.parse(fs.readFileSync(file, 'utf8'));

const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

const label = (node) => {
  const { functionName, url, lineNumber } = node.callFrame;
  const name = functionName || '(anonymous)';
  if (!url) return name;
  const clean = url.replace(/^file:\/\//, '');
  const rel = clean.includes('/src/') ? clean.slice(clean.indexOf('/src/') + 1)
    : clean.includes('/scratch/') ? clean.slice(clean.indexOf('/scratch/') + 1)
    : path.basename(clean);
  return `${name}  ${rel}:${lineNumber + 1}`;
};

const self = new Map();
const total = new Map();
let totalTime = 0;

profile.samples.forEach((nodeId, i) => {
  const dt = (profile.timeDeltas[i] ?? 0) / 1000; // µs -> ms
  if (dt <= 0) return;
  totalTime += dt;
  const leaf = nodes.get(nodeId);
  const leafKey = label(leaf);
  self.set(leafKey, (self.get(leafKey) ?? 0) + dt);

  const seen = new Set();
  for (let id = nodeId; id !== undefined; id = parent.get(id)) {
    const key = label(nodes.get(id));
    if (seen.has(key)) continue;
    seen.add(key);
    total.set(key, (total.get(key) ?? 0) + dt);
  }
});

const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const print = (title, map, filter = () => true) => {
  console.log(`\n${title}`);
  console.log(`${pad('ms', 10)}${pad('%', 8)}function`);
  [...map.entries()]
    .filter(([key]) => filter(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .forEach(([key, ms]) => {
      console.log(`${pad(ms.toFixed(1), 10)}${pad(((ms / totalTime) * 100).toFixed(1) + '%', 8)}${key}`);
    });
};

console.log(`Profile: ${path.basename(file)}  |  sampled time: ${totalTime.toFixed(1)} ms  |  samples: ${profile.samples.length}`);
print('Top functions by SELF time', self);
print('Top project functions by TOTAL (inclusive) time', total, (key) => key.includes('src/'));
