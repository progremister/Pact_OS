import fs from 'node:fs';
import { createRequire } from 'node:module';

// Use the istanbul libraries c8 itself depends on, so the versions always match
const requireFromC8 = createRequire(createRequire(import.meta.url).resolve('c8'));
const { Report } = requireFromC8('./index.js');
const libCoverage = requireFromC8('istanbul-lib-coverage');
const libReport = requireFromC8('istanbul-lib-report');
const reports = requireFromC8('istanbul-reports');

/**
 * jiti and vitest transpile the same .ts file differently, so their raw V8 ranges cannot be merged
 * (which is what a single `c8` run would do). Each runner's coverage is source-mapped on its own,
 * and the resulting istanbul maps are merged per original source location.
 */
export async function writeCoverageReport({ v8Dirs, reportsDir }) {
  const merged = libCoverage.createCoverageMap({});

  for (const tempDirectory of v8Dirs.filter((dir) => fs.existsSync(dir))) {
    const report = Report({
      tempDirectory,
      reporter: [],
      all: true,
      src: ['src'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts'],
      extension: ['.ts', '.tsx'],
      excludeNodeModules: true,
      resolve: '',
      omitRelative: true,
    });
    merged.merge(await report.getCoverageMapFromAllCoverageFiles());
  }

  const context = libReport.createContext({ dir: reportsDir, coverageMap: merged });
  for (const reporter of ['text', 'html', 'json-summary']) {
    reports.create(reporter, { skipEmpty: false, maxCols: process.stdout.columns || 100 }).execute(context);
  }
  console.log(`Coverage report written to ${reportsDir}/index.html`);
}
