#property strict
// K线推送：OnTick 内检测当前 bar 时间变化。收盘 bar RELIABLE，当前 bar CONFLATED。

#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Handlers/MarketHandler.mqh>

datetime g_bar_last_time=0;

string BridgeBarParams(const string symbol, const ENUM_TIMEFRAMES period, const MqlRates &bar)
{
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   // 线上约定 UTC（与 HandleMarketBars 出参一致）：bar.time 是服务器钟，历史查询/图表轴/实时推送
   // 必须同钟，否则历史块与实时蜡烛错位一个时区、图表末尾出现整段空档。
   const long utc_shift=(long)(TimeCurrent()-TimeGMT())*1000;
   return "\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"period\":"+BridgeJsonQuote(TimeframeName(period))+
      ",\"time_msc\":"+IntegerToString((long)bar.time*1000-utc_shift)+
      ",\"open\":"+DoubleToString(bar.open,digits)+
      ",\"high\":"+DoubleToString(bar.high,digits)+
      ",\"low\":"+DoubleToString(bar.low,digits)+
      ",\"close\":"+DoubleToString(bar.close,digits)+
      ",\"tick_volume\":"+IntegerToString((long)bar.tick_volume)+
      ",\"spread\":"+IntegerToString((long)bar.spread)+
      ",\"real_volume\":"+IntegerToString((long)bar.real_volume);
}

void PublishBarCheck(const long handle, const string symbol, const ENUM_TIMEFRAMES period)
{
   const datetime current=iTime(symbol,period,0);
   if(current<=0) return;

   if(current!=g_bar_last_time)
   {
      // 开新 bar：先补发刚收盘那根（RELIABLE），基线推进。首帧没有"上一根"可发。
      if(g_bar_last_time>0)
      {
         MqlRates closed[];
         if(CopyRates(symbol,period,1,1,closed)==1)
            BridgeEmitEvent(handle,"event.market.bar_closed",
               "{"+BridgeBarParams(symbol,period,closed[0])+",\"closed\":true}",false);
      }
      g_bar_last_time=current;
   }
   // 当前 bar 盘中演进：每 tick 都发（CONFLATED 同 symbol+period 覆盖，DLL 出站每周期至多一份）。
   // 只在开盘时发快照的话，M15 图的最后一根整个周期是死的——列表报价在跳、蜡烛不动。
   MqlRates bar[];
   if(CopyRates(symbol,period,0,1,bar)==1)
      BridgeEmitEvent(handle,"event.market.bar",
         "{"+BridgeBarParams(symbol,period,bar[0])+",\"closed\":false}",true);
}

void BarPublisherReset()
{
   g_bar_last_time=0;
}
