import {Component,useEffect,useRef,useState} from "react";
import {
 BellRing,
 BrainCircuit,
 CheckCircle2,
 CloudCog,
 CloudDownload,
 CloudUpload,
 Download,
 Eye,
 EyeOff,
 FileUp,
 GitBranch,
 KeyRound,
 LoaderCircle,
 RadioTower,
 RefreshCw,
 Save,
 ScanEye,
 SmilePlus,
 Trash2,
 Volume2,
 WandSparkles
} from "lucide-react";
import {useNavigate} from "react-router-dom";
import {AppTopBar,Modal} from "../components/ui";
import {clearGitHubCredentials,createBackup,downloadJson,factoryReset,restoreBackup} from "../core/backup";
import {getSetting,setSetting} from "../core/db";
import {decryptBackup,encryptBackup,GitHubBackupClient} from "../core/githubBackup";
import {
 clearModelServiceKeys,
 getModelServiceSettings,
 saveModelServiceSettings,
 testDedicatedProvider
} from "../core/modelServices";
import {OpenAIProvider,ProviderError,createProviderTransport,testProviderConnection} from "../core/provider";
import {backgroundActivitySettingsOf,notificationSettingsOf,saveBackgroundActivitySettings,saveNotificationSettings} from "../core/notificationSettings";
import {notificationSupported,requestTeaNotificationPermission,sendTestNotification} from "../core/notifications";
import {getEmbeddingSettings,saveEmbeddingSettings,testEmbeddingConnection} from "../core/embedding";
import {startBackgroundActivities,stopBackgroundActivity} from "../core/backgroundAudio";
import {
 activateProviderPreset,
 clearProviderPresetKeys,
 deactivateProviderPreset,
 deleteProviderPreset,
 getProviderPresetState,
 saveProviderPreset
} from "../core/providerPresets";
import {useStore} from "../core/store";
import {
 backupSchema,
 defaultModelServiceSettings,
 defaultProvider,
 type BackgroundActivityKeepaliveMode,
 type BackgroundActivitySettings,
  type EmbeddingServiceSettings,
 type GitHubBackupSettings,
  type NotificationSettings,
 type ModelServiceSettings,
 type ProviderPreset,
 type ProviderPresetState,
 type ProviderSettings
} from "../core/types";

const emptyGitHub:GitHubBackupSettings={owner:"",repo:"",branch:"main",path:"mira-backup.enc.json",token:""};
const counts=(backup:any)=>({角色:backup.data.characters.length,会话:backup.data.conversations.length,消息:backup.data.messages.length,动态:backup.data.feedPosts.length,世界书:backup.data.loreBooks.length,记忆:backup.data.memories.length,待审核:backup.data.memoryExtractionBatches?.length??0,媒体:backup.data.mediaAssets?.length??0,表情分组:backup.data.stickerPacks?.length??0});
type StatusValue={ok:boolean;text:string};
type ServiceKind="secondary"|"vision";
function connectivityErrorText(result:{kind?:string;httpStatus?:number;providerCode?:string;protocol?:string;relayErrorCode?:string}){
 if(result.kind==="relay")return result.relayErrorCode==="relay-activation-invalid"?"安全 Relay 需要有效的茶茶机激活许可，请先完成激活。":result.relayErrorCode==="relay-endpoint-blocked"?"该 Provider Endpoint 被安全 Relay 拦截，请使用公网 HTTPS 地址。":result.relayErrorCode==="relay-timeout"?"安全 Relay 等待 Provider 超时，请稍后重试。":result.relayErrorCode==="relay-unavailable"?"安全 Relay 暂时不可用，请稍后重试。":"安全 Relay 请求失败，请查看诊断信息。";
 if(result.kind==="protocol")return "请求协议与 Endpoint 不匹配，请检查协议选择和 Base URL。";
 if(result.kind==="context")return "Provider 不接受当前输入长度，请降低上下文窗口配置或更换模型。";
 if(result.kind==="cors")return "\u5f53\u524d Provider \u4e0d\u652f\u6301\u6d4f\u89c8\u5668\u76f4\u8fde\u6216\u8de8\u57df\u8bbf\u95ee\uff0c\u8bf7\u66f4\u6362\u652f\u6301 CORS \u7684\u5730\u5740\u3002";
 if(result.kind==="auth")return "Provider \u9274\u6743\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 API Key\u3001Base URL \u548c\u6a21\u578b\u6743\u9650\u3002";
 if(result.kind==="rate")return "Provider \u5f53\u524d\u8fbe\u5230\u8c03\u7528\u9891\u7387\u6216\u989d\u5ea6\u9650\u5236\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002";
 if(result.kind==="server")return `Provider \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528${result.httpStatus?` (HTTP \${result.httpStatus})`:""}\u3002`;
 return result.providerCode?`Provider \u8fde\u63a5\u5931\u8d25 (${result.providerCode})\u3002` : "Provider \u8fde\u63a5\u5931\u8d25\u3002";
}

