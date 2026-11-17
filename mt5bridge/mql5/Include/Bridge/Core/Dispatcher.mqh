#property strict
// method 字符串 → Handler 分发。与 contracts/registry.yaml 一一对应。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Handlers/SystemHandler.mqh>
#include <Bridge/Handlers/AccountHandler.mqh>
#include <Bridge/Handlers/SymbolHandler.mqh>
#include <Bridge/Handlers/MarketHandler.mqh>
#include <Bridge/Handlers/PositionHandler.mqh>
#include <Bridge/Handlers/OrderHandler.mqh>
#include <Bridge/Handlers/HistoryHandler.mqh>
#include <Bridge/Handlers/TradeHandler.mqh>
#include <Bridge/Chart/ChartManager.mqh>
#include <Bridge/Market/WatchPublisher.mqh>
#include <Bridge/Events/AccountWatcher.mqh>
#include <Bridge/Events/TradeWatcher.mqh>

string BridgeDispatch(const string request, const long handle)
{
   const string method=RpcMethod(request);
   const string id=RpcIdEcho(request);

   if(method=="system.status")         return HandleSystemStatus(request);
   if(method=="system.capabilities")   return HandleSystemCapabilities(request);
   if(method=="terminal.get")          return HandleTerminalGet(request);

   if(method=="account.get")           return HandleAccountGet(request);
   if(method=="state.snapshot")        return HandleStateSnapshot(request);

   if(method=="symbol.list")           return HandleSymbolList(request);
   if(method=="symbol.get")            return HandleSymbolGet(request);
   if(method=="symbol.sessions")       return HandleSymbolSessions(request);

   if(method=="market.quote")          return HandleMarketQuote(request);
   if(method=="market.bars")           return HandleMarketBars(request);
   if(method=="market.ticks")          return HandleMarketTicks(request);

   if(method=="position.list")         return HandlePositionList(request);
   if(method=="position.close")        return HandlePositionClose(request);
   if(method=="position.modify")       return HandlePositionModify(request);

   if(method=="order.list")            return HandleOrderList(request);
   if(method=="order.modify")          return HandleOrderModify(request);
   if(method=="order.cancel")          return HandleOrderCancel(request);

   if(method=="history.orders")        return HandleHistoryOrders(request);
   if(method=="history.deals")         return HandleHistoryDeals(request);

   if(method=="trade.preview")         return HandleTradePreview(request);
   if(method=="trade.execute")         return HandleTradeExecute(request);
   if(method=="trade.status")          return HandleTradeStatus(request);

   if(method=="market.subscribe")      return HandleMarketSubscribe(request);
   if(method=="market.unsubscribe")    return HandleMarketUnsubscribe(request);
   if(method=="market.subscriptions")  return HandleMarketSubscriptions(request);
   if(method=="market.watch")          return HandleMarketWatch(request);

   if(method=="system.resync")
   {
      // 客户端 seq 断档恢复：清空 watcher 基线 → 下一 tick 全量重推
      AccountWatcherReset();
      BridgeEmitEvent(handle,"event.resync_required","{\"reason\":\"resync\"}");
      AccountWatcherTick(handle,true);
      TradeWatcherTick(handle,true);
      return RpcOk(id,"{\"state\":\"full\"}");
   }

   return RpcFail(id,-32601,"METHOD_NOT_FOUND","unknown method: "+method);
}
