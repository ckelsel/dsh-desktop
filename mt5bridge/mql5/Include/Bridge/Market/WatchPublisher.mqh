#property strict
// Watchlist 报价发布：Service 定时器读 SymbolInfoTick，零图表（图表只留给 K线流——DSH 看哪个开哪个）。
// 集合语义：market.watch 一次请求整体替换 watch 集；空数组 = 全部停。
// 变化门槛：tick.time_msc 前进才发；event.market.tick 本就 CONFLATED（同 symbol 覆盖）。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Market/TickPublisher.mqh>

#define BRIDGE_WATCH_MAX         64
#define BRIDGE_WATCH_INTERVAL_MS 200

string g_watchlist_symbols[BRIDGE_WATCH_MAX];
long   g_watchlist_msc[BRIDGE_WATCH_MAX];
int    g_watchlist_count=0;
ulong  g_watchlist_scan_ms=0;

// params.symbols 是字符串数组（["A","B"]）：扫描带引号的段。规模小（≤64），不求 JSON 通用解析。
int WatchParseSymbols(const string request, int &end)
{
   int pos=StringFind(request,"\"symbols\"");
   if(pos<0) return 0;
   pos=StringFind(request,"[",pos);
   if(pos<0) return 0;
   end=StringFind(request,"]",pos);
   if(end<0) end=StringLen(request);
   int n=0;
   while(n<BRIDGE_WATCH_MAX)
   {
      const int q1=StringFind(request,"\"",pos+1);
      if(q1<0 || q1>=end) break;
      const int q2=StringFind(request,"\"",q1+1);
      if(q2<0) break;
      g_watchlist_symbols[n]=StringSubstr(request,q1+1,q2-q1-1);
      g_watchlist_msc[n]=0;
      n++;
      pos=q2;
   }
   return n;
}

string HandleMarketWatch(const string request)
{
   int end=0;
   const int count=WatchParseSymbols(request,end);
   g_watchlist_count=count;
   g_watchlist_scan_ms=0;   // 下一轮循环立即全量发一帧（种子报价）
   return RpcOk(RpcIdEcho(request),
      "{\"count\":"+IntegerToString(count)+"}");
}

void WatchPublisherTick(const long handle)
{
   if(g_watchlist_count<=0) return;
   const ulong now=GetTickCount64();
   if(now-g_watchlist_scan_ms<BRIDGE_WATCH_INTERVAL_MS) return;
   g_watchlist_scan_ms=now;
   for(int i=0;i<g_watchlist_count;i++)
   {
      MqlTick tick;
      if(!SymbolInfoTick(g_watchlist_symbols[i],tick)) continue;
      if((long)tick.time_msc==g_watchlist_msc[i]) continue;
      g_watchlist_msc[i]=(long)tick.time_msc;
      PublishTick(handle,g_watchlist_symbols[i],tick);
   }
}