export default function SettingsPage(){
 const nav=useNavigate();
 const {provider,settings,reload}=useStore();
 const [form,setForm]=useState<ProviderSettings>(provider??defaultProvider);
 const [show,setShow]=useState(false);
 const [busy,setBusy]=useState(false);
 const [models,setModels]=useState<string[]>([]);
 const [query,setQuery]=useState("");
 const [status,setStatus]=useState<StatusValue|null>(null);
 const [providerPresets,setProviderPresets]=useState<ProviderPresetState>({version:1,items:[]});
 const [presetName,setPresetName]=useState("");
 const [editingPresetId,setEditingPresetId]=useState("");
 const [modelServices,setModelServices]=useState<ModelServiceSettings>(defaultModelServiceSettings);
 const [showSecondary,setShowSecondary]=useState(false);
 const [showVision,setShowVision]=useState(false);
 const [embeddingDraft,setEmbeddingDraft]=useState<EmbeddingServiceSettings>({enabled:false,baseUrl:"https://api.openai.com/v1",apiKey:"",model:"text-embedding-3-small",batchSize:20});
 const [showEmbedding,setShowEmbedding]=useState(false);
 const [embeddingStatus,setEmbeddingStatus]=useState<StatusValue|null>(null);
 const [serviceStatus,setServiceStatus]=useState<Record<ServiceKind,StatusValue|null>>({secondary:null,vision:null});
 const [serviceModels,setServiceModels]=useState<Record<ServiceKind,string[]>>({secondary:[],vision:[]});
 const [serviceQueries,setServiceQueries]=useState<Record<ServiceKind,string>>({secondary:"",vision:""});
 const [embeddingModels,setEmbeddingModels]=useState<string[]>([]);
 const [embeddingQuery,setEmbeddingQuery]=useState("");
 const [modelPickerOpen,setModelPickerOpen]=useState(false);
 const [servicePickerOpen,setServicePickerOpen]=useState<Record<ServiceKind,boolean>>({secondary:false,vision:false});
 const [embeddingPickerOpen,setEmbeddingPickerOpen]=useState(false);
 const [importPreview,setImportPreview]=useState<any>(null);
 const [github,setGithub]=useState<GitHubBackupSettings>(emptyGitHub);
 const [githubPass,setGithubPass]=useState("");
 const [githubStatus,setGithubStatus]=useState<StatusValue|null>(null);
 const [cloudPreview,setCloudPreview]=useState<any>(null);
 const [factoryOpen,setFactoryOpen]=useState(false);
 const [factoryText,setFactoryText]=useState("");
 const [notificationDraft,setNotificationDraft]=useState<NotificationSettings>(()=>notificationSettingsOf(settings));
 const [backgroundDraft,setBackgroundDraft]=useState<BackgroundActivitySettings>(()=>backgroundActivitySettingsOf(settings));
 const [notificationStatus,setNotificationStatus]=useState<StatusValue|null>(null);
 const fileRef=useRef<HTMLInputElement>(null);

 useEffect(()=>{
  void Promise.all([
   getSetting<GitHubBackupSettings>("github-backup",emptyGitHub),
   getProviderPresetState(),
   getModelServiceSettings(),
   getEmbeddingSettings()
  ]).then(([githubSettings,presets,services,embedding])=>{
   setGithub(githubSettings);
   setProviderPresets(presets);
   setModelServices(services);
   setEmbeddingDraft(embedding);
  });
 },[]);
 useEffect(()=>{setNotificationDraft(notificationSettingsOf(settings));setBackgroundDraft(backgroundActivitySettingsOf(settings))},[settings?.notifications,settings?.backgroundActivity]);

 const set=<K extends keyof ProviderSettings>(key:K,value:ProviderSettings[K])=>{
  setForm(current=>({...current,[key]:value}));
  setStatus(null);
 };
 const save=async()=>{
  setBusy(true);
  try{
   await setSetting("provider",form);
   setProviderPresets(await deactivateProviderPreset());
   await reload();
   setStatus({ok:true,text:"设置已保存；当前未绑定预设"});
  }finally{setBusy(false)}
 };
 const requireFields=()=>{
  if(!form.baseUrl.trim()||!form.apiKey.trim())throw new ProviderError("format","请先填写 Base URL 和 API Key");
 };
 const discoverModels=async(provider:ProviderSettings)=>{
  const transport=createProviderTransport(provider);
  return transport.listModels?.(provider) ?? {supported:false,protocol:provider.protocol??"auto",reason:"unsupported" as const,models:[]};
 };
 const modelDiscoveryMessage=(result:{reason?:string;protocol?:string})=>{
  if(result.reason==="unsupported")return "当前协议（"+(result.protocol??"auto")+"）不提供通用模型列表，请手动填写模型名称。";
  if(result.reason==="auth")return "模型列表认证失败，请检查 API Key 和模型权限。";
  if(result.reason==="cors")return "模型列表请求被浏览器 CORS 拦截，请确认 Provider 允许网页直连。";
  if(result.reason==="network")return "模型列表网络请求失败，请检查网络或安全 Relay。";
 if(result.reason==="invalid-response")return "Provider 返回的模型列表格式无法识别。";
  return "当前 Provider 不支持自动拉取模型，请手动填写模型名称。";
 };
 const test=async()=>{
  setBusy(true);
  try{
   requireFields();
   if(!form.model.trim())throw new ProviderError("format","请填写或选择模型");
   const result=await testProviderConnection({...form,stream:false});
   if(!result.ok)throw new ProviderError("format",connectivityErrorText(result));
   setStatus({ok:true,text:`连接成功（${result.protocol??"auto"}），模型已正常响应`});
  }catch(error){setStatus({ok:false,text:error instanceof Error?error.message:"连接失败"})}
  finally{setBusy(false)}
 };
 const fetchModels=async()=>{
  setBusy(true);
  setStatus(null);
  try{
   requireFields();
   const result=await discoverModels(form);
   if(!result.supported){setModels([]);setModelPickerOpen(false);setStatus({ok:false,text:modelDiscoveryMessage(result)});return;}
   const ids=result.models??[];
   setModels(ids);
   setModelPickerOpen(true);
   setStatus({ok:true,text:"已拉取 "+ids.length+" 个模型（"+result.protocol+"）"});
  }catch(error){setStatus({ok:false,text:error instanceof Error?error.message:"拉取失败"})}
  finally{setBusy(false)}
 };
 const clear=async()=>{
  const next={...form,apiKey:""};
  setForm(next);
  setModels([]);
  await setSetting("provider",next);
  setProviderPresets(await clearProviderPresetKeys());
  setModelServices(await clearModelServiceKeys());
  await reload();
  setStatus({ok:true,text:"已清除主 API、全部主 API 预设、副 API 和识图 API 的密钥"});
 };
 const storePreset=async()=>{
  setBusy(true);
  try{
   requireFields();
   if(!form.model.trim())throw new ProviderError("format","请填写或选择模型");
   const result=await saveProviderPreset({id:editingPresetId||undefined,name:presetName,provider:form});
   setProviderPresets(result.state);
   setEditingPresetId(result.preset.id);
   setPresetName(result.preset.name);
   setForm(result.preset.provider);
   await reload();
   setStatus({ok:true,text:`已保存并启用预设“${result.preset.name}”`});
  }catch(error){setStatus({ok:false,text:error instanceof Error?error.message:"预设保存失败"})}
  finally{setBusy(false)}
 };
 const switchPreset=async(id:string)=>{
  setBusy(true);
  try{
   const result=await activateProviderPreset(id);
   setProviderPresets(result.state);
   setEditingPresetId(result.preset.id);
   setPresetName(result.preset.name);
   setForm(result.preset.provider);
   setModels([]);
   await reload();
   setStatus({ok:true,text:`已切换到预设“${result.preset.name}”；副 API 与识图 API 保持不变`});
  }catch(error){setStatus({ok:false,text:error instanceof Error?error.message:"预设切换失败"})}
  finally{setBusy(false)}
 };
 const editPreset=(preset:ProviderPreset)=>{
  setEditingPresetId(preset.id);
  setPresetName(preset.name);
  setForm(preset.provider);
  setModels([]);
  setStatus({ok:true,text:`正在编辑预设“${preset.name}”`});
 };
 const newPreset=()=>{setEditingPresetId("");setPresetName("");setStatus(null)};
 const removePreset=async(id:string)=>{
  const next=await deleteProviderPreset(id);
  setProviderPresets(next);
  if(editingPresetId===id){setEditingPresetId("");setPresetName("")}
  setStatus({ok:true,text:"预设已删除"});
 };
 const patchServiceProvider=<K extends keyof ProviderSettings>(kind:ServiceKind,key:K,value:ProviderSettings[K])=>{
  setModelServices(current=>{const provider={...current[kind].provider,...({[key]:value} as Partial<ProviderSettings>)};if(key==="networkMode")provider.networkModeExplicit=true;return {...current,[kind]:{...current[kind],provider}}});
  setServiceStatus(current=>({...current,[kind]:null}));
 };
 const patchServiceEnabled=(kind:ServiceKind,enabled:boolean)=>{
  setModelServices(current=>({...current,[kind]:{...current[kind],enabled}}));
  setServiceStatus(current=>({...current,[kind]:null}));
 };
 const testService=async(kind:ServiceKind)=>{
  setBusy(true);
  setServiceStatus(current=>({...current,[kind]:null}));
  try{
   await testDedicatedProvider(modelServices[kind].provider);
   setServiceStatus(current=>({...current,[kind]:{ok:true,text:kind==="secondary"?"副 API 连接成功":"识图 API 连接成功"}}));
  }catch(error){setServiceStatus(current=>({...current,[kind]:{ok:false,text:error instanceof Error?error.message:"连接失败"}}))}
  finally{setBusy(false)}
 };
 const fetchServiceModels=async(kind:ServiceKind)=>{
  const provider=modelServices[kind].provider;setBusy(true);setServiceStatus(current=>({...current,[kind]:null}));
  try{if(!provider.baseUrl.trim()||!provider.apiKey.trim())throw new Error("请先填写 Base URL 和 API Key");const result=await discoverModels({...provider,model:provider.model.trim()||defaultProvider.model});if(!result.supported){setServiceModels(current=>({...current,[kind]:[]}));setServicePickerOpen(current=>({...current,[kind]:false}));setServiceStatus(current=>({...current,[kind]:{ok:false,text:modelDiscoveryMessage(result)}}));return;}const ids=result.models??[];setServiceModels(current=>({...current,[kind]:ids}));setServiceQueries(current=>({...current,[kind]:""}));setServicePickerOpen(current=>({...current,[kind]:true}));setServiceStatus(current=>({...current,[kind]:{ok:true,text:"已拉取 "+ids.length+" 个模型（"+result.protocol+"）"}}))}catch(error){setServiceStatus(current=>({...current,[kind]:{ok:false,text:error instanceof Error?error.message:"拉取模型失败"}}))}finally{setBusy(false)}
 };
 const fetchEmbeddingModels=async()=>{setBusy(true);setEmbeddingStatus(null);try{if(!embeddingDraft.baseUrl.trim()||!embeddingDraft.apiKey.trim())throw new Error("请先填写 Base URL 和 API Key");const ids=await new OpenAIProvider({...defaultProvider,baseUrl:embeddingDraft.baseUrl,apiKey:embeddingDraft.apiKey,model:embeddingDraft.model.trim()||defaultProvider.model,stream:false}).models(),sorted=[...ids].sort((a,b)=>Number(!/(?:embed|embedding)/i.test(a))-Number(!/(?:embed|embedding)/i.test(b))||a.localeCompare(b));setEmbeddingModels(sorted);setEmbeddingQuery("");setEmbeddingPickerOpen(true);setEmbeddingStatus({ok:true,text:`已拉取 ${ids.length} 个模型`})}catch(error){setEmbeddingStatus({ok:false,text:error instanceof Error?error.message:"拉取模型失败"})}finally{setBusy(false)}};
 const saveServices=async(kind:ServiceKind)=>{
  setBusy(true);
  try{
   const next=await saveModelServiceSettings(modelServices);
   setModelServices(next);
   setServiceStatus(current=>({...current,[kind]:{ok:true,text:kind==="secondary"?"副 API 已独立保存，不会随主 API 预设切换":"识图 API 已保存到当前设备"}}));
  }catch(error){setServiceStatus(current=>({...current,[kind]:{ok:false,text:error instanceof Error?error.message:"保存失败"}}))}
  finally{setBusy(false)}
 };
 const saveEmbedding=async()=>{setBusy(true);try{await saveEmbeddingSettings(embeddingDraft);setEmbeddingStatus({ok:true,text:"Embedding API 已保存；向量只保存在当前设备"})}catch(error){setEmbeddingStatus({ok:false,text:error instanceof Error?error.message:"保存失败"})}finally{setBusy(false)}};
 const testEmbedding=async()=>{setBusy(true);try{const result=await testEmbeddingConnection({...embeddingDraft,enabled:true});if(result.mode!=="configured"&&embeddingDraft.dimensions){setEmbeddingDraft(current=>({...current,dimensions:undefined}))}setEmbeddingStatus({ok:true,text:result.warning??`\u8fde\u63a5\u6210\u529f\uff0c\u5411\u91cf\u7ef4\u5ea6 ${result.dimensions}`})}catch(error){setEmbeddingStatus({ok:false,text:error instanceof Error?error.message:"\u8fde\u63a5\u5931\u8d25"})}finally{setBusy(false)}};
 const resetAll=async()=>{
  if(factoryText!=="永久删除全部数据")return;
  setBusy(true);
  await factoryReset();
  setFactoryOpen(false);
  setFactoryText("");
  await reload();
  window.location.assign("/");
 };
 const filtered=models.filter(item=>item.toLowerCase().includes(query.toLowerCase()));
 const exportLocal=async()=>downloadJson(await createBackup(),`chachaji-backup-${new Date().toISOString().slice(0,10)}.json`);
 const chooseBackup=async(file?:File)=>{
  if(!file)return;
  try{setImportPreview(backupSchema.parse(JSON.parse(await file.text())))}
  catch{setStatus({ok:false,text:"无法识别这个备份文件"})}
 };
 const restoreLocal=async()=>{
  if(!importPreview)return;
  setBusy(true);
  try{
   await restoreBackup(importPreview);
   await reload();
   setImportPreview(null);
   setStatus({ok:true,text:"本地备份已恢复，API Key 保持当前设备配置"});
  }catch(error){setStatus({ok:false,text:error instanceof Error?error.message:"恢复失败"})}
  finally{setBusy(false)}
 };
 const saveGithub=async()=>{
  await setSetting("github-backup",github);
  setGithubStatus({ok:true,text:"GitHub 配置已保存在当前浏览器，不会进入备份文件"});
 };
 const uploadGithub=async()=>{
  setBusy(true);setGithubStatus(null);
  try{
   await saveGithub();
   const encrypted=await encryptBackup(await createBackup(),githubPass),client=new GitHubBackupClient(github);
   let sha=github.lastSha;
   try{if(!sha)sha=(await client.get()).sha}catch(error:any){if(error.kind!=="not-found")throw error}
   const result=await client.put(encrypted,sha),next={...github,lastSha:result.sha,lastBackupAt:Date.now()};
   setGithub(next);await setSetting("github-backup",next);
   setGithubStatus({ok:true,text:"加密备份已上传到 GitHub 私有仓库"});
  }catch(error){setGithubStatus({ok:false,text:error instanceof Error?error.message:"上传失败"})}
  finally{setBusy(false)}
 };
 const downloadGithub=async()=>{
  setBusy(true);setGithubStatus(null);
  try{
   await saveGithub();
   const remote=await new GitHubBackupClient(github).get(),backup=backupSchema.parse(await decryptBackup(remote.content,githubPass));
   setCloudPreview({backup,sha:remote.sha});
   setGithubStatus({ok:true,text:"已读取云端备份，请确认内容后恢复"});
  }catch(error){setGithubStatus({ok:false,text:error instanceof Error?error.message:"读取失败"})}
  finally{setBusy(false)}
 };
 const restoreCloud=async()=>{
  if(!cloudPreview)return;
  setBusy(true);
  try{
   await restoreBackup(cloudPreview.backup);
   const next={...github,lastSha:cloudPreview.sha};
   setGithub(next);await setSetting("github-backup",next);await reload();
   setCloudPreview(null);setGithubStatus({ok:true,text:"GitHub 云端备份已恢复"});
  }finally{setBusy(false)}
 };

 const persistNotifications=async(next=notificationDraft)=>{const permission=typeof Notification!=="undefined"?Notification.permission:"denied",value={...next,enabled:next.enabled&&permission==="granted",permission};setNotificationDraft(value);await saveNotificationSettings(value);await reload();setNotificationStatus({ok:true,text:"通知设置已保存"})};
 const enableNotifications=async():Promise<NotificationPermission>=>{if(!notificationSupported()){const permission="denied" as const,next={...notificationDraft,enabled:false,permission};setNotificationDraft(next);await saveNotificationSettings(next);await reload();setNotificationStatus({ok:false,text:typeof window!=="undefined"&&!window.isSecureContext?"手机端系统通知需要使用 HTTPS 安全地址或安装后的 PWA，当前地址无法申请通知权限":"当前浏览器不支持系统通知或 Service Worker"});return permission}const permission=await requestTeaNotificationPermission(),next={...notificationDraft,enabled:permission==="granted",permission};setNotificationDraft(next);await saveNotificationSettings(next);await reload();setNotificationStatus({ok:permission==="granted",text:permission==="granted"?"系统通知已开启":permission==="denied"?"通知权限已被系统拒绝，请在浏览器或手机系统设置中重新允许":"通知权限尚未确认"});return permission};
 const toggleSystemNotifications=async()=>{if(notificationDraft.enabled){await persistNotifications({...notificationDraft,enabled:false});return}await enableNotifications()};
 const testNotification=async()=>{let permission=typeof Notification!=="undefined"?Notification.permission:"denied";if(permission!=="granted")permission=await enableNotifications();if(permission!=="granted")return;const ok=await sendTestNotification();setNotificationStatus({ok,text:ok?"测试通知已发送":"无法发送测试通知，请确认茶茶机已通过 HTTPS 打开或安装到主屏幕"})};
 const backgroundModesOf=(value:BackgroundActivitySettings)=>value.modes?.length?value.modes:value.mode!=="off"?[value.mode]:[];
 const applyBackgroundModes=async(input:BackgroundActivityKeepaliveMode[])=>{const modes=[...new Set(input)],active=await startBackgroundActivities(modes);if(!modes.length)stopBackgroundActivity();const enabled=modes.length>0&&active.length>0,next:BackgroundActivitySettings={mode:modes[0]??"off",modes,enabled,lastStartedAt:enabled?Date.now():backgroundDraft.lastStartedAt};setBackgroundDraft(next);await saveBackgroundActivitySettings(next);await reload();setNotificationStatus({ok:!modes.length||active.length>0,text:!modes.length?"后台保活已关闭":active.length===modes.length?`已启动 ${active.length} 种后台保活方式`:active.length?`已启动 ${active.length} 种保活方式，另有 ${modes.length-active.length} 种未能启动`:`浏览器阻止了保活音频启动，请再次点击或检查媒体权限`})};
 const toggleBackgroundMode=async(mode:BackgroundActivityKeepaliveMode)=>{const current=backgroundDraft.enabled?backgroundModesOf(backgroundDraft):[],next=current.includes(mode)?current.filter(item=>item!==mode):[...current,mode];await applyBackgroundModes(next)};
 const toggleBackgroundActivity=async(enabled:boolean)=>{if(enabled){const modes=backgroundModesOf(backgroundDraft);await applyBackgroundModes(modes.length?modes:["oscillator"]);return}stopBackgroundActivity();const next={...backgroundDraft,enabled:false};setBackgroundDraft(next);await saveBackgroundActivitySettings(next);await reload();setNotificationStatus({ok:true,text:"后台保活已关闭"})};

 return <div className="app-page settings-page">
  <AppTopBar className="settings-app-header" title="设置" backLabel="返回桌面" onBack={()=>nav("/")}/>
  <main className="settings-scroll"><div className="settings-form">
   <SettingsAccordion title="模型与 AI 服务" subtitle="API 预设、模型与向量服务">
   <section className="provider-presets-section">
    <small>API PRESETS</small><h3>API 预设管理</h3>
    <p className="section-note">将主 API 的地址、密钥、模型和参数保存为多个本机方案。切换主 API 预设不会修改副 API、识图 API 或语音服务。</p><p className="section-note provider-setup-hint">首次使用无需创建预设：直接填写下方主 API 设置并点击“保存设置”即可。预设是可选的本机快捷切换功能。</p>
    <div className="provider-preset-editor"><label>预设名称<input maxLength={40} value={presetName} onChange={event=>setPresetName(event.target.value)} placeholder="例如：日常聊天 / 高质量模型"/></label><div><button type="button" onClick={newPreset}>新建预设</button><button className="save" disabled={busy||!presetName.trim()||!form.apiKey.trim()||!form.model.trim()} onClick={()=>void storePreset()}><Save/>{editingPresetId?"更新预设":"保存预设"}</button></div></div>
    <div className="provider-preset-list">{providerPresets.items.length?providerPresets.items.map(preset=><article className={providerPresets.activeId===preset.id?"active":""} key={preset.id}><button className="provider-preset-main" disabled={busy} onClick={()=>void switchPreset(preset.id)}><span><b>{preset.name}</b><small>{preset.provider.model} · {preset.provider.baseUrl}</small></span><em>{providerPresets.activeId===preset.id?"使用中":"切换"}</em></button><button onClick={()=>editPreset(preset)}>编辑</button><button className="danger" aria-label={`删除预设 ${preset.name}`} onClick={()=>void removePreset(preset.id)}><Trash2/></button></article>):<p className="provider-preset-empty">还没有 API 预设。先在下方填写主 API 设置，再回到这里保存。</p>}</div>
    <p className="provider-preset-note">预设和 API Key 只保存在当前浏览器，不会进入本地或 GitHub 聊天备份。</p>
   </section>

   <section className="main-model-section">
    <small>PRIMARY API</small><h3>主 API 设置</h3><p className="section-note provider-setup-hint">填写 Base URL、API Key 和模型名称后，直接点击“保存设置”即可。测试连接和拉取模型是可选操作。</p>
    <label>Base URL<input value={form.baseUrl} onChange={event=>set("baseUrl",event.target.value)}/></label>
    <details className="provider-compatibility-diagnostics"><summary>兼容性诊断（高级）</summary><p className="section-note">正常使用无需修改。仅在接口文档明确要求特定协议，或需要诊断浏览器跨域问题时展开设置。</p><label>请求协议<select value={form.protocol??"auto"} onChange={event=>set("protocol",event.target.value as ProviderSettings["protocol"])}><option value="auto">自动判断</option><option value="openai-compatible">OpenAI 兼容</option><option value="openai-responses">OpenAI Responses</option><option value="gemini">Gemini 原生</option><option value="claude">Claude 原生</option><option value="deepseek-compatible">DeepSeek 兼容</option></select><small className="section-note">官方 Gemini / Claude API 请选择对应原生协议；中转站若提供 /chat/completions，请选择 OpenAI 兼容。</small></label><label>请求通道<select value={form.networkMode??"direct"} onChange={event=>{set("networkMode",event.target.value as ProviderSettings["networkMode"]);setForm(current=>({...current,networkModeExplicit:true}))}}><option value="relay">安全 Relay（高级）</option><option value="direct">浏览器直连（高级）</option></select><small className="section-note">安全 Relay 用于兼容不允许网页跨域访问的 API 中转站，且不会保存 API Key。两个通道之间不会自动重放请求。</small></label></details>
   <label>API Key<div className="secret-input"><input type={show?"text":"password"} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" value={form.apiKey} onChange={event=>set("apiKey",event.target.value)} placeholder="sk-..."/><button type="button" aria-label={show?"隐藏密钥":"显示密钥"} onClick={()=>setShow(!show)}>{show?<EyeOff/>:<Eye/>}</button></div></label>
    <label>模型名称<div className="model-input"><input value={form.model} onFocus={()=>models.length&&setModelPickerOpen(true)} onChange={event=>set("model",event.target.value)}/><button type="button" disabled={busy} onClick={fetchModels}><RefreshCw/>拉取模型</button></div></label>
    {modelPickerOpen&&models.length>0&&<ModelPicker models={models} query={query} selected={form.model} onQuery={setQuery} onClose={()=>setModelPickerOpen(false)} onSelect={model=>{set("model",model);setModelPickerOpen(false)}}/>}
    <label>Temperature<input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={event=>set("temperature",Number(event.target.value))}/></label>
    <label>上下文窗口<select value={form.contextBudgetMode??"auto"} onChange={event=>set("contextBudgetMode",event.target.value as ProviderSettings["contextBudgetMode"])}><option value="auto">自动设置（推荐）</option><option value="custom">自定义</option></select></label>
    {form.contextBudgetMode==="custom"&&<label>上下文窗口 Token 数<input type="number" min="8000" max="1000000" step="1000" value={form.contextWindowTokens??128000} onChange={event=>set("contextWindowTokens",Math.max(8000,Math.min(1000000,Math.trunc(Number(event.target.value)||128000))))}/><small className="section-note">请填写模型支持的总上下文窗口，不是单次输入或输出 Token 限制。</small></label>}
    <p className="section-note">自动设置按 128,000 Token 的安全窗口分配见面输入预算；只有 Provider 文档明确给出其他窗口大小时才需要自定义。</p>
    {status&&<Status value={status}/>}<div className="settings-actions"><button type="button" disabled={busy} onClick={test}>{busy?<LoaderCircle className="spin"/>:<CloudCog/>}测试连接</button><button type="button" className="save" disabled={busy} onClick={save}><Save/>保存设置</button></div>

   </section>

   <ServiceErrorBoundary name="副 API"><ServiceSection kind="secondary" title="副 API" eyebrow="SECONDARY API" icon={<GitBranch/>} note="副 API 独立保存，不跟随主 API 预设切换。用于关系判断、格式化、转账和商业行为等辅助任务；关闭或未配置时自动使用主 API。" value={modelServices.secondary} showKey={showSecondary} status={serviceStatus.secondary} busy={busy} onShowKey={setShowSecondary} onEnabled={enabled=>patchServiceEnabled("secondary",enabled)} onPatch={(key,value)=>patchServiceProvider("secondary",key,value)} models={serviceModels.secondary} query={serviceQueries.secondary} pickerOpen={servicePickerOpen.secondary} onPickerOpen={()=>setServicePickerOpen(current=>({...current,secondary:true}))} onPickerClose={()=>setServicePickerOpen(current=>({...current,secondary:false}))} onQuery={query=>setServiceQueries(current=>({...current,secondary:query}))} onFetchModels={()=>void fetchServiceModels("secondary")} onTest={()=>void testService("secondary")} onSave={()=>void saveServices("secondary")}/></ServiceErrorBoundary>

   <ServiceErrorBoundary name="识图 API"><ServiceSection kind="vision" title="识图 API" eyebrow="VISION API" icon={<ScanEye/>} note="用于把用户发送的图片读取为文字描述，再交给角色模型理解。关闭、未配置或识图失败时，会自动把原图片交给主 API 处理，不会阻止发送。" value={modelServices.vision} showKey={showVision} status={serviceStatus.vision} busy={busy} instruction={modelServices.vision.instruction} onInstruction={instruction=>setModelServices(current=>({...current,vision:{...current.vision,instruction}}))} onShowKey={setShowVision} onEnabled={enabled=>patchServiceEnabled("vision",enabled)} onPatch={(key,value)=>patchServiceProvider("vision",key,value)} models={serviceModels.vision} query={serviceQueries.vision} pickerOpen={servicePickerOpen.vision} onPickerOpen={()=>setServicePickerOpen(current=>({...current,vision:true}))} onPickerClose={()=>setServicePickerOpen(current=>({...current,vision:false}))} onQuery={query=>setServiceQueries(current=>({...current,vision:query}))} onFetchModels={()=>void fetchServiceModels("vision")} onTest={()=>void testService("vision")} onSave={()=>void saveServices("vision")}/></ServiceErrorBoundary>

   <ServiceErrorBoundary name="Embedding API"><section className="embedding-api-section"><div className="settings-service-heading"><span><BrainCircuit/></span><div><small>EMBEDDING API</small><h3>Embedding API</h3></div><button type="button" role="switch" aria-checked={embeddingDraft.enabled} aria-label="启用 Embedding API" className={`settings-switch-button ${embeddingDraft.enabled?"active":""}`} onClick={()=>setEmbeddingDraft(current=>({...current,enabled:!current.enabled}))}><span/></button></div><p className="section-note">为海马体记忆提供语义召回。独立保存，不跟随主 API 预设；未配置时自动使用关键词检索。</p><label>Base URL<input value={embeddingDraft.baseUrl} onChange={event=>setEmbeddingDraft({...embeddingDraft,baseUrl:event.target.value})}/></label><label>API Key<div className="secret-input"><input type={showEmbedding?"text":"password"} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" value={embeddingDraft.apiKey} onChange={event=>setEmbeddingDraft({...embeddingDraft,apiKey:event.target.value})} placeholder="sk-..."/><button type="button" onClick={()=>setShowEmbedding(!showEmbedding)}>{showEmbedding?<EyeOff/>:<Eye/>}</button></div></label><label>Embedding 模型<div className="model-input"><input value={embeddingDraft.model} onFocus={()=>embeddingModels.length&&setEmbeddingPickerOpen(true)} onChange={event=>setEmbeddingDraft(current=>({...current,model:event.target.value}))} placeholder="text-embedding-3-small"/><button type="button" disabled={busy||!embeddingDraft.apiKey.trim()} onClick={()=>void fetchEmbeddingModels()}><RefreshCw/>拉取模型</button></div></label>{embeddingPickerOpen&&embeddingModels.length>0&&<ModelPicker models={embeddingModels} query={embeddingQuery} selected={embeddingDraft.model} onQuery={setEmbeddingQuery} onClose={()=>setEmbeddingPickerOpen(false)} onSelect={model=>{setEmbeddingDraft(current=>({...current,model}));setEmbeddingPickerOpen(false)}}/>} <div className="form-row"><label>向量维度<input type="number" min="1" value={embeddingDraft.dimensions??""} onChange={event=>setEmbeddingDraft({...embeddingDraft,dimensions:event.target.value?Number(event.target.value):undefined})} placeholder="自动"/></label><label>每批数量<input type="number" min="1" max="100" value={embeddingDraft.batchSize} onChange={event=>setEmbeddingDraft({...embeddingDraft,batchSize:Number(event.target.value)})}/></label></div>{embeddingStatus&&<Status value={embeddingStatus}/>}<div className="settings-actions"><button disabled={busy||!embeddingDraft.apiKey.trim()} onClick={()=>void testEmbedding()}><CloudCog/>测试连接</button><button className="save" disabled={busy} onClick={()=>void saveEmbedding()}><Save/>保存 Embedding</button></div></section></ServiceErrorBoundary>
   </SettingsAccordion>

   <SettingsAccordion title="语音与媒体" subtitle="角色语音、AI 生图与表情包">
   <section><small>CHARACTER VOICE</small><h3>角色语音服务</h3><p className="section-note">配置 MiniMax 或 ElevenLabs，用于模拟通话中的角色朗读。</p><button className="settings-entry-button" onClick={()=>nav("/settings/speech")}><Volume2/><span><b>配置语音服务</b><small>服务密钥、模型、Voice ID 与试听</small></span></button></section>
   <section><small>AI IMAGE</small><h3>AI 生图服务</h3><p className="section-note">单独配置 GPT/OpenAI Images 或 NovelAI，并细调尺寸、质量与正负面预设词。</p><button className="settings-entry-button" onClick={()=>nav("/settings/images")}><WandSparkles/><span><b>配置生图服务</b><small>供应商、模型、画面尺寸、质量与提示词预设</small></span></button></section>
   <section><small>CHAT MEDIA</small><h3>表情包</h3><p className="section-note">创建分组，从相册、相机、图片 URL 或 TXT 链接列表导入自己的表情。</p><button className="settings-entry-button" onClick={()=>nav("/settings/stickers")}><SmilePlus/><span><b>管理我的表情包</b><small>分组、说明、排序与删除</small></span></button></section>
   </SettingsAccordion>

   <SettingsAccordion title="通知与后台活动" subtitle="系统通知与后台保活">
   <section className="notification-settings-section"><div className="settings-service-heading"><span><BellRing/></span><div><small>NOTIFICATIONS & BACKGROUND</small><h3>通知与后台活动</h3></div></div><p className="section-note background-activity-note">开启后台保活后，茶茶机会尝试在切换到其他 App 时继续处理角色主动消息和来电；关闭后不使用任何后台保活措施，茶茶机只在前台运行。手机系统仍可能暂停 PWA，未完成任务会在下次打开时补算。</p><label className="settings-toggle-row background-master-toggle"><span><b>后台保活</b></span><input type="checkbox" checked={backgroundDraft.enabled} onChange={event=>void toggleBackgroundActivity(event.target.checked)}/><i/></label><div className="background-mode-card"><header><RadioTower/><span><b>实验性后台活动</b><small>振荡器和静音音频可以同时选择；可能增加耗电、影响媒体播放，也无法阻止系统终止茶茶机。</small></span></header><div><button className={!backgroundDraft.enabled?"active":""} aria-pressed={!backgroundDraft.enabled} onClick={()=>void applyBackgroundModes([])}><b>关闭</b><small>茶茶机仅在前台运行，不启用后台保活</small></button><button className={backgroundDraft.enabled&&backgroundModesOf(backgroundDraft).includes("oscillator")?"active":""} aria-pressed={backgroundDraft.enabled&&backgroundModesOf(backgroundDraft).includes("oscillator")} onClick={()=>void toggleBackgroundMode("oscillator")}><b>振荡器</b><small>使用极低音量 Web Audio 尝试延缓暂停，可与静音音频同时开启</small></button><button className={backgroundDraft.enabled&&backgroundModesOf(backgroundDraft).includes("silent-audio")?"active":""} aria-pressed={backgroundDraft.enabled&&backgroundModesOf(backgroundDraft).includes("silent-audio")} onClick={()=>void toggleBackgroundMode("silent-audio")}><b>静音音频循环</b><small>循环播放本地静音音频，可与振荡器同时开启</small></button></div></div><button type="button" className="settings-toggle-row settings-toggle-button" onClick={()=>void toggleSystemNotifications()}><span><b>系统通知</b><small>{notificationDraft.permission==="granted"?"通知权限已允许":notificationDraft.permission==="denied"?"权限未开启，点击重新检查或查看解决说明":"点击申请手机系统通知权限"}</small></span><i className={notificationDraft.enabled?"checked":""}/></button><label className="settings-toggle-row"><span><b>主动私聊通知</b><small>角色主动发送消息时通知</small></span><input type="checkbox" disabled={!notificationDraft.enabled} checked={notificationDraft.proactiveMessages} onChange={event=>setNotificationDraft({...notificationDraft,proactiveMessages:event.target.checked})}/><i/></label><label className="settings-toggle-row"><span><b>语音与视频来电通知</b><small>点击通知后进入接听或拒绝页面</small></span><input type="checkbox" disabled={!notificationDraft.enabled} checked={notificationDraft.incomingCalls} onChange={event=>setNotificationDraft({...notificationDraft,incomingCalls:event.target.checked})}/><i/></label><label className="settings-toggle-row"><span><b>显示通知正文</b><small>关闭后仅显示“发来一条新消息”</small></span><input type="checkbox" disabled={!notificationDraft.enabled} checked={notificationDraft.previewContent} onChange={event=>setNotificationDraft({...notificationDraft,previewContent:event.target.checked})}/><i/></label><div className="settings-actions"><button disabled={!notificationDraft.enabled} onClick={()=>void persistNotifications()}><Save/>保存通知设置</button><button onClick={()=>void testNotification()}><BellRing/>发送测试通知</button></div>{notificationStatus&&<Status value={notificationStatus}/>}</section>
   </SettingsAccordion>

   <SettingsAccordion title="数据与备份" subtitle="本地备份与 GitHub 加密备份">
   <section><small>LOCAL BACKUP</small><h3>本地备份与恢复</h3><p className="section-note">导出全部角色、聊天、动态、世界书和记忆。API Key 与 GitHub Token 不会导出；恢复时保留当前设备连接配置。</p><div className="backup-actions"><button onClick={exportLocal}><Download/>导出备份</button><button onClick={()=>fileRef.current?.click()}><FileUp/>选择备份</button><input ref={fileRef} hidden type="file" accept=".json,application/json" onChange={event=>chooseBackup(event.target.files?.[0])}/></div></section>
   <section><small>GITHUB CLOUD · ADVANCED</small><h3>GitHub 加密云备份</h3><p className="section-note">高级功能，适合熟悉 GitHub 的用户。推荐使用私有仓库和仅限该仓库 Contents 读写权限的 Fine-grained Token。上传前会在浏览器内用 AES-GCM 加密。</p><div className="form-row"><label>Owner<input value={github.owner} onChange={event=>setGithub({...github,owner:event.target.value})}/></label><label>Repository<input value={github.repo} onChange={event=>setGithub({...github,repo:event.target.value})}/></label></div><div className="form-row"><label>分支<input value={github.branch} onChange={event=>setGithub({...github,branch:event.target.value})}/></label><label>文件路径<input value={github.path} onChange={event=>setGithub({...github,path:event.target.value})}/></label></div><label>GitHub Token<input type="password" value={github.token} onChange={event=>setGithub({...github,token:event.target.value})} placeholder="github_pat_..."/></label><label>备份加密密码<input type="password" value={githubPass} onChange={event=>setGithubPass(event.target.value)} placeholder="至少 8 个字符；忘记后无法恢复"/></label>{githubStatus&&<Status value={githubStatus}/>}<div className="backup-actions"><button disabled={busy} onClick={saveGithub}><Save/>保存配置</button><button disabled={busy||githubPass.length<8} onClick={uploadGithub}><CloudUpload/>上传云备份</button><button disabled={busy||githubPass.length<8} onClick={downloadGithub}><CloudDownload/>读取云备份</button></div><button className="clear-key" disabled={!github.token||busy} onClick={async()=>{await clearGitHubCredentials();setGithub(emptyGitHub);setGithubPass("");setGithubStatus({ok:true,text:"已清除 GitHub Token 和仓库配置，其他数据保持不变"})}}><Trash2/>清除 GitHub Token</button></section>
   </SettingsAccordion>

   <SettingsAccordion title="安全与危险操作" subtitle="密钥清理与永久删除数据">
    <section className="settings-danger-section"><small>SAFETY & DANGER</small><h3>危险操作</h3><p className="section-note">这些操作不会自动执行，恢复出厂设置仍需要输入确认文字。</p><div className="data-cleanup"><button onClick={()=>void clear()}><Trash2/>清除模型 API Key</button><button onClick={()=>setFactoryOpen(true)} className="danger"><Trash2/>恢复出厂设置</button></div></section>
   </SettingsAccordion>
   <p className="key-notice">聊天语言、上下文、世界书和主动互动请在对应角色的聊天窗口中配置。</p>
  </div></main>
  {factoryOpen&&<Modal onClose={()=>setFactoryOpen(false)}><div className="compact-confirm factory-confirm"><Trash2/><h2>恢复出厂设置？</h2><p>将永久删除全部角色、聊天、动态、世界书、记忆、候选以及模型和 GitHub 连接配置，并重新显示免责声明。</p><label>输入“永久删除全部数据”确认<input autoFocus value={factoryText} onChange={event=>setFactoryText(event.target.value)}/></label><button className="danger-button" disabled={factoryText!=="永久删除全部数据"||busy} onClick={resetAll}>{busy?"正在清除…":"永久删除全部数据"}</button><button className="cancel-button" onClick={()=>setFactoryOpen(false)}>取消</button></div></Modal>}
  {importPreview&&<Preview title="恢复本地备份？" backup={importPreview} busy={busy} onClose={()=>setImportPreview(null)} onConfirm={restoreLocal}/>} {cloudPreview&&<Preview title="恢复 GitHub 云备份？" backup={cloudPreview.backup} busy={busy} onClose={()=>setCloudPreview(null)} onConfirm={restoreCloud}/>} 
 </div>;
}

