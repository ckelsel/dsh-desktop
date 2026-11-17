#property strict
#property version   "0.1.0"
#property description "MT5 Bridge Tester EA - Strategy Tester harness (Service+Market in one; history ticks as feed)"

// 策略测试器环境专用的桥载具（周末/休市回测链路验证）：
//   真实终端 = BridgeService(Service 程序长循环) + BridgeMarketEA(挂图回调推流)；
//   测试器 agent 只能跑单个 EA、OnTimer 最小 1s、图表不加载 EA —— 故合体：
//     OnInit  注册 SERVICE + MARKET 两个组件（agent 的 TERMINAL_DATA_PATH 天然
//             不同于真实终端 → 网关看到第二个 terminal_id，多终端路由可实测）
//     OnTick  历史 tick 回放 = 行情源（PublishTick/PublishBar）
//     OnTimer ServiceLoop 的单步切片：抽干 RPC + 事件引擎 + market.book（无 Sleep）
// 测试编排见 debug-page/tester-test.mjs；网关须在跑（DLL 拨号 18850）。

#include <Bridge/Abi/BridgeApi.mqh>
#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Core/Dispatcher.mqh>
#include <Bridge/Market/TickPublisher.mqh>
#include <Bridge/Market/BarPublisher.mqh>
#include <Bridge/Market/BookPublisher.mqh>

long g_service_handle=0;
long g_market_handle=0;

int OnInit()
{
   uchar ver_bytes[];
   ArrayResize(ver_bytes,64);
   const int ver_len=Bridge_Version(ver_bytes,63);
   PrintFormat("[MT5Bridge-tester] init dll=%s",
               ver_len>0 ? CharArrayToString(ver_bytes,0,ver_len,CP_UTF8) : "unknown");
   g_service_handle=Bridge_Register(BRIDGE_ROLE_SERVICE,BridgeTerminalId(),"service");
   g_market_handle=Bridge_Register(BRIDGE_ROLE_MARKET,BridgeTerminalId(),_Symbol);
   if(g_service_handle<=0 || g_market_handle<=0)
   {
      PrintFormat("[MT5Bridge-tester] register failed service=%I64d market=%I64d status=%d",
                  g_service_handle,g_market_handle,Bridge_Status());
      return INIT_FAILED;
   }
   BarPublisherReset();
   MarketBookAdd(_Symbol);   // 失败 = 无盘口，不致命
   EventSetTimer(1);         // 测试器 OnTimer 最小粒度 1s
   PrintFormat("[MT5Bridge-tester] started service=%I64d market=%I64d symbol=%s terminal=%s",
               g_service_handle,g_market_handle,_Symbol,BridgeTerminalId());
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   MarketBookRelease(_Symbol);
   if(g_service_handle>0) Bridge_Unregister(g_service_handle);
   if(g_market_handle>0) Bridge_Unregister(g_market_handle);
   g_service_handle=0;
   g_market_handle=0;
   PrintFormat("[MT5Bridge-tester] stopped reason=%d",reason);
}

// Service 循环的单步切片（对应 ServiceLoop.mqh 的 while 体，去掉 Sleep/孤儿图表）：
// OnTimer 抽干 + 事件引擎；OnTick 也抽干——1:1 回放下 OnTimer 每模拟秒一轮且被视觉流
// 挤压，RPC 曾积压 30s+ 撞网关 TTL；tick 到达即抽干把延迟压回秒级。
void ServicePump()
{
   if(g_service_handle<=0 || g_market_handle<=0) return;
   // ① service 面：全量 RPC 分发（抽干，上限 64）
   for(int i=0;i<64;i++)
   {
      string request=BridgeReadText(g_service_handle);
      if(request=="") break;
      BridgeWriteReply(g_service_handle,BridgeDispatch(request,g_service_handle));
   }
   // ② market 面：market.book 快照（同 BridgeMarketEA.OnTimer）
   for(int i=0;i<8;i++)
   {
      string request=BridgeReadText(g_market_handle);
      if(request=="") break;
      string method=RpcMethod(request);
      string response;
      if(method=="market.book")
         response=HandleMarketBookSnapshot(request,_Symbol);
      else
         response=RpcFail(RpcIdEcho(request),-32601,"METHOD_NOT_FOUND","market worker only serves market.book");
      BridgeWriteReply(g_market_handle,response);
   }
}

// 历史 tick 回放 = 行情源（真实终端靠挂图 EA 推流，测试器图表不加载 EA，本 EA 直接承担）
void OnTick()
{
   if(g_market_handle<=0) return;
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick)) return;
   PublishTick(g_market_handle,_Symbol,tick);
   PublishBarCheck(g_market_handle,_Symbol,_Period);
   ServicePump();
}

void OnBookEvent(const string &symbol)
{
   if(g_market_handle<=0 || symbol!=_Symbol) return;
   PublishBook(g_market_handle,symbol);
}

// Service 循环的单步切片（对应 ServiceLoop.mqh 的 while 体，去掉 Sleep/孤儿图表）
void OnTimer()
{
   const long sh=BridgeEnsureComponent(g_service_handle,BRIDGE_ROLE_SERVICE,BridgeTerminalId(),"service");
   if(sh>0 && sh!=g_service_handle)
   {
      g_service_handle=sh;
      PrintFormat("[MT5Bridge-tester] service component re-registered handle=%I64d",g_service_handle);
   }
   const long mh=BridgeEnsureComponent(g_market_handle,BRIDGE_ROLE_MARKET,BridgeTerminalId(),_Symbol);
   if(mh>0 && mh!=g_market_handle)
   {
      g_market_handle=mh;
      PrintFormat("[MT5Bridge-tester] market component re-registered handle=%I64d",g_market_handle);
   }
   if(g_service_handle<=0 || g_market_handle<=0) return;
   // ① service/market 面抽干 + ② 事件引擎（账户/成交变动 → event.* 推 SDK）
   ServicePump();
   AccountWatcherTick(g_service_handle);
   TradeWatcherTick(g_service_handle);
}
