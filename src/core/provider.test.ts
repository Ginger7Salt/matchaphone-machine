import {describe,expect,it,vi} from "vitest";
import {OpenAIProvider,ProviderError} from "./provider";
import {defaultProvider} from "./types";
import {parseReplyTurn,parseStrictReplyTurn} from "./replyBubbles";
const settings={...defaultProvider,apiKey:"test",baseUrl:"https://api.test/v1",stream:false,timeoutMs:1000};
const encoder=new TextEncoder();
function streamResponse(chunks:string[],fail=false){let i=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(i<chunks.length){controller.enqueue(encoder.encode(chunks[i++]));return}if(fail){controller.error(new Error("broken"));return}controller.close()}}),{status:200,headers:{"Content-Type":"text/event-stream"}})}
describe("OpenAI provider",()=>{ it("does not send output token limits",async()=>{let payload:any;vi.stubGlobal("fetch",vi.fn().mockImplementation(async(_url,options:any)=>{payload=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:"OK"}}]}),{status:200,headers:{"Content-Type":"application/json"}})}));await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false});expect(payload).not.toHaveProperty("max_tokens");expect(payload).not.toHaveProperty("max_completion_tokens")});
 it("extracts nested relay wrappers and metadata",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{result:{choices:[{message:{content:"正文"},finish_reason:"length"}],usage:{completion_tokens:321}}}}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false})).resolves.toMatchObject({text:"正文",finishReason:"length",truncated:true,responseShape:"wrapper:data",outputTokens:321})});
 it("extracts Responses-style output without reasoning",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({output:[{type:"reasoning",content:[{type:"reasoning",text:"隐藏思考"}]},{type:"message",content:[{type:"output_text",text:"可见正文"}]}],usage:{output_tokens:12}}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false})).resolves.toMatchObject({text:"可见正文",outputTokens:12})});
 it("fetches unique sorted models",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:"z"},{id:"a"},{id:"z"}]}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).models()).resolves.toEqual(["a","z"])});
 it("rejects invalid model list",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({models:[]}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).models()).rejects.toMatchObject({kind:"format"})});
 it("parses content arrays from compatible non-streaming providers",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:[{type:"text",text:"你"},{type:"text",text:"好"}]}}]}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false})).resolves.toBe("你好")});
 it("accepts an SSE body returned for a non-streaming request",async()=>{const body='data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n';vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body,{status:200,headers:{"Content-Type":"text/event-stream"}})));await expect(new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false})).resolves.toBe("你好")});
 it("turns HTML success bodies into a sanitized format error",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("<html><body>proxy error</body></html>",{status:200,headers:{"Content-Type":"text/html"}})));const error=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;expect(error).toMatchObject({kind:"format"});expect(error.message).toContain("网页")}); it("parses non-streaming replies",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:"你好"}}]}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false})).resolves.toBe("你好")});
 it.each([[401,"auth"],[404,"model"],[429,"rate"],[500,"server"]] as const)("maps %s to %s",async(status,kind)=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("error",{status})));await expect(new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false})).rejects.toMatchObject({kind})});
 it("rejects invalid response",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[]}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false})).rejects.toBeInstanceOf(ProviderError)});
 it("parses SSE split across chunks",async()=>{const tokens:string[]=[];vi.stubGlobal("fetch",vi.fn().mockResolvedValue(streamResponse(['data: {"choices":[{"delta":{"content":"你','好"}}]}\n\ndata: {"choices":[{"delta":{"content":"！"}}]}\n\n','data: [DONE]\n\n'])));await expect(new OpenAIProvider({...settings,stream:true}).chat([{role:"user",content:"hi"}],{stream:true,onToken:t=>tokens.push(t)})).resolves.toBe("你好！");expect(tokens).toEqual(["你好","！"])});
 it("reports interrupted stream with partial text",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(streamResponse(['data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'],true)));await expect(new OpenAIProvider({...settings,stream:true}).chat([{role:"user",content:"hi"}],{stream:true})).rejects.toMatchObject({kind:"interrupted",partial:"部分"})});
 it("distinguishes request timeout",async()=>{vi.stubGlobal("fetch",vi.fn((_u,options:any)=>new Promise((_r,reject)=>{options.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError"))) })));await expect(new OpenAIProvider({...settings,timeoutMs:5}).chat([{role:"user",content:"hi"}],{stream:false})).rejects.toMatchObject({kind:"timeout"})});
 it("distinguishes user abort",async()=>{const controller=new AbortController();vi.stubGlobal("fetch",vi.fn((_u,_o)=>new Promise((_r,reject)=>{controller.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError"))) })));const p=new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false,signal:controller.signal});controller.abort();await expect(p).rejects.toMatchObject({kind:"aborted"})});
 it.each([[400,"format"],[408,"timeout"],[422,"format"],[503,"server"]] as const)("keeps HTTP status and guidance for %s",async(status,kind)=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:"provider detail",code:"provider_code",type:"provider_type",param:"messages"}}),{status,headers:{"Content-Type":"application/json"}})));const error=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;expect(error).toMatchObject({kind,apiError:{source:"api",kind,httpStatus:status,providerCode:"provider_code",providerType:"provider_type",param:"messages"}});expect(error.apiError?.troubleshooting.length).toBeGreaterThan(1)});
 it("parses and redacts a standard OpenAI error body",async()=>{const secret="sk-secret-value-123456",configured={...settings,apiKey:secret};vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:"Quota failed for "+secret+" Authorization: Bearer hidden-token",code:"insufficient_quota",type:"billing_error"}}),{status:429,headers:{"Content-Type":"application/json"}})));const error=await new OpenAIProvider(configured).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;expect(error.apiError).toMatchObject({httpStatus:429,providerCode:"insufficient_quota",providerType:"billing_error"});expect(error.apiError?.detail).not.toContain(secret);expect(error.apiError?.detail).not.toContain("hidden-token");expect(error.apiError?.detail).toContain("[REDACTED]")});
 it("sanitizes and truncates non-JSON provider errors",async()=>{const raw="<html>Authorization: Bearer secret-token "+"x".repeat(1200)+"</html>";vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(raw,{status:500})));const error=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;expect(error.apiError?.detail?.length).toBeLessThanOrEqual(800);expect(error.apiError?.detail).not.toContain("secret-token");expect(error.apiError?.httpStatus).toBe(500)});
 it("marks malformed successful responses as API format failures",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[]}),{status:200,headers:{"Content-Type":"application/json"}})));const error=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;expect(error.apiError).toMatchObject({kind:"format",providerCode:"invalid_response"})});

 it("passes through consensual adult prose with quotes, newlines and escapes",async()=>{const adult="ADULT_CONSENSUAL: she said \"stop is always allowed\".\nHe answered \"I will listen\".\nC:\\private";vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:adult},finish_reason:"stop"}]}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).chat([{role:"user",content:"continue"}],{stream:false})).resolves.toBe(adult)});
 it("does not classify provider policy refusal as truncation",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:"provider refused this request"},finish_reason:"content_filter"}]}),{status:200,headers:{"Content-Type":"application/json"}})));await expect(new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false})).resolves.toMatchObject({truncated:false,finishReason:"content_filter"})});

 it("preserves a direct role reply protocol for downstream bubble and inner-voice parsing",async()=>{
  const protocol={
   messages:[{content:"\u7b2c\u4e00\u6761"},{content:"\u7b2c\u4e8c\u6761"}],
   innerVoice:{
    sections:{physicalState:"\u547c\u5438\u5e73\u7a33",emotionAndMind:"\u5fc3\u60c5\u653e\u677e",unspokenWords:"\u5176\u5b9e\u8fd8\u60f3\u591a\u8bf4\u4e00\u70b9",selfDeception:"\u5047\u88c5\u81ea\u5df1\u5e76\u4e0d\u5728\u610f",triggeredMemory:"\u6b64\u523b\u6ca1\u6709\u88ab\u89e6\u53d1\u7684\u5177\u4f53\u56de\u5fc6",angelThought:"\u5e94\u8be5\u8ba4\u771f\u542c\u5b8c",devilThought:"\u60f3\u6545\u610f\u9017\u4e00\u4e0b\u5bf9\u65b9"},
    continuity:{emotion:"\u653e\u677e"},
   },
  };
  const raw=JSON.stringify(protocol)+" ".repeat(1900);
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(raw,{status:200,headers:{"Content-Type":"application/json"}})));
  const result=await new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false});
  expect(result.responseShape).toBe("direct-role-json");
  expect(JSON.parse(result.text)).toEqual(protocol);
  const turn=parseReplyTurn(result.text,false,{min:1,max:8},true);
  expect(turn.parts.map(item=>item.content)).toEqual(["\u7b2c\u4e00\u6761","\u7b2c\u4e8c\u6761"]);
  expect(turn.innerVoice?.sections.unspokenWords).toBe("\u5176\u5b9e\u8fd8\u60f3\u591a\u8bf4\u4e00\u70b9");
 });
 it.each([
  ["top-level array",[{content:"array body"}],"direct-role-array"],
  ["payload wrapper",{payload:{messages:[{content:"wrapped body"}],innerVoice:{marker:true}}},"wrapper:payload"],
  ["JSON string wrapper",{data:JSON.stringify({messages:[{content:"string body"}],innerVoice:{marker:true}})},"wrapper:data"],
 ] as const)("preserves direct role JSON from %s",async(_name,body,shape)=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}})));
  const result=await new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false});
  expect(result.responseShape).toBe(shape);
  expect(()=>JSON.parse(result.text)).not.toThrow();
 });
 it("preserves a fenced direct role protocol with surrounding explanation",async()=>{
  const protocol={messages:[{content:"fenced body"}],innerVoice:{}};
  const raw="preface\n```json\n"+JSON.stringify(protocol)+"\n```\nafterword";
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(raw,{status:200,headers:{"Content-Type":"application/json"}})));
  const result=await new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false});
  expect(result.responseShape).toBe("direct-role-json");
  expect(JSON.parse(result.text)).toEqual(protocol);
 });
 it("accepts non-empty plain text from a successful provider",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("plain visible body",{status:200,headers:{"Content-Type":"text/plain"}})));
  await expect(new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false})).resolves.toMatchObject({text:"plain visible body",responseShape:"plain-text"});
 });
 it.each([
  ["completion",{completion:"completion body"},"completion body"],
  ["generated_text",{generated_text:"generated body"},"generated body"],
  ["answer",{answer:"answer body"},"answer body"],
  ["response_text",{response_text:"response body"},"response body"],
  ["Anthropic",{content:[{type:"text",text:"Anthropic body"}]},"Anthropic body"],
  ["Gemini",{candidates:[{content:{parts:[{text:"Gemini body"}]}}]},"Gemini body"],
  ["Ollama message",{message:{role:"assistant",content:"Ollama message"}},"Ollama message"],
  ["Ollama response",{response:"Ollama response"},"Ollama response"],
  ["multi wrapper",{data:{payload:{result:{answer:"nested body"}}}},"nested body"],
 ] as const)("extracts %s response envelopes",async(_name,body,expected)=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}})));
  await expect(new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false})).resolves.toBe(expected);
 });
 it("extracts visible text from NDJSON",async()=>{
  const body='{"response":"hello ","done":false}\n{"response":"world","done":true}';
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body,{status:200,headers:{"Content-Type":"application/x-ndjson"}})));
  await expect(new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false})).resolves.toMatchObject({text:"hello world",responseShape:"ndjson"});
 });
 it("maps an HTTP 200 error object to a provider error instead of generic invalid_response",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:"quota exhausted",code:"insufficient_quota",type:"billing_error"}}),{status:200,headers:{"Content-Type":"application/json"}})));
  const error=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;
  expect(error).toMatchObject({kind:"rate",apiError:{providerCode:"insufficient_quota",providerType:"billing_error",responseShape:"object:error:error@$"}});
  expect(error.apiError?.detail).toContain("quota exhausted");
 });
 it("reports reasoning-only, refusal-only and tool-only responses without exposing hidden payloads",async()=>{
  const cases=[
   [{choices:[{message:{reasoning_content:"secret reasoning",content:null}}]},"reasoning_only","\u670d\u52a1\u53ea\u8fd4\u56de\u4e86\u63a8\u7406\u5185\u5bb9"],
   [{choices:[{message:{refusal:"provider policy refusal",content:null}}]},"provider_refusal","provider policy refusal"],
   [{choices:[{message:{tool_calls:[{function:{name:"x",arguments:"secret arguments"}}],content:null}}]},"tool_only_response","\u670d\u52a1\u53ea\u8fd4\u56de\u4e86\u5de5\u5177\u8c03\u7528"],
  ] as const;
  for(const [body,code,detail] of cases){
   vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}})));
   const error=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;
   expect(error.apiError?.providerCode).toBe(code);
   expect(error.apiError?.detail).toContain(detail);
   expect(error.apiError?.detail).not.toContain("secret reasoning");
   expect(error.apiError?.detail).not.toContain("secret arguments");
  }
 });
 it("handles nested error wrappers and Gemini refusal metadata",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{payload:{error:{message:"invalid api key",code:"invalid_api_key",type:"authentication_error"}}}}),{status:200,headers:{"Content-Type":"application/json"}})));
  const nestedError=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;
  expect(nestedError).toMatchObject({kind:"auth",apiError:{providerCode:"invalid_api_key",responseShape:"wrapper:data:error@data.payload"}});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({promptFeedback:{blockReason:"SAFETY"},candidates:[]}),{status:200,headers:{"Content-Type":"application/json"}})));
  const refusal=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;
  expect(refusal.apiError).toMatchObject({providerCode:"provider_refusal",detail:"SAFETY",responseShape:"gemini-candidates"});
 });
 it("adds safe response-shape diagnostics for unknown JSON without including response values",async()=>{
  const secretBody="private model output must not appear";
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({id:"abc",metadata:{private:secretBody}}),{status:200,headers:{"Content-Type":"application/custom+json"}})));
  const error=await new OpenAIProvider(settings).chat([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;
  expect(error.apiError).toMatchObject({providerCode:"invalid_response",responseShape:"object:id,metadata",contentType:"application/custom+json"});
  expect(error.apiError?.rawLength).toBeGreaterThan(0);
  expect(error.apiError?.visibleCandidatePaths).toEqual([]);
  expect(JSON.stringify(error.apiError)).not.toContain(secretBody);
 });

 it("repairs malformed direct role JSON and returns normalized protocol metadata",async()=>{
  const raw='{messages:[{content:"他说"你好""}],innerVoice:{sections:{physicalState:"呼吸平稳",emotionAndMind:"我在认真思考",unspokenWords:"还有话没说",selfDeception:"我假装不紧张",triggeredMemory:"此刻没有被触发的具体回忆",angelThought:"先尊重边界",devilThought:"想更直接表达"},continuity:{emotion:"专注"}},}';
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(raw,{status:200,headers:{"Content-Type":"application/json"}})));
  const result=await new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false});
  expect(result).toMatchObject({responseShape:"direct-role-json",parseStatus:"repaired-json",repairAttempted:true,repairedParseSucceeded:true,hasMessages:true,hasInnerVoice:true});
  expect(parseStrictReplyTurn(result.text,false,{min:1,max:8,adaptive:true},true,result)).toMatchObject({innerVoiceFormatError:false});
 });
 it("classifies truly truncated role JSON without exposing content",async()=>{
  const sentinel="PRIVATE_SENTINEL";
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response('{"messages":[{"content":"'+sentinel,{status:200,headers:{"Content-Type":"application/json"}})));
  const error=await new OpenAIProvider(settings).chatWithMeta([{role:"user",content:"hi"}],{stream:false}).catch(value=>value) as ProviderError;
  expect(error.apiError).toMatchObject({providerCode:"truncated_json",parseStatus:"truncated-json",unterminatedString:true,failureStage:"provider-parse"});
  expect(JSON.stringify(error.apiError)).not.toContain(sentinel);
 });

});


describe("chat timeout override",()=>{
 it("allows chat tasks to disable the provider-owned timeout",async()=>{
  const slowSettings={...settings,timeoutMs:1};
  vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify({choices:[{message:{content:"OK"}}]}),{status:200,headers:{"Content-Type":"application/json"}})),20))));
  await expect(new OpenAIProvider(slowSettings).chat([{role:"user",content:"hi"}],{stream:false,timeoutMs:null})).resolves.toBe("OK");
 });
});
