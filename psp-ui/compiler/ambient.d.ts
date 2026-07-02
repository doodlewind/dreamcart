// Ambient module declarations for untyped babel presets (build-time only).
// babel-preset-solid and @babel/preset-typescript ship no .d.ts; both are
// only ever passed opaquely into @babel/core's `presets` array.

declare module "babel-preset-solid" {
  const preset: unknown;
  export default preset;
}

declare module "@babel/preset-typescript" {
  const preset: unknown;
  export default preset;
}