function MatchaTeapotIcon(){
 return <svg className="settings-matcha-teapot" viewBox="0 0 40 32" aria-hidden="true" focusable="false">
  <path className="teapot-glass teapot-handle" d="M11.7 12.2C5.9 11.2 2 14 2 18.4c0 4.5 4 7.3 9.8 5.8l-.9-3.2c-3.7 1-5.7-.5-5.7-2.7 0-2 2-3.5 5.8-2.7Z"/>
  <path className="teapot-glass teapot-spout" d="M29 16.9c2.8-2 4-4.8 6.1-6.3 1.3-.9 3.1-.3 3.2 1.1.1 1.2-1.2 1.8-2.2 2.3-2.5 1.4-3.6 4.3-5.8 6.5Z"/>
  <path className="teapot-glass teapot-body" d="M9.4 13.2h20.9c1.1 2.2 1.5 4.5 1.1 6.8-.8 5.1-5.2 8.2-11 8.2-6 0-10.3-3.2-11.1-8.3-.4-2.4-.1-4.6.1-6.7Z"/>
  <path className="teapot-liquid" d="M10.1 19.4c4.9.8 15.5.8 20.4 0 .1.8 0 1.6-.2 2.4-.9 3.8-4.6 6.1-10 6.1-5.5 0-9.2-2.3-10.1-6.1-.2-.8-.3-1.6-.1-2.4Z"/>
  <path className="teapot-liquid-surface" d="M10.2 19.4c4.8.8 15.3.8 20.1 0"/>
  <path className="teapot-glass-inner" d="M10.5 14.3h19.7c.7 1.8.9 3.7.6 5.5-.7 4.5-4.6 7.3-10.4 7.3-5.8 0-9.7-2.8-10.4-7.4-.3-1.8-.1-3.6.5-5.4Z"/>
  <path className="teapot-glass teapot-lid" d="M11.5 13.2c.9-4.3 4.2-6.9 8.9-6.9s8.1 2.6 9 6.9Z"/>
  <path className="teapot-rim" d="M11.5 13.2c2.2 1.2 15.6 1.2 17.9 0"/>
  <circle className="teapot-glass teapot-knob" cx="20.4" cy="5.1" r="1.75"/>
  <path className="teapot-shine" d="M13.1 15.8c-.5 1.5-.6 3.1-.2 4.5"/>
  <circle className="teapot-face-eye" cx="16.9" cy="22" r=".9"/>
  <circle className="teapot-face-eye" cx="23.7" cy="22" r=".9"/>
  <path className="teapot-face-mouth" d="M18.2 23.6c1.1 1.35 3.1 1.35 4.2 0"/>
 </svg>;
}

