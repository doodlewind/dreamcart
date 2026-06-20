# DreamCart `.dcpak` asset container

`.dcpak` (DreamCart PAcK) is a small, flat binary container for the baked binary
asset blobs (mesh vertex/index buffers, skinning matrices, animation tracks,
texture pixels) that the framework's `assets-*.ts` modules used to carry as
base64 string literals.

## Why it exists

Before `.dcpak`, every baked asset shipped as a base64 string inside the bundled
game JS (e.g. `new Float32Array(unb64('AACA...').buffer)`). The PSP host embeds
that JS into the EBOOT and evaluates it with QuickJS at boot. That forced QuickJS
to (1) **tokenize megabytes of string literals** (a 1.28 MB source for the
soldier model alone) and (2) **base64-decode** them at startup — the dominant
cost of loading an asset-heavy game.

`.dcpak` moves those bytes out of the JS source into one binary blob per game.
The JS bundle keeps only the small structural skeleton (scalars, joint tables,
clip metadata) plus string *keys*; the binary blobs are read straight from the
pack as typed arrays. No base64, no megabyte source parse.

The pack is the single canonical artifact. Each host transports it differently
(see "Delivery") but the binary format is identical everywhere.

## Layout

Little-endian throughout. PSP, ARM/x86 build hosts and browsers are all LE, so
typed-array views map directly with no byte swapping.

```
+----------------------------------+  offset 0
| Header (32 bytes)                |
+----------------------------------+  dirOffset
| Directory: entryCount x 24 bytes |
+----------------------------------+  namesOffset
| Name table (UTF-8/ASCII keys)    |
+----------------------------------+  blobsOffset (16-aligned)
| Blob region (each blob 16-aligned)|
+----------------------------------+  fileSize
```

### Header (32 bytes)

| off | type | field        | notes                                            |
|----:|------|--------------|--------------------------------------------------|
|  0  | u32  | magic        | `0x4B504344` = bytes `'D','C','P','K'`            |
|  4  | u16  | version      | `1`                                              |
|  6  | u16  | flags        | reserved, `0`                                    |
|  8  | u32  | entryCount   | number of directory entries                      |
| 12  | u32  | dirOffset    | byte offset of the directory                     |
| 16  | u32  | namesOffset  | byte offset of the name table                    |
| 20  | u32  | blobsOffset  | byte offset of the blob region (multiple of 16)  |
| 24  | u32  | fileSize     | total size in bytes                              |
| 28  | u32  | reserved     | `0`                                              |

### Directory entry (24 bytes)

| off | type | field    | notes                                               |
|----:|------|----------|-----------------------------------------------------|
|  0  | u32  | keyHash  | FNV-1a-32 of the key (quick reject; exact match via name) |
|  4  | u32  | blobOff  | blob offset from file start (multiple of 16)        |
|  8  | u32  | byteLen  | blob length in bytes                                 |
| 12  | u32  | nameOff  | key offset relative to `namesOffset`                |
| 16  | u16  | nameLen  | key length in bytes                                  |
| 18  | u8   | dtype    | element type (see below)                            |
| 19  | u8   | reserved | `0`                                                 |
| 20  | u32  | reserved | `0`                                                 |

Entries are sorted by key (ascending) so a reader may binary-search; the
reference reader builds a hash map instead.

### `dtype`

| value | element  | TypedArray      |
|------:|----------|-----------------|
| 0     | u8       | `Uint8Array`    |
| 1     | i8       | `Int8Array`     |
| 2     | u16      | `Uint16Array`   |
| 3     | i16      | `Int16Array`    |
| 4     | u32      | `Uint32Array`   |
| 5     | i32      | `Int32Array`    |
| 6     | f32      | `Float32Array`  |
| 7     | f64      | `Float64Array`  |

`dtype` is advisory metadata — the consuming asset module chooses the accessor
(`dcU8`/`dcI8`/`dcU16`/`dcF32`). `byteLen` is always a whole multiple of the
element size.

## Keys

Keys are namespaced `"<module>:<path>"` ASCII strings, unique per pack, e.g.

```
three-soldier:inverseBindMatrices
three-soldier:bind.t
three-soldier:batch.0.vertices
three-soldier:batch.0.indices
three-soldier:clip.Walk.r
three-soldier:texture.pixels
car:body.vertices
nature:tree.indices
```

The `<module>:` prefix is what makes per-game subsetting work: after Bun bundles
a game (non-minified), every key string a baked module references appears
verbatim in the bundle text. The packer includes exactly the master entries
whose key occurs in that bundle, so a game only carries the assets it imports —
preserving the old tree-shaking behavior.

## Accessors return copies

`framework/src/dcpak.ts` returns each blob as a typed array backed by a **fresh
`ArrayBuffer` copy** of the blob bytes, so `arr.buffer` is exactly that blob.
This matches the old `unb64('...').buffer` semantics — `meshFromBaked` passes
`vertices.buffer` straight to the host mesh uploader, so it must not be a view
into the shared pack buffer. The copy is a single `memcpy` per blob (~1–2 MB
total per game), negligible next to the base64 parse it replaces.

## Delivery per host

The binary format is identical; only transport differs:

- **PSP (Rust):** `runtime/build.rs` copies `<game>.dcpak` next to `game.js` into
  `OUT_DIR`; `main.rs` `include_bytes!`-embeds it and exposes it to JS as the
  global `__dcpak` (`JS_NewArrayBuffer`, zero-copy over the static slice) before
  `JS_Eval`. No runtime file IO; the raw bytes live in `.rodata` and are never
  parsed by QuickJS.
- **3DS (C):** the build generates `game_dcpak.h` (`GAME_DCPAK[]` + len); `main.c`
  exposes it as `__dcpak` before eval.
- **Web + Android:** `web/build-games.ts` embeds each game's pack (base64) in the
  generated manifest; `web/engine.js` decodes it to `__dcpak` before eval.
  Android runs the same WebView engine, so it inherits this path.
- **Test harness (Bun):** `framework/test/golden.ts` reads `<game>.dcpak` from
  disk and sets `globalThis.__dcpak` before evaluating the bundle.

A game with no baked assets (2D games, raw demos, procedural-mesh 3D) produces an
empty pack (header, `entryCount = 0`) or none at all; the reader only throws when
a missing key is actually requested, so those games run with `__dcpak` unset.

## Versioning

`version` is bumped on any incompatible layout change. Readers must reject
unknown majors. v1 is described above.
