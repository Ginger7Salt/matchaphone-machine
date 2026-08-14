import {z} from "zod";
import {canCharacterInteract} from "./conversationSettings";
import {db,getAppSettings} from "./db";
import {buildContext} from "./context";
import {pauseActiveMeetForOnlineActivity,resolveOnlineCrossModeContinuity} from "./crossModeContinuity";
import {resolveChatPresenceContext} from "./chatPresence";
import {prepareRoleplayResources,reviewCharacterReply} from "./personaEngine";
import {OpenAIProvider,ProviderError,type ProviderChatInvoker} from "./provider";
import {coreSettingOf,personaOf,relationshipContextOf} from "./character";
import {userPersonaContext} from "./userPersona";
import {rewardIslandGift} from "./coupleIsland";
import {parseStructuredJson} from "./structuredJson";
import {now,SCHEMA_VERSION,uid,type Character,type Conversation,type MallCatalogItem,type MallOrder,type MallOrderItem,type MallOrderKind,type MallOrderStatus,type MallWalletSettings,type Message,type MessageQuote,type ProviderSettings,type WalletTransaction} from "./types";

const strip=(text:string)=>text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
const money=(value:number,min=100,max=500000)=>Math.max(min,Math.min(max,Math.round(value*100)));
const tone=(text:string)=>[...text].reduce((sum,char)=>sum+char.charCodeAt(0),0)%8;
const MALL_STARTER_CATALOG_KEY="mall-starter-catalog-v2";
const LEGACY_MALL_STARTER_SEARCH_ID="mall-starter-v1";
const starterShopProducts=[
 {title:"掌心复古数码相机",merchantName:"TINY FRAME",category:"DIGITAL",description:"小巧的虚构数码相机，带有柔和复古滤镜和随身挂绳。",priceCents:89900,colors:["奶油白","雾银"],sizes:["ONE SIZE"]},
 {title:"月球触控小夜灯",merchantName:"SLEEP OBJECT",category:"HOME",description:"轻触即可调整亮度的月球造型小夜灯，适合床头和书桌。",priceCents:12900,colors:["暖白","浅灰"],sizes:["16cm"]},
 {title:"雨夜悬疑小说三册套装",merchantName:"PAPER MOON",category:"BOOKS",description:"三本发生在不同雨夜的虚构悬疑小说，附有角色关系书签。",priceCents:8800,colors:["黑灰书封"],sizes:["3册"]},
 {title:"手作云朵陶瓷马克杯",merchantName:"CLAY MORNING",category:"TABLEWARE",description:"杯口略带手作弧度的陶瓷杯，适合咖啡、牛奶和热可可。",priceCents:6900,colors:["米白","雾蓝"],sizes:["360ml"]},
 {title:"静音降噪头戴耳机",merchantName:"SOFT SIGNAL",category:"AUDIO",description:"包耳式虚构无线耳机，提供轻柔降噪和长时间舒适佩戴。",priceCents:35900,colors:["石墨黑","暖灰"],sizes:["ONE SIZE"]},
 {title:"奶油小熊安睡玩偶",merchantName:"NAP FRIENDS",category:"TOYS",description:"触感柔软的小熊玩偶，附带可拆洗格纹睡衣和迷你枕头。",priceCents:7900,colors:["奶油棕"],sizes:["35cm"]},
 {title:"无花果与棉麻淡香水",merchantName:"LATE AFTERNOON",category:"BEAUTY",description:"无花果、棉麻和浅木质调组成的低饱和虚构淡香水。",priceCents:21900,colors:["透明灰瓶"],sizes:["50ml"]},
 {title:"迷你香草植物种植盒",merchantName:"WINDOW GARDEN",category:"HOBBY",description:"包含罗勒、薄荷与迷迭香种子的桌面种植套装。",priceCents:5900,colors:["鼠尾草绿"],sizes:["3盆"]},
 {title:"深夜便利店合作桌游",merchantName:"AFTER TEN",category:"GAME",description:"围绕经营深夜便利店展开的轻策略桌游，适合两到四人。",priceCents:12800,colors:["夜蓝包装"],sizes:["2-4人"]},
 {title:"海盐榛子巧克力礼盒",merchantName:"MELT LETTER",category:"FOOD",description:"包含海盐、榛子和莓果夹心的虚构手作巧克力礼盒。",priceCents:11800,colors:["暖灰礼盒"],sizes:["12枚"]},
 {title:"灰绿色宽松连帽卫衣",merchantName:"SLOW WEEKEND",category:"CLOTHING",description:"柔软抓绒材质与宽松肩线，适合作为日常休闲单品。",priceCents:16900,colors:["灰绿色","炭灰"],sizes:["S","M","L"]},
 {title:"午夜车站千片拼图",merchantName:"PIECE OF NIGHT",category:"PUZZLE",description:"描绘雨后午夜车站的千片拼图，完成后可作为装饰画。",priceCents:9900,colors:["夜色"],sizes:["1000片"]}
] as const;
const starterEatsRestaurants=[
 {name:"暖食堂 WARM BOWL",category:"家常料理",description:"提供热汤、盖饭和面食的虚拟日常小店。",rating:4.8,etaMinutes:28,deliveryFeeCents:300,menu:[
  {title:"番茄牛肉浓汤面",category:"面食",description:"酸甜番茄汤底、炖牛肉与溏心蛋。",priceCents:3600},
  {title:"照烧鸡腿温泉蛋饭",category:"盖饭",description:"照烧鸡腿、温泉蛋与清爽卷心菜丝。",priceCents:3200},
  {title:"虾仁滑蛋炒饭",category:"炒饭",description:"虾仁、滑蛋和葱香米饭。",priceCents:2800},
  {title:"海带豆腐味噌汤",category:"汤品",description:"海带、嫩豆腐与温和味噌汤。",priceCents:1200}
 ]},
 {name:"MOMO PIZZA LAB",category:"披萨与意面",description:"主打薄底披萨、烤蔬菜和奶油意面的虚构厨房。",rating:4.7,etaMinutes:35,deliveryFeeCents:500,menu:[
  {title:"蜂蜜芝士薄底披萨",category:"披萨",description:"马苏里拉、淡奶酪与少量蜂蜜。",priceCents:5800},
  {title:"蘑菇奶油宽面",category:"意面",description:"混合蘑菇、淡奶油与黑胡椒。",priceCents:4200},
  {title:"番茄罗勒肉丸意面",category:"意面",description:"番茄酱、罗勒与烤牛肉丸。",priceCents:4500},
  {title:"柠檬油醋烤蔬菜",category:"配菜",description:"南瓜、彩椒和西葫芦。",priceCents:2200}
 ]},
 {name:"白昼咖啡社 DAYLIGHT",category:"咖啡与早午餐",description:"有咖啡、三明治和甜点的虚构全天咖啡社。",rating:4.9,etaMinutes:22,deliveryFeeCents:200,menu:[
  {title:"燕麦拿铁",category:"咖啡",description:"双份浓缩与燕麦奶。",priceCents:2200},
  {title:"无花果火腿可颂",category:"三明治",description:"可颂、无花果、火腿和芝麻菜。",priceCents:3200},
  {title:"蓝莓酸奶碗",category:"早午餐",description:"希腊酸奶、蓝莓与坚果燕麦。",priceCents:2600},
  {title:"焦糖布丁",category:"甜点",description:"口感柔软的经典焦糖布丁。",priceCents:1800}
 ]},
 {name:"小岛食集 ISLAND TABLE",category:"东南亚风味",description:"提供咖喱、米粉和清爽饮品的虚构小岛餐厅。",rating:4.6,etaMinutes:32,deliveryFeeCents:400,menu:[
  {title:"椰香黄咖喱鸡饭",category:"咖喱",description:"温和黄咖喱、鸡腿肉与香米。",priceCents:3800},
  {title:"冬阴功海鲜米粉",category:"米粉",description:"酸辣汤底、虾和鱿鱼。",priceCents:4200},
  {title:"炭烤鸡肉沙嗲",category:"小食",description:"炭烤鸡肉串与花生蘸酱。",priceCents:2600},
  {title:"青柠薄荷苏打",category:"饮品",description:"青柠、薄荷与气泡水。",priceCents:1600}
 ]}
] as const;
const shopSchema=z.object({items:z.array(z.object({title:z.string().min(1).max(80),brand:z.string().min(1).max(50),category:z.string().min(1).max(40),description:z.string().min(1).max(300),price:z.number().positive().max(5000),colors:z.array(z.string().max(30)).max(8).optional(),sizes:z.array(z.string().max(20)).max(8).optional()})).min(1).max(8)});
const eatsSchema=z.object({restaurants:z.array(z.object({name:z.string().min(1).max(60),category:z.string().min(1).max(40),description:z.string().min(1).max(240),rating:z.number().min(3).max(5),etaMinutes:z.number().int().min(10).max(90),deliveryFee:z.number().min(0).max(100),menu:z.array(z.object({title:z.string().min(1).max(80),category:z.string().min(1).max(40),description:z.string().min(1).max(240),price:z.number().positive().max(1000)})).min(2).max(6)})).min(1).max(6)});
const actionSchema=z.object({action:z.enum(["none","transfer","food","gift"]),amount:z.number().positive().max(5200).optional(),title:z.string().max(80).optional(),merchant:z.string().max(60).optional(),description:z.string().max(240).optional(),price:z.number().positive().max(5200).optional(),reason:z.string().max(200).optional()});
export function parseCharacterCommerceDecision(raw:string){try{return actionSchema.parse(parseStructuredJson(raw))}catch{return null}}
export const DEFAULT_MALL_BALANCE_CENTS=520000;
export class MallError extends Error{constructor(public kind:"provider"|"format"|"balance"|"merchant"|"missing",message:string){super(message)}}

