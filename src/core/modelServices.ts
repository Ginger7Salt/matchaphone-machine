import {getSetting,setSetting} from "./db";
import {OpenAIProvider,testProviderConnection as testProviderConnectionRaw} from "./provider";
import {defaultModelServiceSettings,defaultProvider,type ModelServiceSettings,type ProviderSettings} from "./types";

export const MODEL_SERVICES_KEY="model-services-v1";
function providerOf(value: Partial<ProviderSettings> | undefined, fallback: ProviderSettings): ProviderSettings {
 const result: ProviderSettings = {
  ...fallback,
  ...value,
  baseUrl: (value?.baseUrl ?? fallback.baseUrl).trim(),
  apiKey: (value?.apiKey ?? "").trim(),
  model: (value?.model ?? fallback.model).trim(),
  stream: false,
  protocol: ["auto","openai-compatible","openai-responses","gemini","claude","deepseek-compatible"].includes(String(value?.protocol)) ? value?.protocol : fallback.protocol,
  temperature: Math.max(0, Math.min(2, Number(value?.temperature ?? fallback.temperature))),
  maxTokens: Math.max(1, Math.trunc(Number(value?.maxTokens ?? fallback.maxTokens))),
  contextLimit: Math.max(2, Math.min(100, Math.trunc(Number(value?.contextLimit ?? fallback.contextLimit)))),
  timeoutMs: Math.max(1000, Math.trunc(Number(value?.timeoutMs ?? fallback.timeoutMs))),
 };
 if (value?.contextBudgetMode !== undefined || value?.contextWindowTokens !== undefined || fallback.contextBudgetMode !== undefined || fallback.contextWindowTokens !== undefined) {
  result.contextBudgetMode = (value?.contextBudgetMode ?? fallback.contextBudgetMode) === "custom" ? "custom" : "auto";
  result.contextWindowTokens = Math.max(8_000, Math.min(1_000_000, Math.trunc(Number(value?.contextWindowTokens ?? fallback.contextWindowTokens ?? 128_000))));
 }
 return result;
}
export function normalizeModelServiceSettings(value:unknown):ModelServiceSettings{const raw=value as Partial<ModelServiceSettings>|undefined;return{version:1,secondary:{enabled:raw?.secondary?.enabled??false,provider:providerOf(raw?.secondary?.provider,{...defaultProvider,stream:false,temperature:.3})},vision:{enabled:raw?.vision?.enabled??false,provider:providerOf(raw?.vision?.provider,{...defaultProvider,model:"gpt-4.1-mini",stream:false,temperature:.2,maxTokens:500}),instruction:raw?.vision?.instruction?.trim()||defaultModelServiceSettings.vision.instruction}}}
export async function getModelServiceSettings(){return normalizeModelServiceSettings(await getSetting<unknown>(MODEL_SERVICES_KEY,defaultModelServiceSettings))}
export async function saveModelServiceSettings(settings:ModelServiceSettings){const normalized=normalizeModelServiceSettings(settings);await setSetting(MODEL_SERVICES_KEY,normalized);return normalized}
export function configuredProvider(value:{enabled:boolean;provider:ProviderSettings}){return value.enabled&&Boolean(value.provider.apiKey.trim()&&value.provider.baseUrl.trim()&&value.provider.model.trim())}
export async function resolveSecondaryProvider(primary:ProviderSettings){const settings=await getModelServiceSettings();return configuredProvider(settings.secondary)?settings.secondary.provider:primary}
export async function testDedicatedProvider(provider:ProviderSettings){if(!provider.baseUrl.trim()||!provider.apiKey.trim()||!provider.model.trim())throw new Error("请填写 Base URL、API Key 和模型名称");await new OpenAIProvider({...provider,stream:false}).test()}
export async function describeImageWithVision(imageUrl:string,hint=""){const settings=await getModelServiceSettings();if(!configuredProvider(settings.vision))return;const prompt=[settings.vision.instruction,hint.trim()?`用户补充说明：${hint.trim()}`:"","只输出一段可供角色理解图片的客观描述，不要输出标题、JSON 或分析过程。"].filter(Boolean).join("\n");return(await new OpenAIProvider({...settings.vision.provider,stream:false}).chat([{role:"system",content:"你是独立的图片理解服务，只负责提取图片中可见的信息。"},{role:"user",content:prompt,imageUrl}],{stream:false})).trim()||undefined}
export async function clearModelServiceKeys(){const settings=await getModelServiceSettings(),next:ModelServiceSettings={...settings,secondary:{...settings.secondary,provider:{...settings.secondary.provider,apiKey:""}},vision:{...settings.vision,provider:{...settings.vision.provider,apiKey:""}}};await saveModelServiceSettings(next);return next}