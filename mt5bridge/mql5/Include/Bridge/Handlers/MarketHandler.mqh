#property strict
// 行情查询：quote（即时）/ bars（K线）/ ticks（tick 历史，slow，窗口强制 ≤2h）。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>

string TimeframeName(const ENUM_TIMEFRAMES period)
{
   switch(period)
   {
      case PERIOD_M1: return "M1";  case PERIOD_M2: return "M2";  case PERIOD_M3: return "M3";
      case PERIOD_M4: return "M4";  case PERIOD_M5: return "M5";  case PERIOD_M6: return "M6";
      case PERIOD_M10: return "M10";case PERIOD_M12: return "M12";case PERIOD_M15: return "M15";
      case PERIOD_M20: return "M20";case PERIOD_M30: return "M30";case PERIOD_H1: return "H1";
      case PERIOD_H2: return "H2";  case PERIOD_H3: return "H3";  case PERIOD_H4: return "H4";
      case PERIOD_H6: return "H6";  case PERIOD_H8: return "H8";  case PERIOD_H12: return "H12";
      case PERIOD_D1: return "D1";  case PERIOD_W1: return "W1";  case PERIOD_MN1: return "MN1";
   }
   return "CURRENT";
}

ENUM_TIMEFRAMES TimeframeFromName(const string name)
{
   if(name=="M1") return PERIOD_M1;   if(name=="M2") return PERIOD_M2;
   if(name=="M3") return PERIOD_M3;   if(name=="M4") return PERIOD_M4;
   if(name=="M5") return PERIOD_M5;   if(name=="M6") return PERIOD_M6;
   if(name=="M10") return PERIOD_M10; if(name=="M12") return PERIOD_M12;
   if(name=="M15") return PERIOD_M15; if(name=="M20") return PERIOD_M20;
   if(name=="M30") return PERIOD_M30; if(name=="H1") return PERIOD_H1;
   if(name=="H2") return PERIOD_H2;   if(name=="H3") return PERIOD_H3;
   if(name=="H4") return PERIOD_H4;   if(name=="H6") return PERIOD_H6;
   if(name=="H8") return PERIOD_H8;   if(name=="H12") return PERIOD_H12;
   if(name=="D1") return PERIOD_D1;   if(name=="W1") return PERIOD_W1;
   if(name=="MN1") return PERIOD_MN1;
   return PERIOD_CURRENT;
}

// 服务上下文没有图表，历史序列的同步是惰性的：单发 CopyRates 常见首发 4401（刚触发同步）。
// 跨 RPC 重试泵不动它（两次调用之间程序不碰该序列，MT5 不为其推进同步）——必须在本进程内
// 持续泵（文档/论坛的标准姿势）。等待有界，避免冷序列把 RPC 拖死。
#define BRIDGE_BARS_SYNC_MS 4000
#define BRIDGE_BARS_SYNC_STEP_MS 50

int CopyRatesPumped(const string symbol,const ENUM_TIMEFRAMES period,
   const datetime from,const datetime to,MqlRates &rates[])
{
   const ulong deadline=GetTickCount64()+BRIDGE_BARS_SYNC_MS;
   int copied=CopyRates(symbol,period,from,to,rates);
   while(copied<0 && GetLastError()==4401 && GetTickCount64()<deadline)
   {
      Sleep(BRIDGE_BARS_SYNC_STEP_MS);
      copied=CopyRates(symbol,period,from,to,rates);
   }
   return copied;
}

string HandleMarketQuote(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   if(symbol=="")
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","symbol required");
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick))
      return RpcFail(RpcIdEcho(request),-32051,"SYMBOL_NOT_FOUND","no tick for symbol: "+symbol);

   string result="{\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"bid\":"+DoubleToString(tick.bid,digits)+
      ",\"ask\":"+DoubleToString(tick.ask,digits)+
      ",\"last\":"+DoubleToString(tick.last,digits)+
      ",\"time_msc\":"+IntegerToString(tick.time_msc-(long)(TimeCurrent()-TimeGMT())*1000)+
      ",\"flags\":"+IntegerToString((long)tick.flags)+
      ",\"volume\":"+IntegerToString((long)tick.volume)+
      ",\"volume_real\":"+DoubleToString(tick.volume_real,8)+"}";
   return RpcOk(RpcIdEcho(request),result);
}