export async function ensureMallStarterCatalog(){
 return db.transaction("rw",[db.settings,db.mallCatalogItems,db.mallCartItems],async()=>{
  if(await db.settings.get(MALL_STARTER_CATALOG_KEY))return [];
  const legacyRows=await db.mallCatalogItems.where("searchId").equals(LEGACY_MALL_STARTER_SEARCH_ID).toArray();
  if(legacyRows.length){
   await db.mallCartItems.where("catalogItemId").anyOf(legacyRows.map(item=>item.id)).delete();
   await db.mallCatalogItems.bulkDelete(legacyRows.map(item=>item.id));
  }
  const t=now(),shopRows:MallCatalogItem[]=starterShopProducts.map((item,index)=>({id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t-index,updatedAt:t-index,searchId:"mall-starter-shop-v2",query:"MALL 多品类精选",kind:"shop",title:item.title,merchantName:item.merchantName,category:item.category,description:item.description,priceCents:item.priceCents,tone:tone(item.title),colors:[...item.colors],sizes:[...item.sizes]})),eatsRows:MallCatalogItem[]=starterEatsRestaurants.flatMap((restaurant,restaurantIndex)=>{
   const restaurantId=uid(),createdAt=t-100-restaurantIndex*10,restaurantRow:MallCatalogItem={id:restaurantId,schemaVersion:SCHEMA_VERSION,createdAt,updatedAt:createdAt,searchId:"mall-starter-eats-v2",query:"EATS 初始餐厅",kind:"restaurant",title:restaurant.name,merchantName:restaurant.name,category:restaurant.category,description:restaurant.description,priceCents:0,tone:tone(restaurant.name),rating:restaurant.rating,etaMinutes:restaurant.etaMinutes,deliveryFeeCents:restaurant.deliveryFeeCents};
   const menuRows:MallCatalogItem[]=restaurant.menu.map((item,itemIndex)=>({id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:createdAt-itemIndex-1,updatedAt:createdAt-itemIndex-1,searchId:"mall-starter-eats-v2",query:"EATS 初始餐厅",kind:"food",title:item.title,merchantName:restaurant.name,merchantId:restaurantId,category:item.category,description:item.description,priceCents:item.priceCents,tone:tone(item.title),deliveryFeeCents:restaurant.deliveryFeeCents}));
   return[restaurantRow,...menuRows];
  }),rows=[...shopRows,...eatsRows];
  await db.mallCatalogItems.bulkAdd(rows);
  await db.settings.delete("mall-starter-catalog-v1");
  await db.settings.put({key:MALL_STARTER_CATALOG_KEY,value:{version:2,seededAt:t}});
  return rows;
 });
}

