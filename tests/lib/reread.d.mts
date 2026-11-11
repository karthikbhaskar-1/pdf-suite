export interface RereadResult {
  pages: number;
  sizes: Array<{ width: number; height: number; rotate: number }>;
  text: string[];
  outline: Array<{ title: string; depth: number; page: number | null }>;
  annotations: Array<{ page: number; subtype: string; url?: string }>;
}
export function reread(bytes: Uint8Array, options?: { password?: string }): Promise<RereadResult>;