function SettingsAccordion({title,subtitle,children}:{title:string;subtitle:string;children:React.ReactNode}){
 return <details className="settings-accordion"><summary><MatchaTeapotIcon/><span><b>{title}</b><small>{subtitle}</small></span></summary><div className="settings-accordion-content">{children}</div></details>;
}

class ServiceErrorBoundary extends Component<{name:string;children:React.ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return{failed:true}}
 render(){return this.state.failed?<section className="dedicated-api-section api-service-recovery" role="alert"><h3>{this.props.name} 暂时无法显示</h3><p className="section-note">该区域的旧配置可能不完整，其他设置仍可继续使用。</p><button type="button" onClick={()=>this.setState({failed:false})}>重新载入此区域</button></section>:this.props.children}
}

function ServiceSection({kind,title,eyebrow,icon,note,value,showKey,status,busy,models,query,pickerOpen,instruction,onInstruction,onPickerOpen,onPickerClose,onShowKey,onEnabled,onPatch,onQuery,onFetchModels,onTest,onSave}:{kind:ServiceKind;title:string;eyebrow:string;icon:React.ReactNode;note:string;value:ModelServiceSettings[ServiceKind];showKey:boolean;status:StatusValue|null;busy:boolean;models:string[];query:string;pickerOpen:boolean;instruction?:string;onInstruction?:(value:string)=>void;onPickerOpen:()=>void;onPickerClose:()=>void;onShowKey:(value:boolean)=>void;onEnabled:(value:boolean)=>void;onPatch:<K extends keyof ProviderSettings>(key:K,value:ProviderSettings[K])=>void;onQuery:(value:string)=>void;onFetchModels:()=>void;onTest:()=>void;onSave:()=>void}){
 return <section className={`dedicated-api-section ${kind}-api-section`}>
  <div className="settings-service-heading"><span>{icon}</span><div><small>{eyebrow}</small><h3>{title}</h3></div><button type="button" role="switch" aria-checked={value.enabled} aria-label={`启用${title}`} className={`settings-switch-button ${value.enabled?"active":""}`} onClick={event=>{event.preventDefault();event.stopPropagation();onEnabled(!value.enabled)}}><span/></button></div>
  <p className="section-note">{note}</p><p className="section-note provider-setup-hint">填写 Base URL、API Key 和模型名称后点击“保存”即可；测试连接和拉取模型都是可选操作。</p>
  <div className="dedicated-api-fields">
   <label>Base URL<input value={value.provider.baseUrl} onChange={event=>onPatch("baseUrl",event.target.value)}/></label>
   <details className="provider-compatibility-diagnostics"><summary>兼容性诊断（高级）</summary><p className="section-note">默认自动识别协议并使用浏览器直连；仅在接口文档明确要求或排查兼容问题时修改。</p><label>请求协议<select value={value.provider.protocol??"auto"} onChange={event=>onPatch("protocol",event.target.value as ProviderSettings["protocol"])}><option value="auto">自动判断</option><option value="openai-compatible">OpenAI 兼容</option><option value="openai-responses">OpenAI Responses</option><option value="gemini">Gemini 原生</option><option value="claude">Claude 原生</option><option value="deepseek-compatible">DeepSeek 兼容</option></select></label><label>请求通道<select value={value.provider.networkMode??"direct"} onChange={event=>onPatch("networkMode",event.target.value as ProviderSettings["networkMode"])}><option value="relay">安全 Relay（高级）</option><option value="direct">浏览器直连（高级）</option></select></label></details>
   <label>API Key<div className="secret-input"><input type={showKey?"text":"password"} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" value={value.provider.apiKey} onChange={event=>onPatch("apiKey",event.target.value)} placeholder="sk-..."/><button type="button" aria-label={showKey?"隐藏密钥":"显示密钥"} onClick={()=>onShowKey(!showKey)}>{showKey?<EyeOff/>:<Eye/>}</button></div></label>
   <label>模型名称<div className="model-input"><input value={value.provider.model} onFocus={()=>models.length&&onPickerOpen()} onChange={event=>onPatch("model",event.target.value)} placeholder={kind==="vision"?"例如 gpt-4.1-mini":"辅助任务模型"}/><button type="button" disabled={busy||!value.provider.apiKey.trim()} onClick={onFetchModels}><RefreshCw/>拉取模型</button></div></label>{pickerOpen&&models.length>0&&<ModelPicker models={models} query={query} selected={value.provider.model} onQuery={onQuery} onClose={onPickerClose} onSelect={model=>{onPatch("model",model);onPickerClose()}}/>} 
   <label>Temperature<input type="number" min="0" max="2" step="0.1" value={value.provider.temperature} onChange={event=>onPatch("temperature",Number(event.target.value))}/></label>
   {kind==="vision"&&<label>识图指令<textarea rows={4} value={instruction??""} onChange={event=>onInstruction?.(event.target.value)} placeholder="告诉识图模型应重点读取哪些内容"/></label>}
  </div>
  {status&&<Status value={status}/>}<div className="settings-actions"><button disabled={busy||!value.provider.apiKey.trim()} onClick={onTest}>{busy?<LoaderCircle className="spin"/>:<CloudCog/>}测试连接</button><button type="button" className="save" disabled={busy} onClick={onSave}><Save/>保存{title}</button></div>
 </section>;
}

