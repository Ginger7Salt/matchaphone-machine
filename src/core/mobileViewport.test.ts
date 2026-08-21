import {describe,expect,it} from "vitest";
import {cssViewportVariablesOf,keyboardModeOf,readMobileViewportSnapshot} from "./mobileViewport";

describe("mobile viewport snapshot",()=>{
 it("falls back to layout dimensions without visual viewport APIs",()=>{
  const snapshot=readMobileViewportSnapshot({innerWidth:390,innerHeight:844,documentClientWidth:390,documentClientHeight:844});
  expect(snapshot).toMatchObject({layoutWidth:390,layoutHeight:844,visualWidth:390,visualHeight:844,keyboardMode:"none",keyboardInset:0,orientation:"portrait"});
 });
 it("uses the visual viewport height without adding an overlay inset for a shrinking keyboard",()=>{
  const snapshot=readMobileViewportSnapshot({innerWidth:390,innerHeight:844,documentClientWidth:390,documentClientHeight:844,visualWidth:390,visualHeight:520,visualOffsetTop:0,virtualKeyboardInset:0,stableLayoutWidth:390,stableLayoutHeight:844});
  expect(snapshot.keyboardMode).toBe("viewport-shrink");
  expect(snapshot.keyboardInset).toBe(0);
  expect(snapshot.layoutHeight).toBe(844);
  expect(cssViewportVariablesOf(snapshot)["--app-viewport-height"]).toBe("520px");
  expect(cssViewportVariablesOf(snapshot)["--app-height"]).toBe("520px");
  expect(cssViewportVariablesOf(snapshot)["--visible-viewport-height"]).toBe("520px");
 });
 it("uses one overlay inset when the visual viewport stays stable",()=>{
  const snapshot=readMobileViewportSnapshot({innerWidth:390,innerHeight:844,documentClientWidth:390,documentClientHeight:844,visualWidth:390,visualHeight:844,virtualKeyboardInset:280,stableLayoutWidth:390,stableLayoutHeight:844});
  expect(snapshot.keyboardMode).toBe("overlay");
  expect(snapshot.keyboardInset).toBe(280);
  expect(cssViewportVariablesOf(snapshot)["--app-viewport-height"]).toBe("844px");
 });
 it("prefers viewport shrink over a duplicate virtual keyboard inset",()=>{
  expect(keyboardModeOf({innerHeight:844,visualHeight:520,visualOffsetTop:0,virtualKeyboardInset:280})).toBe("viewport-shrink");
 });
 it("clamps invalid dimensions and detects landscape orientation",()=>{
  const snapshot=readMobileViewportSnapshot({innerWidth:844,innerHeight:390,documentClientWidth:844,documentClientHeight:390,visualWidth:844,visualHeight:390,safeAreaTop:-2,safeAreaBottom:34});
  expect(snapshot).toMatchObject({layoutWidth:844,layoutHeight:390,orientation:"landscape",safeAreaTop:0,safeAreaBottom:34});
 });
 it("uses the stable layout while an overlay keyboard is present",()=>{
  const snapshot=readMobileViewportSnapshot({innerWidth:390,innerHeight:844,documentClientWidth:390,documentClientHeight:844,visualWidth:390,visualHeight:844,virtualKeyboardInset:300,stableLayoutWidth:390,stableLayoutHeight:844});
  expect(snapshot.layoutHeight).toBe(844);
  expect(snapshot.visualHeight).toBe(844);
 });
});
