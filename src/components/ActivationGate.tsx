import {useEffect,useState,type FormEvent,type ReactNode} from "react";
import {KeyRound,LockKeyhole,ShieldCheck,WifiOff} from "lucide-react";
import {activateDevice,ActivationClientError,formatActivationCode,verifyStoredActivation,type ActivationFailureReason} from "../core/activation";
import { PUBLIC_DEMO_MODE } from "../core/publicDemo";

type GateState="checking"|"locked"|"activating"|"active";
const messages:Record<ActivationFailureReason,string>={
 "invalid-code":"激活码无效，请检查后重新输入。",
 "already-used":"这个激活码已经绑定其他设备。",
 "rate-limited":"尝试次数过多，请十分钟后再试。",
 "unauthenticated":"无法建立匿名身份，请检查 CloudBase 登录配置。",
 "invalid-device":"当前浏览器无法保存或验证设备密钥。",
 network:"无法连接激活服务，请检查网络后重试。",
 configuration:"激活服务尚未完成配置。",
 incompatible:"当前浏览器缺少安全存储能力，暂时无法激活。",
};
export default function ActivationGate({children}:{children:ReactNode}){
 if(PUBLIC_DEMO_MODE)return <>{children}</>;
 const [state,setState]=useState<GateState>("checking"),[code,setCode]=useState(""),[error,setError]=useState("");
 useEffect(()=>{let alive=true;void verifyStoredActivation().then(valid=>{if(alive)setState(valid?"active":"locked")}).catch(()=>{if(alive)setState("locked")});return()=>{alive=false}},[]);
 const submit=async(event:FormEvent)=>{event.preventDefault();if(state==="activating")return;setError("");setState("activating");try{await activateDevice(code);setState("active")}catch(reason){const key=reason instanceof ActivationClientError?reason.reason:"network";setError(messages[key]);setState("locked")}};
 if(state==="active")return <>{children}</>;
 if(state==="checking")return <div className="activation-loading" role="status" aria-label="正在验证茶茶机激活状态"><span/><b>正在检查设备许可</b></div>;
 return <main className="activation-shell"><div className="activation-glow"/><section className="activation-card" aria-labelledby="activation-title"><div className="activation-mark"><span><LockKeyhole/></span><small>PRIVATE BETA</small></div><h1 id="activation-title">激活茶茶机</h1><p>这是茶茶机内测版本。请输入为这台设备分配的一次性激活码。</p><form onSubmit={submit}><label htmlFor="activation-code">设备激活码</label><div className="activation-input"><KeyRound/><input id="activation-code" value={code} onChange={event=>{setCode(formatActivationCode(event.target.value));setError("")}} autoCapitalize="characters" autoCorrect="off" spellCheck={false} inputMode="text" placeholder="MATCHA-XXXX-XXXX-XXXX-XXXX" maxLength={29} autoFocus/></div>{error&&<div className="activation-error" role="alert">{error.startsWith("无法连接")?<WifiOff/>:<LockKeyhole/>}<span>{error}</span></div>}<button type="submit" disabled={state==="activating"||!code}>{state==="activating"?<><span className="activation-spinner"/>正在绑定设备</>:<><ShieldCheck/>激活这台设备</>}</button></form><aside><ShieldCheck/><span><b>一机一码</b><small>激活码使用后将绑定当前浏览器。清除浏览器数据或更换设备后，需要新的激活码。</small></span></aside></section><footer>茶茶机 · MATCHA PHONE</footer></main>
}


