// @ts-check
// @title White Album 2
// @order 2
// @controls CROSS/START advance & reveal · hold SQUARE to fast-forward
// A text-only visual novel (ADV) playing the opening of White Album 2: the snowy
// airport flashback and the classroom prologue. Pure text on a simple gradient —
// no CG/sprites. Japanese glyphs (+ furigana) are baked to a 1-bit atlas
// (framework/src/wa2-font.ts) and rasterized natively via gfx.vnDrawGlyphs; this
// JS layer just orchestrates layout (wrapping + ruby placement), the typewriter,
// and scene flow. The script is packed from the raw game files into
// framework/src/wa2-script.ts. Latin UI text uses the framework 8×8 font (g.text).
import { Btn, Colors, Scene, start, unb64 } from '../src/index';
import { WA2_SCENES } from '../src/wa2-script';
import { WA2_FONT } from '../src/wa2-font';

/** @import { Graphics, UpdateContext } from '../src/index' */
/** @typedef {{gid:number, x:number, y:number}} Place */
/** @typedef {{gid:number, x:number, y:number, revAt:number}} RubyPlace */
/** @typedef {{base:Place[], ruby:RubyPlace[], nBase:number}} Page */

const SCREEN_W = 480;
const SCREEN_H = 272;

// Dialogue box geometry (lower portion of the screen).
const PX = 12, PY = 146, PW = 456, PH = 116;
const AREA_X = PX + 14;            // text area left
const AREA_W = PW - 28;            // text area width
const AREA_TOP = PY + 16;
const AREA_BOT = PY + PH - 12;
const ROWGAP = 5;                  // vertical gap between base rows
const RUBY_CLEAR = 14;             // extra space above a row that carries furigana

const BASE = WA2_FONT.base;
const RUBY = WA2_FONT.ruby;
const CELL = BASE.cellW;           // 18 — full-width advance
const RCELL = RUBY.cellW;          // 13
const MAXCOLS = Math.floor(AREA_W / CELL);

// Per-speaker text tint (a little colour identity; narration is soft white).
const SPK_COLOR = /** @type {Record<string, number>} */ ({
  '春希': 0xffffff, '雪菜': 0xffd2e0, 'かずさ': 0xbcd0ff,
  '武也': 0xc8f0c0, '親志': 0xe8d0a0, '依緒': 0xf2c0b0, '？？？': 0x9aa6c0,
});
const NARRATION = 0xeae3d6;
const SPECIAL = 0xffdca0;           // 『 … 』 emphasised lines

// Per-scene background gradient [top, bottom] — sets the mood per chapter.
const SCENE_BG = /** @type {number[][]} */ ([
  [0x2a3a5c, 0xcdd8e6], // 1001 airport snow: cold steel blue -> pale sky
  [0x140e22, 0x3a2a52], // 1002 WHITE ALBUM: night purple
  [0x3a4a72, 0xe8c898], // 1003 rooftop: dusk blue -> warm gold
  [0x4a3a52, 0xe0b890], // 1004 classroom: warm afternoon
]);

// ---- baked-font decode + codepoint -> glyph id maps -----------------------
const baseBlob = unb64(BASE.b64);
const rubyBlob = unb64(RUBY.b64);
const baseMap = /** @type {Map<number, number>} */ (new Map());
const rubyMap = /** @type {Map<number, number>} */ (new Map());
{
  let i = 0;
  for (const ch of BASE.codes) baseMap.set(/** @type {number} */ (ch.codePointAt(0)), ++i);
  i = 0;
  for (const ch of RUBY.codes) rubyMap.set(/** @type {number} */ (ch.codePointAt(0)), ++i);
}
const baseGid = (/** @type {string} */ ch) => baseMap.get(/** @type {number} */ (ch.codePointAt(0))) || 0;
const rubyGid = (/** @type {string} */ ch) => rubyMap.get(/** @type {number} */ (ch.codePointAt(0))) || 0;

// Reused scratch for gfx.vnDrawGlyphs ([glyphId, x, y] triples).
const GBUF = new Int32Array(2048 * 3);
const GBUFAB = /** @type {ArrayBuffer} */ (GBUF.buffer);
/** Draw a list of placements from a slot in one batched native call. */
function drawGlyphs(/** @type {number} */ slot, /** @type {Place[]} */ list, /** @type {number} */ color) {
  let n = 0;
  for (const g of list) {
    if (n >= 2048) break;
    if (!g.gid) continue;
    GBUF[n * 3] = g.gid; GBUF[n * 3 + 1] = g.x | 0; GBUF[n * 3 + 2] = g.y | 0; n++;
  }
  const draw = gfx.vnDrawGlyphs;
  if (n && draw) draw(slot, GBUFAB, n, color);
}

