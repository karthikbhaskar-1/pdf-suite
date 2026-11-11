// @vitest-environment node
// Import boundary (ruling 9): only these files outside src/engine/ may import engine/mupdf.
// A new importer must be added here deliberately, so the coupling stays a decision and not an accident.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ALLOWED = [
  'src/app/blockedKeys.test.ts',
  // 1.3.4 Compare (orchestrator-approved): each needs engine types or the MuPDF document class, nothing else.
  'src/app/compareCommands.test.ts', // stands in for MupdfDocument (the commands check `instanceof`)
  'src/app/organizerCommands.ts',
  'src/app/services.ts',
  'src/core/model/types.ts',
  'src/core/stores/editStore.ts',
  'src/features/compare/compareSession.test.ts', // PageEdit type of the edit the session sends
  'src/features/compare/compareSession.ts', // MupdfDocument (attachSource, detachSource, sourceSize) and PageEdit
  'src/features/documents/documentService.ts',
  'src/features/documents/editOps.ts',
  'src/features/documents/editOpsAbort.test.ts',
  'src/features/documents/editOpsProtected.test.ts',
  'src/features/documents/recoverySequences.test.ts',
  'src/features/documents/saveAs.test.ts',
  'src/features/documents/saveDiskCheck.test.ts',
  'src/features/documents/saveDocument.ts',
  'src/features/documents/saveGuards.test.ts',
  'src/features/documents/saveVerify.test.ts',
  'src/features/documents/tabResidency.real.test.ts',
  'src/features/organizer/actions.ts',
  'src/features/organizer/cutMath.ts',
  'src/features/organizer/insertLimit.test.ts',
  'src/features/organizer/sheetActions.test.ts',
  'src/features/organizer/sheetActions.ts',
  'src/features/organizer/sizeCancel.test.ts',
  'src/features/recovery/editLog.test.ts',
  'src/features/recovery/editLog.ts',
  'src/features/search/searchRunner.ts',
  'src/features/split/splitRelease.real.test.ts',
  // 1.3.2 job runner and Split (orchestrator approved 2026-11-10): they use the job worker's message types in
  // engine/mupdf/jobProtocol.ts. Moving those types to src/engine/ is a 1.5 tidy-up.
  'src/app/jobCommands.ts',
  'src/core/stores/jobStore.ts',
  'src/core/stores/splitStore.ts',
  'src/features/jobs/jobMessages.ts',
  'src/features/jobs/jobRunner.test.ts',
  'src/features/jobs/jobRunner.ts',
  'src/features/jobs/splitFlow.test.ts',
  'src/features/jobs/splitFlow.ts',
  'src/features/jobs/splitPlan.ts',
  'src/features/jobs/splitSheetModel.ts',
  'src/ui/jobs/SplitSheet.tsx',
  // 1.3.3 Combine (orchestrator approved 2026-11-11): same reason, the job worker's message types.
  'src/features/jobs/combineFlow.test.ts',
  'src/features/jobs/combinePlan.ts',
  // 1.5.10 file-size limits: the two limits are defined once, in the import-free leaf engine/mupdf/fileLimitBytes.ts (the job worker
  // may reach only that leaf, not the contract); contract.ts re-exports them for the main process and the page.
  'src/platform/desktop/contract.ts',
  'src/app/viewOnlyCommands.test.ts', // stands in for MupdfDocument (the commands check `instanceof`), like compareCommands.test.ts
  'src/core/fileLimits.test.ts', // checks that a job input uses the same constant (MAX_TOTAL_INPUT_BYTES of jobProtocol)
];

const root = process.cwd();
function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'corpus') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('engine/mupdf import boundary', () => {
  it('is imported only by the listed files outside src/engine', () => {
    const files = [...walk(join(root, 'src'), []), ...walk(join(root, 'electron'), [])];
    const importers = files
      .map((f) => relative(root, f).split(sep).join('/'))
      .filter((f) => !f.startsWith('src/engine/'))
      .filter((f) => /engine\/mupdf\b/.test(readFileSync(join(root, f), 'utf8')))
      .filter((f) => f !== 'src/engine/mupdf/importBoundary.test.ts')
      .sort();
    expect(importers).toEqual([...ALLOWED].sort());
  });
});
