#property strict
#property version   "0.2.0"
#property description "MT5 Bridge Market EA - OnTick/OnBookEvent publisher on ws://127.0.0.1:18851"

#include <Bridge/Abi/BridgeApi.mqh>
#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Market/TickPublisher.mqh>
#include <Bridge/Market/BarPublisher.mqh>
#include <Bridge/Market/BookPublisher.mqh>

input bool InpBookEnabled=true;   // 订阅盘口（MarketBookAdd 实测仅 EA 可用）

long   g_market_handle=0;
string g_market_symbol="";

int OnInit()
{
   uchar ver_bytes[];
   ArrayResize(ver_bytes,64);
   const int ver_len=Bridge_Version(ver_bytes,63);
   PrintFormat("[MT5Bridge] market EA init dll=%s",
               ver_len>0 ? CharArrayToString(ver_bytes,0,ver_len,CP_UTF8) : "unknown");
   g_market_symbol=_Symbol;
   g_market_handle=Bridge_Register(BRIDGE_ROLE_MARKET,BridgeTerminalId(),_Symbol);
   if(g_market_handle<=0)
   {
      PrintFormat("[MT5Bridge] market EA register failed symbol=%s status=%d",_Symbol,Bridge_Status());
      return INIT_FAILED;
   }
   // P9 起 DLL=client：网关可后启动，DLL 自动重连，无 bind 自检
   BarPublisherReset();
   if(InpBookEnabled)
      MarketBookAdd(_Symbol);   // 失败 = 该品种无盘口，不致命
   EventSetMillisecondTimer(1000);   // 心跳 + market.book/bars/ticks 请求处理
   PrintFormat("[MT5Bridge] market EA started handle=%I64d symbol=%s period=%d chart=%I64d",
               g_market_handle,_Symbol,(int)_Period,ChartID());
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   if(InpBookEnabled)
      MarketBookRelease(_Symbol);
   if(g_market_handle>0) Bridge_Unregister(g_market_handle);
   g_market_handle=0;
   PrintFormat("[MT5Bridge] market EA stopped symbol=%s reason=%d",_Symbol,reason);
}

// 行情推送（零轮询：MT5 回调驱动）
void OnTick()
{
   if(g_market_handle<=0) return;
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick)) return;
   PublishTick(g_market_handle,_Symbol,tick);
   PublishBarCheck(g_market_handle,_Symbol,_Period);
}

void OnBookEvent(const string &symbol)
{
   if(g_market_handle<=0 || symbol!=_Symbol) return;
   PublishBook(g_market_handle,symbol);
}

// 入站 RPC（market.book 快照 / 历史取数）+ 组件自愈
void OnTimer()
{
   if(g_market_handle<=0)
   {
      const long healed=BridgeEnsureComponent(g_market_handle,BRIDGE_ROLE_MARKET,BridgeTerminalId(),_Symbol);
      if(healed>0 && healed!=g_market_handle)
      {
         g_market_handle=healed;
         PrintFormat("[MT5Bridge] market EA component re-registered handle=%I64d",g_market_handle);
      }
   }
   if(g_market_handle<=0) return;
   for(int i=0;i<8;i++)
   {
      string request=BridgeReadText(g_market_handle);
      if(request=="") break;
      string method=RpcMethod(request);
      string response;
      if(method=="market.book")
         response=HandleMarketBookSnapshot(request,_Symbol);
      else if(method=="market.bars")
         response=HandleMarketBars(request);   // 历史读取必须在图表域：Service 无图表读不到历史库（6320 实测全 4401）
      else if(method=="market.ticks")
         response=HandleMarketTicks(request);
      else
         response=RpcFail(RpcIdEcho(request),-32601,"METHOD_NOT_FOUND","market worker only serves market.book/bars/ticks");
      BridgeWriteReply(g_market_handle,response);
   }
}
