// Build-side writer/reader for the DreamCart .dcpak binary asset container (see
// docs/dcpak-format.md). Runs on Bun/Node. Shared by:
//   - bake-gltf.ts        -> packs every baked asset blob into the master store
//                            framework/src/assets.dcstore
//   - framework/build.ts  -> subsets the store into a per-game <name>.dcpak by the
//                            keys present in the bundled game JS.
// Keep byte-for-byte in sync with the runtime reader framework/src/dcpak.ts.

const MAGIC = 0x4b504344; // 'DCPK' little-endian
const VERSION = 1;
const HEADER_SIZE = 32;
const ENTRY_SIZE = 24;

// dtype codes (see docs/dcpak-format.md).
export const DT_U8 = 0;
export const DT_I8 = 1;
export const DT_U16 = 2;
export const DT_I16 = 3;
export const DT_U32 = 4;
export const DT_I32 = 5;
export const DT_F32 = 6;
export const DT_F64 = 7;

export interface Blob {
  key: string;
  dtype: number;
  data: Uint8Array; // raw little-endian bytes
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const align16 = (n: number): number => (n + 15) & ~15;

/** Pack blobs into a .dcpak byte buffer. Entries are sorted by key. */
export function pack(blobsIn: Blob[]): Uint8Array {
  const blobs = [...blobsIn].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  for (const b of blobs) {
    if (seen.has(b.key)) throw new Error('dcpak: duplicate key ' + b.key);
    seen.add(b.key);
  }

  const enc = new TextEncoder();
  const names = blobs.map((b) => enc.encode(b.key));

  const dirOffset = HEADER_SIZE;
  const namesOffset = dirOffset + blobs.length * ENTRY_SIZE;
  let nameCursor = 0;
  const nameOffsets = names.map((n) => {
    const o = nameCursor;
    nameCursor += n.length;
    return o;
  });
  const namesSize = nameCursor;
  const blobsOffset = align16(namesOffset + namesSize);

  // place blobs, each 16-aligned
  let blobCursor = blobsOffset;
  const blobOffsets = blobs.map((b) => {
    const o = blobCursor;
    blobCursor += align16(b.data.length);
    return o;
  });
  // blobCursor >= blobsOffset >= HEADER_SIZE always (align16 is non-decreasing);
  // for an empty pack it equals blobsOffset (header + empty dir + empty names).
  const out = new Uint8Array(blobCursor);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, MAGIC, true);
  dv.setUint16(4, VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, blobs.length, true);
  dv.setUint32(12, dirOffset, true);
  dv.setUint32(16, namesOffset, true);
  dv.setUint32(20, blobsOffset, true);
  dv.setUint32(24, out.length, true);
  dv.setUint32(28, 0, true);

  for (let i = 0; i < blobs.length; i++) {
    const e = dirOffset + i * ENTRY_SIZE;
    dv.setUint32(e + 0, fnv1a(blobs[i].key), true);
    dv.setUint32(e + 4, blobOffsets[i], true);
    dv.setUint32(e + 8, blobs[i].data.length, true);
    dv.setUint32(e + 12, nameOffsets[i], true);
    dv.setUint16(e + 16, names[i].length, true);
    out[e + 18] = blobs[i].dtype & 0xff;
    out[e + 19] = 0;
    dv.setUint32(e + 20, 0, true);
    out.set(names[i], namesOffset + nameOffsets[i]);
    out.set(blobs[i].data, blobOffsets[i]);
  }
  return out;
}

/** Parse a .dcpak byte buffer back into its blob list (round-trips pack()). */
export function unpack(file: Uint8Array): Blob[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('dcpak: bad magic');
  if (dv.getUint16(4, true) !== VERSION) throw new Error('dcpak: unsupported version');
  const entryCount = dv.getUint32(8, true);
  const dirOff = dv.getUint32(12, true);
  const namesOff = dv.getUint32(16, true);
  const dec = new TextDecoder();
  const blobs: Blob[] = [];
  for (let i = 0; i < entryCount; i++) {
    const e = dirOff + i * ENTRY_SIZE;
    const blobOff = dv.getUint32(e + 4, true);
    const byteLen = dv.getUint32(e + 8, true);
    const nameOff = dv.getUint32(e + 12, true);
    const nameLen = dv.getUint16(e + 16, true);
    const dtype = file[e + 18];
    const key = dec.decode(file.subarray(namesOff + nameOff, namesOff + nameOff + nameLen));
    blobs.push({ key, dtype, data: file.slice(blobOff, blobOff + byteLen) });
  }
  return blobs;
}

/** Pack only the blobs whose key occurs in `present` (per-game subsetting). */
export function subset(blobs: Blob[], present: (key: string) => boolean): Uint8Array {
  return pack(blobs.filter((b) => present(b.key)));
}

/** Raw little-endian bytes of a typed array (for building Blob.data). */
export function rawBytes(arr: ArrayBufferView): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
