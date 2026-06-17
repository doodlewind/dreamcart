// Hardware lighting for the 3D layer. The PSP GE does T&L in hardware: up to 4
// directional lights + a global ambient, applied per-vertex using the mesh's
// FMT_NORMAL. The JS side only describes the lights; Scene3D emits one
// OP_SET_LIGHTS record per frame and the host programs sceGuLight/sceGuAmbient.
//
// Determinism note: in contract.ts's `detFiles` no-trig guard — only +,-,*,/ and
// math.ts helpers here.
import { colorToABGR } from './g3d';
import { Vec3 } from './math';
import type { Color } from './color';

/** A directional (sun-style) light: a direction + an RGB color. */
export class DirectionalLight {
  dir: Vec3;
  color: Color;

  constructor(dir: Vec3, color: Color = 0xffffff) {
    // The GE wants the direction normalized; do it once up front (Vec3.normalize
    // uses dsqrt — deterministic across hosts).
    this.dir = dir.normalize();
    this.color = color;
  }

  /** ABGR u32 as the wire/host expect. */
  colorABGR(): number {
    return colorToABGR(this.color);
  }
}

/** The lighting environment for a Scene3D: a global ambient + directional lights. */
export class Lighting {
  ambient: Color;
  lights: DirectionalLight[] = [];

  constructor(ambient: Color = 0x202020) {
    this.ambient = ambient;
  }

  add(light: DirectionalLight): DirectionalLight {
    this.lights.push(light);
    return light;
  }

  /** ABGR u32 for the ambient term. */
  ambientABGR(): number {
    return colorToABGR(this.ambient);
  }

  /** Encoder-ready light list: {dir, color} per light, ≤4 (the GE limit). */
  encoded(): { dir: number[]; color: number }[] {
    const out: { dir: number[]; color: number }[] = [];
    for (let i = 0; i < this.lights.length && i < 4; i++) {
      const l = this.lights[i];
      out.push({ dir: [l.dir.x, l.dir.y, l.dir.z], color: l.colorABGR() });
    }
    return out;
  }
}
