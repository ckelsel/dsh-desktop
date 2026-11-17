#property strict
// 账户查询与全量快照（快照类仅 state.snapshot 一个）。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Handlers/PositionHandler.mqh>
#include <Bridge/Handlers/OrderHandler.mqh>

string AccountEntryJson()
{
   return "{\"login\":\""+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"\""+
      ",\"server\":"+BridgeJsonQuote(AccountInfoString(ACCOUNT_SERVER))+
      ",\"currency\":"+BridgeJsonQuote(AccountInfoString(ACCOUNT_CURRENCY))+
      ",\"company\":"+BridgeJsonQuote(AccountInfoString(ACCOUNT_COMPANY))+
      ",\"leverage\":"+IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE))+
      ",\"balance\":"+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)+
      ",\"equity\":"+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)+
      ",\"margin\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN),2)+
      ",\"margin_free\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2)+
      ",\"margin_level\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL),2)+
      ",\"profit\":"+DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT),2)+
      ",\"trade_allowed\":"+(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)?"true":"false")+
      ",\"algo_allowed\":"+(AccountInfoInteger(ACCOUNT_TRADE_EXPERT)?"true":"false")+
      ",\"hedging\":"+(AccountInfoInteger(ACCOUNT_MARGIN_MODE)==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING?"true":"false")+"}";
}

string HandleAccountGet(const string request)
{
   return RpcOk(RpcIdEcho(request),AccountEntryJson());
}

string HandleStateSnapshot(const string request)
{
   string result="{\"account\":"+AccountEntryJson()+
      ",\"positions\":"+BridgeAllPositionsJson()+
      ",\"orders\":"+BridgeAllOrdersJson()+"}";
   return RpcOk(RpcIdEcho(request),result);
}
