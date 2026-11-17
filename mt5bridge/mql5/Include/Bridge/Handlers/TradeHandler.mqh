#property strict
// 交易闭环：preview(OrderCheck) / execute(OrderSendAsync) / status(journal 对账)。
// 硬约束 C1/C2：只用 OrderSendAsync（同步 OrderSend 实测阻塞 61s，禁用）。
// request_id 无法反查（MQL5 无 HistoryOrderRequest），用内存 journal 按
// magic+comment 关联，由 TradeWatcher 轮询历史回填 order/deal 终态。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>

#define BRIDGE_TRADE_MAGIC 20261113

// comment 上限 31 字符；key 为空时用固定前缀
string BridgeBuildComment(const string key)
{
   if(StringLen(key)==0) return "mt5bridge";
   return StringSubstr(key,0,31);
}

ENUM_ORDER_TYPE_FILLING BridgePickFilling(const string symbol)
{
   const long modes=SymbolInfoInteger(symbol,SYMBOL_FILLING_MODE);
   if((modes & SYMBOL_FILLING_FOK)!=0) return ORDER_FILLING_FOK;
   if((modes & SYMBOL_FILLING_IOC)!=0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

// action → 订单类型。挂单（limit/stop）返回 true，price 必填；未知 action 返回 false 且 type=WRONG_VALUE。
bool BridgeParseOrderType(const string action, ENUM_ORDER_TYPE &type)
{
   if(action=="buy")        { type=ORDER_TYPE_BUY;        return false; }
   if(action=="sell")       { type=ORDER_TYPE_SELL;       return false; }
   if(action=="buy_limit")  { type=ORDER_TYPE_BUY_LIMIT;  return true; }
   if(action=="sell_limit") { type=ORDER_TYPE_SELL_LIMIT; return true; }
   if(action=="buy_stop")   { type=ORDER_TYPE_BUY_STOP;   return true; }
   if(action=="sell_stop")  { type=ORDER_TYPE_SELL_STOP;  return true; }
   type=WRONG_VALUE;
   return false;
}

// ── 内存 journal：request_id → 终态（TradeWatcher 回填） ─────────────
#define BRIDGE_JOURNAL_MAX 256
string  g_journal_keys[BRIDGE_JOURNAL_MAX];
long    g_journal_request_ids[BRIDGE_JOURNAL_MAX];
ulong   g_journal_orders[BRIDGE_JOURNAL_MAX];
ulong   g_journal_deals[BRIDGE_JOURNAL_MAX];
string  g_journal_states[BRIDGE_JOURNAL_MAX];   // pending|filled|rejected|unknown
int     g_journal_count=0;

void JournalPut(const long request_id, const string key)
{
   if(g_journal_count>=BRIDGE_JOURNAL_MAX)
   {
      for(int i=0;i<BRIDGE_JOURNAL_MAX-1;i++)   // 环形淘汰最旧
      {
         g_journal_keys[i]=g_journal_keys[i+1];
         g_journal_request_ids[i]=g_journal_request_ids[i+1];
         g_journal_orders[i]=g_journal_orders[i+1];
         g_journal_deals[i]=g_journal_deals[i+1];
         g_journal_states[i]=g_journal_states[i+1];
      }
      g_journal_count=BRIDGE_JOURNAL_MAX-1;
   }
   g_journal_keys[g_journal_count]=key;
   g_journal_request_ids[g_journal_count]=request_id;
   g_journal_orders[g_journal_count]=0;
   g_journal_deals[g_journal_count]=0;
   g_journal_states[g_journal_count]="pending";
   g_journal_count++;
}

// TradeWatcher 发现新订单/成交时按 comment 回填（返回 true 表示命中）
bool JournalFillOrder(const string comment, const ulong order)
{
   bool hit=false;
   for(int i=0;i<g_journal_count;i++)
   {
      if(g_journal_states[i]=="pending" && comment!="" && StringFind(comment,g_journal_keys[i])==0)
      {
         g_journal_orders[i]=order;
         g_journal_states[i]="filled";
         hit=true;
      }
   }
   return hit;
}

bool JournalFillDeal(const string comment, const ulong deal)
{
   bool hit=false;
   for(int i=0;i<g_journal_count;i++)
   {
      if(comment!="" && StringFind(comment,g_journal_keys[i])==0)
      {
         g_journal_deals[i]=deal;
         hit=true;
      }
   }
   return hit;
}

// ── 方法 ─────────────────────────────────────────────────────────

string HandleTradePreview(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   const string action=RpcParamString(request,"action","buy");
   if(symbol=="")
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","symbol required");

   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick))
      return RpcFail(RpcIdEcho(request),-32051,"SYMBOL_NOT_FOUND","no tick for symbol: "+symbol);

   ENUM_ORDER_TYPE otype;
   const bool is_pending=BridgeParseOrderType(action,otype);
   if(otype==WRONG_VALUE)
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","unknown action: "+action);

   MqlTradeRequest req; ZeroMemory(req);
   req.action=(is_pending ? TRADE_ACTION_PENDING : TRADE_ACTION_DEAL);
   req.symbol=symbol;
   req.volume=RpcParamDouble(request,"volume",0.01);
   req.type=otype;
   if(is_pending)
   {
      const double pending_price=RpcParamDouble(request,"price",0);
      if(pending_price<=0)
         return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","price required for pending action: "+action);
      req.price=pending_price;
   }
   else
      req.price=(req.type==ORDER_TYPE_BUY ? tick.ask : tick.bid);
   req.deviation=(ulong)RpcParamLong(request,"deviation",50);
   req.type_filling=BridgePickFilling(symbol);

   MqlTradeCheckResult check; ZeroMemory(check);
   const bool ok=OrderCheck(req,check);
   return RpcOk(RpcIdEcho(request),
      "{\"ok\":"+(ok?"true":"false")+
      ",\"retcode\":"+IntegerToString((long)check.retcode)+
      ",\"comment\":"+BridgeJsonQuote(check.comment)+
      ",\"margin\":"+DoubleToString(check.margin,2)+
      ",\"margin_free\":"+DoubleToString(check.margin_free,2)+
      ",\"balance\":"+DoubleToString(check.balance,2)+
      ",\"equity\":"+DoubleToString(check.equity,2)+"}");
}