export async function ensureMallWallet():Promise<MallWalletSettings>{const row=await db.settings.get("mall-wallet");if(row?.value)return row.value as MallWalletSettings;const value={balanceCents:DEFAULT_MALL_BALANCE_CENTS,initializedAt:now(),updatedAt:now()};await db.settings.put({key:"mall-wallet",value});return value}
export async function setMallBalance(balanceCents:number){
 const next=Math.max(0,Math.round(balanceCents));
 return db.transaction("rw",[db.settings,db.walletTransactions],async()=>{
  const current=await ensureMallWallet(),delta=next-current.balanceCents,t=now();
  if(!delta)return current;
  const tx:WalletTransaction={id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,kind:"adjustment",amountCents:delta,state:"completed",title:"余额调整"},wallet={...current,balanceCents:next,updatedAt:t};
  await db.settings.put({key:"mall-wallet",value:wallet});
  await db.walletTransactions.add(tx);
  return wallet;
 });
}

export async function generateMallCatalog(kind:"shop"|"eats",query:string,provider:ProviderSettings){const q=query.trim();if(!q)throw new MallError("format","请输入想搜索的内容");if(!provider.apiKey.trim())throw new MallError("provider","请先在设置中配置可用模型");const api=new OpenAIProvider({...provider,stream:false}),searchId=uid(),t=now();try{if(kind==="shop"){const raw=await api.chat([{role:"system",content:"你为虚拟陪伴应用生成完全虚构的多品类购物目录。根据用户搜索内容生成任意类别商品，只输出严格 JSON，不要使用真实支付或声称库存真实存在。"},{role:"user",content:`用户想购买：${q}\n生成 8 个价格为人民币的虚拟商品。类别可以是数码、家居、书籍、美妆、食品、玩具、兴趣用品、服饰或用户明确搜索的任何东西，不要默认只生成服装。只返回：{"items":[{"title":"商品名","brand":"虚拟品牌","category":"分类","description":"描述","price":199,"colors":["颜色"],"sizes":["尺码"]}]}`}],{stream:false}),parsed=shopSchema.parse(JSON.parse(strip(raw))),rows:MallCatalogItem[]=parsed.items.map(item=>({id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,searchId,query:q,kind:"shop",title:item.title,merchantName:item.brand,category:item.category,description:item.description,priceCents:money(item.price),tone:tone(item.title),colors:item.colors,sizes:item.sizes}));await db.mallCatalogItems.bulkAdd(rows);return rows}
 const raw=await api.chat([{role:"system",content:"你为虚拟陪伴应用生成完全虚构的外卖餐厅和菜单。只输出严格 JSON，不连接真实餐厅。"},{role:"user",content:`用户想搜索餐厅、菜系或外卖：${q}\n生成 6 家虚拟餐厅，每家 2 到 6 个餐品，价格为人民币。只返回：{"restaurants":[{"name":"餐厅","category":"菜系","description":"介绍","rating":4.7,"etaMinutes":30,"deliveryFee":3,"menu":[{"title":"餐品","category":"分类","description":"描述","price":28}]}]}`}],{stream:false}),parsed=eatsSchema.parse(JSON.parse(strip(raw))),rows:MallCatalogItem[]=[];for(const restaurant of parsed.restaurants){const restaurantId=uid();rows.push({id:restaurantId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,searchId,query:q,kind:"restaurant",title:restaurant.name,merchantName:restaurant.name,category:restaurant.category,description:restaurant.description,priceCents:0,tone:tone(restaurant.name),rating:restaurant.rating,etaMinutes:restaurant.etaMinutes,deliveryFeeCents:money(restaurant.deliveryFee,0,10000)});for(const dish of restaurant.menu)rows.push({id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,searchId,query:q,kind:"food",title:dish.title,merchantName:restaurant.name,merchantId:restaurantId,category:dish.category,description:dish.description,priceCents:money(dish.price,100,100000),tone:tone(dish.title),rating:restaurant.rating,etaMinutes:restaurant.etaMinutes,deliveryFeeCents:money(restaurant.deliveryFee,0,10000)})}await db.mallCatalogItems.bulkAdd(rows);return rows}catch(error){if(error instanceof ProviderError)throw new MallError("provider",error.message);if(error instanceof z.ZodError||error instanceof SyntaxError)throw new MallError("format","模型返回的商品格式无法识别，请重试");throw error}}

