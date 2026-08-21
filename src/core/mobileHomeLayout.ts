export const MOBILE_HOME_LAYOUT_VERSION = 3 as const;
export const MOBILE_HOME_COLUMNS = 4 as const;
export const MOBILE_HOME_LOGICAL_ROWS = 6 as const;

const REFERENCE_WIDTH = 390;
const MIN_SCALE = 360 / REFERENCE_WIDTH;
const MAX_SCALE = 414 / REFERENCE_WIDTH;
const REFERENCE_ROW_HEIGHTS = [101.5, 101.5, 79.2, 86.6, 79.2, 79.2] as const;
const REFERENCE_ROW_GAPS = [24, 24, 24, 24, 24] as const;
const REFERENCE_DOCK_HEIGHT = 84;
const REFERENCE_PAGE_DOTS_HEIGHT = 10;
const REFERENCE_DOTS_TO_DOCK_GAP = 22;
const REFERENCE_CONTENT_TO_DOTS_GAP = 12;
const REFERENCE_TOP_PADDING = 48;
const REFERENCE_HORIZONTAL_PADDING = 18;
const MIN_BOTTOM_PADDING = 5;
const MIN_DISTRIBUTABLE_HEIGHT = 4;
const MAX_TOP_EXTRA = 48;
const MAX_GROUP_GAP_EXTRA = 40;
const MAX_CONTENT_TO_DOTS_EXTRA = 42;

export interface MobileHomeLayoutInput {
  viewportWidth: number;
  viewportHeight: number;
  safeAreaTop?: number;
  safeAreaBottom?: number;
}

export interface MobileHomeEnvironmentInput {
  routeIsHome: boolean;
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  screenAvailHeight?: number;
  touchCapable: boolean;
  portrait: boolean;
  keyboardOpen: boolean;
  displayModeStandalone?: boolean;
  displayModeFullscreen?: boolean;
  displayModeMinimalUi?: boolean;
  navigatorStandalone?: boolean;
  androidAppReferrer?: boolean;
}

export interface MobileHomeRowBound {
  top: number;
  bottom: number;
  center: number;
}

type SixNumbers = readonly [number, number, number, number, number, number];
type FiveNumbers = readonly [number, number, number, number, number];

export interface MobileHomeLayoutMetrics {
  version: typeof MOBILE_HOME_LAYOUT_VERSION;
  columns: typeof MOBILE_HOME_COLUMNS;
  logicalRows: typeof MOBILE_HOME_LOGICAL_ROWS;
  rowHeights: SixNumbers;
  rowGaps: FiveNumbers;
  rowStarts: SixNumbers;
  rowEnds: SixNumbers;
  rowBounds: readonly [MobileHomeRowBound, MobileHomeRowBound, MobileHomeRowBound, MobileHomeRowBound, MobileHomeRowBound, MobileHomeRowBound];
  rowGap: number;
  columnGap: number;
  desktopHeight: number;
  flexibleSpacer: number;
  contentToDotsGap: number;
  dotsToDockGap: number;
  footerHeight: number;
  dockHeight: number;
  pageDotsHeight: number;
  footerGap: number;
  heroHeight: number;
  heroThumbSize: number;
  topPadding: number;
  bottomPadding: number;
  safeAreaTop: number;
  safeAreaBottom: number;
  minimumRequiredHeight: number;
  extraHeight: number;
  enabled: boolean;
}

export interface MobileHomeResponsiveLayout extends Omit<MobileHomeLayoutMetrics, "version" | "enabled"> {
  version: 6;
  contentScale: number;
  compact: boolean;
  scrollable: boolean;
}

const finiteNonNegative = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const round = (value: number) => Math.round(value * 100) / 100;
const scaled = (value: number, scale: number) => round(value * scale);

const REFERENCE_TOTAL_HEIGHT = 827.2;
const MIN_RESPONSIVE_SCALE = 0.76;

function scaleForWidth(width: number) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, width / REFERENCE_WIDTH));
}

function normalizeRowGaps(rowGap: number | readonly number[]): FiveNumbers {
  if (typeof rowGap === "number") return [rowGap, rowGap, rowGap, rowGap, rowGap];
  return Array.from({ length: MOBILE_HOME_LOGICAL_ROWS - 1 }, (_, index) => finiteNonNegative(rowGap[index])) as unknown as FiveNumbers;
}