/** Lay out a plain (no-ruby, no-wrap) string of base glyphs centred at cx. */
function layoutCentered(/** @type {string} */ str, /** @type {number} */ cx, /** @type {number} */ y) {
  const chars = [...str];
  let x = cx - (chars.length * CELL) / 2;
  /** @type {Place[]} */
  const out = [];
  for (const ch of chars) { out.push({ gid: baseGid(ch), x: x | 0, y }); x += CELL; }
  return out;
}

// ---- line layout -> pages -------------------------------------------------
// Each page reveals base glyphs in reading order; a ruby reading appears once its
// base segment is fully revealed (revAt = the reveal index that completes it).
/** @returns {Page[]} */
function layoutLine(/** @type {{sp:string,k:number,segs:{t:string,r?:string}[]}} */ line) {
  /** @type {{gid:number, lx:number, row:number}[][]} */
  const rows = [[]];
  /** @type {{row:number, lx0:number, lx1:number, gids:number[]}[]} */
  const rubySpans = [];
  let row = 0, col = 0;
  const newRow = () => { row++; rows.push([]); col = 0; };
  for (const seg of line.segs) {
    /** @type {{gid:number, lx:number, row:number}[]} */
    const segCells = [];
    for (const ch of seg.t) {
      if (ch === '\n') { newRow(); continue; }
      if (col >= MAXCOLS) newRow();
      const cell = { gid: baseGid(ch), lx: col * CELL, row };
      rows[row].push(cell); segCells.push(cell); col++;
    }
    if (seg.r && segCells.length) {
      // Place the reading over the largest single-row run of the base segment.
      const countByRow = /** @type {Record<number, number>} */ ({});
      for (const c of segCells) countByRow[c.row] = (countByRow[c.row] || 0) + 1;
      let bestRow = segCells[0].row, bestN = -1;
      for (const c of segCells) { const n = countByRow[c.row]; if (n > bestN) { bestN = n; bestRow = c.row; } }
      const rowCells = segCells.filter((c) => c.row === bestRow);
      rubySpans.push({ row: bestRow, lx0: rowCells[0].lx, lx1: rowCells[rowCells.length - 1].lx + CELL, gids: [...seg.r].map(rubyGid) });
    }
  }
  const nRows = rows.length;
  const rowHasRuby = /** @type {boolean[]} */ (new Array(nRows).fill(false));
  for (const rs of rubySpans) rowHasRuby[rs.row] = true;

  // Pack rows into pages by available height (ruby rows are taller).
  /** @type {{r:number, top:number}[][]} */
  const pages = [];
  /** @type {{r:number, top:number}[]} */
  let cur = [];
  let y = AREA_TOP;
  for (let r = 0; r < nRows; r++) {
    const rh = (rowHasRuby[r] ? RUBY_CLEAR : 0) + CELL + ROWGAP;
    if (cur.length && y + rh > AREA_BOT) { pages.push(cur); cur = []; y = AREA_TOP; }
    cur.push({ r, top: y });
    y += rh;
  }
  if (cur.length) pages.push(cur);

  /** @type {Page[]} */
  const out = [];
  for (const pageRows of pages) {
    /** @type {Place[]} */
    const base = [];
    /** @type {RubyPlace[]} */
    const ruby = [];
    const keyIndex = /** @type {Record<number, number>} */ ({});
    const rowTop = /** @type {Record<number, number>} */ ({});
    for (const pr of pageRows) rowTop[pr.r] = pr.top;
    for (const pr of pageRows) {
      const baseY = pr.top + (rowHasRuby[pr.r] ? RUBY_CLEAR : 0);
      for (const c of rows[pr.r]) { keyIndex[pr.r * 4096 + c.lx] = base.length; base.push({ gid: c.gid, x: AREA_X + c.lx, y: baseY }); }
    }
    for (const rs of rubySpans) {
      if (!(rs.row in rowTop)) continue;
      const baseY = rowTop[rs.row] + RUBY_CLEAR;
      const ry = baseY - RUBY.cellH - 1;
      const rubyW = rs.gids.length * RCELL;
      let rx = AREA_X + rs.lx0 + ((rs.lx1 - rs.lx0) - rubyW) / 2;
      const lastKey = rs.row * 4096 + (rs.lx1 - CELL);
      const revAt = lastKey in keyIndex ? keyIndex[lastKey] + 1 : base.length;
      for (const g of rs.gids) { ruby.push({ gid: g, x: rx | 0, y: ry, revAt }); rx += RCELL; }
    }
    out.push({ base, ruby, nBase: base.length });
  }
  return out.length ? out : [{ base: [], ruby: [], nBase: 0 }];
}

