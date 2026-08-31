export const PUBLIC_DEMO_MODE = import.meta.env.VITE_PUBLIC_DEMO === "true";
export const APP_BASE_PATH = import.meta.env.BASE_URL || "/";

export function appAssetPath(asset: string) {
  const base = APP_BASE_PATH.endsWith("/") ? APP_BASE_PATH : `${APP_BASE_PATH}/`;
  return `${base}${asset.replace(/^\/+/, "")}`;
}

export function publicDemoBackendError(service: string): Error {
  return new Error(`公开演示版不连接${service}，请使用浏览器直连 Provider。`);
}
