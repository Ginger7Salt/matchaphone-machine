export type MobileKeyboardMode = "none" | "viewport-shrink" | "overlay";
export type MobileOrientation = "portrait" | "landscape";

export interface MobileViewportEnvironment {
  innerWidth?: number;
  innerHeight?: number;
  documentClientWidth?: number;
  documentClientHeight?: number;
  visualWidth?: number;
  visualHeight?: number;
  visualOffsetTop?: number;
  virtualKeyboardInset?: number;
  safeAreaTop?: number;
  safeAreaBottom?: number;
  stableLayoutWidth?: number;
  stableLayoutHeight?: number;
}

export interface MobileViewportSnapshot {
  layoutWidth: number;
  layoutHeight: number;
  visualWidth: number;
  visualHeight: number;
  visualOffsetTop: number;
  safeAreaTop: number;
  safeAreaBottom: number;
  keyboardInset: number;
  keyboardMode: MobileKeyboardMode;
  orientation: MobileOrientation;
}

const finitePositive = (value: number | undefined, fallback: number) => {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? Math.round(candidate) : fallback;
};

const finiteNonNegative = (value: number | undefined) => {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.max(0, Math.round(candidate)) : 0;
};

export function keyboardModeOf(input: Pick<MobileViewportEnvironment, "innerHeight" | "visualHeight" | "visualOffsetTop" | "virtualKeyboardInset">): MobileKeyboardMode {
  const innerHeight = finitePositive(input.innerHeight, finitePositive(input.visualHeight, 1));
  const visualHeight = finitePositive(input.visualHeight, innerHeight);
  const offsetTop = finiteNonNegative(input.visualOffsetTop);
  const virtualKeyboardInset = finiteNonNegative(input.virtualKeyboardInset);
  const covered = Math.max(0, innerHeight - visualHeight - offsetTop);
  const viewportShrink = visualHeight < innerHeight - 80 && visualHeight < innerHeight * 0.85;
  if (viewportShrink) return "viewport-shrink";
  if (virtualKeyboardInset > 80 || covered > 80) return "overlay";
  return "none";
}

export function readMobileViewportSnapshot(input: MobileViewportEnvironment): MobileViewportSnapshot {
  const innerWidth = finitePositive(input.innerWidth, finitePositive(input.documentClientWidth, 1));
  const innerHeight = finitePositive(input.innerHeight, finitePositive(input.documentClientHeight, 1));
  const documentWidth = finitePositive(input.documentClientWidth, innerWidth);
  const documentHeight = finitePositive(input.documentClientHeight, innerHeight);
  const rawLayoutWidth = Math.min(innerWidth, documentWidth);
  const rawLayoutHeight = Math.min(innerHeight, documentHeight);
  const visualWidth = finitePositive(input.visualWidth, rawLayoutWidth);
  const visualHeight = finitePositive(input.visualHeight, innerHeight);
  const visualOffsetTop = finiteNonNegative(input.visualOffsetTop);
  const keyboardMode = keyboardModeOf({
    innerHeight,
    visualHeight,
    visualOffsetTop,
    virtualKeyboardInset: input.virtualKeyboardInset,
  });
  const stableLayoutWidth = finitePositive(input.stableLayoutWidth, rawLayoutWidth);
  const stableLayoutHeight = finitePositive(input.stableLayoutHeight, rawLayoutHeight);
  const layoutWidth = keyboardMode === "none" ? rawLayoutWidth : stableLayoutWidth;
  const layoutHeight = keyboardMode === "none" ? rawLayoutHeight : stableLayoutHeight;
  const keyboardInset = keyboardMode === "overlay"
    ? Math.max(finiteNonNegative(input.virtualKeyboardInset), Math.max(0, innerHeight - visualHeight - visualOffsetTop))
    : 0;
  return {
    layoutWidth,
    layoutHeight,
    visualWidth,
    visualHeight,
    visualOffsetTop,
    safeAreaTop: finiteNonNegative(input.safeAreaTop),
    safeAreaBottom: finiteNonNegative(input.safeAreaBottom),
    keyboardInset,
    keyboardMode,
    orientation: layoutHeight >= layoutWidth ? "portrait" : "landscape",
  };
}

export function cssViewportVariablesOf(snapshot: MobileViewportSnapshot): Record<string, string> {
  return {
    "--app-viewport-width": `${snapshot.layoutWidth}px`,
    "--app-viewport-height": `${snapshot.keyboardMode === "viewport-shrink" ? snapshot.visualHeight : snapshot.layoutHeight}px`,
    "--visual-viewport-width": `${snapshot.visualWidth}px`,
    "--visual-viewport-height": `${snapshot.visualHeight}px`,
    "--visual-viewport-offset-top": `${snapshot.visualOffsetTop}px`,
    "--stable-layout-width": `${snapshot.layoutWidth}px`,
    "--stable-layout-height": `${snapshot.layoutHeight}px`,
    "--safe-area-top": `${snapshot.safeAreaTop}px`,
    "--safe-area-bottom": `${snapshot.safeAreaBottom}px`,
    "--keyboard-inset": `${snapshot.keyboardInset}px`,
  };
}
