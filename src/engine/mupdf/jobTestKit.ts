/**
 * Helpers for the job tests: build small PDFs with known text, outline, links and notes, and run a job through a JobSession
 * the way the page does (auto-acknowledging every chunk). Not part of the app.
 */
import * as mu from 'mupdf';
import { JobSession, type SessionOptions } from './jobCore';
import type { CombineSpec, FromJob, SplitSpec, ToJob } from './jobProtocol';

export interface DocSpec {
  pages: number;
  /** Text printed on page n (1-based). Default "Page n". */
  text?: (page: number) => string;
  /** Page size. Default 300 x 400. */
  size?: [number, number];
  /** Flat or nested bookmarks: title, 1-based page, children. */
  outline?: OutlineSpec[];
  /** Web links [page, url] and internal links [page, targetPage]. */
  links?: Array<{ page: number; url?: string; toPage?: number }>;
  /** A Text note and a Highlight on these pages. */
  notes?: number[];
  info?: { Title?: string; Author?: string; Subject?: string; Keywords?: string };
}

export interface OutlineSpec {
  title: string;
  page: number;
  children?: OutlineSpec[];
}

export function makeDoc(spec: DocSpec): Uint8Array {
  const pdf = new mu.PDFDocument();
  const font = pdf.addSimpleFont(new mu.Font('Helvetica'));
  const [w, h] = spec.size ?? [300, 400];
  const fonts = pdf.newDictionary();
  fonts.put('F1', font);
  const resources = pdf.addObject(pdf.newDictionary());
  resources.put('Font', fonts);
  for (let n = 1; n <= spec.pages; n++) {
    const text = spec.text ? spec.text(n) : `Page ${n}`;
    pdf.insertPage(-1, pdf.addPage([0, 0, w, h], 0, resources, `BT /F1 18 Tf 30 ${h - 60} Td (${text}) Tj ET`));
  }
  for (const link of spec.links ?? []) {
    const page = pdf.loadPage(link.page - 1);
    page.createLink([20, 20, 120, 50], link.url ?? `#page=${link.toPage}`);
    page.update();
  }
  for (const n of spec.notes ?? []) {
    const page = pdf.loadPage(n - 1);
    const note = page.createAnnotation('Text');
    note.setRect([200, 200, 220, 220]);
    note.setContents(`note on ${n}`);
    const hl = page.createAnnotation('Highlight');
    hl.setQuadPoints([[30, h - 60, 130, h - 60, 30, h - 40, 130, h - 40]]);
    page.update();
  }
  if (spec.outline) {
    writeOutline(pdf, spec.outline);
  }
  for (const [key, value] of Object.entries(spec.info ?? {})) pdf.setMetaData(`info:${key}`, value);
  return pdf.saveToBuffer('garbage=compact').asUint8Array().slice();
}

/** Writes an outline with the same object layout as outlineCarry.ts but straight from a spec (test input, not the code under test). */
function writeOutline(pdf: mu.PDFDocument, items: OutlineSpec[]): void {
  const outlines = pdf.createObject();
  const level = (list: OutlineSpec[], parent: mu.PDFObject): { first: mu.PDFObject; last: mu.PDFObject; total: number } => {
    const refs = list.map(() => pdf.createObject());
    let total = 0;
    list.forEach((item, i) => {
      const dict = pdf.newDictionary();
      dict.put('Title', pdf.newString(item.title));
      dict.put('Parent', parent);
      if (i > 0) dict.put('Prev', refs[i - 1]!);
      if (i < list.length - 1) dict.put('Next', refs[i + 1]!);
      const dest = pdf.newArray();
      dest.push(pdf.findPage(item.page - 1));
      dest.push(pdf.newName('Fit'));
      dict.put('Dest', dest);
      let below = 0;
      if (item.children && item.children.length > 0) {
        const inner = level(item.children, refs[i]!);
        dict.put('First', inner.first);
        dict.put('Last', inner.last);
        dict.put('Count', inner.total);
        below = inner.total;
      }
      refs[i]!.writeObject(dict);
      total += 1 + below;
    });
    return { first: refs[0]!, last: refs[refs.length - 1]!, total };
  };
  const top = level(items, outlines);
  const dict = pdf.newDictionary();
  dict.put('Type', pdf.newName('Outlines'));
  dict.put('First', top.first);
  dict.put('Last', top.last);
  dict.put('Count', top.total);
  outlines.writeObject(dict);
  pdf.getTrailer().get('Root').put('Outlines', outlines);
}

