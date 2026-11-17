#property strict
// 历史订单与成交（slow：上限 2000 条 + truncated 标记，大区间走分页）。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>

#define BRIDGE_HISTORY_LIMIT 2000

string HandleHistoryOrders(const string request)
{
   const long from_ms=RpcParamLong(request,"from_ms",0);
   const long to_ms=RpcParamLong(request,"to_ms",0);
   const string filter=RpcParamString(request,"symbol","");
   // 消费方给 UTC epoch；HistorySelect 的 datetime 按服务器时间解释 —— 先转服务器时区
   // （TimeCurrent() 是服务器钟、TimeGMT() 是 UTC 钟，差即偏移）
   const long tz_shift=(long)(TimeCurrent()-TimeGMT());
   datetime from=(datetime)(from_ms>0 ? from_ms/1000+tz_shift : TimeCurrent()-86400*7);
   datetime to=(datetime)(to_ms>0 ? to_ms/1000+tz_shift : TimeCurrent()+3600);

   if(!HistorySelect(from,to))
      return RpcFail(RpcIdEcho(request),-32052,"NO_HISTORY","HistorySelect failed");

   string items="";
   const int total=HistoryOrdersTotal();
   // 历史为空在服务环境有前科（HistoryCenter 家族），每次查询留痕便于分辨"没数据"与"没同步"
   PrintFormat("[MT5Bridge] history orders %s..%s total=%d",TimeToString(from,TIME_DATE|TIME_MINUTES),TimeToString(to,TIME_DATE|TIME_MINUTES),total);
   const int limit=MathMin(total,BRIDGE_HISTORY_LIMIT);
   for(int i=0;i<limit;i++)
   {
      ulong ticket=HistoryOrderGetTicket(i);
      if(ticket==0) continue;
      if(filter!="" && HistoryOrderGetString(ticket,ORDER_SYMBOL)!=filter) continue;
      const string symbol=HistoryOrderGetString(ticket,ORDER_SYMBOL);
      const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      if(items!="") items+=",";
      items+="{\"ticket\":\""+IntegerToString(ticket)+"\""+
         ",\"symbol\":"+BridgeJsonQuote(symbol)+
         ",\"type\":"+BridgeOrderTypeJson(HistoryOrderGetInteger(ticket,ORDER_TYPE))+
         ",\"state\":"+BridgeJsonQuote(EnumToString((ENUM_ORDER_STATE)HistoryOrderGetInteger(ticket,ORDER_STATE)))+
         ",\"volume_initial\":"+DoubleToString(HistoryOrderGetDouble(ticket,ORDER_VOLUME_INITIAL),2)+
         ",\"volume_current\":"+DoubleToString(HistoryOrderGetDouble(ticket,ORDER_VOLUME_CURRENT),2)+
         ",\"price_open\":"+DoubleToString(HistoryOrderGetDouble(ticket,ORDER_PRICE_OPEN),digits)+
         ",\"price_filled\":"+DoubleToString(HistoryOrderGetDouble(ticket,ORDER_PRICE_STOPLIMIT),digits)+
         ",\"time_setup_msc\":"+IntegerToString(HistoryOrderGetInteger(ticket,ORDER_TIME_SETUP_MSC))+
         ",\"time_done_msc\":"+IntegerToString(HistoryOrderGetInteger(ticket,ORDER_TIME_DONE_MSC))+
         ",\"magic\":"+IntegerToString(HistoryOrderGetInteger(ticket,ORDER_MAGIC))+
         ",\"comment\":"+BridgeJsonQuote(HistoryOrderGetString(ticket,ORDER_COMMENT))+"}";
   }
   return RpcOk(RpcIdEcho(request),
      "{\"count\":"+IntegerToString(limit)+
      ",\"truncated\":"+(total>BRIDGE_HISTORY_LIMIT?"true":"false")+
      ",\"orders\":["+items+"]}");
}

string HandleHistoryDeals(const string request)
{
   const long from_ms=RpcParamLong(request,"from_ms",0);
   const long to_ms=RpcParamLong(request,"to_ms",0);
   const string filter=RpcParamString(request,"symbol","");
   const long tz_shift=(long)(TimeCurrent()-TimeGMT());
   datetime from=(datetime)(from_ms>0 ? from_ms/1000+tz_shift : TimeCurrent()-86400*7);
   datetime to=(datetime)(to_ms>0 ? to_ms/1000+tz_shift : TimeCurrent()+3600);

   if(!HistorySelect(from,to))
      return RpcFail(RpcIdEcho(request),-32052,"NO_HISTORY","HistorySelect failed");

   string items="";
   const int total=HistoryDealsTotal();
   PrintFormat("[MT5Bridge] history deals %s..%s total=%d",TimeToString(from,TIME_DATE|TIME_MINUTES),TimeToString(to,TIME_DATE|TIME_MINUTES),total);
   const int limit=MathMin(total,BRIDGE_HISTORY_LIMIT);
   for(int i=0;i<limit;i++)
   {
      ulong ticket=HistoryDealGetTicket(i);
      if(ticket==0) continue;
      if(filter!="" && HistoryDealGetString(ticket,DEAL_SYMBOL)!=filter) continue;
      const string symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);
      const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      if(items!="") items+=",";
      const long entry=HistoryDealGetInteger(ticket,DEAL_ENTRY);
      items+="{\"ticket\":\""+IntegerToString(ticket)+"\""+
         ",\"order\":\""+IntegerToString(HistoryDealGetInteger(ticket,DEAL_ORDER))+"\""+
         ",\"symbol\":"+BridgeJsonQuote(symbol)+
         ",\"type\":"+BridgeDealTypeJson(HistoryDealGetInteger(ticket,DEAL_TYPE))+
         ",\"direction\":"+(entry==DEAL_ENTRY_OUT?"\"out\"":(entry==DEAL_ENTRY_INOUT?"\"inout\"":"\"in\""))+
         ",\"position\":\""+IntegerToString(HistoryDealGetInteger(ticket,DEAL_POSITION_ID))+"\""+
         ",\"volume\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_VOLUME),2)+
         ",\"price\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_PRICE),digits)+
         ",\"profit\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_PROFIT),2)+
         ",\"commission\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_COMMISSION),2)+
         ",\"swap\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_SWAP),2)+
         ",\"time_msc\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_TIME_MSC))+
         ",\"magic\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_MAGIC))+
         ",\"comment\":"+BridgeJsonQuote(HistoryDealGetString(ticket,DEAL_COMMENT))+"}";
   }
   return RpcOk(RpcIdEcho(request),
      "{\"count\":"+IntegerToString(limit)+
      ",\"truncated\":"+(total>BRIDGE_HISTORY_LIMIT?"true":"false")+
      ",\"deals\":["+items+"]}");
}