export async function deleteMallCatalogItem(id:string){const item=await db.mallCatalogItems.get(id);if(!item)return;const ids=item.kind==="restaurant"?(await db.mallCatalogItems.where("merchantId").equals(id).toArray()).map(row=>row.id):[];await db.transaction("rw",[db.mallCatalogItems,db.mallCartItems],async()=>{await db.mallCatalogItems.bulkDelete([id,...ids]);await db.mallCartItems.where("catalogItemId").anyOf([id,...ids]).delete()})}
export async function addMallCartItem(item:MallCatalogItem){if(item.kind==="restaurant")throw new MallError("missing","请先选择餐品");const cartKind=item.kind==="food"?"eats":"shop",existing=await db.mallCartItems.where("cartKind").equals(cartKind).toArray();if(cartKind==="eats"&&existing.length){const catalog=await db.mallCatalogItems.bulkGet(existing.map(row=>row.catalogItemId)),merchant=catalog.find(Boolean)?.merchantId;if(merchant&&merchant!==item.merchantId)throw new MallError("merchant","外卖购物车中已有其他餐厅的餐品，请先清空")};const old=existing.find(row=>row.catalogItemId===item.id),t=now();if(old)await db.mallCartItems.update(old.id,{quantity:old.quantity+1,updatedAt:t});else await db.mallCartItems.add({id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,cartKind,catalogItemId:item.id,quantity:1,merchantId:item.merchantId})}
export async function updateMallCartQuantity(id:string,quantity:number){if(quantity<=0)await db.mallCartItems.delete(id);else await db.mallCartItems.update(id,{quantity:Math.min(99,Math.round(quantity)),updatedAt:now()})}
export async function clearMallCart(kind:"shop"|"eats"){await db.mallCartItems.where("cartKind").equals(kind).delete()}
export async function mallCartDetails(kind:"shop"|"eats"){const cart=await db.mallCartItems.where("cartKind").equals(kind).toArray(),items=await db.mallCatalogItems.bulkGet(cart.map(row=>row.catalogItemId));return cart.flatMap((row,index)=>items[index]?[{cart:row,item:items[index]!}]:[])}

