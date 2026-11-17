#property strict
// 交易变化：持仓/订单/成交 三路轮询对比（~200ms）。
// 新订单/成交同时回填 TradeHandler journal（magic+comment 关联 request_id）。

#define BRIDGE_POS_MAX 512
#define BRIDGE_ORD_MAX 512

#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Handlers\PositionHandler.mqh>
#include <Bridge/Handlers\OrderHandler.mqh>
#include <Bridge/Handlers\TradeHandler.mqh>

string BridgePositionSnapshot(const ulong ticket)
{
   // PositionGetTicket 选择后取条目；快照串 = 条目（含 profit，波动即 changed）
   return IntegerToString(ticket)+"|"+DoubleToString(PositionGetDouble(POSITION_PROFIT),2)+
          "|"+DoubleToString(PositionGetDouble(POSITION_SL),8)+
          "|"+DoubleToString(PositionGetDouble(POSITION_TP),8)+
          "|"+DoubleToString(PositionGetDouble(POSITION_VOLUME),2);
}

void TradeWatcherTick(const long handle, const bool resync=false)
{
   // 节流：无节流时 HistorySelect 每毫秒全量执行会把 Service 线程拖进服务器往返
   static ulong last_ms=0;
   const ulong now=GetTickCount64();
   if(!resync && last_ms!=0 && now-last_ms<200) return;
   last_ms=now;

   // ── 持仓 ──
   {
      static ulong  pos_tickets[BRIDGE_POS_MAX];
      static string  pos_snapshots[BRIDGE_POS_MAX];
      static int     pos_count=-1;   // -1 = 未初始化

      ulong new_tickets[BRIDGE_POS_MAX]; string new_snapshots[BRIDGE_POS_MAX];
      int new_count=0;
      const int total=PositionsTotal();
      for(int i=0;i<total && new_count<BRIDGE_POS_MAX;i++)
      {
         ulong ticket=PositionGetTicket(i);
         if(ticket==0) continue;
         new_tickets[new_count]=ticket;
         new_snapshots[new_count]=BridgePositionSnapshot(ticket);
         new_count++;
      }

      // 基线仅首次初始化（pos_count<0）时静默；空→有的 added 必须正常发出
      bool baseline=false;
      if(pos_count<0) { pos_count=0; baseline=!resync; }
      // added / modified
      string added=""; int added_n=0;
      string modified=""; int modified_n=0;
      for(int n=0;n<new_count;n++)
      {
         bool known=false;
         for(int o=0;o<pos_count;o++)
         {
            if(pos_tickets[o]==new_tickets[n])
            {
               known=true;
               if(pos_snapshots[o]!=new_snapshots[n])
               {
                  if(modified_n>0) modified+=",";
                  modified+=BridgePositionEntryJson(new_tickets[n]);
                  modified_n++;
               }
               break;
            }
         }
         if(!known)
         {
            if(added_n>0) added+=",";
            added+=BridgePositionEntryJson(new_tickets[n]);
            added_n++;
         }
      }
      // removed
      string removed=""; int removed_n=0;
      for(int o=0;o<pos_count;o++)
      {
         bool still=false;
         for(int n=0;n<new_count;n++) if(pos_tickets[n]==pos_tickets[o]) { still=true; break; }
         if(!still)
         {
            if(removed_n>0) removed+=",";
            removed+="{\"ticket\":\""+IntegerToString(pos_tickets[o])+"\"}";
            removed_n++;
         }
      }
      // 提交新基线
      for(int n=0;n<new_count;n++) { pos_tickets[n]=new_tickets[n]; pos_snapshots[n]=new_snapshots[n]; }
      int prev_count=pos_count;
      pos_count=new_count;

      if(!baseline)
      {
         if(added_n>0)   BridgeEmitEvent(handle,"event.position.changed","{\"kind\":\"added\",\"entries\":["+added+"]}");
         if(removed_n>0) BridgeEmitEvent(handle,"event.position.changed","{\"kind\":\"removed\",\"entries\":["+removed+"]}");
         if(modified_n>0) BridgeEmitEvent(handle,"event.position.changed","{\"kind\":\"modified\",\"entries\":["+modified+"]}");
         if(resync && new_count>0)
            BridgeEmitEvent(handle,"event.position.changed","{\"kind\":\"snapshot\",\"entries\":"+BridgeAllPositionsJson()+"}");
      }
   }

   // ── 活动订单 ──
   {
      static ulong ord_tickets[BRIDGE_ORD_MAX];
      static int    ord_count=-1;

      ulong new_orders[BRIDGE_ORD_MAX];
      int new_count=0;
      const int total=OrdersTotal();
      for(int i=0;i<total && new_count<BRIDGE_ORD_MAX;i++)
      {
         ulong ticket=OrderGetTicket(i);
         if(ticket==0) continue;
         new_orders[new_count]=ticket;
         new_count++;
      }
      // 同上：基线仅首建静默
      bool baseline=false;
      if(ord_count<0) { ord_count=0; baseline=!resync; }

      string added=""; int added_n=0;
      for(int n=0;n<new_count;n++)
      {
         bool known=false;
         for(int o=0;o<ord_count;o++) if(ord_tickets[o]==new_orders[n]) { known=true; break; }
         if(!known)
         {
            if(added_n>0) added+=",";
            added+=BridgeOrderEntryJson(new_orders[n]);
            added_n++;
         }
      }
      string removed=""; int removed_n=0;
      for(int o=0;o<ord_count;o++)
      {
         bool still=false;
         for(int n=0;n<new_count;n++) if(new_orders[n]==ord_tickets[o]) { still=true; break; }
         if(!still)
         {
            if(removed_n>0) removed+=",";
            removed+="{\"ticket\":\""+IntegerToString(ord_tickets[o])+"\"}";
            removed_n++;
         }
      }
      for(int n=0;n<new_count;n++) ord_tickets[n]=new_orders[n];
      ord_count=new_count;

      if(!baseline)
      {
         if(added_n>0)   BridgeEmitEvent(handle,"event.order.changed","{\"kind\":\"added\",\"entries\":["+added+"]}");
         if(removed_n>0) BridgeEmitEvent(handle,"event.order.changed","{\"kind\":\"removed\",\"entries\":["+removed+"]}");
         if(resync && new_count>0)
            BridgeEmitEvent(handle,"event.order.changed","{\"kind\":\"snapshot\",\"entries\":"+BridgeAllOrdersJson()+"}");
      }
   }

   // ── 成交（只增）+ journal 回填 ──
   {
      static ulong deal_last=0;
      static bool  deal_ready=false;
      static ulong deal_probe_ms=0;
      static ulong deal_defer_until=GetTickCount64()+15000;   // 首探延迟：避开启动期历史同步
      static bool  deal_first=true;

      // HistorySelect 涉及历史缓存检索，独立 1s 节流（持仓/订单对比是纯本地调用）
      const ulong now_ms=GetTickCount64();
      if(now_ms<deal_defer_until) return;
      if(deal_probe_ms!=0 && now_ms-deal_probe_ms<1000) return;
      deal_probe_ms=now_ms;

      // 固定宽度滚动窗口（近 1h）：from=0 会每次全量扫描账户历史，实测拖死线程；
      // 上界不用未来时间——TimeCurrent()+N 每次前进会触发服务器同步往返，偶发秒级卡顿
      const ulong select_t0=GetTickCount64();
      const bool selected=HistorySelect(TimeCurrent()-3600,TimeCurrent());
      const ulong select_dt=GetTickCount64()-select_t0;
      if(deal_first || select_dt>100)
         PrintFormat("[MT5Bridge] deal select %s %I64ums",selected?"ok":"fail",select_dt);
      deal_first=false;
      if(selected)
      {
         const int total=HistoryDealsTotal();
         // 成交池大小变化留痕：历史同步延迟到达、以及"选中但为空"的怪癖都靠它分辨
         static int deal_pool_last=-1;
         if(total!=deal_pool_last)
         {
            PrintFormat("[MT5Bridge] deal pool %d -> %d",deal_pool_last,total);
            deal_pool_last=total;
         }
         string items=""; int count=0;
         for(int i=total-1;i>=0;i--)
         {
            ulong ticket=HistoryDealGetTicket(i);
            if(ticket==0) continue;
            if(deal_ready && ticket<=deal_last) break;
            if(!deal_ready)
            {
               // 基线是什么水平、历史表里有多少货，首探时留一条痕
               if(deal_first) PrintFormat("[MT5Bridge] deal baseline total=%d top=%I64u",total,ticket);
               deal_last=ticket; break;   // 首次仅记录基线
            }
            const string symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);
            const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
            const string comment=HistoryDealGetString(ticket,DEAL_COMMENT);
            if(count>0) items+=",";
            const long entry=HistoryDealGetInteger(ticket,DEAL_ENTRY);
            items+="{\"ticket\":\""+IntegerToString(ticket)+"\""+
               ",\"order\":\""+IntegerToString(HistoryDealGetInteger(ticket,DEAL_ORDER))+"\""+
               ",\"symbol\":"+BridgeJsonQuote(symbol)+
               ",\"type\":"+BridgeDealTypeJson(HistoryDealGetInteger(ticket,DEAL_TYPE))+
               ",\"direction\":"+(entry==DEAL_ENTRY_OUT?"\"out\"":(entry==DEAL_ENTRY_INOUT?"\"inout\"":"\"in\""))+
               ",\"volume\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_VOLUME),2)+
               ",\"price\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_PRICE),digits)+
               ",\"profit\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_PROFIT),2)+
               ",\"time_msc\":"+IntegerToString(HistoryDealGetInteger(ticket,DEAL_TIME_MSC))+
               ",\"comment\":"+BridgeJsonQuote(comment)+"}";
            count++;
            // journal 关联（magic 是桥发的单）
            if(HistoryDealGetInteger(ticket,DEAL_MAGIC)==BRIDGE_TRADE_MAGIC)
            {
               JournalFillOrder(comment,(ulong)HistoryDealGetInteger(ticket,DEAL_ORDER));
               JournalFillDeal(comment,ticket);
            }
            if(ticket>deal_last) deal_last=ticket;
         }
         deal_ready=true;
         if(count>0)
         BridgeEmitEvent(handle,"event.deal.added","{\"deals\":["+items+"]}");
      }
   }
}