function ModelPicker({models,query,selected,onQuery,onSelect,onClose}:{models:string[];query:string;selected:string;onQuery:(value:string)=>void;onSelect:(value:string)=>void;onClose:()=>void}){
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const onPointerDown=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node))onClose()};
  const onKeyDown=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose()};
  document.addEventListener("pointerdown",onPointerDown);
  document.addEventListener("keydown",onKeyDown);
  return()=>{document.removeEventListener("pointerdown",onPointerDown);document.removeEventListener("keydown",onKeyDown)};
 },[onClose]);
 const filtered=models.filter(model=>model.toLowerCase().includes(query.trim().toLowerCase()));
 return <div className="model-picker" ref={root}><input autoFocus value={query} onChange={event=>onQuery(event.target.value)} placeholder="搜索模型"/><div>{filtered.map(model=><button type="button" className={model===selected?"active":""} key={model} onClick={()=>onSelect(model)}>{model}</button>)}</div></div>
}

function Status({value}:{value:StatusValue}){return <div className={`connection-status ${value.ok?"ok":"bad"}`}>{value.ok?<CheckCircle2/>:<KeyRound/>}<span>{value.text}</span></div>}
function Preview({title,backup,busy,onClose,onConfirm}:{title:string;backup:any;busy:boolean;onClose:()=>void;onConfirm:()=>void}){return <Modal onClose={onClose}><div className="sheet-head"><div><small>BACKUP PREVIEW</small><h2>{title}</h2></div><button onClick={onClose}>×</button></div><div className="backup-preview"><p>备份时间：{new Date(backup.exportedAt).toLocaleString("zh-CN")}</p><div>{Object.entries(counts(backup)).map(([name,value])=><span key={name}><b>{String(value)}</b><small>{name}</small></span>)}</div><button className="primary" disabled={busy} onClick={onConfirm}>{busy?"正在恢复…":"覆盖当前本地数据并恢复"}</button><button className="cancel-button" onClick={onClose}>取消</button></div></Modal>}