export interface RunOutput {
  /** Messages in the order they were posted. */
  messages: FromJob[];
  files: Array<{ leafName: string; bytes: Uint8Array; pages: number }>;
  done?: Extract<FromJob, { t: 'done' }>;
  error?: Extract<FromJob, { t: 'error' }>;
  probed?: Extract<FromJob, { t: 'probed' }>;
}

export class JobHarness {
  readonly messages: FromJob[] = [];
  readonly session: JobSession;
  private readonly open = new Map<number, Uint8Array[]>();

  /** Combine: the bytes the page would hand over for each `need`, by item index. */
  inputs: Uint8Array[] = [];

  constructor(options: SessionOptions & { autoAck?: boolean } = {}) {
    this.session = new JobSession(
      mu,
      (message) => {
        this.messages.push(message);
        if (message.t === 'need') {
          const bytes = this.inputs[message.index];
          queueMicrotask(() => {
            if (bytes) this.session.handle({ t: 'input', id: message.id, index: message.index, bytes: bytes.slice().buffer as ArrayBuffer });
          });
        }
        if (message.t === 'chunk' && options.autoAck !== false) {
          // The page acknowledges after it has handed the chunk to main.
          queueMicrotask(() => this.session.handle({ t: 'ack', id: message.id, file: message.file, seq: message.seq }));
        }
      },
      options,
    );
  }

  send(message: ToJob): void {
    this.session.handle(message);
  }

  async probe(bytes: Uint8Array, password?: string, id = 1): Promise<RunOutput> {
    const copy = bytes.slice().buffer as ArrayBuffer;
    this.send({ t: 'probe', id, kind: 'pdf', bytes: copy, ...(password !== undefined ? { password } : {}) });
    await this.session.idle();
    return this.output();
  }

  async split(spec: SplitSpec, id = 2): Promise<RunOutput> {
    this.send({ t: 'start', id, spec });
    await this.session.idle();
    return this.output();
  }

  /** Runs a combine; `inputs` are the files in list order. */
  async combine(spec: CombineSpec, inputs: Uint8Array[], id = 3): Promise<RunOutput> {
    this.inputs = inputs;
    this.send({ t: 'start', id, spec });
    await this.session.idle();
    return this.output();
  }

  /** Probes any kind of input. */
  async probeKind(kind: 'pdf' | 'image' | 'text', bytes: Uint8Array, extra: Partial<Extract<ToJob, { t: 'probe' }>> = {}, id = 1): Promise<RunOutput> {
    this.send({ t: 'probe', id, kind, bytes: bytes.slice().buffer as ArrayBuffer, ...extra } as ToJob);
    await this.session.idle();
    return this.output();
  }

  /** Everything posted so far, with the files put together from their chunks. */
  output(): RunOutput {
    const files: RunOutput['files'] = [];
    this.open.clear();
    const names = new Map<number, string>();
    for (const message of this.messages) {
      if (message.t === 'file') {
        names.set(message.file, message.leafName);
        this.open.set(message.file, []);
      } else if (message.t === 'chunk') {
        this.open.get(message.file)?.push(new Uint8Array(message.bytes));
      } else if (message.t === 'fileEnd') {
        const parts = this.open.get(message.file) ?? [];
        const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        files.push({ leafName: names.get(message.file)!, bytes, pages: message.pages });
        if (bytes.length !== message.byteLength) throw new Error('fileEnd length does not match the chunks');
      }
    }
    const out: RunOutput = { messages: this.messages, files };
    for (const message of this.messages) {
      if (message.t === 'done') out.done = message;
      if (message.t === 'error') out.error = message;
      if (message.t === 'probed') out.probed = message;
    }
    return out;
  }
}