string HandleMarketBars(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   const string period_name=RpcParamString(request,"period","M1");
   const ENUM_TIMEFRAMES period=TimeframeFromName(period_name);
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);

   long count=RpcParamLong(request,"count",500);
   const long from_ms=RpcParamLong(request,"from_ms",0);
   const long to_ms=RpcParamLong(request,"to_ms",0);
   // 消费方给 UTC epoch；CopyRates 的 datetime 按服务器时间解释 —— 先转服务器时区（与 HistoryHandler 同约定）。
   // 不转的话 to=Date.now() 被当服务器钟，历史永远截在真实时刻前 tz 小时，与实时推送（原始服务器钟）
   // 相差一个时区 → 图表历史块与最后一根实时蜡烛之间出现整段空档。
   const long tz_shift=(long)(TimeCurrent()-TimeGMT())*1000;
   const long from_srv=from_ms>0 ? from_ms+tz_shift : 0;
   const long to_srv=to_ms>0 ? to_ms+tz_shift : 0;
   if(count>5000) count=5000;    // 大区间走分页，防单帧 MB 级响应
   if(count<=0) count=100;

   MqlRates rates[];
   int copied=0;
   datetime dbg_first=0,dbg_last=0;
   if(from_srv>0 && to_srv>0)
   {
      datetime from=(datetime)(from_srv/1000);
      datetime to=(datetime)(to_srv/1000);
      dbg_first=from; dbg_last=to;
      copied=CopyRatesPumped(symbol,period,from,to,rates);
   }
   else if(to_srv>0)
   {
      // to+count：to 之前（排他）最近 count 根，锚定版取数——与 dsh 老桥 market.history 同语义。
      // CopyRates(start,count) 是从 start 向后取根——锚点会被钳到回放前沿，之后无数据必 4401；
      // "之前 count 根"须用双时间区间：[last-count*周期, last]，再截掉区间前端多出的根。
      // 锚点钳到 TimeCurrent()：真实终端 to 落在停盘/未来时收敛到最近一根；测试器 agent 的
      // TimeCurrent() 是回放模拟钟，墙钟 to（如 SDK 传 Date.now()）越过回放头也能取到已流过的根。
      datetime last=(datetime)MathMin(to_srv/1000-1,(long)TimeCurrent());
      datetime first=last-(int)count*PeriodSeconds(period);
      dbg_first=first; dbg_last=last;
      copied=CopyRatesPumped(symbol,period,first,last,rates);
      if(copied>(int)count)   // 区间宽度按整根估算，至多多取 1 根在头部
      {
         const int extra=copied-(int)count;
         for(int i=0;i<(int)count;i++)
            rates[i]=rates[i+extra];
         copied=(int)count;
      }
   }
   else if(from_srv>0)
   {
      datetime from=(datetime)(from_srv/1000);
      datetime to=(datetime)(TimeCurrent()+86400);
      dbg_first=from; dbg_last=to;
      copied=CopyRatesPumped(symbol,period,from,to,rates);
   }
   else
      copied=CopyRates(symbol,period,0,(int)count,rates);   // (start,count) 重载，dsh 路径不带 to 不会走到

   if(copied<0)
   {
      MqlRates probe[];
      const int plain=CopyRates(symbol,period,0,5,probe);
      PrintFormat("[MT5Bridge] bars dbg sym=%s per=%s shift=%I64d tcur=%I64d gmt=%I64d to_in=%I64d to_srv=%I64d first=%I64d last=%I64d copied=%d err=%d plain=%d plainerr=%d",
         symbol,period_name,tz_shift,(long)TimeCurrent(),(long)TimeGMT(),to_ms,to_srv,(long)dbg_first,(long)dbg_last,copied,GetLastError(),plain,GetLastError());
      return RpcFail(RpcIdEcho(request),-32052,"NO_HISTORY","CopyRates failed: "+IntegerToString(GetLastError()));
   }

   string bars="";
   for(int i=0;i<copied;i++)
   {
      if(i>0) bars+=",";
      bars+="{\"time_msc\":"+IntegerToString((long)rates[i].time*1000-tz_shift)+
         ",\"open\":"+DoubleToString(rates[i].open,digits)+
         ",\"high\":"+DoubleToString(rates[i].high,digits)+
         ",\"low\":"+DoubleToString(rates[i].low,digits)+
         ",\"close\":"+DoubleToString(rates[i].close,digits)+
         ",\"tick_volume\":"+IntegerToString((long)rates[i].tick_volume)+
         ",\"spread\":"+IntegerToString((long)rates[i].spread)+
         ",\"real_volume\":"+IntegerToString((long)rates[i].real_volume)+"}";
   }
   string result="{\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"period\":"+BridgeJsonQuote(TimeframeName(period))+
      ",\"count\":"+IntegerToString(copied)+
      ",\"truncated\":"+(copied>=count ? "true" : "false")+
      ",\"bars\":["+bars+"]}";
   return RpcOk(RpcIdEcho(request),result);
}

string HandleMarketTicks(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   long from_ms=RpcParamLong(request,"from_ms",0);
   const long to_ms=RpcParamLong(request,"to_ms",0);
   if(symbol=="" || from_ms<=0 || to_ms<=0 || to_ms<=from_ms)
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","symbol/from_ms/to_ms required");

   // 消费方给 UTC epoch；CopyTicksRange 的毫秒时间按服务器钟解释 —— 与 HandleMarketBars 同约定。
   const long tz_shift=(long)(TimeCurrent()-TimeGMT())*1000;
   from_ms+=tz_shift;
   const long to_srv=to_ms+tz_shift;

   // 硬约束 C6：CopyTicksRange 同步阻塞可达分钟级 → 服务端强制 ≤2h 窗口
   bool truncated=false;
   long span=to_srv-from_ms;
   if(span>2*3600*1000)
   {
      truncated=true;
      from_ms=to_srv-2*3600*1000;
   }

   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   MqlTick ticks[];
   int copied=CopyTicksRange(symbol,ticks,(ulong)from_ms,(ulong)to_srv,(uint)COPY_TICKS_INFO);
   if(copied<0)
      return RpcFail(RpcIdEcho(request),-32052,"NO_HISTORY","CopyTicksRange failed: "+IntegerToString(GetLastError()));

   string items="";
   const int limit=MathMin(copied,5000);
   if(limit<copied) truncated=true;
   for(int i=0;i<limit;i++)
   {
      if(i>0) items+=",";
      items+="{\"time_msc\":"+IntegerToString(ticks[i].time_msc-tz_shift)+
         ",\"bid\":"+DoubleToString(ticks[i].bid,digits)+
         ",\"ask\":"+DoubleToString(ticks[i].ask,digits)+
         ",\"last\":"+DoubleToString(ticks[i].last,digits)+
         ",\"volume\":"+IntegerToString((long)ticks[i].volume)+
         ",\"flags\":"+IntegerToString((long)ticks[i].flags)+"}";
   }
   string result="{\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"count\":"+IntegerToString(limit)+
      ",\"truncated\":"+(truncated?"true":"false")+
      ",\"ticks\":["+items+"]}";
   return RpcOk(RpcIdEcho(request),result);
}
