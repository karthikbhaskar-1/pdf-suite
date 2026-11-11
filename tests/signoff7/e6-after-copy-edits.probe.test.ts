// Sign-Off 1.3.1 re-check, probe E6: edits that DELETE the CropBox (Remove crop, Page size) on a page that sits under a /Pages
// node carrying /CropBox: (a) an original page of that node (as in 1.2.1), (b) the second half of a cut that landed there.
import { it } from 'vitest';
import { buildTree, openCore, reopen, uids } from './e-lib';

const leaf = (name: string) => ({ name });
const TREE = { attrs: { MediaBox: [0, 0, 800, 500], font: 'Helvetica' }, kids: [leaf('wa'), leaf('wb'), { attrs: { CropBox: [100, 50, 700, 450] }, kids: [leaf('cc')] }] };
const sizes = (bytes: ArrayBuffer) => {
  const doc = reopen(bytes);
  return Array.from({ length: doc.countPages() }, (_, i) => {
    const b = doc.loadPage(i).getBounds();
    return `${Math.round(b[2] - b[0])}x${Math.round(b[3] - b[1])}`;
  }).join(' ');
};
it('E6', async () => {
  const { bytes } = buildTree(TREE);
  const a = openCore(bytes);
  await a.applyEdits([{ op: 'resize', uids: [uids(a)[2]!], size: { width: 300, height: 300 }, fit: 'scale' }]);
  console.log('E6a original page of the CropBox node, Page size 300x300 ->', sizes(a.save(false, false).bytes), '(want 800x500 800x500 300x300)');
  const b = openCore(bytes);
  await b.applyEdits([{ op: 'slice', uids: [uids(b)[1]!], cut: 'vertical', at: 0.5, first: 'left' }]);
  await b.applyEdits([{ op: 'resize', uids: [uids(b)[2]!], size: { width: 300, height: 300 }, fit: 'scale' }]);
  console.log('E6b cut page 2, then Page size 300x300 on its second half ->', sizes(b.save(false, false).bytes), '(want 800x500 400x500 300x300 600x400)');
  const c = openCore(bytes);
  await c.applyEdits([{ op: 'slice', uids: [uids(c)[1]!], cut: 'vertical', at: 0.5, first: 'left' }]);
  await c.applyEdits([{ op: 'crop', uids: [uids(c)[2]!], box: null }]);
  console.log('E6c cut page 2, then Remove crop on its second half ->', sizes(c.save(false, false).bytes), '(want 800x500 400x500 800x500 600x400)');
  const d = openCore(bytes);
  await d.applyEdits([{ op: 'slice', uids: [uids(d)[1]!], cut: 'vertical', at: 0.5, first: 'left' }]);
  await d.applyEdits([{ op: 'rotate', uids: [uids(d)[2]!], degrees: 90 }]);
  await d.applyEdits([{ op: 'slice', uids: [uids(d)[2]!], cut: 'horizontal', at: 0.5, first: 'left' }]);
  console.log('E6d cut page 2, turn its second half, cut that again ->', sizes(d.save(false, false).bytes), '(want 800x500 400x500 500x200 500x200 600x400)');
});
