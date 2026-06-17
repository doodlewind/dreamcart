// Portable base64 -> Uint8Array decoder for the baked asset modules. Geometry
// and texture blobs are stored base64 in the generated assets-*.ts so the source
// files stay compact; this decodes them at load. Hand-rolled (charCodeAt + a LUT)
// rather than relying on `atob`, which is not guaranteed on the QuickJS hosts.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LUT = /* @__PURE__ */ (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Decode a standard (padded) base64 string into a fresh Uint8Array. */
export function unb64(s: string): Uint8Array {
  const len = s.length;
  if (len === 0) return new Uint8Array(0);
  let pad = 0;
  if (s.charCodeAt(len - 1) === 61) pad++; // '='
  if (s.charCodeAt(len - 2) === 61) pad++;
  const outLen = (len >> 2) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = LUT[s.charCodeAt(i)];
    const b = LUT[s.charCodeAt(i + 1)];
    const c = LUT[s.charCodeAt(i + 2)];
    const d = LUT[s.charCodeAt(i + 3)];
    out[o++] = (a << 2) | (b >> 4);
    if (o < outLen) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (o < outLen) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}
