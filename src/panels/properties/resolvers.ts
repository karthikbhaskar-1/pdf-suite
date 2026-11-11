import type { PageRef } from '../../core/model/types';
import type { DocInfo } from '../../core/stores/documentsStore';
import type { DocumentMetadata, PageSize } from '../../engine/types';

/** What the Properties panel is describing. */
export type SelectionType = 'document' | 'page';

export interface PropertyRow {
  label: string;
  value: string;
}

/** Everything a resolver may read. Metadata is loaded before the rows are built. */
export interface PropertyContext {
  doc: DocInfo;
  pageIndex: number;
  page: PageRef | undefined;
  size: PageSize | undefined;
  metadata: DocumentMetadata | undefined;
  /** From the open document, so it is known even before metadata loads. */
  encrypted: boolean | undefined;
  /** Desktop only: where the file lives and what the disk says about it. */
  file?: { path?: string; size?: number; modified?: number };
  /** True when the page described is a picked page that is not the current page (see pageHeading). */
  pickedElsewhere?: boolean;
  /** True when the page described is the one the user picked last (not just the current page). */
  pickedPage?: boolean;
  /** How many pages of this document are selected. */
  selectedCount?: number;
}

/** One section of the Properties panel, shown for one selection type. */
export interface PropertyResolver {
  id: string;
  type: SelectionType;
  title: string;
  /** The heading when it depends on what is described; `title` otherwise. */
  heading?: (ctx: PropertyContext) => string;
  /** One line under the heading, or nothing. */
  note?: (ctx: PropertyContext) => string | undefined;
  rows: (ctx: PropertyContext) => PropertyRow[];
}

/** Resolvers keyed by selection type. A new kind of selection adds resolvers here, not panel code. */
export class PropertyResolverRegistry {
  private readonly resolvers: PropertyResolver[] = [];

  register(resolver: PropertyResolver): void {
    if (this.resolvers.some((r) => r.id === resolver.id)) throw new Error(`Property resolver already registered: ${resolver.id}`);
    this.resolvers.push(resolver);
  }

  forType(type: SelectionType): PropertyResolver[] {
    return this.resolvers.filter((r) => r.type === type);
  }
}

export const propertyResolvers = new PropertyResolverRegistry();

const PT_PER_INCH = 72;
const PT_PER_MM = PT_PER_INCH / 25.4;

const round = (value: number, digits = 1) => Number(value.toFixed(digits)).toString();

/** "612 × 792 pt (8.5 × 11 in, 215.9 × 279.4 mm)". */
export function formatPageSize(width: number, height: number): string {
  return `${round(width)} × ${round(height)} pt (${round(width / PT_PER_INCH, 2)} × ${round(height / PT_PER_INCH, 2)} in, ${round(width / PT_PER_MM)} × ${round(height / PT_PER_MM)} mm)`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'Unknown';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)} KB`;
  return `${round(bytes / (1024 * 1024))} MB`;
}

const dash = (value: string | undefined) => (value && value.length > 0 ? value : '—');

export const documentResolver: PropertyResolver = {
  id: 'document',
  type: 'document',
  title: 'Document',
  rows: ({ doc, metadata, encrypted, file }) => [
    ...(file?.path ? [{ label: 'Location', value: file.path }] : []),
    { label: 'Title', value: dash(metadata?.title) },
    { label: 'Author', value: dash(metadata?.author) },
    { label: 'Subject', value: dash(metadata?.subject) },
    { label: 'Keywords', value: dash(metadata?.keywords) },
    { label: 'Creator', value: dash(metadata?.creator) },
    { label: 'Producer', value: dash(metadata?.producer) },
    { label: 'Created', value: dash(metadata?.created) },
    { label: 'Modified', value: dash(metadata?.modified) },
    { label: 'PDF version', value: dash(metadata?.pdfVersion) },
    { label: 'Pages', value: String(doc.pageCount) },
    { label: 'File size', value: formatBytes(file?.size ?? doc.byteSize) },
    ...(file?.modified !== undefined ? [{ label: 'File modified', value: new Date(file.modified).toLocaleString() }] : []),
    { label: 'Password-protected', value: encrypted === undefined ? '—' : encrypted ? 'Yes' : 'No' },
  ],
};

/** "Current page" for the page in the page box; "Selected page" for a picked page that is not the current page. */
export function pageHeading(ctx: Pick<PropertyContext, 'pickedElsewhere'>): string {
  return ctx.pickedElsewhere ? 'Selected page' : 'Current page';
}

export const currentPageResolver: PropertyResolver = {
  id: 'page',
  type: 'page',
  title: 'Current page',
  heading: pageHeading,
  note: ({ pickedPage, selectedCount }) =>
    pickedPage && selectedCount !== undefined && selectedCount >= 2 ? `${selectedCount} pages are selected. This is the one you clicked last.` : undefined,
  rows: ({ pageIndex, page, size }) => {
    const turn = (page?.rotation ?? 0) + (size?.rotation ?? 0);
    return [
      { label: 'Number', value: pageIndex >= 0 ? `${pageIndex + 1}` : '—' },
      { label: 'Size', value: size ? formatPageSize(size.width, size.height) : 'Measuring…' },
      { label: 'Rotation', value: `${((turn % 360) + 360) % 360}°` },
    ];
  },
};

propertyResolvers.register(documentResolver);
propertyResolvers.register(currentPageResolver);
