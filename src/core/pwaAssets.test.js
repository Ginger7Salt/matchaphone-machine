import {readFileSync,existsSync} from "node:fs";
import path from "node:path";
import {describe,expect,it} from "vitest";

const root=path.resolve(process.cwd());
const read=(relative)=>readFileSync(path.join(root,relative));
const text=(relative)=>read(relative).toString("utf8");
const pngSize=(relative)=>{const bytes=read(relative);expect(bytes.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");return{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}};

describe("PWA matcha cup icons",()=>{
  it("declares versioned PNG icons for regular and maskable installs",()=>{
    const manifest=JSON.parse(text("public/manifest.webmanifest"));
    expect(manifest.icons).toEqual([
      {src:"./icon-192-v2.png",sizes:"192x192",type:"image/png",purpose:"any"},
      {src:"./icon-512-v2.png",sizes:"512x512",type:"image/png",purpose:"any"},
      {src:"./icon-maskable-512-v2.png",sizes:"512x512",type:"image/png",purpose:"maskable"},
    ]);
    for(const icon of manifest.icons)expect(existsSync(path.join(root,"public",icon.src.replace(/^\.\//,"")))).toBe(true);
  });

  it("ships PNGs at their declared sizes",()=>{
    expect(pngSize("public/icon-192-v2.png")).toEqual({width:192,height:192});
    expect(pngSize("public/icon-512-v2.png")).toEqual({width:512,height:512});
    expect(pngSize("public/icon-maskable-512-v2.png")).toEqual({width:512,height:512});
    expect(pngSize("public/apple-touch-icon-v2.png")).toEqual({width:180,height:180});
  });

  it("keeps the maskable cup inside a padded full-bleed background",()=>{
    const svg=text("public/icon-maskable-v2.svg");
    expect(svg).toContain('<rect width="512" height="512"');
    expect(svg).toContain('transform="translate(25.6 25.6) scale(.9)"');
  });

  it("links the same icon family from HTML and notifications",()=>{
    const html=text("index.html");
    const notifications=text("src/core/notifications.ts");
    expect(html).toContain('rel="apple-touch-icon" href="%BASE_URL%apple-touch-icon-v2.png" sizes="180x180"');
    expect(html).toContain('rel="icon" href="%BASE_URL%icon-v2.svg" type="image/svg+xml"');
    expect(notifications).toContain('icon:payload.icon||appAssetPath("icon-192-v2.png"),badge:appAssetPath("icon-192-v2.png")');
  });
});
