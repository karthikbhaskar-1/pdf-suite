/**
 * The bytes of a Buffer as an ArrayBuffer of exactly that length. When the Buffer spans its whole ArrayBuffer (a file read of any size
 * the Node pool does not serve, which is every PDF) the underlying buffer is handed over as it is: no second copy of a file that may be
 * hundreds of megabytes. Only a Buffer that is a slice of a larger one (a small read from the shared pool) is copied.
 */
export function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = data.buffer;
  if (buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === buffer.byteLength) return buffer;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
