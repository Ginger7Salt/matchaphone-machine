import {beforeEach,describe,expect,it,vi} from "vitest";
import {db} from "./db";
import {createBackup,factoryReset,restoreBackup} from "./backup";
import {
  DEFAULT_MALL_BALANCE_CENTS,
  addMallCartItem,
  checkoutMall,
  createOutgoingWalletTransfer,
  ensureMallStarterCatalog,
  ensureMallWallet,
  generateMallCatalog,
  mallOrderStatus,
  parseCharacterCommerceDecision,
  receiveIncomingWalletTransfer,
  setMallBalance,
  settleOutgoingWalletTransfer
} from "./mall";
import {defaultProvider,type Conversation,type MallCatalogItem,type MallOrder,type Message,type WalletTransaction} from "./types";

const shop=(id:string,title:string,priceCents=1200):MallCatalogItem=>({
  id,schemaVersion:1,createdAt:1,updatedAt:1,searchId:"search",query:"衣服",kind:"shop",
  title,merchantName:"MALL STUDIO",category:"服装",description:"测试商品",priceCents,tone:1
});
const food=(id:string,merchantId:string):MallCatalogItem=>({
  id,schemaVersion:1,createdAt:1,updatedAt:1,searchId:"search",query:"午餐",kind:"food",
  title:`餐品 ${id}`,merchantName:`餐厅 ${merchantId}`,merchantId,category:"主食",description:"测试餐品",
  priceCents:1800,tone:2,deliveryFeeCents:300
});
const conversation:Conversation={
  id:"cv",schemaVersion:1,createdAt:1,updatedAt:1,title:"私聊",type:"private",memberIds:["c"],
  presetIds:[],loreBookIds:[],lastActivityAt:1
};

beforeEach(async()=>{
  await db.delete();
  await db.open();
  vi.restoreAllMocks();
});