// ---- the VN scene ---------------------------------------------------------
const REVEAL_SPEED = 0.7; // base glyphs revealed per frame (typewriter)

class VnScene extends Scene {
  constructor() {
    super();
    this.ready = false;
    /** @type {'title'|'card'|'vn'|'end'} */
    this.mode = 'title';
    this.scene = 0;
    this.li = 0;
    /** @type {Page[]} */
    this.pages = [];
    this.pi = 0;
    this.rev = 0;
    this.blink = 0;
    /** @type {{x:number, y:number, v:number, sz:number}[]} */
    this.snow = [];
  }

  onEnter() {
    const up = gfx.vnUploadFont;
    this.ready = !!(up && gfx.vnDrawGlyphs);
    if (up && this.ready) {
      up(0, /** @type {ArrayBuffer} */ (baseBlob.buffer), BASE.count, BASE.cellW, BASE.cellH, BASE.bpr);
      up(1, /** @type {ArrayBuffer} */ (rubyBlob.buffer), RUBY.count, RUBY.cellW, RUBY.cellH, RUBY.bpr);
    }
    this.mode = 'title';
    this.scene = 0;
    this.li = 0;
    this.pages = [];
    this.pi = 0;
    this.rev = 0;
    this.blink = 0;
    this.snow = [];
    let s = 0x1234;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < 40; i++) this.snow.push({ x: rnd() * SCREEN_W, y: rnd() * SCREEN_H, v: 0.3 + rnd() * 0.9, sz: rnd() < 0.3 ? 2 : 1 });
  }

  curLine() { return WA2_SCENES[this.scene].lines[this.li]; }

  loadLine() { this.pages = layoutLine(this.curLine()); this.pi = 0; this.rev = 0; }

  advance() {
    if (this.mode === 'title') { this.mode = 'card'; this.scene = 0; this.blink = 0; return; }
    if (this.mode === 'end') { this.onEnter(); return; }
    if (this.mode === 'card') { this.mode = 'vn'; this.li = 0; this.loadLine(); return; }
    const page = this.pages[this.pi];
    if (this.rev < page.nBase) { this.rev = page.nBase; return; }          // reveal all
    if (this.pi < this.pages.length - 1) { this.pi++; this.rev = 0; return; } // next page
    if (this.li < WA2_SCENES[this.scene].lines.length - 1) { this.li++; this.loadLine(); return; } // next line
    if (this.scene < WA2_SCENES.length - 1) { this.scene++; this.mode = 'card'; this.blink = 0; return; } // next chapter
    this.mode = 'end';
  }

  /** @param {UpdateContext} ctx */
  update(ctx) {
    this.blink++;
    const i = ctx.input;
    if (this.mode === 'vn') {
      const page = this.pages[this.pi];
      const fast = i.held(Btn.Square) || i.held(Btn.Circle);
      if (this.rev < page.nBase) this.rev = Math.min(page.nBase, this.rev + (fast ? 6 : REVEAL_SPEED));
    }
    for (const p of this.snow) { p.y += p.v; p.x += 0.15; if (p.y > SCREEN_H) p.y = -2; if (p.x > SCREEN_W) p.x = 0; }
    if (i.pressed(Btn.Cross) || i.pressed(Btn.Start) || i.pressed(Btn.Circle)) this.advance();
  }

  /** @param {Graphics} g */
  drawBg(g) {
    const pal = SCENE_BG[this.mode === 'title' ? 0 : this.scene] || SCENE_BG[0];
    const top = pal[0], bot = pal[1];
    const tr = (top >> 16) & 255, tg = (top >> 8) & 255, tb = top & 255;
    const br = (bot >> 16) & 255, bg = (bot >> 8) & 255, bb = bot & 255;
    const BANDS = 34, bh = Math.ceil(SCREEN_H / BANDS);
    for (let i = 0; i < BANDS; i++) {
      const t = i / (BANDS - 1);
      const c = (((tr + (br - tr) * t) | 0) << 16) | (((tg + (bg - tg) * t) | 0) << 8) | ((tb + (bb - tb) * t) | 0);
      g.rect(0, i * bh, SCREEN_W, bh, c >>> 0);
    }
    for (const p of this.snow) g.rect(p.x | 0, p.y | 0, p.sz, p.sz, 0xf4f8ff);
  }

  /** @param {Graphics} g */
  draw(g) {
    this.drawBg(g);
    if (!this.ready) {
      g.text('WHITE ALBUM 2', 120, 110, Colors.white, 2);
      g.text('native VN glyph support missing on this host', 70, 140, 0xffb0b0, 1);
      return;
    }
    if (this.mode === 'title') return this.drawTitle(g);
    if (this.mode === 'card') return this.drawCard(g);
    if (this.mode === 'end') return this.drawEnd(g);
    this.drawVn(g);
  }

  /** @param {Graphics} g */
  drawTitle(g) {
    g.text('WHITE ALBUM 2', 96, 86, 0xffffff, 3);
    g.rect(96, 120, 288, 2, 0xbcd0ff);
    drawGlyphs(0, layoutCentered('雪の物語、ふたたび', SCREEN_W / 2, 134), 0xdfe8ff);
    g.text('A DreamCart visual-novel demo', 132, 172, 0xb9c4dd, 1);
    if ((this.blink >> 4) & 1) g.text('PRESS START / CROSS', 158, 210, 0xffe6a0, 1);
  }

  /** @param {Graphics} g */
  drawCard(g) {
    const sc = WA2_SCENES[this.scene];
    g.text('CHAPTER ' + (this.scene + 1), SCREEN_W / 2 - 44, 96, 0xb9c4dd, 1);
    drawGlyphs(0, layoutCentered(sc.title, SCREEN_W / 2, 124), 0xffffff);
    g.rect(SCREEN_W / 2 - 70, 152, 140, 2, 0x6677aa);
    if ((this.blink >> 4) & 1) g.text('CROSS', SCREEN_W / 2 - 18, 196, 0xffe6a0, 1);
  }

  /** @param {Graphics} g */
  drawEnd(g) {
    drawGlyphs(0, layoutCentered('つづく', SCREEN_W / 2, 110), 0xffffff);
    g.text('END OF DEMO  -  ' + WA2_SCENES.length + ' SCENES', 124, 150, 0xb9c4dd, 1);
    if ((this.blink >> 4) & 1) g.text('CROSS TO RESTART', 156, 196, 0xffe6a0, 1);
  }

  /** @param {Graphics} g */
  drawVn(g) {
    const line = this.curLine();
    const page = this.pages[this.pi];
    g.rect(PX, PY, PW, PH, 0x0c1020);
    g.rectOutline(PX, PY, PW, PH, 0x46587e, 2);
    g.rect(PX + 2, PY + 2, PW - 4, 1, 0x223052);
    if (line.sp) {
      const tint = SPK_COLOR[line.sp] || 0xffffff;
      const nameGl = [...line.sp];
      const nw = nameGl.length * CELL + 16;
      g.rect(PX + 8, PY - 16, nw, 22, 0x202a44);
      g.rectOutline(PX + 8, PY - 16, nw, 22, 0x46587e, 1);
      let nx = PX + 16;
      /** @type {Place[]} */
      const np = [];
      for (const ch of nameGl) { np.push({ gid: baseGid(ch), x: nx, y: PY - 14 }); nx += CELL; }
      drawGlyphs(0, np, tint);
    }
    const color = line.k === 2 ? SPECIAL : line.sp ? (SPK_COLOR[line.sp] || 0xffffff) : NARRATION;
    const rv = this.rev | 0;
    drawGlyphs(0, page.base.slice(0, rv), color);
    const rubyShown = page.ruby.filter((/** @type {RubyPlace} */ r) => r.revAt <= rv);
    if (rubyShown.length) drawGlyphs(1, rubyShown, color);
    if (this.rev >= page.nBase && (this.blink >> 4) & 1) {
      const tx = PX + PW - 22, ty = PY + PH - 14;
      g.rect(tx, ty, 10, 2, 0xffe6a0); g.rect(tx + 2, ty + 2, 6, 2, 0xffe6a0); g.rect(tx + 4, ty + 4, 2, 2, 0xffe6a0);
    }
    if (this.pages.length > 1) g.text((this.pi + 1) + '/' + this.pages.length, PX + PW - 40, PY - 12, 0x9aa6c0, 1);
  }
}

start(() => new VnScene());
