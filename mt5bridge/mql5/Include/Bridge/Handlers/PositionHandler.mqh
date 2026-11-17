#property strict
// 持仓：查询 + 平仓/修改（OrderSendAsync，deferred）。
// 条目序列化同时被 AccountHandler.state_snapshot 与 TradeWatcher 复用。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Handlers/TradeHandler.mqh>

string BridgePositionEntryJson(const ulong ticket)
{
   const string symbol=PositionGetString(POSITION_SYMBOL);
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   // 服务环境下重读 POSITION_TICKET 属性恒为 0（Windsor 实测），ticket 一律取选仓时的返回值
   return "{\"ticket\":\""+IntegerToString((long)ticket)+"\""+
      ",\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"type\":"+(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY ? "\"buy\"" : "\"sell\"")+
      ",\"volume\":"+DoubleToString(PositionGetDouble(POSITION_VOLUME),2)+
      ",\"price_open\":"+DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN),digits)+
      ",\"price_current\":"+DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT),digits)+
      ",\"sl\":"+DoubleToString(PositionGetDouble(POSITION_SL),digits)+
      ",\"tp\":"+DoubleToString(PositionGetDouble(POSITION_TP),digits)+
      ",\"profit\":"+DoubleToString(PositionGetDouble(POSITION_PROFIT),2)+
      ",\"swap\":"+DoubleToString(PositionGetDouble(POSITION_SWAP),2)+
      ",\"time_msc\":"+IntegerToString((long)PositionGetInteger(POSITION_TIME_MSC))+
      ",\"magic\":"+IntegerToString(PositionGetInteger(POSITION_MAGIC))+
      ",\"comment\":"+BridgeJsonQuote(PositionGetString(POSITION_COMMENT))+"}";
}

string BridgeAllPositionsJson()
{
   string items="";
   const int total=PositionsTotal();
   for(int i=0;i<total;i++)
   {
      const ulong ticket=PositionGetTicket(i);
      if(ticket==0) continue;
      if(items!="") items+=",";
      items+=BridgePositionEntryJson(ticket);
   }
   return "["+items+"]";
}

string HandlePositionList(const string request)
{
   return RpcOk(RpcIdEcho(request),"{\"positions\":"+BridgeAllPositionsJson()+"}");
}

string HandlePositionClose(const string request)
{
   const ulong ticket=RpcParamUlong(request,"ticket");
   if(ticket==0 || !PositionSelectByTicket(ticket))
      return RpcFailMt(RpcIdEcho(request),"POSITION_NOT_FOUND","position ticket not found",0);

   const string symbol=PositionGetString(POSITION_SYMBOL);
   const double volume_open=PositionGetDouble(POSITION_VOLUME);
   double volume=RpcParamDouble(request,"volume",0);
   if(volume<=0 || volume>volume_open) volume=volume_open;   // 0 = 全平

   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick))
      return RpcFailMt(RpcIdEcho(request),"NO_TICK","cannot price the close",0);

   MqlTradeRequest req; ZeroMemory(req);
   MqlTradeResult  res; ZeroMemory(res);
   req.action=TRADE_ACTION_DEAL;
   req.symbol=symbol;
   req.position=ticket;
   req.volume=volume;
   req.type=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY);
   req.price=(req.type==ORDER_TYPE_SELL ? tick.bid : tick.ask);
   req.deviation=(ulong)RpcParamLong(request,"deviation",50);
   req.type_filling=BridgePickFilling(symbol);
   req.magic=BRIDGE_TRADE_MAGIC;
   req.comment=BridgeBuildComment(RpcParamString(request,"idempotency_key",""));

   if(!OrderSendAsync(req,res))
      return RpcFailMt(RpcIdEcho(request),"TRADE_SEND_FAILED","OrderSendAsync returned false",res.retcode);
   return RpcOk(RpcIdEcho(request),
      "{\"status\":\"accepted\",\"request_id\":"+IntegerToString(res.request_id)+
      ",\"retcode\":"+IntegerToString(res.retcode)+"}");
}

string HandlePositionModify(const string request)
{
   const ulong ticket=RpcParamUlong(request,"ticket");
   if(ticket==0 || !PositionSelectByTicket(ticket))
      return RpcFailMt(RpcIdEcho(request),"POSITION_NOT_FOUND","position ticket not found",0);

   MqlTradeRequest req; ZeroMemory(req);
   MqlTradeResult  res; ZeroMemory(res);
   req.action=TRADE_ACTION_SLTP;
   req.symbol=PositionGetString(POSITION_SYMBOL);
   req.position=ticket;
   req.sl=RpcParamDouble(request,"sl",0);
   req.tp=RpcParamDouble(request,"tp",0);

   if(!OrderSendAsync(req,res))
   {
      PrintFormat("[MT5Bridge] position.modify fail ticket=%I64u symbol=%s sl=%.5f tp=%.5f err=%d ret=%u",
         ticket,req.symbol,req.sl,req.tp,GetLastError(),res.retcode);
      return RpcFailMt(RpcIdEcho(request),"TRADE_SEND_FAILED","OrderSendAsync returned false",res.retcode);
   }
   return RpcOk(RpcIdEcho(request),
      "{\"status\":\"accepted\",\"request_id\":"+IntegerToString(res.request_id)+
      ",\"retcode\":"+IntegerToString(res.retcode)+"}");
}
