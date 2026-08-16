import {Aperture,ContactRound,Image as ImageIcon,Plus,UserRound} from "lucide-react";
import {Navigate,NavLink,Outlet,useLocation,useNavigate} from "react-router-dom";
import {AppTopBar} from "../components/ui";
import {useStore} from "../core/store";

export default function SocialLayout(){
 const loc=useLocation(),nav=useNavigate(),{conversationSummaries,feedPosts}=useStore(),chatUnread=Object.values(conversationSummaries??{}).reduce((sum,summary)=>sum+summary.proactiveUnreadCount,0),feedUnread=feedPosts.filter(p=>(p.origin==="proactive"&&!p.readAt)||p.comments.some(c=>c.origin==="proactive"&&!c.readAt)).length;
 if(loc.pathname==="/messages")return <Navigate to="/messages/chats" replace/>;
 const chats=loc.pathname.endsWith("/chats"),feed=loc.pathname.endsWith("/feed"),title=chats?"chat":feed?"动态":loc.pathname.endsWith("/contacts")?"通讯录":"我",backTarget=chats?"/":"/messages/chats";
 return <div className="social-page mono-social"><AppTopBar className="social-header mono-social-header" title={title} titleClassName={chats?"chat-title":"social-section-title"} backLabel={chats?"返回桌面":"返回消息"} onBack={()=>nav(backTarget)} actions={feed?<button className="social-add" aria-label="发布动态" onClick={()=>nav("/messages/feed?compose=1")}><Plus/></button>:undefined}/><div className="social-content"><Outlet/></div><nav className="social-tabs mono-social-tabs"><NavLink to="/messages/chats"><ImageIcon/>{chatUnread>0&&<i>{Math.min(99,chatUnread)}</i>}<span>消息</span></NavLink><NavLink to="/messages/contacts"><ContactRound/><span>通讯录</span></NavLink><NavLink to="/messages/feed"><Aperture/>{feedUnread>0&&<i>{Math.min(99,feedUnread)}</i>}<span>动态</span></NavLink><NavLink to="/messages/me"><UserRound/><span>我</span></NavLink></nav></div>;
}