export function mallOrderStatus(order:MallOrder,at=now()):MallOrderStatus{if(order.status==="cancelled"||order.status==="delivered")return order.status;const minutes=(at-order.createdAt)/60000;if(order.kind==="eats")return minutes<1?"placed":minutes<5?"preparing":minutes<12?"delivering":"delivered";return minutes<2?"placed":minutes<10?"preparing":minutes<30?"shipped":minutes<45?"delivering":"delivered"}
export async function syncMallOrderStatuses(at=now()){const orders=await db.mallOrders.toArray(),changes=orders.map(order=>({order,status:mallOrderStatus(order,at)})).filter(row=>row.status!==row.order.status);if(!changes.length)return 0;await db.transaction("rw",[db.mallOrders,db.messages],async()=>{for(const {order,status} of changes){await db.mallOrders.update(order.id,{status,updatedAt:at});if(order.messageId){const message=await db.messages.get(order.messageId);if(message)await db.messages.update(message.id,{attachments:message.attachments?.map(attachment=>attachment.type==="commerce"&&attachment.orderId===order.id?{...attachment,status}:attachment),updatedAt:at})}}});await Promise.allSettled(changes.filter(({order,status})=>status==="delivered"&&order.kind==="gift").map(({order})=>{const characterId=order.recipientType==="character"?order.recipientId:order.payerType==="character"?order.payerId:undefined;return characterId?rewardIslandGift(characterId,order.id,`共同礼物：${order.items.map(item=>item.title).join("、")}`,order.conversationId):Promise.resolve()}));return changes.length}

