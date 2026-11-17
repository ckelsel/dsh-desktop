#property strict
// 活动订单（挂单）：查询 / 改单 / 撤单。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Handlers/TradeHandler.mqh>

string BridgeOrderEntryJson(const ulong ticket)
{
   const string symbol=OrderGetString(ORDER_SYMBOL);
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   return "{\"ticket\":\""+IntegerToString(ticket)+"\""+
      ",\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"type\":"+BridgeOrderTypeJson(OrderGetInteger(ORDER_TYPE))+
      ",\"state\":"+BridgeJsonQuote(EnumToString((ENUM_ORDER_STATE)OrderGetInteger(ORDER_STATE)))+
      ",\"volume_initial\":"+DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT),2)+
      ",\"volume_current\":"+DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT),2)+
      ",\"price_open\":"+DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN),digits)+
      ",\"sl\":"+DoubleToString(OrderGetDouble(ORDER_SL),digits)+
      ",\"tp\":"+DoubleToString(OrderGetDouble(ORDER_TP),digits)+
      ",\"time_setup_msc\":"+IntegerToString(OrderGetInteger(ORDER_TIME_SETUP_MSC))+
      ",\"magic\":"+IntegerToString(OrderGetInteger(ORDER_MAGIC))+
      ",\"comment\":"+BridgeJsonQuote(OrderGetString(ORDER_COMMENT))+"}";
}

string BridgeAllOrdersJson()
{
   string items="";
   const int total=OrdersTotal();
   for(int i=0;i<total;i++)
   {
      ulong ticket=OrderGetTicket(i);
      if(ticket==0) continue;
      if(items!="") items+=",";
      items+=BridgeOrderEntryJson(ticket);
   }
   return "["+items+"]";
}

string HandleOrderList(const string request)
{
   return RpcOk(RpcIdEcho(request),"{\"orders\":"+BridgeAllOrdersJson()+"}");
}

string HandleOrderModify(const string request)
{
   const ulong ticket=RpcParamUlong(request,"ticket");
   if(ticket==0 || !OrderSelect(ticket))
      return RpcFailMt(RpcIdEcho(request),"ORDER_NOT_FOUND","order ticket not found",0);

   MqlTradeRequest req; ZeroMemory(req);
   MqlTradeResult  res; ZeroMemory(res);
   req.action=TRADE_ACTION_MODIFY;
   req.order=ticket;
   req.price=RpcParamDouble(request,"price",OrderGetDouble(ORDER_PRICE_OPEN));
   req.sl=RpcParamDouble(request,"sl",OrderGetDouble(ORDER_SL));
   req.tp=RpcParamDouble(request,"tp",OrderGetDouble(ORDER_TP));

   if(!OrderSendAsync(req,res))
      return RpcFailMt(RpcIdEcho(request),"TRADE_SEND_FAILED","OrderSendAsync returned false",res.retcode);
   return RpcOk(RpcIdEcho(request),
      "{\"status\":\"accepted\",\"request_id\":"+IntegerToString(res.request_id)+
      ",\"retcode\":"+IntegerToString(res.retcode)+"}");
}

string HandleOrderCancel(const string request)
{
   const ulong ticket=RpcParamUlong(request,"ticket");
   if(ticket==0 || !OrderSelect(ticket))
      return RpcFailMt(RpcIdEcho(request),"ORDER_NOT_FOUND","order ticket not found",0);

   MqlTradeRequest req; ZeroMemory(req);
   MqlTradeResult  res; ZeroMemory(res);
   req.action=TRADE_ACTION_REMOVE;
   req.order=ticket;

   if(!OrderSendAsync(req,res))
      return RpcFailMt(RpcIdEcho(request),"TRADE_SEND_FAILED","OrderSendAsync returned false",res.retcode);
   return RpcOk(RpcIdEcho(request),
      "{\"status\":\"accepted\",\"request_id\":"+IntegerToString(res.request_id)+
      ",\"retcode\":"+IntegerToString(res.retcode)+"}");
}