function allocateExtra(total: number, capacities: readonly number[]) {
  const allocations = capacities.map(() => 0);
  let remaining = Math.max(0, total);
  let active = capacities.map((capacity, index) => ({ capacity: Math.max(0, capacity), index }));
  while (remaining > 0.005 && active.length) {
    const share = remaining / active.length;
    let consumed = 0;
    const next: typeof active = [];
    for (const item of active) {
      const available = item.capacity - allocations[item.index];
      const amount = Math.min(share, available);
      allocations[item.index] += amount;
      consumed += amount;
      if (available - amount > 0.005) next.push(item);
    }
    if (consumed <= 0.005) break;
    remaining -= consumed;
    active = next;
  }
  // Extremely tall canvases keep any final excess above the content, never between Apps and Dock.
  allocations[0] += remaining;
  return allocations.map(round);
}

export function isMobileHomeFullCanvasEnvironment(input: MobileHomeEnvironmentInput) {
  if (!input.routeIsHome || input.viewportWidth > 600 || !input.portrait || input.keyboardOpen) return false;
  const explicit = Boolean(
    input.displayModeStandalone ||
    input.displayModeFullscreen ||
    input.displayModeMinimalUi ||
    input.navigatorStandalone ||
    input.androidAppReferrer
  );
  if (explicit) return true;
  if (!input.touchCapable) return false;
  const screenWidth = finiteNonNegative(input.screenWidth);
  const screenHeight = Math.max(finiteNonNegative(input.screenAvailHeight), finiteNonNegative(input.screenHeight));
  if (screenWidth <= 0 || screenHeight <= 0) return false;
  const widthTolerance = Math.max(8, screenWidth * 0.03);
  const widthMatches = Math.abs(input.viewportWidth - screenWidth) <= widthTolerance;
  const heightCoverage = input.viewportHeight / screenHeight;
  return widthMatches && heightCoverage >= 0.94 && heightCoverage <= 1.08;
}

export function buildMobileHomeRowBounds(
  rowHeights: readonly number[],
  rowGap: number | readonly number[],
  offset = 0,
): MobileHomeLayoutMetrics["rowBounds"] {
  const rowGaps = normalizeRowGaps(rowGap);
  const starts: number[] = [];
  let cursor = offset;
  for (let row = 0; row < MOBILE_HOME_LOGICAL_ROWS; row += 1) {
    starts.push(cursor);
    cursor += rowHeights[row] ?? 0;
    if (row < MOBILE_HOME_LOGICAL_ROWS - 1) cursor += rowGaps[row] ?? 0;
  }
  return starts.map((top, row) => ({
    top,
    bottom: top + (rowHeights[row] ?? 0),
    center: top + (rowHeights[row] ?? 0) / 2,
  })) as unknown as MobileHomeLayoutMetrics["rowBounds"];
}

