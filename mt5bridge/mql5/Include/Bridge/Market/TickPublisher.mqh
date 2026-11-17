#property strict
// Tick 推送：OnTick 触发（零轮询）。CONFLATED：同 symbol 覆盖。

#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Abi/BridgeApi.mqh>
#include <Bridge/Handlers/MarketHandler.mqh>

string BridgeTickDailyFields(const string symbol)
{
   MqlRates days[];
   int copied=CopyRates(symbol,PERIOD_D1,0,2,days);
   if(copied<=0)
      return ",\"day_open\":null,\"day_high\":null,\"day_low\":null,\"prev_close\":null";
   const int latest=copied-1;
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   string fields=",\"day_open\":"+DoubleToString(days[latest].open,digits)+
      ",\"day_high\":"+DoubleToString(days[latest].high,digits)+
      ",\"day_low\":"+DoubleToString(days[latest].low,digits);
   if(copied>1)
      fields+=",\"prev_close\":"+DoubleToString(days[latest-1].close,digits);
   else
      fields+=",\"prev_close\":null";
   return fields;
}

void PublishTick(const long handle, const string symbol, const MqlTick &tick)
{
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   // 线上约定 UTC（与 BarPublisher/HandleMarketBars 出参同钟）。
   const long utc_shift=(long)(TimeCurrent()-TimeGMT())*1000;
   BridgeEmitEvent(handle,"event.market.tick",
      "{\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"bid\":"+DoubleToString(tick.bid,digits)+
      ",\"ask\":"+DoubleToString(tick.ask,digits)+
      ",\"last\":"+DoubleToString(tick.last,digits)+
      ",\"time_msc\":"+IntegerToString(tick.time_msc-utc_shift)+
      ",\"volume\":"+IntegerToString((long)tick.volume)+
      ",\"volume_real\":"+DoubleToString(tick.volume_real,8)+
      ",\"flags\":"+IntegerToString((long)tick.flags)+
      BridgeTickDailyFields(symbol)+"}",
      true);   // conflated
}
