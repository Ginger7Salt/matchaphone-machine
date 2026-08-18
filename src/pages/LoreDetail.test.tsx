import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {MemoryRouter,Route,Routes} from "react-router-dom";
import {afterEach,describe,expect,it,vi} from "vitest";
import LoreDetail from "./LoreDetail";

const mocked=vi.hoisted(()=>({state:{} as any}));
vi.mock("../core/store",()=>({useStore:()=>mocked.state}));
vi.mock("../core/loreShelfGroups",()=>({getLoreShelfGroups:vi.fn(async()=>[]),ensureLoreShelfGroup:vi.fn()}));

const book={id:"book-long",schemaVersion:1,createdAt:1,updatedAt:1,name:"Long lore",description:"",entries:[],enabled:true,mount:{mode:"none",characterIds:[],conversationIds:[]},triggerSettings:{defaultScanDepth:20}};

describe("LoreDetail unlimited source editor",()=>{
 afterEach(()=>cleanup());
 it("accepts an entry larger than the former runtime budget without maxLength",async()=>{
  mocked.state={loreBooks:[book],characters:[],conversations:[],reload:vi.fn()};
  render(<MemoryRouter initialEntries={["/lore/book-long"]}><Routes><Route path="/lore/:id" element={<LoreDetail/>}/></Routes></MemoryRouter>);
  await waitFor(()=>expect(screen.getByRole("button",{name:"\u65b0\u5efa\u6761\u76ee"})).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button",{name:"\u65b0\u5efa\u6761\u76ee"}));
  const textarea=screen.getByLabelText(/\u8bbe\u5b9a\u6b63\u6587/) as HTMLTextAreaElement,longText="start-"+"x".repeat(120000)+"-end";
  expect(textarea.maxLength).toBe(-1);
  fireEvent.change(textarea,{target:{value:longText}});
  expect(textarea.value).toBe(longText);
  expect(screen.getByText(/\u6761\u76ee\u539f\u6587\u4e0d\u4f1a\u88ab\u622a\u65ad/)).toBeInTheDocument();
 });
});