string HandleTradeExecute(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   const string action=RpcParamString(request,"action","buy");
   const double volume=RpcParamDouble(request,"volume",0.0);
   if(symbol=="" || volume<=0)
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","symbol/volume required");

   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick))
      return RpcFail(RpcIdEcho(request),-32051,"SYMBOL_NOT_FOUND","no tick for symbol: "+symbol);

   ENUM_ORDER_TYPE otype;
   const bool is_pending=BridgeParseOrderType(action,otype);
   if(otype==WRONG_VALUE)
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","unknown action: "+action);

   MqlTradeRequest req; ZeroMemory(req);
   MqlTradeResult  res; ZeroMemory(res);
   req.action=(is_pending ? TRADE_ACTION_PENDING : TRADE_ACTION_DEAL);
   req.symbol=symbol;
   req.volume=volume;
   req.type=otype;
   if(is_pending)
   {
      const double pending_price=RpcParamDouble(request,"price",0);
      if(pending_price<=0)
         return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","price required for pending action: "+action);
      req.price=pending_price;
   }
   else
   {
      const double price_override=RpcParamDouble(request,"price",0);
      req.price=(price_override>0 ? price_override : (req.type==ORDER_TYPE_BUY ? tick.ask : tick.bid));
   }
   req.sl=RpcParamDouble(request,"sl",0);
   req.tp=RpcParamDouble(request,"tp",0);
   req.deviation=(ulong)RpcParamLong(request,"deviation",50);
   req.type_filling=BridgePickFilling(symbol);
   req.magic=BRIDGE_TRADE_MAGIC;
   const string key=RpcParamString(request,"idempotency_key","");
   req.comment=BridgeBuildComment(key);

   if(!OrderSendAsync(req,res))
      return RpcFailMt(RpcIdEcho(request),"TRADE_SEND_FAILED","OrderSendAsync returned false",res.retcode);

   JournalPut(res.request_id,req.comment);
   const bool accepted=(res.retcode==TRADE_RETCODE_PLACED || res.retcode==TRADE_RETCODE_DONE);
   return RpcOk(RpcIdEcho(request),
      "{\"status\":"+(accepted?"\"accepted\"":"\"rejected\"")+
      ",\"request_id\":"+IntegerToString(res.request_id)+
      ",\"retcode\":"+IntegerToString(res.retcode)+"}");
}

string HandleTradeStatus(const string request)
{
   // 优先 order 直查；否则按 request_id 查 journal
   const ulong order=RpcParamUlong(request,"order");
   if(order>0)
   {
      if(HistoryOrderSelect(order))
      {
         return RpcOk(RpcIdEcho(request),
            "{\"found\":true,\"order\":\""+IntegerToString(order)+"\""+
            ",\"state\":"+BridgeJsonQuote(EnumToString((ENUM_ORDER_STATE)HistoryOrderGetInteger(order,ORDER_STATE)))+
            ",\"time_done_msc\":"+IntegerToString(HistoryOrderGetInteger(order,ORDER_TIME_DONE_MSC))+"}");
      }
      // 未进历史 = 活动或未找到
      for(int i=OrdersTotal()-1;i>=0;i--)
      {
         if(OrderGetTicket(i)==order)
            return RpcOk(RpcIdEcho(request),
               "{\"found\":true,\"order\":\""+IntegerToString(order)+"\""+
               ",\"state\":"+BridgeJsonQuote(EnumToString((ENUM_ORDER_STATE)OrderGetInteger(ORDER_STATE)))+"}");
      }
      return RpcOk(RpcIdEcho(request),"{\"found\":false}");
   }

   const long request_id=RpcParamLong(request,"request_id");
   for(int i=0;i<g_journal_count;i++)
   {
      if(g_journal_request_ids[i]==request_id)
      {
         return RpcOk(RpcIdEcho(request),
            "{\"found\":true,\"request_id\":"+IntegerToString(request_id)+
            ",\"state\":"+BridgeJsonQuote(g_journal_states[i])+
            ",\"order\":\""+IntegerToString(g_journal_orders[i])+"\""+
            ",\"deal\":\""+IntegerToString(g_journal_deals[i])+"\"}");
      }
   }
   return RpcOk(RpcIdEcho(request),"{\"found\":false}");
}
