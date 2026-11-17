#property strict
// 系统与终端信息。system.capabilities 是 registry 的镜像（两者同步维护）。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Abi/BridgeApi.mqh>

ulong g_service_start_ms=0;

string HandleSystemStatus(const string request)
{
   string version="unknown";
   uchar version_bytes[];
   ArrayResize(version_bytes,64);
   int version_size=Bridge_Version(version_bytes,63);
   if(version_size>0) version=CharArrayToString(version_bytes,0,version_size,CP_UTF8);

   long uptime=0;
   if(g_service_start_ms>0) uptime=(long)(GetTickCount64()-g_service_start_ms);

   string result="{\"bridge_version\":"+BridgeJsonQuote(version)+
      ",\"role\":\"SERVICE\""+
      ",\"terminal_id\":"+BridgeJsonQuote(BridgeTerminalId())+
      ",\"uptime_ms\":"+IntegerToString(uptime)+
      ",\"dll_status\":"+IntegerToString(Bridge_Status())+
      ",\"trade_allowed\":"+(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)?"true":"false")+"}";
   return RpcOk(RpcIdEcho(request),result);
}

string HandleSystemCapabilities(const string request)
{
   string result="{\"version\":\"0.2.0\""+
      ",\"service_methods\":[\"system.status\",\"system.capabilities\",\"system.resync\",\"terminal.get\","+
      "\"account.get\",\"state.snapshot\",\"symbol.list\",\"symbol.get\",\"symbol.sessions\","+
      "\"market.quote\","+
      "\"position.list\",\"position.close\",\"position.modify\","+
      "\"order.list\",\"order.modify\",\"order.cancel\","+
      "\"history.orders\",\"history.deals\","+
      "\"trade.preview\",\"trade.execute\",\"trade.status\","+
      "\"market.subscribe\",\"market.unsubscribe\",\"market.subscriptions\",\"market.watch\"]"+
      ",\"market_methods\":[\"market.book\",\"market.bars\",\"market.ticks\"]"+
      ",\"events\":[\"event.market.tick\",\"event.market.bar\",\"event.market.bar_closed\",\"event.market.book\","+
      "\"event.account.changed\",\"event.position.changed\",\"event.order.changed\",\"event.deal.added\","+
      "\"event.component\",\"event.resync_required\"]}";
   return RpcOk(RpcIdEcho(request),result);
}

string HandleTerminalGet(const string request)
{
   string result="{\"name\":"+BridgeJsonQuote(TerminalInfoString(TERMINAL_NAME))+
      ",\"company\":"+BridgeJsonQuote(TerminalInfoString(TERMINAL_COMPANY))+
      ",\"build\":"+IntegerToString(TerminalInfoInteger(TERMINAL_BUILD))+
      ",\"data_path\":"+BridgeJsonQuote(TerminalInfoString(TERMINAL_DATA_PATH))+
      ",\"connected\":"+(TerminalInfoInteger(TERMINAL_CONNECTED)?"true":"false")+
      ",\"trade_allowed\":"+(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)?"true":"false")+
      ",\"dlls_allowed\":"+(TerminalInfoInteger(TERMINAL_DLLS_ALLOWED)?"true":"false")+"}";
   return RpcOk(RpcIdEcho(request),result);
}
