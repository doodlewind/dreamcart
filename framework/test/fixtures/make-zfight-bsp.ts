// Generates `zfight.bsp` — an ORIGINAL CC0 GoldSrc v30 test scene engineered to PROVOKE the
// camera-motion rendering divergences the bsp-iterate 3-leg compare hunts: a closed room +
// staggered solid props at different depths (so near/far ordering flips as the camera orbits)
// + a thin slab whose front face is COPLANAR with a prop's front face (classic z-fighting) +
// a slanted wall (near-plane / guard-band seam bait). Our own bytes -> safe to commit.
//
// Run: bun framework/test/fixtures/make-zfight-bsp.ts  ->  writes zfight.bsp next to it.
import { BspBuilder, checkerTex } from './bsp-gen';

const b = new BspBuilder();
const wall = b.addTexture(checkerTex('ZFWALL', 64, 64, [[28, 30, 38], [150, 154, 162], [80, 96, 140]]));
const prop = b.addTexture(checkerTex('ZFPROP', 64, 64, [[24, 20, 18], [190, 140, 90], [120, 170, 110]]));
const slab = b.addTexture(checkerTex('ZFSLAB', 32, 32, [[18, 18, 22], [212, 92, 92], [92, 212, 92]]));

// Closed room (inward), 512 x 512 x 320 Hammer units (Z-up, inches).
b.box([-256, -256, 0], [256, 256, 320], wall, true);

// Staggered solid props along +Y (in front of the spawn), at different depths so the
// near/far ordering changes as the camera sweep yaws past them.
b.box([-72, -40, 0], [-24, 8, 140], prop);   // A: near-left pillar
b.box([40, 56, 0], [104, 120, 168], prop);   // B: mid-right box
b.box([-48, 168, 0], [56, 216, 96], prop);   // C: far wide box

// Z-FIGHT bait: a 1-unit-thin slab whose front (-Y) face sits EXACTLY on box B's front face
// plane (y=56) — two coplanar faces facing the camera fight for the same depth as it moves.
b.box([50, 56, 20], [94, 57, 130], slab);

// A slanted wall off to the left (near-plane clip / guard-band seam bait when the sweep
// passes close to it). Auto-normal from the winding; doesn't occlude the central props.
b.polygon([[-220, 40, 0], [-120, 92, 0], [-120, 92, 220], [-220, 40, 220]], wall);

b.entity({ classname: 'worldspawn', wad: '' });
b.entity({ classname: 'info_player_start', origin: '0 -200 48', angle: '90' });

const path = new URL('zfight.bsp', import.meta.url).pathname;
const bytes = b.write(path);
const s = b.stats();
console.log(`wrote ${path} (${bytes} bytes, v30, ${s.faces} faces, ${s.verts} verts, ${s.textures} tex) — original CC0`);