function privateConversation(characterId:string,conversations:Conversation[]){return conversations.find(conversation=>conversation.type==="private"&&conversation.memberIds.length===1&&conversation.memberIds[0]===characterId)}
function orderContent(order:MallOrder){const names=order.items.map(item=>item.quantity>1?`${item.title}×${item.quantity}`:item.title).join("、");return order.kind==="eats"?`[外卖] ${order.payerName}给${order.recipientName}点了${names}`:`[礼物] ${order.payerName}给${order.recipientName}买了${names}`}
function commerceAttachment(order:MallOrder){return{type:"commerce" as const,orderId:order.id,commerceType:order.kind,direction:order.payerType==="user"?"user-to-character" as const:"character-to-user" as const,title:order.kind==="eats"?"外卖订单":"礼物订单",itemNames:order.items.map(item=>item.title),amountCents:order.totalCents,currency:"CNY" as const,recipientName:order.recipientName,status:order.status}}
async function generateOrderReply(character:Character,conversation:Conversation,provider:ProviderSettings){
 if(!provider.apiKey.trim())throw new MallError("provider","尚未配置模型");
 const [messages,loreBooks,memories,settings,characters,mediaAssets]=await Promise.all([
  db.messages.where("conversationId").equals(conversation.id).sortBy("createdAt"),
  db.loreBooks.toArray(),
  db.memories.toArray(),
  getAppSettings(),
  db.characters.toArray(),
  db.mediaAssets.toArray(),
 ]),source=messages.at(-1),prepared=await prepareRoleplayResources({character,conversation,loreBooks,provider}),cast=characters.map(item=>item.id===character.id?prepared.character:item),userText="请以角色身份自然回应刚收到的礼物或外卖，不要声称这是真实商业服务。",presence=await resolveChatPresenceContext({conversation,actorId:prepared.character.id,messages}),crossModeContinuity=await resolveOnlineCrossModeContinuity({conversation,actorId:prepared.character.id,names:Object.fromEntries(cast.map(item=>[item.id,item.name]))}),ctx=buildContext({character:prepared.character,conversation,messages,loreBooks:prepared.loreBooks,memories,userText,settings,provider,characters:cast,mediaAssets,scene:"commerce",presence,crossModeContinuity}),draft=await new OpenAIProvider({...provider,stream:false}).chat(ctx,{stream:false}),review=await reviewCharacterReply({character:prepared.character,conversation,scene:"commerce",draftMessages:[draft],messages,characters:cast,loreBooks:prepared.loreBooks,memories,settings,provider,presence,crossModeContinuity}),reply=review.revisedMessages[0],t=now(),message:Message={id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,conversationId:conversation.id,senderType:"character",senderId:character.id,content:reply,status:"complete",parentId:source?.id,generation:{model:provider.model,temperature:provider.temperature,stream:false}};
 await db.transaction("rw",[db.messages,db.conversations],async()=>{await db.messages.add(message);await db.conversations.update(conversation.id,{lastActivityAt:t,updatedAt:t})});return message
}
export async function checkoutMall(input:{cartKind:"shop"|"eats";recipientType:"user"|"character";recipientId?:string;recipientName:string;userName:string;provider?:ProviderSettings;note?:string}){
 let character:Character|undefined,conversation:Conversation|undefined;
 if(input.recipientType==="character"){
  character=input.recipientId?await db.characters.get(input.recipientId):undefined;
  if(!character)throw new MallError("missing","请选择接收礼物的角色");
   if(!canCharacterInteract(character))throw new MallError("missing","该角色已被拉黑，暂时不能赠送礼物或外卖");
  conversation=privateConversation(character.id,await db.conversations.toArray());
  if(!conversation)throw new MallError("missing","没有找到该角色的私聊");
 }
 const order=await db.transaction("rw",[db.settings,db.walletTransactions,db.mallOrders,db.mallCartItems,db.mallCatalogItems,db.messages,db.conversations,db.meetSessions],async()=>{
  const details=await mallCartDetails(input.cartKind);
  if(!details.length)throw new MallError("missing","购物车是空的");
  const wallet=await ensureMallWallet(),t=now(),subtotal=details.reduce((sum,row)=>sum+row.item.priceCents*row.cart.quantity,0),delivery=input.cartKind==="eats"?(details[0].item.deliveryFeeCents??0):0,total=subtotal+delivery;
  if(wallet.balanceCents<total)throw new MallError("balance","钱包余额不足");
  const orderId=uid(),txId=uid(),messageId=input.recipientType==="character"?uid():undefined,orderItems:MallOrderItem[]=details.map(row=>({id:uid(),catalogItemId:row.item.id,title:row.item.title,merchantName:row.item.merchantName,category:row.item.category,priceCents:row.item.priceCents,quantity:row.cart.quantity,tone:row.item.tone})),kind:MallOrderKind=input.cartKind==="eats"?"eats":"shop",createdOrder:MallOrder={id:orderId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,kind,source:"checkout",payerType:"user",payerName:input.userName,recipientType:input.recipientType,recipientId:character?.id,recipientName:input.recipientName,items:orderItems,subtotalCents:subtotal,deliveryFeeCents:delivery,totalCents:total,userChargeCents:total,status:"placed",conversationId:conversation?.id,messageId,note:input.note},transaction:WalletTransaction={id:txId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,kind:kind==="eats"?"food":"purchase",amountCents:-total,state:"completed",title:kind==="eats"?"外卖消费":"购物消费",orderId},nextWallet={...wallet,balanceCents:wallet.balanceCents-total,updatedAt:t};
  await db.settings.put({key:"mall-wallet",value:nextWallet});
  await db.walletTransactions.add(transaction);
  await db.mallOrders.add(createdOrder);
  await db.mallCartItems.where("cartKind").equals(input.cartKind).delete();
  if(conversation&&messageId){
   await pauseActiveMeetForOnlineActivity(conversation.id,t);
   const message:Message={id:messageId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,conversationId:conversation.id,senderType:"user",content:orderContent(createdOrder),kind:"commerce",attachments:[commerceAttachment(createdOrder)],status:"complete"};
   await db.messages.add(message);
   await db.conversations.update(conversation.id,{lastActivityAt:t,updatedAt:t});
  }
  return createdOrder;
 });
 let replyError="";
 if(character&&conversation&&input.provider)try{
  const reply=await generateOrderReply(character,conversation,input.provider);
  await db.mallOrders.update(order.id,{characterReplyMessageId:reply.id,updatedAt:now()});
 }catch(error){replyError=error instanceof Error?error.message:"角色暂未回复"}
 return{order:await db.mallOrders.get(order.id)??order,replyError};
}

