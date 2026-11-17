#property strict
// Service 主循环：Poll 批处理 → Watchers → Watchdog → Sleep(1)。
// 全部循环内调用为立即返回（交易只 OrderSendAsync）。

#include <Bridge/Abi/BridgeApi.mqh>
#include <Bridge/Core/Dispatcher.mqh>

long g_bridge_handle=0;
long g_reader_chart=0;

// 保活读取图：market.bars/ticks 走 EA（图表域）应答——Service 无图表上下文读不到
// 历史库（6320 实测 CopyRates 全 4401、SERIES_SYNCHRONIZED=0），任何 EA 都能读任意序列。
// 订阅图表全关时由它兜底；图表没了（含服务冷启动）就重开。品种无所谓，取 Market Watch 首个可用项。
void ReaderChartEnsure()
{
   if(g_reader_chart>0 && ChartSymbol(g_reader_chart)!="") return;
   string symbol="";
   const int total=SymbolsTotal(true);
   for(int i=0;i<total;i++)
   {
      const string s=SymbolName(i,true);
      if(SymbolInfoInteger(s,SYMBOL_TRADE_MODE)!=SYMBOL_TRADE_MODE_DISABLED) { symbol=s; break; }
   }
   if(symbol=="") symbol="EURUSD";
   g_reader_chart=SubOpenChart(symbol,PERIOD_M1);
   if(g_reader_chart>0)
      PrintFormat("[MT5Bridge] reader chart opened %s M1 chart=%I64d",symbol,g_reader_chart);
}

void BridgeServiceRun()
{
   g_service_start_ms=GetTickCount64();
   g_bridge_handle=Bridge_Register(BRIDGE_ROLE_SERVICE,BridgeTerminalId(),"service");
   if(g_bridge_handle<=0)
   {
      uchar error_bytes[];
      ArrayResize(error_bytes,512);
      int error_size=Bridge_LastError(error_bytes,511);
      if(error_size>0) error_bytes[error_size]=0;
      PrintFormat("[MT5Bridge] service register failed: %d %s",
                  Bridge_Status(),
                  error_size>0 ? CharArrayToString(error_bytes,0,error_size,CP_UTF8) : "");
      return;
   }
   PrintFormat("[MT5Bridge] service started handle=%I64d (dialing gateway, DLL reconnects on its own)",g_bridge_handle);
   // P9 起 DLL=client：网关可后启动，DLL 连接线程自动重连，这里不再做 bind 自检自杀。

   // 孤儿图表清理：终端重启会从 profile 恢复上一世的订阅图表（EA 随之加载），
   // 但订阅表是空的、无人管理。凡挂着 BridgeMarketEA 的图表一律关闭，由后续
   // market.subscribe 重新建立。
   {
      long orphans[32];
      int orphan_count=0;
      for(long chart=ChartFirst(); chart>0 && orphan_count<32; chart=ChartNext(chart))
      {
         if(ChartGetString(chart,CHART_EXPERT_NAME)=="BridgeMarketEA")
            orphans[orphan_count++]=chart;
      }
      for(int i=0;i<orphan_count;i++) ChartClose(orphans[i]);
      if(orphan_count>0)
         PrintFormat("[MT5Bridge] closed %d orphan market chart(s)",orphan_count);
   }

   Print("[MT5Bridge] loop entered");

   ReaderChartEnsure();

   ulong watchdog_ms=GetTickCount64();
   ulong heartbeat_ms=GetTickCount64();
   long  loop_count=0;
   long  poll_nonzero=0;
   while(!IsStopped())
   {
      // ① 组件自愈（失活被 DLL 清理时重注册；正常时即一次 PeekSize）
      const long healed=BridgeEnsureComponent(g_bridge_handle,BRIDGE_ROLE_SERVICE,BridgeTerminalId(),"service");
      if(healed>0 && healed!=g_bridge_handle)
      {
         g_bridge_handle=healed;
         PrintFormat("[MT5Bridge] service component re-registered handle=%I64d",g_bridge_handle);
      }
      // ② 请求批处理（抽干，上限 64 防单循环霸占）
      for(int i=0;i<64;i++)
      {
         string request=BridgeReadText(g_bridge_handle);
         if(request=="") break;
         poll_nonzero++;
         BridgeWriteReply(g_bridge_handle,BridgeDispatch(request,g_bridge_handle));
      }
      // ② 轮询事件引擎
      AccountWatcherTick(g_bridge_handle);
      TradeWatcherTick(g_bridge_handle);
      WatchPublisherTick(g_bridge_handle);
      // ③ 订阅图表对账（~2s 周期）
      if(GetTickCount64()-watchdog_ms>2000)
      {
         watchdog_ms=GetTickCount64();
         SubscriptionsWatchdog();
         ReaderChartEnsure();
      }
      // ④ 心跳诊断（每 5s：循环轮数 / 取到消息数）
      loop_count++;
      if(GetTickCount64()-heartbeat_ms>5000)
      {
         heartbeat_ms=GetTickCount64();
         PrintFormat("[MT5Bridge] alive loops=%I64d dispatched=%I64d status=%d",loop_count,poll_nonzero,Bridge_Status());
      }
      Sleep(1);
   }

   Bridge_Unregister(g_bridge_handle);
   g_bridge_handle=0;
   Print("[MT5Bridge] service stopped");
}
