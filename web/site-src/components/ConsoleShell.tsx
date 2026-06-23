/**
 * ConsoleShell — the headless, themeable handheld. Renders the bezel + a SCREEN
 * SLOT (where /play mounts the 480x272 PSPJS canvas) + d-pad + analog nub + face
 * buttons + shoulders + START/SELECT + brand. Every control fires
 * onPress(bit, down) so the page can wire PSPJS.pressVirtual.
 *
 * data-layout: "horizontal" (PSP-like, wide) | "vertical" (GBA-SP-like, narrow).
 * The page picks the layout (e.g. from a ResizeObserver / media query). Themed via
 * [data-theme] [data-part] CSS in base.ts + themes.ts — all four themes restyle it.
 *
 * Button bits use the PSPJS.BTN bitmask (see web/engine.js):
 *   SELECT 0x01, START 0x08, UP 0x10, RIGHT 0x20, DOWN 0x40, LEFT 0x80,
 *   LTRIGGER 0x100, RTRIGGER 0x200, TRIANGLE 0x1000, CIRCLE 0x2000,
 *   CROSS 0x4000, SQUARE 0x8000.
 */
import type { ReactNode } from "react";

/** The PSP button bitmask (kept local so this component has no engine import). */
export const BTN = {
  SELECT: 0x01,
  START: 0x08,
  UP: 0x10,
  RIGHT: 0x20,
  DOWN: 0x40,
  LEFT: 0x80,
  LTRIGGER: 0x100,
  RTRIGGER: 0x200,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
} as const;

export type Layout = "horizontal" | "vertical";

interface ConsoleShellProps {
  layout: Layout;
  /** Fired when a console control is pressed (down=true) / released (down=false). */
  onPress?: (bit: number, down: boolean) => void;
  /** The screen contents — typically a <div ref> the page mounts the canvas into. */
  screen?: ReactNode;
  /** Brand text printed on the shell (default "DreamCart"). */
  brand?: string;
}

/** A pressable console button that emits down/up and prevents text selection. */
function CBtn({
  bit,
  onPress,
  children,
  ...rest
}: {
  bit: number;
  onPress?: (bit: number, down: boolean) => void;
  children?: ReactNode;
} & React.HTMLAttributes<HTMLButtonElement>) {
  const down = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onPress?.(bit, true);
  };
  const up = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onPress?.(bit, false);
  };
  return (
    <button
      type="button"
      data-part="console-btn"
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={up}
      onPointerCancel={up}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ConsoleShell({
  layout,
  onPress,
  screen,
  brand = "DreamCart",
}: ConsoleShellProps) {
  return (
    <div data-part="console" data-layout={layout}>
      {/* Shoulders */}
      <div data-part="console-shoulders">
        <CBtn bit={BTN.LTRIGGER} onPress={onPress} data-shoulder="l" aria-label="Left shoulder">L</CBtn>
        <CBtn bit={BTN.RTRIGGER} onPress={onPress} data-shoulder="r" aria-label="Right shoulder">R</CBtn>
      </div>

      {/* Screen slot */}
      <div data-part="console-screen">
        {screen}
        <span data-part="console-brand">{brand}</span>
      </div>

      {/* Left cluster: d-pad + analog nub */}
      <div data-part="console-dpad-zone">
        <div data-part="console-dpad">
          <CBtn bit={BTN.UP} onPress={onPress} data-dir="up" aria-label="Up">▲</CBtn>
          <CBtn bit={BTN.LEFT} onPress={onPress} data-dir="left" aria-label="Left">◀</CBtn>
          <span data-part="console-btn" data-dir="center" aria-hidden="true" />
          <CBtn bit={BTN.RIGHT} onPress={onPress} data-dir="right" aria-label="Right">▶</CBtn>
          <CBtn bit={BTN.DOWN} onPress={onPress} data-dir="down" aria-label="Down">▼</CBtn>
        </div>
        <div data-part="console-nub" aria-hidden="true" />
      </div>

      {/* Right cluster: face buttons */}
      <div data-part="console-face-zone">
        <div data-part="console-face">
          <CBtn bit={BTN.TRIANGLE} onPress={onPress} data-btn="triangle" aria-label="Triangle">△</CBtn>
          <CBtn bit={BTN.SQUARE} onPress={onPress} data-btn="square" aria-label="Square">□</CBtn>
          <CBtn bit={BTN.CIRCLE} onPress={onPress} data-btn="circle" aria-label="Circle">○</CBtn>
          <CBtn bit={BTN.CROSS} onPress={onPress} data-btn="cross" aria-label="Cross">✕</CBtn>
        </div>
      </div>

      {/* Start / Select */}
      <div data-part="console-startsel">
        <CBtn bit={BTN.SELECT} onPress={onPress} aria-label="Select">Select</CBtn>
        <CBtn bit={BTN.START} onPress={onPress} aria-label="Start">Start</CBtn>
      </div>
    </div>
  );
}
