#property strict
// 盘口：订阅（MarketBookAdd 实测仅 EA 可用）+ OnBookEvent 推流 + 快照 RPC。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Abi/BridgeApi.mqh>

string BridgeBookParams(const string symbol)
{
   MqlBookInfo book[];
   const int count=MarketBookGet(symbol,book) ? ArraySize(book) : 0;
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   string entries="";
   for(int i=0;i<count;i++)
   {
      if(i>0) entries+=",";
      entries+="{\"type\":"+IntegerToString((long)book[i].type)+
         ",\"price\":"+DoubleToString(book[i].price,digits)+
         ",\"volume\":"+IntegerToString((long)book[i].volume)+
         ",\"volume_real\":"+DoubleToString(book[i].volume_real,8)+"}";
   }
   return "\"symbol\":"+BridgeJsonQuote(symbol)+",\"entries\":["+entries+"]";
}

void PublishBook(const long handle, const string symbol)
{
   BridgeEmitEvent(handle,"event.market.book","{"+BridgeBookParams(symbol)+"}",false);
}

// market.book 请求（18851 端口，market 方法）
string HandleMarketBookSnapshot(const string request, const string chart_symbol)
{
   const string symbol=RpcParamString(request,"symbol",chart_symbol);
   return RpcOk(RpcIdEcho(request),"{"+BridgeBookParams(symbol)+"}");
}