export async function createOutgoingWalletTransfer(input:{conversation:Conversation;amountCents:number;note:string;quote?:MessageQuote}){
 const amount=Math.max(1,Math.round(input.amountCents));
 return db.transaction("rw",[db.settings,db.walletTransactions,db.messages,db.conversations,db.meetSessions],async()=>{
  const wallet=await ensureMallWallet();
  if(wallet.balanceCents<amount)throw new MallError("balance","钱包余额不足");
  const t=now(),messageId=uid(),transactionId=uid(),transaction:WalletTransaction={id:transactionId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,kind:"transfer-out",amountCents:-amount,state:"pending",title:input.note||"聊天转账",messageId},message:Message={id:messageId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,conversationId:input.conversation.id,senderType:"user",content:`[转账] ¥${(amount/100).toFixed(2)}${input.note?` · ${input.note}`:""}`,kind:"transfer",quote:input.quote,attachments:[{type:"transfer",amountCents:amount,currency:"CNY",note:input.note,state:"pending",direction:"user-to-character",walletTransactionId:transactionId}],status:"complete"};
  await pauseActiveMeetForOnlineActivity(input.conversation.id,t);
  await db.settings.put({key:"mall-wallet",value:{...wallet,balanceCents:wallet.balanceCents-amount,updatedAt:t}});
  await db.walletTransactions.add(transaction);
  await db.messages.add(message);
  await db.conversations.update(input.conversation.id,{lastActivityAt:t,updatedAt:t});
  return message;
 });
}

export async function settleOutgoingWalletTransfer(messageId:string,action:"accept"|"refund",handledBy?:string){
 return db.transaction("rw",[db.settings,db.walletTransactions,db.messages],async()=>{
  const message=await db.messages.get(messageId),attachment=message?.attachments?.find(item=>item.type==="transfer");
  if(!message||!attachment||attachment.type!=="transfer"||attachment.state!=="pending")return false;
  const tx=attachment.walletTransactionId?await db.walletTransactions.get(attachment.walletTransactionId):undefined,t=now();
  if(action==="refund"&&tx?.state==="pending"){
   const wallet=await ensureMallWallet();
   await db.settings.put({key:"mall-wallet",value:{...wallet,balanceCents:wallet.balanceCents+attachment.amountCents,updatedAt:t}});
   await db.walletTransactions.update(tx.id,{state:"refunded",updatedAt:t});
  }else if(tx?.state==="pending")await db.walletTransactions.update(tx.id,{state:action==="accept"?"completed":"refunded",updatedAt:t});
  await db.messages.update(message.id,{attachments:message.attachments?.map(item=>item===attachment?{...item,state:action==="accept"?"accepted":"refunded",handledBy,processedAt:t}:item),updatedAt:t});
  return true;
 });
}

export async function receiveIncomingWalletTransfer(messageId:string){
 return db.transaction("rw",[db.settings,db.walletTransactions,db.messages],async()=>{
  const message=await db.messages.get(messageId),attachment=message?.attachments?.find(item=>item.type==="transfer");
  if(!message||!attachment||attachment.type!=="transfer"||attachment.direction!=="character-to-user"||attachment.state!=="pending")return false;
  const tx=attachment.walletTransactionId?await db.walletTransactions.get(attachment.walletTransactionId):undefined;
  if(tx?.state==="completed")return false;
  const wallet=await ensureMallWallet(),t=now();
  await db.settings.put({key:"mall-wallet",value:{...wallet,balanceCents:wallet.balanceCents+attachment.amountCents,updatedAt:t}});
  if(tx)await db.walletTransactions.update(tx.id,{state:"completed",updatedAt:t});
  await db.messages.update(message.id,{attachments:message.attachments?.map(item=>item===attachment?{...item,state:"accepted",handledBy:"user",processedAt:t}:item),updatedAt:t});
  return true;
 });
}

