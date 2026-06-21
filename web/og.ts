// Generates the committed social/OG images + raster favicons under web/static/,
// by rendering branded HTML to PNG with Playwright. Run manually after a brand or
// copy change — the OUTPUTS ARE COMMITTED so the deploy build needs no browser:
//
//   bun run og        (= bun web/og.ts)
//
// Outputs:
//   web/static/og/{default,home,play,docs,changelog}.png   1200x630 social cards
//   web/static/apple-touch-icon.png                         180x180
//   web/static/favicon.png                                  32x32
import { chromium } from "playwright";

const outDir = new URL("./static/", import.meta.url).pathname;
const ogDir = outDir + "og/";
await Bun.$`mkdir -p ${ogDir}`.quiet();

// Dream Night palette — the default brand theme (matches web/site-src/styles/themes.ts).
const BG = "#13121d";
const FG = "#f1eef8";
const MUTED = "#a39db9";
const ACCENT = "#e9b24c"; // brand gold
const ACCENT2 = "#46c7c4"; // teal grid

const SLOGAN = "Self-contained game cartridges for tiny worlds";

// The DreamCart cartridge logo bitmap, embedded into the brand lockup on each card.
const CART_DATA_URL =
  "data:image/png;base64," +
  Buffer.from(await Bun.file(outDir + "logo.png").arrayBuffer()).toString("base64");

const CARDS = [
  { name: "default", eyebrow: "Isomorphic game runtime", title: "DreamCart" },
  { name: "home", eyebrow: "Isomorphic game runtime", title: "DreamCart" },
  { name: "play", eyebrow: "Playground", title: "Run a cartridge in your browser" },
  { name: "docs", eyebrow: "Documentation", title: "Architecture &amp; lib API" },
  { name: "changelog", eyebrow: "Changelog", title: "New capabilities, every week" },
];

const card = (eyebrow: string, title: string) => /* html */ `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&display=swap');
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background:
      radial-gradient(900px 500px at 78% -10%, ${ACCENT}22, transparent 60%),
      radial-gradient(700px 500px at 0% 120%, ${ACCENT2}18, transparent 55%),
      ${BG};
    color: ${FG}; font-family: 'Inter', system-ui, sans-serif;
    padding: 80px; display: flex; flex-direction: column; justify-content: space-between;
    position: relative; overflow: hidden;
  }
  .grid { position: absolute; inset: 0;
    background-image: linear-gradient(${FG}0a 1px, transparent 1px), linear-gradient(90deg, ${FG}0a 1px, transparent 1px);
    background-size: 48px 48px; mask-image: radial-gradient(circle at 50% 40%, #000 30%, transparent 75%); }
  .brand { display: flex; align-items: center; gap: 18px; position: relative; z-index: 1; }
  .chip { width: 92px; height: 90px; display: flex; align-items: center; justify-content: center;
    filter: drop-shadow(0 14px 26px #00000088) drop-shadow(0 0 30px ${ACCENT}33); }
  .chip img { width: 100%; height: 100%; object-fit: contain; }
  .brand-name { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 34px; letter-spacing: -0.01em; }
  .main { position: relative; z-index: 1; }
  .eyebrow { color: ${ACCENT}; font-weight: 600; font-size: 24px; letter-spacing: 0.18em; text-transform: uppercase; }
  .title { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 76px; line-height: 1.04;
    letter-spacing: -0.02em; margin-top: 22px; max-width: 980px; }
  .slogan { color: ${MUTED}; font-size: 28px; margin-top: 28px; }
  .foot { display: flex; justify-content: space-between; align-items: center; position: relative; z-index: 1;
    color: ${MUTED}; font-size: 24px; }
  .foot b { color: ${FG}; }
  .pills { display: flex; gap: 12px; }
  .pill { border: 1px solid ${FG}22; border-radius: 999px; padding: 8px 18px; font-size: 20px; color: ${FG}; }
</style></head>
<body>
  <div class="grid"></div>
  <div class="brand"><div class="chip"><img src="${CART_DATA_URL}"/></div><div class="brand-name">DreamCart</div></div>
  <div class="main">
    <div class="eyebrow">${eyebrow}</div>
    <div class="title">${title}</div>
    <div class="slogan">${SLOGAN}</div>
  </div>
  <div class="foot">
    <div class="pills"><span class="pill">PSP</span><span class="pill">Web</span><span class="pill">3DS</span><span class="pill">Android</span></div>
    <div><b>dreamcart.games</b></div>
  </div>
</body></html>`;

const browser = await chromium.launch();

// OG cards (1200x630).
for (const c of CARDS) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(card(c.eyebrow, c.title), { waitUntil: "networkidle" });
  await page.waitForTimeout(300); // let webfonts settle
  await page.screenshot({ path: `${ogDir}${c.name}.png` });
  await page.close();
  console.log(`  og/${c.name}.png`);
}

// Raster favicons from favicon.svg.
const svg = await Bun.file(outDir + "favicon.svg").text();
for (const [file, size] of [["apple-touch-icon.png", 180], ["favicon.png", 32]] as const) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>*{margin:0}html,body{width:${size}px;height:${size}px}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
    { waitUntil: "networkidle" },
  );
  await page.screenshot({ path: outDir + file, omitBackground: true });
  await page.close();
  console.log(`  ${file}`);
}

await browser.close();
console.log("✓ static assets generated (web/static/) — commit them.");
