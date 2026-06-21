// Public API of the DreamCart game framework. Games import from here and are
// bundled (with the framework inlined) per platform by framework/build.ts (Bun.build).
import './assets-font'; // registers the default font (side effect: setFont)

import './host3d'; // registers the ambient g3d declaration (type-only side effect)
export * from './host';
export * from './host3d';
export * from './math';
export * from './mesh';
export * from './g3d';
export * from './material';
export * from './light';
export * from './anim';
export * from './skin';
export * from './scene3d';
export * from './fps';
export * from './color';
export * from './input';
export * from './action';
export * from './rng';
export * from './bitmap';
export * from './font';
export * from './graphics';
export * from './scene';
export * from './scene-desc';
export * from './engine';
export * from './controller';
export * from './dialogue';
export * from './tilemap';
export { FONT8X8 } from './assets-font';
export { SPRITES } from './assets-sprites';
export { unb64 } from './b64';
// NOTE: the baked glTF asset modules (assets-kenney-*.ts, assets-fox.ts) are
// deliberately NOT re-exported here. Their binary blobs live in the per-game
// .dcpak pack (docs/dcpak-format.md), but each module still builds a top-level
// object (geometry/clip skeleton) that pulls those blobs via dc*() at module
// load. Re-exporting them would run that side effect — and pull every asset's
// blobs into EVERY game's pack — even for 2D games. Games import the asset they
// need DIRECTLY, e.g.
//   import { KENNEY_CAR } from '../src/assets-kenney-car';