const commerceGate=/吃|饿|饭|餐|外卖|咖啡|奶茶|礼物|送你|买|购物|钱|转账|生日|纪念|难过|安慰|庆祝|奖励|food|eat|hungry|gift|buy|money|birthday/i;
export async function maybeCreateCharacterCommerce(input:{character:Character;conversation:Conversation;sourceMessageId:string;userText:string;replyText:string;provider:ProviderSettings;signal?:AbortSignal;invokeProvider?:ProviderChatInvoker}){if(!canCharacterInteract(input.character)||input.conversation.type!=="private"||!commerceGate.test(`${input.userText}\n${input.replyText}`))return null;const duplicate=await db.messages.filter(message=>message.parentId===input.sourceMessageId&&(message.kind==="commerce"||message.kind==="transfer")&&message.senderType==="character").first();if(duplicate)return duplicate;const app=await getAppSettings(),prompt=["根据私聊语境判断角色是否会自然地转账、给用户点外卖或送礼。只返回严格 JSON。",`角色：${input.character.name}`,`核心设定：${coreSettingOf(input.character)}`,`人物设定：${personaOf(input.character)}`,userPersonaContext(app),relationshipContextOf(input.character),`用户内容：${input.userText}`,`角色刚才的回复：${input.replyText}`,"动作完全由语境决定，不要固定概率；不合适时必须选择 none。一次最多一个动作。",'只返回：{"action":"none|transfer|food|gift","amount":金额数字,"title":"商品或餐品","merchant":"虚构商家","description":"简短说明","price":价格数字,"reason":"原因"}'].filter(Boolean).join("\n\n"),providerMessages=[{role:"system" as const,content:"你只输出虚构角色生活互动的严格 JSON。"},{role:"user" as const,content:prompt}],raw=input.invokeProvider?(await input.invokeProvider({...input.provider,stream:false},providerMessages,{stream:false,signal:input.signal,timeoutMs:null},"auxiliary")).text:await new OpenAIProvider({...input.provider,stream:false}).chat(providerMessages,{stream:false,signal:input.signal}),decision=parseCharacterCommerceDecision(raw);if(!decision||decision.action==="none")return null;const t=now();if(decision.action==="transfer"){const amount=money(decision.amount??decision.price??52,100,520000),messageId=uid(),txId=uid(),message:Message={id:messageId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,conversationId:input.conversation.id,senderType:"character",senderId:input.character.id,content:`[转账] ${input.character.name}向你转账 ¥${(amount/100).toFixed(2)}`,kind:"transfer",parentId:input.sourceMessageId,attachments:[{type:"transfer",amountCents:amount,currency:"CNY",note:decision.description||decision.reason,state:"pending",direction:"character-to-user",walletTransactionId:txId}],status:"complete"},tx:WalletTransaction={id:txId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,kind:"transfer-in",amountCents:amount,state:"pending",title:`${input.character.name}的转账`,messageId,counterpartyId:input.character.id,counterpartyName:input.character.name};await db.transaction("rw",[db.messages,db.walletTransactions,db.conversations],async()=>{await db.messages.add(message);await db.walletTransactions.add(tx);await db.conversations.update(input.conversation.id,{lastActivityAt:t,updatedAt:t})});return message}
 const title=decision.title?.trim()|| (decision.action==="food"?"一份热乎的外卖":"一份礼物"),price=money(decision.price??decision.amount??88,100,520000),kind:MallOrderKind=decision.action==="food"?"eats":"gift",orderId=uid(),messageId=uid(),item:MallOrderItem={id:uid(),title,merchantName:decision.merchant?.trim()||"MALL 虚拟商店",category:decision.action==="food"?"外卖":"礼物",priceCents:price,quantity:1,tone:tone(title)},order:MallOrder={id:orderId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,kind,source:"character",payerType:"character",payerId:input.character.id,payerName:input.character.name,recipientType:"user",recipientName:app.userName||"我",items:[item],subtotalCents:price,deliveryFeeCents:0,totalCents:price,userChargeCents:0,status:"placed",conversationId:input.conversation.id,messageId,sourceMessageId:input.sourceMessageId,note:decision.description||decision.reason},message:Message={id:messageId,schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,conversationId:input.conversation.id,senderType:"character",senderId:input.character.id,content:orderContent(order),kind:"commerce",parentId:input.sourceMessageId,attachments:[commerceAttachment(order)],status:"complete"};await db.transaction("rw",[db.mallOrders,db.messages,db.conversations],async()=>{await db.mallOrders.add(order);await db.messages.add(message);await db.conversations.update(input.conversation.id,{lastActivityAt:t,updatedAt:t})});return message}

