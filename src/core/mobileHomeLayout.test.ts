import { describe, expect, it } from "vitest";
import {
  MOBILE_HOME_LAYOUT_VERSION,
  calculateMobileHomeLayout,
  calculateMobileHomeResponsiveLayout,
  isMobileHomeFullCanvasEnvironment,
  mobileHomeVisualGridPlacement,
  nearestMobileHomeLogicalRow,
} from "./mobileHomeLayout";

const fullCanvas = (overrides: Partial<Parameters<typeof isMobileHomeFullCanvasEnvironment>[0]> = {}) => ({
  routeIsHome: true,
  viewportWidth: 390,
  viewportHeight: 844,
  screenWidth: 390,
  screenHeight: 844,
  screenAvailHeight: 844,
  touchCapable: true,
  portrait: true,
  keyboardOpen: false,
  ...overrides,
});


describe("mobile home layout v6 responsive contract", () => {
  it.each([
    [320, 568], [360, 640], [360, 800], [390, 760], [390, 844], [412, 915],
  ])("keeps the footer in normal flow for %ix%i", (width, height) => {
    const metrics = calculateMobileHomeResponsiveLayout({ viewportWidth: width, viewportHeight: height });
    expect(metrics.version).toBe(6);
    expect(metrics.rowHeights).toHaveLength(6);
    expect(metrics.footerHeight).toBeGreaterThanOrEqual(70);
    expect(metrics.dockHeight).toBeGreaterThanOrEqual(63);
    if (metrics.scrollable) expect(metrics.minimumRequiredHeight).toBeGreaterThan(height);
    else expect(metrics.topPadding + metrics.desktopHeight + metrics.footerHeight + metrics.bottomPadding).toBeLessThanOrEqual(height + 1);
    expect(metrics.minimumRequiredHeight).toBeGreaterThan(0);
  });

  it("uses the visible safe area without changing the legacy v3 contract", () => {
    const metrics = calculateMobileHomeResponsiveLayout({ viewportWidth: 390, viewportHeight: 844, safeAreaTop: 47, safeAreaBottom: 34 });
    expect(metrics.safeAreaTop).toBe(47);
    expect(metrics.bottomPadding).toBe(34);
    expect(metrics.topPadding).toBeGreaterThanOrEqual(48);
    expect(metrics.minimumRequiredHeight).toBeLessThanOrEqual(844 + 1);
    expect(calculateMobileHomeLayout({ viewportWidth: 390, viewportHeight: 844 }).version).toBe(MOBILE_HOME_LAYOUT_VERSION);
  });

  it("marks only extremely short screens as scrollable instead of hiding the Dock", () => {
    expect(calculateMobileHomeResponsiveLayout({ viewportWidth: 390, viewportHeight: 760 }).scrollable).toBe(false);
    expect(calculateMobileHomeResponsiveLayout({ viewportWidth: 320, viewportHeight: 568 }).scrollable).toBe(true);
  });
});
describe("mobile PWA home layout contract v3", () => {
  it.each([
    [360, 800], [390, 844], [393, 873], [402, 874],
    [414, 896], [412, 915], [432, 960], [432, 1024],
  ])("keeps six logical rows, square Hero media and a bounded footer gap at %ix%i", (width, height) => {
    const metrics = calculateMobileHomeLayout({ viewportWidth: width, viewportHeight: height });
    expect(metrics.version).toBe(MOBILE_HOME_LAYOUT_VERSION);
    expect(metrics.enabled).toBe(true);
    expect(metrics.columns).toBe(4);
    expect(metrics.logicalRows).toBe(6);
    expect(metrics.rowHeights).toHaveLength(6);
    expect(metrics.rowGaps).toHaveLength(5);
    expect(metrics.heroHeight).toBeCloseTo(metrics.rowHeights[0] + metrics.rowGaps[0] + metrics.rowHeights[1], 3);
    expect(metrics.heroThumbSize).toBeGreaterThan(94);
    expect(metrics.heroThumbSize).toBeLessThan(125);
    expect(metrics.contentToDotsGap).toBeLessThanOrEqual(height * 0.15);
    expect(metrics.topPadding + metrics.desktopHeight + metrics.footerHeight + metrics.bottomPadding).toBeCloseTo(height, 1);
    expect(metrics.flexibleSpacer).toBe(0);
  });

  it("distributes tall-screen space instead of putting it all between Apps and Dock", () => {
    const standard = calculateMobileHomeLayout({ viewportWidth: 390, viewportHeight: 844 });
    const tall = calculateMobileHomeLayout({ viewportWidth: 432, viewportHeight: 1024 });
    expect(tall.topPadding).toBeGreaterThan(standard.topPadding);
    expect(tall.rowGaps[1]).toBeGreaterThan(standard.rowGaps[1]);
    expect(tall.rowGaps[3]).toBeGreaterThan(standard.rowGaps[3]);
    expect(tall.contentToDotsGap).toBeLessThanOrEqual(60);
  });

  it("keeps the Dock above a non-zero bottom safe area", () => {
    const metrics = calculateMobileHomeLayout({ viewportWidth: 390, viewportHeight: 896, safeAreaTop: 47, safeAreaBottom: 34 });
    expect(metrics.safeAreaTop).toBe(47);
    expect(metrics.bottomPadding).toBe(34);
    expect(metrics.topPadding + metrics.desktopHeight + metrics.footerHeight + metrics.bottomPadding).toBeCloseTo(896, 2);
  });

  it("does not activate for short, wide or desktop viewports", () => {
    expect(calculateMobileHomeLayout({ viewportWidth: 390, viewportHeight: 620 }).enabled).toBe(false);
    expect(calculateMobileHomeLayout({ viewportWidth: 844, viewportHeight: 390 }).enabled).toBe(false);
    expect(calculateMobileHomeLayout({ viewportWidth: 900, viewportHeight: 1200 }).enabled).toBe(false);
  });

  it("recognizes explicit PWA modes and strict full-canvas mobile windows", () => {
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ displayModeStandalone: true }))).toBe(true);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ displayModeMinimalUi: true }))).toBe(true);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ androidAppReferrer: true }))).toBe(true);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas())).toBe(true);
  });

  it("rejects ordinary tabs, keyboard windows, landscape, desktop and non-home routes", () => {
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ viewportHeight: 730 }))).toBe(false);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ keyboardOpen: true }))).toBe(false);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ portrait: false }))).toBe(false);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ routeIsHome: false }))).toBe(false);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ touchCapable: false }))).toBe(false);
    expect(isMobileHomeFullCanvasEnvironment(fullCanvas({ viewportWidth: 900, screenWidth: 900 }))).toBe(false);
  });

  it("maps persisted logical rows through explicit visual gap tracks", () => {
    expect(Array.from({ length: 6 }, (_, y) => mobileHomeVisualGridPlacement(y, 1))).toEqual([
      { start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 6 },
      { start: 7, end: 8 }, { start: 9, end: 10 }, { start: 11, end: 12 },
    ]);
    expect(mobileHomeVisualGridPlacement(0, 2)).toEqual({ start: 1, end: 4 });
    expect(mobileHomeVisualGridPlacement(3, 2)).toEqual({ start: 7, end: 10 });
  });

  it("maps pointers in variable gaps to the nearest logical row", () => {
    const metrics = calculateMobileHomeLayout({ viewportWidth: 432, viewportHeight: 1024 });
    const gapStart = metrics.rowEnds[1], gapEnd = metrics.rowStarts[2];
    expect(nearestMobileHomeLogicalRow(gapStart + 1, metrics.rowBounds)).toBe(1);
    expect(nearestMobileHomeLogicalRow(gapEnd - 1, metrics.rowBounds)).toBe(2);
  });
});
