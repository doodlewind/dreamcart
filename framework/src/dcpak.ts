// Isomorphic reader for the DreamCart .dcpak binary asset container (see
// docs/dcpak-format.md). The host loads the per-game pack and exposes its bytes
// as the global ArrayBuffer `__dcpak` BEFORE the game bundle is evaluated; the
// baked asset modules (assets-*.ts) then pull their typed-array blobs from it by
// key. This replaces the old base64 + unb64() path, which forced QuickJS to
// tokenize megabytes of string literals and base64-decode them at boot.
//
// Accessors return a typed array over a FRESH copy of the blob bytes, so
// `arr.buffer` is exactly that blob — matching the old `unb64('...').buffer`
// semantics that meshFromBaked relies on (it hands vertices.buffer straight to
// the host mesh uploader). The copy is one memcpy per blob, negligible next to
// the parse it replaces.

const MAGIC = 0x4b504344; // 'DCPK' little-endian

interface Entry {
  off: number; // blob offset from file start
  len: number; // blob byte length
  dtype: number;
}

let parsed = false;
let map: Map<string, Entry> | null = null;
let bytes: Uint8Array | null = null;

// ASCII-only keys (we control them); avoid TextDecoder, which QuickJS lacks.
function readKey(u8: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
  return s;
}

function ensureLoaded(): void {
  if (parsed) return;
  parsed = true;
  const ab = (globalThis as unknown as { __dcpak?: ArrayBuffer }).__dcpak;
  if (!ab) return; // no pack provided (asset-free game); throws only on access
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('dcpak: bad magic');
  const version = dv.getUint16(4, true);
  if (version !== 1) throw new Error('dcpak: unsupported version ' + version);
  const entryCount = dv.getUint32(8, true);
  const dirOff = dv.getUint32(12, true);
  const namesOff = dv.getUint32(16, true);
  const u8 = new Uint8Array(ab);
  const m = new Map<string, Entry>();
  for (let i = 0; i < entryCount; i++) {
    const e = dirOff + i * 24;
    const blobOff = dv.getUint32(e + 4, true);
    const byteLen = dv.getUint32(e + 8, true);
    const nameOff = dv.getUint32(e + 12, true);
    const nameLen = dv.getUint16(e + 16, true);
    const dtype = u8[e + 18];
    m.set(readKey(u8, namesOff + nameOff, nameLen), { off: blobOff, len: byteLen, dtype });
  }
  map = m;
  bytes = u8;
}

/** Raw bytes of a blob as a fresh Uint8Array (copy); throws if the key is absent. */
export function dcU8(key: string): Uint8Array {
  ensureLoaded();
  const e = map && map.get(key);
  if (!e) throw new Error('dcpak: missing key ' + key + ' (host did not provide __dcpak, or per-game pack is incomplete)');
  // .slice() copies into a fresh, offset-0, length-exact ArrayBuffer.
  return bytes!.slice(e.off, e.off + e.len);
}

/** Blob as Int8Array (e.g. joint parents). */
export function dcI8(key: string): Int8Array {
  return new Int8Array(dcU8(key).buffer);
}

/** Blob as Uint16Array (e.g. triangle index buffers). */
export function dcU16(key: string): Uint16Array {
  return new Uint16Array(dcU8(key).buffer);
}

/** Blob as Float32Array (e.g. matrices, bind pose, animation tracks). */
export function dcF32(key: string): Float32Array {
  return new Float32Array(dcU8(key).buffer);
}
