// Action map — a thin, data-driven layer over Input. A game declares NAMED
// actions bound to buttons and/or an analog axis once, then queries by name, so
// rebinding is a one-line config edit (no code change) and the same source runs
// on every host. It is deliberately allocation-free per frame and adds no math
// the digital path didn't already do: axis(name) returns the analog stick past
// its deadzone, else the digital +/- button pair — byte-identical to the old
// inp.axis().x on a digital-only host (analog 0 -> axisButtons fallback). This is
// why the racing3d golden does not move after migration.
//
//   const map = new ActionMap(ctx.input, {
//     ACCEL: { buttons: [Btn.Cross] },
//     STEER: { axis: 'lx', axisButtons: [Btn.Left, Btn.Right] },
//     RESET: { buttons: [Btn.Start] },
//   });
//   if (map.pressed('RESET')) reset();
//   ctrl.step({ throttle: map.held('ACCEL') ? 1 : 0, steer: map.axis('STEER'), ... });
import { Input } from './input';

export interface Binding {
  /** Digital buttons; held/pressed are true if ANY is down / just went down. */
  buttons?: number[];
  /** Analog stick axis this action reads ('lx' = analogX, 'ly' = analogY). */
  axis?: 'lx' | 'ly';
  /** Digital fallback pair [negative, positive] used when the axis is idle. */
  axisButtons?: [number, number];
  /** Negate the resulting axis value (analog and digital alike). */
  invert?: boolean;
  /** Per-action deadzone; the raw axis is already deadzoned by Input.update(). */
  deadzone?: number;
}
export type ActionConfig = Record<string, Binding>;

/**
 * Query input by action name. Constructed once with an Input + config; the
 * config is referenced directly (not copied) so a host/game can mutate a binding
 * to rebind live. All queries are O(buttons) with no allocation.
 */
export class ActionMap {
  constructor(public inp: Input, public cfg: ActionConfig) {}

  private bind(action: string): Binding {
    const b = this.cfg[action];
    if (!b) throw new Error('ActionMap: unknown action ' + action);
    return b;
  }

  /** True while any bound button is down. */
  held(action: string): boolean {
    const bs = this.bind(action).buttons;
    if (bs) for (let i = 0; i < bs.length; i++) if (this.inp.held(bs[i])) return true;
    return false;
  }

  /** True only on the frame any bound button transitions to down. */
  pressed(action: string): boolean {
    const bs = this.bind(action).buttons;
    if (bs) for (let i = 0; i < bs.length; i++) if (this.inp.pressed(bs[i])) return true;
    return false;
  }

  /**
   * Analog value in [-1,1]: the bound stick axis past its deadzone, else the
   * digital axisButtons pair (positive - negative). With no analog input this is
   * exactly the old Input.axis() component, so the digital golden path is byte
   * identical. invert flips the sign; an extra per-action deadzone may be applied.
   *
   * Per-axis (NOT whole-vector) semantics, on purpose: the fallback to the digital
   * pair is gated only on THIS action's bound axis ('lx' -> analogX, 'ly' ->
   * analogY) being idle, never on the other stick axis. Input.axis() instead
   * returns the whole {x,y} vector and suppresses BOTH components whenever EITHER
   * stick axis is live, so a stick pushed purely vertical there forces x=0. The two
   * differ only when one analog axis is live AND the other's digital pair is held —
   * a real game never binds an action to one stick axis while D-pad-steering the
   * orthogonal one. The byte-exact golden path (analogX==analogY==0) is identical
   * to the old inp.axis().x either way, which is what keeps racing3d's golden put.
   */
  axis(action: string): number {
    const b = this.bind(action);
    let v = 0;
    if (b.axis) {
      const a = b.axis === 'lx' ? this.inp.analogX : this.inp.analogY;
      if (a !== 0) v = a; // analog active -> use it (Input already deadzoned it)
    }
    if (v === 0 && b.axisButtons) {
      const [neg, pos] = b.axisButtons;
      if (this.inp.held(pos)) v += 1;
      if (this.inp.held(neg)) v -= 1;
    }
    if (b.deadzone && v > -b.deadzone && v < b.deadzone) v = 0;
    return b.invert ? -v : v;
  }

  /** Convenience: two axis actions as a vector (e.g. move + strafe). */
  vec(xa: string, ya: string): { x: number; y: number } {
    return { x: this.axis(xa), y: this.axis(ya) };
  }
}
