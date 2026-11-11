// Sign-Off 1.3.1, probe E5: (a) cut in an encrypted file keeps the encryption and the halves; (b) annotations on a
// /UserUnit 2, /Rotate 90 page go to the half that shows them, and /P follows.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTree, halvesProblem, mu, MupdfCore, reopen, shots, uids, openCore } from './e-lib';

const LOCKED = new URL('../fixtures/out/locked.pdf', import.meta.url);
const PASSWORD = readFileSync(new URL('../fixtures/make-fixtures.mjs', import.meta.url), 'utf8').match(/LOCK_PASSWORD = '([^']+)'/)![1]!;

describe('E5a encrypted file', () => {
  for (const mode of ['incremental', 'full'] as const) {
    it(`cut, ${mode} save: still asks for the password, and the two halves add up`, async () => {
      const bytes = new Uint8Array(readFileSync(LOCKED));
      const plain = mu.Document.openDocument(bytes.slice(), 'application/pdf');
      expect(plain.needsPassword()).toBe(true);
      expect(plain.authenticatePassword(PASSWORD)).toBeGreaterThan(0);
      const base = shots(plain);
      const core = new MupdfCore(mu as never, {});
      core.open(bytes.slice(), PASSWORD);
      await core.applyEdits([{ op: 'slice', uids: [uids(core)[0]!], cut: 'horizontal', at: 0.5, first: 'left' }]);
      const saved = mode === 'incremental' ? core.save(true, true) : core.save(false, false);
      expect(saved.mode).toBe(mode);
      const doc = reopen(saved.bytes);
      expect(doc.needsPassword()).toBe(true);
      expect(doc.authenticatePassword('wrong-one')).toBe(0);
      expect(doc.authenticatePassword(PASSWORD)).toBeGreaterThan(0);
      const now = shots(doc);
      expect(now.length).toBe(base.length + 1);
      expect(halvesProblem(base[0]!, now[0]!, now[1]!, 'horizontal', 0.5, 'left')).toBe('');
    });
  }
});

describe('E5b annotations on a UserUnit 2, Rotate 90 page', () => {
  it('each comment goes to the half that shows it; /P points at its page; nothing is lost or doubled', async () => {
    const { pdf, pages } = buildTree({ attrs: { MediaBox: [0, 0, 400, 200], font: 'Helvetica', Rotate: 90, CropBox: [0, 0, 400, 200] }, kids: [{ name: 'uu', attrs: { UserUnit: 2 } }, { name: 'zz' }] });
    const note = (x: number, name: string) => {
      const a = pdf.newDictionary();
      a.put('Type', pdf.newName('Annot'));
      a.put('Subtype', pdf.newName('Text'));
      const r = pdf.newArray();
      for (const n of [x - 10, 90, x + 10, 110]) r.push(pdf.newReal(n));
      a.put('Rect', r);
      a.put('Contents', pdf.newString(name));
      a.put('P', pages[0]!);
      return pdf.addObject(a);
    };
    const list = pdf.newArray();
    list.push(note(50, 'near-user-left'));
    list.push(note(350, 'near-user-right'));
    pages[0]!.resolve().put('Annots', list);
    const bytes = pdf.saveToBuffer('').asUint8Array().slice();
    const core = openCore(bytes);
    // Display is 400 x 800 (user x runs down the screen): user-left is the top half, user-right the bottom half.
    await core.applyEdits([{ op: 'slice', uids: [uids(core)[0]!], cut: 'horizontal', at: 0.5, first: 'left' }]);
    const out = reopen(core.save(false, false).bytes).asPDF()!;
    expect(out.countPages()).toBe(3);
    const names = (i: number) => {
      const page = out.findPage(i);
      const annots = page.get('Annots');
      const found: string[] = [];
      if (annots.isArray()) {
        for (let k = 0; k < annots.length; k++) {
          const a = annots.get(k);
          found.push(`${a.get('Contents').asString()}${a.get('P').asIndirect() === page.asIndirect() ? '' : ' (WRONG /P)'}`);
        }
      }
      return found;
    };
    expect(names(0)).toEqual(['near-user-left']);
    expect(names(1)).toEqual(['near-user-right']);
    // Each note's rectangle lies inside the CropBox of the page it is on.
    for (const i of [0, 1]) {
      const page = out.findPage(i);
      const crop = [0, 1, 2, 3].map((k) => page.get('CropBox').get(k).asNumber());
      const rect = [0, 1, 2, 3].map((k) => page.get('Annots').get(0).get('Rect').get(k).asNumber());
      expect(rect[0]! >= crop[0]! && rect[2]! <= crop[2]! && rect[1]! >= crop[1]! && rect[3]! <= crop[3]!).toBe(true);
    }
  });
});
