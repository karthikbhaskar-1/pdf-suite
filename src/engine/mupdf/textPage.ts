/**
 * Builds the pages of a text file (blueprint B3, layout in textLayout.ts). One `CourierFonts` per output document: the three
 * simple fonts (Latin, Greek, Cyrillic) are added to the document the first time a page needs them and are shared by every
 * text page, so a combined file holds each font once.
 */
import type * as Mu from 'mupdf';
import { TEXT_CHAR_WIDTH, TEXT_FONT_SIZE, TEXT_LINE_HEIGHT, TEXT_MARGIN, runsOf, type FontEncoding, type LaidOutText } from './textLayout';
import type { PageDims } from './jobProtocol';

type MuModule = typeof Mu;

const FONT_NAME: Record<FontEncoding, string> = { Latin: 'F1', Greek: 'F2', Cyrillic: 'F3' };

export class CourierFonts {
  private readonly courier: Mu.Font;
  private readonly refs = new Map<FontEncoding, Mu.PDFObject>();

  constructor(
    mu: MuModule,
    private readonly out: Mu.PDFDocument,
  ) {
    this.courier = new mu.Font('Courier');
  }

  ref(encoding: FontEncoding): Mu.PDFObject {
    let ref = this.refs.get(encoding);
    if (!ref) {
      ref = this.out.addSimpleFont(this.courier, encoding);
      this.refs.set(encoding, ref);
    }
    return ref;
  }

  destroy(): void {
    this.refs.clear();
    this.courier.destroy();
  }
}

const hex = (bytes: readonly number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
const round = (n: number) => String(Math.round(n * 100) / 100);

/** Adds the pages of `laid` after the last page of `out`. Returns how many were added. */
export function addTextPages(out: Mu.PDFDocument, fonts: CourierFonts, laid: LaidOutText, dims: PageDims): number {
  for (const lines of laid.pages) {
    const used = new Set<FontEncoding>();
    let content = '';
    lines.forEach((line, row) => {
      const y = dims.height - TEXT_MARGIN - TEXT_FONT_SIZE * 0.9 - row * TEXT_LINE_HEIGHT;
      for (const run of runsOf(line)) {
        used.add(run.encoding);
        content += `BT /${FONT_NAME[run.encoding]} ${TEXT_FONT_SIZE} Tf 1 0 0 1 ${round(TEXT_MARGIN + run.column * TEXT_CHAR_WIDTH)} ${round(y)} Tm <${hex(run.bytes)}> Tj ET\n`;
      }
    });
    const fontDict = out.newDictionary();
    for (const encoding of used) fontDict.put(FONT_NAME[encoding], fonts.ref(encoding));
    const resources = out.addObject(out.newDictionary());
    resources.put('Font', fontDict);
    out.insertPage(-1, out.addPage([0, 0, dims.width, dims.height], 0, resources, content));
  }
  return laid.pages.length;
}