export function calculateMobileHomeLayout(input: MobileHomeLayoutInput): MobileHomeLayoutMetrics {
  const viewportWidth = Math.max(1, Math.round(finiteNonNegative(input.viewportWidth)));
  const viewportHeight = Math.max(1, Math.round(finiteNonNegative(input.viewportHeight)));
  const safeAreaTop = Math.round(finiteNonNegative(input.safeAreaTop));
  const safeAreaBottom = Math.round(finiteNonNegative(input.safeAreaBottom));
  const scale = scaleForWidth(viewportWidth);
  const rowHeights = REFERENCE_ROW_HEIGHTS.map((value) => scaled(value, scale)) as unknown as SixNumbers;
  const baseRowGaps = REFERENCE_ROW_GAPS.map((value) => scaled(value, scale)) as unknown as FiveNumbers;
  const columnGap = 8;
  const dockHeight = scaled(REFERENCE_DOCK_HEIGHT, scale);
  const pageDotsHeight = REFERENCE_PAGE_DOTS_HEIGHT;
  const dotsToDockGap = scaled(REFERENCE_DOTS_TO_DOCK_GAP, scale);
  const baseContentToDotsGap = scaled(REFERENCE_CONTENT_TO_DOTS_GAP, scale);
  const baseTopPadding = Math.max(scaled(REFERENCE_TOP_PADDING, scale), safeAreaTop + 1);
  const bottomPadding = Math.max(MIN_BOTTOM_PADDING, safeAreaBottom);
  const baseDesktopHeight = round(sum(rowHeights) + sum(baseRowGaps));
  const baseFooterHeight = round(baseContentToDotsGap + pageDotsHeight + dotsToDockGap + dockHeight);
  const minimumRequiredHeight = round(baseTopPadding + baseDesktopHeight + baseFooterHeight + bottomPadding);
  const extraHeight = Math.max(0, round(viewportHeight - minimumRequiredHeight));
  const [topExtra, firstGroupExtra, secondGroupExtra, dotsExtra] = allocateExtra(extraHeight, [
    scaled(MAX_TOP_EXTRA, scale),
    scaled(MAX_GROUP_GAP_EXTRA, scale),
    scaled(MAX_GROUP_GAP_EXTRA, scale),
    scaled(MAX_CONTENT_TO_DOTS_EXTRA, scale),
  ]);
  const topPadding = round(baseTopPadding + topExtra);
  const rowGaps = [
    baseRowGaps[0],
    round(baseRowGaps[1] + firstGroupExtra),
    baseRowGaps[2],
    round(baseRowGaps[3] + secondGroupExtra),
    baseRowGaps[4],
  ] as FiveNumbers;
  const contentToDotsGap = round(baseContentToDotsGap + dotsExtra);
  const desktopHeight = round(sum(rowHeights) + sum(rowGaps));
  const footerHeight = round(contentToDotsGap + pageDotsHeight + dotsToDockGap + dockHeight);
  const rowBounds = buildMobileHomeRowBounds(rowHeights, rowGaps);
  const rowStarts = rowBounds.map((bound) => bound.top) as unknown as SixNumbers;
  const rowEnds = rowBounds.map((bound) => bound.bottom) as unknown as SixNumbers;
  const heroHeight = round(rowHeights[0] + rowGaps[0] + rowHeights[1]);
  const heroWidth = Math.max(1, viewportWidth - REFERENCE_HORIZONTAL_PADDING * 2);
  const heroThumbSize = round(heroWidth * (1 - 0.0395 * 2 - 0.0226 * 2) / 3);
  return {
    version: MOBILE_HOME_LAYOUT_VERSION,
    columns: MOBILE_HOME_COLUMNS,
    logicalRows: MOBILE_HOME_LOGICAL_ROWS,
    rowHeights,
    rowGaps,
    rowStarts,
    rowEnds,
    rowBounds,
    rowGap: baseRowGaps[0],
    columnGap,
    desktopHeight,
    flexibleSpacer: 0,
    contentToDotsGap,
    dotsToDockGap,
    footerHeight,
    dockHeight,
    pageDotsHeight,
    footerGap: dotsToDockGap,
    heroHeight,
    heroThumbSize,
    topPadding,
    bottomPadding,
    safeAreaTop,
    safeAreaBottom,
    minimumRequiredHeight,
    extraHeight,
    enabled:
      viewportWidth <= 600 &&
      viewportHeight > viewportWidth &&
      viewportHeight + 0.5 >= minimumRequiredHeight &&
      extraHeight >= MIN_DISTRIBUTABLE_HEIGHT,
  };
}

/**
 * A browser-tab-safe home layout. Unlike the historical v3 contract this is
 * allowed to run when browser chrome makes the visual viewport shorter than
 * the device screen. It keeps the Dock in normal layout flow and only enters
 * scrollable mode when the device is too short to fit the minimum tap targets.
 */