describe("MALL wallet and checkout",()=>{
  it("initializes the wallet with ¥5,200",async()=>{
    expect((await ensureMallWallet()).balanceCents).toBe(DEFAULT_MALL_BALANCE_CENTS);
    expect((await db.settings.get("mall-wallet"))?.value).toMatchObject({balanceCents:520000});
  });

  it("records a balance adjustment",async()=>{
    await setMallBalance(123400);
    expect((await ensureMallWallet()).balanceCents).toBe(123400);
    expect(await db.walletTransactions.count()).toBe(1);
    expect((await db.walletTransactions.toArray())[0]).toMatchObject({kind:"adjustment",amountCents:-396600,state:"completed"});
  });

  it("checks out atomically and blocks insufficient balance",async()=>{
    const item=shop("shirt","衬衫");
    await db.mallCatalogItems.add(item);
    await addMallCartItem(item);
    await setMallBalance(2000);
    const result=await checkoutMall({cartKind:"shop",recipientType:"user",recipientName:"我",userName:"我"});
    expect(result.order).toMatchObject({kind:"shop",totalCents:1200,userChargeCents:1200,status:"placed"});
    expect((await ensureMallWallet()).balanceCents).toBe(800);
    expect(await db.mallCartItems.count()).toBe(0);
    expect((await db.walletTransactions.where("orderId").equals(result.order.id).first())?.amountCents).toBe(-1200);

    await db.mallCatalogItems.add(shop("coat","外套",2000));
    await addMallCartItem((await db.mallCatalogItems.get("coat"))!);
    await expect(checkoutMall({cartKind:"shop",recipientType:"user",recipientName:"我",userName:"我"})).rejects.toMatchObject({kind:"balance"});
    expect(await db.mallOrders.count()).toBe(1);
  });

  it("allows only one checkout when the submit action races",async()=>{
    const item=shop("bag","包",3000);
    await db.mallCatalogItems.add(item);
    await addMallCartItem(item);
    await setMallBalance(5000);
    const results=await Promise.allSettled([
      checkoutMall({cartKind:"shop",recipientType:"user",recipientName:"我",userName:"我"}),
      checkoutMall({cartKind:"shop",recipientType:"user",recipientName:"我",userName:"我"})
    ]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(await db.mallOrders.count()).toBe(1);
    expect((await ensureMallWallet()).balanceCents).toBe(2000);
  });

  it("rejects food from a second restaurant",async()=>{
    const first=food("rice","a"),second=food("noodle","b");
    await db.mallCatalogItems.bulkAdd([first,second]);
    await addMallCartItem(first);
    await expect(addMallCartItem(second)).rejects.toMatchObject({kind:"merchant"});
    expect(await db.mallCartItems.count()).toBe(1);
  });

  it("backs up and restores MALL data and wallet settings",async()=>{
    const item=shop("backup-item","备份商品",2500);
    await db.mallCatalogItems.add(item);
    await addMallCartItem(item);
    await setMallBalance(888800);
    const backup=await createBackup();
    await Promise.all([db.mallCatalogItems.clear(),db.mallCartItems.clear(),db.walletTransactions.clear()]);
    await db.settings.delete("mall-wallet");
    await restoreBackup(backup);
    expect(await db.mallCatalogItems.count()).toBe(1);
    expect(await db.mallCartItems.count()).toBe(1);
    expect((await ensureMallWallet()).balanceCents).toBe(888800);
    expect(await db.walletTransactions.count()).toBe(1);
  });

  it("clears MALL data during factory reset",async()=>{
    const item=shop("reset-item","重置商品");
    await db.mallCatalogItems.add(item);
    await addMallCartItem(item);
    await setMallBalance(10000);
    await factoryReset();
    expect(await db.mallCatalogItems.count()).toBe(0);
    expect(await db.mallCartItems.count()).toBe(0);
    expect(await db.mallOrders.count()).toBe(0);
    expect(await db.walletTransactions.count()).toBe(0);
    expect((await ensureMallWallet()).balanceCents).toBe(DEFAULT_MALL_BALANCE_CENTS);
  });
});

describe("MALL transfers and delivery",()=>{
  it("refunds an outgoing transfer exactly once",async()=>{
    await db.conversations.add(conversation);
    await setMallBalance(5000);
    const message=await createOutgoingWalletTransfer({conversation,amountCents:1200,note:"午餐",quote:{messageId:"source",senderType:"character",senderId:"c",senderName:"角色",kind:"text",preview:"记得吃饭"}});
    expect((await ensureMallWallet()).balanceCents).toBe(3800);
    expect(message.quote?.preview).toBe("记得吃饭");
    expect(await settleOutgoingWalletTransfer(message.id,"refund","c")).toBe(true);
    expect(await settleOutgoingWalletTransfer(message.id,"refund","c")).toBe(false);
    expect((await ensureMallWallet()).balanceCents).toBe(5000);
    expect((await db.walletTransactions.where("messageId").equals(message.id).first())?.state).toBe("refunded");
  });

  it("collects an incoming character transfer idempotently",async()=>{
    const transaction:WalletTransaction={id:"tx",schemaVersion:1,createdAt:1,updatedAt:1,kind:"transfer-in",amountCents:1000,state:"pending",title:"角色转账",messageId:"incoming"};
    const message:Message={id:"incoming",schemaVersion:1,createdAt:1,updatedAt:1,conversationId:"cv",senderType:"character",senderId:"c",content:"转账",kind:"transfer",attachments:[{type:"transfer",amountCents:1000,currency:"CNY",state:"pending",direction:"character-to-user",walletTransactionId:"tx"}],status:"complete"};
    await db.walletTransactions.add(transaction);
    await db.messages.add(message);
    const results=await Promise.all([receiveIncomingWalletTransfer(message.id),receiveIncomingWalletTransfer(message.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await ensureMallWallet()).balanceCents).toBe(DEFAULT_MALL_BALANCE_CENTS+1000);
    expect((await db.walletTransactions.get("tx"))?.state).toBe("completed");
  });

  it("calculates accelerated order progress",()=>{
    const order={id:"o",schemaVersion:1,createdAt:0,updatedAt:0,kind:"eats",source:"checkout",payerType:"user",payerName:"我",recipientType:"user",recipientName:"我",items:[],subtotalCents:0,deliveryFeeCents:0,totalCents:0,userChargeCents:0,status:"placed"} as MallOrder;
    expect(mallOrderStatus(order,30_000)).toBe("placed");
    expect(mallOrderStatus(order,2*60_000)).toBe("preparing");
    expect(mallOrderStatus(order,8*60_000)).toBe("delivering");
    expect(mallOrderStatus(order,13*60_000)).toBe("delivered");
  });
});

describe("MALL starter catalog",()=>{
  it("adds multi-category SHOP products and initial EATS menus only once",async()=>{
    const first=await ensureMallStarterCatalog();
    const second=await ensureMallStarterCatalog();
    expect(first).toHaveLength(32);
    expect(second).toHaveLength(0);
    expect(await db.mallCatalogItems.where("kind").equals("shop").count()).toBe(12);
    expect(await db.mallCatalogItems.where("kind").equals("restaurant").count()).toBe(4);
    expect(await db.mallCatalogItems.where("kind").equals("food").count()).toBe(16);
    const categories=new Set((await db.mallCatalogItems.where("kind").equals("shop").toArray()).map(item=>item.category));
    for(const category of ["DIGITAL","HOME","BOOKS","BEAUTY","FOOD","TOYS"])expect(categories.has(category)).toBe(true);
    await db.mallCatalogItems.clear();
    expect(await ensureMallStarterCatalog()).toHaveLength(0);
    expect(await db.mallCatalogItems.count()).toBe(0);
  });

  it("preserves user products while adding the initial catalog",async()=>{
    await db.mallCatalogItems.add(shop("existing","已有商品"));
    expect(await ensureMallStarterCatalog()).toHaveLength(32);
    expect(await db.mallCatalogItems.get("existing")).toMatchObject({title:"已有商品"});
    expect(await db.mallCatalogItems.count()).toBe(33);
  });

  it("replaces legacy fashion starters and removes their dangling cart rows",async()=>{
    const legacy={...shop("legacy","旧版针织衫"),searchId:"mall-starter-v1"};
    await db.mallCatalogItems.bulkAdd([legacy,shop("user","用户生成商品")]);
    await addMallCartItem(legacy);
    await ensureMallStarterCatalog();
    expect(await db.mallCatalogItems.get("legacy")).toBeUndefined();
    expect(await db.mallCatalogItems.get("user")).toBeDefined();
    expect(await db.mallCartItems.count()).toBe(0);
    expect(await db.mallCatalogItems.where("kind").equals("shop").count()).toBe(13);
  });
});

describe("MALL catalog generation",()=>{
  it("parses strict SHOP JSON and persists generated items",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({items:[{title:"低饱和针织衫",brand:"Mori Studio",category:"针织",description:"柔软的虚构针织衫",price:129,colors:["燕麦色"],sizes:["S","M"]}]})}}]}),{status:200,headers:{"Content-Type":"application/json"}})));
    const rows=await generateMallCatalog("shop","针织衫",{...defaultProvider, networkMode: "direct" as const,apiKey:"test",stream:false});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({kind:"shop",title:"低饱和针织衫",priceCents:12900,query:"针织衫"});
    expect(await db.mallCatalogItems.count()).toBe(1);
  });
});





describe("character commerce parsing",()=>{
  it("recovers a fenced transfer action",()=>{
    const raw="prefix\n"+"`".repeat(3)+"json\n{\"action\":\"transfer\",\"amount\":52,}\n"+"`".repeat(3);
    expect(parseCharacterCommerceDecision(raw)).toMatchObject({action:"transfer",amount:52});
  });
  it("treats an invalid commercial action as no action",()=>{
    expect(parseCharacterCommerceDecision("not json")).toBeNull();
  });
});
