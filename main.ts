// Token Radar's entry point. It takes a sealed snapshot, scores it, and lays out the
// ranked board, the dashboard's data, the dashboard itself, the screenshots and the
// dossier the judge reads — all under one output directory.
//
// Run it outside the grader's container with MAKEFUN_OUTPUT_DIR standing in for
// /output, and --input pointing at the snapshot:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
//
// The program uses only the Node standard library, plus the vendored make.fun dossier
// builder for the last file it writes.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path'; // build file paths
import { fileURLToPath } from 'node:url'; // turn this file's URL into a path
import { buildDashboardData, checkBoard, dashboardScript, readSnapshot } from './lib/model.ts';
import {
  buildDossier,
} from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('./', import.meta.url));

// The caps the scorer enforces on the dossier: the text budget shapes the bytes, the
// screenshot caps refuse anything past them.
const TEXT_BUDGET = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// --name <value> out of the arguments, or the fallback when the flag is absent.
function flag(name: string, fallback: string): string {
  const marker = `--${name}`;
  const at = process.argv.indexOf(marker);
  const hasValue = at >= 0 && at + 1 < process.argv.length;
  if (hasValue) return process.argv[at + 1]!; // the value right after the flag
  const joined = process.argv.find((a) => a.startsWith(`${marker}=`));
  if (joined === undefined) return fallback;
  return joined.slice(marker.length + 1);
}

const inputPath = flag('input', '/input');
const snapshotFile = inputPath.endsWith('.json') ? inputPath : join(inputPath, 'snapshot.json');
if (!existsSync(snapshotFile)) {
  process.stderr.write(
    `token radar: no snapshot at ${snapshotFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
  );
  process.exit(2); // nothing to score without a snapshot
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = readSnapshot(readFileSync(snapshotFile, 'utf8'));
const { board, radar } = buildDashboardData(snap);
const problem = checkBoard(board, snap);
if (problem !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${problem}\n`);
  process.exit(1); // a board the gate refuses is not worth writing out
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dashboardScript(radar));

// Copy one directory's regular files into `to`, skipping names that start with a dot,
// and report the names that landed.
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return []; // nothing to copy when the source is missing
  mkdirSync(to, { recursive: true }); // the destination may not exist yet
  const landed: string[] = [];
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue; // hidden files stay behind
    const source = join(from, entry);
    if (!statSync(source).isFile()) continue; // directories are not copied
    copyFileSync(source, join(to, entry));
    landed.push(entry);
  }
  return landed;
}

copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
const images = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (images.length < 3) {
  const plural = images.length === 1 ? '' : 's';
  process.stderr.write(
    `token radar: screenshots/ holds ${images.length} image${plural}: hand in 3, the board, a detail view and a filtered view\n`,
  );
  process.exit(1); // fewer than three screenshots fails the gate
}
for (const name of images) {
  if (!SHOT_NAME.test(name)) {
    process.stderr.write(
      `token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`,
    );
    process.exit(1); // a bad screenshot name fails the gate
  }
}

// The dossier goes last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: TEXT_BUDGET,
    screenshots: SHOT_LIMIT,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const report =
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
  `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${images.length} images) and ${join(outDir, 'dossier.json')}\n`;
process.stdout.write(report);