export function calculateMobileHomeResponsiveLayout(input: MobileHomeLayoutInput): MobileHomeResponsiveLayout {
  const viewportWidth = Math.max(1, Math.round(finiteNonNegative(input.viewportWidth)));
  const viewportHeight = Math.max(1, Math.round(finiteNonNegative(input.viewportHeight)));
  const safeAreaTop = Math.round(finiteNonNegative(input.safeAreaTop));
  const safeAreaBottom = Math.round(finiteNonNegative(input.safeAreaBottom));
  const widthScale = scaleForWidth(viewportWidth);
  const bottomPadding = Math.max(MIN_BOTTOM_PADDING, safeAreaBottom);
  const topSafeAreaExtra = Math.max(0, safeAreaTop - scaled(REFERENCE_TOP_PADDING, widthScale));
  const heightScale = (viewportHeight - bottomPadding - topSafeAreaExtra) / REFERENCE_TOTAL_HEIGHT;
  const contentScale = round(Math.max(MIN_RESPONSIVE_SCALE, Math.min(widthScale, heightScale)));
  const rowHeights = REFERENCE_ROW_HEIGHTS.map((value) => scaled(value, contentScale)) as unknown as SixNumbers;
  const rowGaps = REFERENCE_ROW_GAPS.map((value) => scaled(value, contentScale)) as unknown as FiveNumbers;
  const topPadding = round(Math.max(scaled(REFERENCE_TOP_PADDING, contentScale), safeAreaTop + 1));
  const columnGap = scaled(8, Math.max(contentScale, 0.86));
  const dockHeight = scaled(REFERENCE_DOCK_HEIGHT, contentScale);
  const pageDotsHeight = Math.max(8, scaled(REFERENCE_PAGE_DOTS_HEIGHT, contentScale));
  const dotsToDockGap = scaled(REFERENCE_DOTS_TO_DOCK_GAP, contentScale);
  const contentToDotsGap = scaled(REFERENCE_CONTENT_TO_DOTS_GAP, contentScale);
  const desktopHeight = round(sum(rowHeights) + sum(rowGaps));
  const footerHeight = round(contentToDotsGap + pageDotsHeight + dotsToDockGap + dockHeight);
  const minimumRequiredHeight = round(topPadding + desktopHeight + footerHeight + bottomPadding);
  const flexibleSpacer = round(Math.max(0, viewportHeight - minimumRequiredHeight));
  const heroHeight = round(rowHeights[0] + rowGaps[0] + rowHeights[1]);
  const horizontalScale = Math.max(0.86, Math.min(1, contentScale / Math.max(widthScale, 0.01)));
  const heroWidth = Math.max(1, viewportWidth - round(36 * horizontalScale));
  const heroThumbSize = round(heroWidth * (1 - 0.0395 * 2 - 0.0226 * 2) / 3 * horizontalScale);
  const rowBounds = buildMobileHomeRowBounds(rowHeights, rowGaps);
  const rowStarts = rowBounds.map((bound) => bound.top) as unknown as SixNumbers;
  const rowEnds = rowBounds.map((bound) => bound.bottom) as unknown as SixNumbers;
  return {
    version: 6,
    columns: MOBILE_HOME_COLUMNS,
    logicalRows: MOBILE_HOME_LOGICAL_ROWS,
    rowHeights,
    rowGaps,
    rowStarts,
    rowEnds,
    rowBounds,
    rowGap: rowGaps[0],
    columnGap,
    desktopHeight,
    flexibleSpacer,
    contentToDotsGap,
    dotsToDockGap,
    footerHeight,
    dockHeight,
    pageDotsHeight,
    footerGap: dotsToDockGap,
    heroHeight,
    heroThumbSize,
    topPadding,
    bottomPadding,
    safeAreaTop,
    safeAreaBottom,
    minimumRequiredHeight,
    extraHeight: flexibleSpacer,
    contentScale,
    compact: contentScale < widthScale - 0.005,
    scrollable: minimumRequiredHeight > viewportHeight + 1,
  };
}

export function mobileHomeVisualGridPlacement(y: number, h: number) {
  const start = Math.max(0, Math.min(MOBILE_HOME_LOGICAL_ROWS - 1, Math.trunc(y) || 0));
  const span = Math.max(1, Math.min(MOBILE_HOME_LOGICAL_ROWS - start, Math.trunc(h) || 1));
  return { start: start * 2 + 1, end: (start + span - 1) * 2 + 2 };
}

export function nearestMobileHomeLogicalRow(y: number, rowBounds: readonly MobileHomeRowBound[]) {
  if (!rowBounds.length) return 0;
  for (let row = 0; row < rowBounds.length; row += 1) {
    const bound = rowBounds[row];
    if (y >= bound.top && y <= bound.bottom) return row;
    if (row < rowBounds.length - 1 && y > bound.bottom && y < rowBounds[row + 1].top) {
      return y - bound.bottom <= rowBounds[row + 1].top - y ? row : row + 1;
    }
  }
  return y < rowBounds[0].top ? 0 : rowBounds.length - 1;
}

export const MOBILE_HOME_HORIZONTAL_PADDING = REFERENCE_HORIZONTAL_PADDING;
