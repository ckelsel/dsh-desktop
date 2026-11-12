//+------------------------------------------------------------------+
//| DshBridge trade history: the `history.query` payload              |
//| (mt5/PROTOCOL.md, stage 2), newest first.                         |
//+------------------------------------------------------------------+
#include "Json.mqh"
#include "Protocol.mqh"
#include "Time.mqh"
#include "Positions.mqh"

#define DSH_HISTORY_ROWS_MAX 5000
//--- Characters per list, so that a reply stays well under the 2 MiB frame limit.
#define DSH_HISTORY_TEXT_MAX 700000

string DshDealTypeName(const long type)
  {
   string name = EnumToString((ENUM_DEAL_TYPE)type);
   // DEAL_DIVIDEND, DEAL_DIVIDEND_FRANKED and DEAL_TAX have no TYPE_ in their names.
   if(StringFind(name, "DEAL_TYPE_") == 0)
      return DshEnumWord(name, "DEAL_TYPE_");
   return DshEnumWord(name, "DEAL_");
  }

string DshHistoryOrderJson(const ulong ticket, const long offset)
  {
   string symbol = HistoryOrderGetString(ticket, ORDER_SYMBOL);
   int digits = DshSymbolDigits(symbol);
   long type = HistoryOrderGetInteger(ticket, ORDER_TYPE);
   CDshJsonObject order;
   order.Str("ticket", IntegerToString((long)ticket));
   order.Str("symbol", symbol);
   order.Str("type", DshOrderTypeName(type));
   order.Str("state", DshOrderStateName(HistoryOrderGetInteger(ticket, ORDER_STATE)));
   order.Num("volume_initial", HistoryOrderGetDouble(ticket, ORDER_VOLUME_INITIAL), 8);
   order.Num("volume_current", HistoryOrderGetDouble(ticket, ORDER_VOLUME_CURRENT), 8);
   DshPriceField(order, "price", HistoryOrderGetDouble(ticket, ORDER_PRICE_OPEN), digits);
   DshPriceField(order, "stop_limit", DshStopLimitType(type) ? HistoryOrderGetDouble(ticket, ORDER_PRICE_STOPLIMIT) : 0.0, digits);
   DshPriceField(order, "sl", HistoryOrderGetDouble(ticket, ORDER_SL), digits);
   DshPriceField(order, "tp", HistoryOrderGetDouble(ticket, ORDER_TP), digits);
   order.Int("time_setup", DshServerMsToUtc(HistoryOrderGetInteger(ticket, ORDER_TIME_SETUP_MSC), offset));
   order.Int("time_done", DshServerMsToUtc(HistoryOrderGetInteger(ticket, ORDER_TIME_DONE_MSC), offset));
   order.Str("position", IntegerToString(HistoryOrderGetInteger(ticket, ORDER_POSITION_ID)));
   order.Str("position_by", IntegerToString(HistoryOrderGetInteger(ticket, ORDER_POSITION_BY_ID)));
   order.Str("reason", DshEnumWord(EnumToString((ENUM_ORDER_REASON)HistoryOrderGetInteger(ticket, ORDER_REASON)), "ORDER_REASON_"));
   order.Str("comment", HistoryOrderGetString(ticket, ORDER_COMMENT));
   order.Int("magic", HistoryOrderGetInteger(ticket, ORDER_MAGIC));
   return order.Text();
  }

string DshDealJson(const ulong ticket, const long offset, const int money)
  {
   string symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);
   // Balance operations have no symbol and no price.
   int digits = symbol == "" ? 2 : DshSymbolDigits(symbol);
   CDshJsonObject deal;
   deal.Str("ticket", IntegerToString((long)ticket));
   deal.Str("order", IntegerToString(HistoryDealGetInteger(ticket, DEAL_ORDER)));
   deal.Str("position", IntegerToString(HistoryDealGetInteger(ticket, DEAL_POSITION_ID)));
   deal.Str("symbol", symbol);
   deal.Str("type", DshDealTypeName(HistoryDealGetInteger(ticket, DEAL_TYPE)));
   deal.Str("entry", DshEnumWord(EnumToString((ENUM_DEAL_ENTRY)HistoryDealGetInteger(ticket, DEAL_ENTRY)), "DEAL_ENTRY_"));
   deal.Num("volume", HistoryDealGetDouble(ticket, DEAL_VOLUME), 8);
   deal.Num("price", HistoryDealGetDouble(ticket, DEAL_PRICE), digits);
   deal.Num("commission", HistoryDealGetDouble(ticket, DEAL_COMMISSION), money);
   deal.Num("swap", HistoryDealGetDouble(ticket, DEAL_SWAP), money);
   deal.Num("fee", HistoryDealGetDouble(ticket, DEAL_FEE), money);
   deal.Num("profit", HistoryDealGetDouble(ticket, DEAL_PROFIT), money);
   deal.Int("time", DshServerMsToUtc(HistoryDealGetInteger(ticket, DEAL_TIME_MSC), offset));
   deal.Str("reason", DshEnumWord(EnumToString((ENUM_DEAL_REASON)HistoryDealGetInteger(ticket, DEAL_REASON)), "DEAL_REASON_"));
   deal.Str("comment", HistoryDealGetString(ticket, DEAL_COMMENT));
   deal.Int("magic", HistoryDealGetInteger(ticket, DEAL_MAGIC));
   return deal.Text();
  }

//--- `history.query`: the orders and deals of [from, to), newest first. Each list stops at
//--- 5,000 rows or 700,000 characters, and `truncated` says whether older rows were left out.
bool DshHistoryPayload(CDshJson *payload, string &answer, string &code, string &message)
  {
   long from = -1;
   long to = -1;
   if(!DshIntegerField(payload, "from", -1, from) || !DshIntegerField(payload, "to", -1, to) || from < 0 || to <= from)
     {
      code = "bad_request";
      message = "history.query needs from < to, in UTC milliseconds";
      return false;
     }
   long offset = DshServerUtcOffset();
   ResetLastError();
   if(!HistorySelect(DshUtcToServerTime(from, offset), DshUtcToServerTime(to - 1, offset)))
     {
      code = "not_ready";
      message = "HistorySelect failed, error " + IntegerToString(GetLastError());
      return false;
     }
   bool truncated = false;
   CDshJsonArray orders;
   for(int i = HistoryOrdersTotal() - 1; i >= 0; i--)
     {
      if(orders.Count() >= DSH_HISTORY_ROWS_MAX || orders.Length() >= DSH_HISTORY_TEXT_MAX)
        {
         truncated = true;
         break;
        }
      ulong ticket = HistoryOrderGetTicket(i);
      if(ticket != 0)
         orders.Raw(DshHistoryOrderJson(ticket, offset));
     }
   int money = DshMoneyDigits();
   CDshJsonArray deals;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
     {
      if(deals.Count() >= DSH_HISTORY_ROWS_MAX || deals.Length() >= DSH_HISTORY_TEXT_MAX)
        {
         truncated = true;
         break;
        }
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket != 0)
         deals.Raw(DshDealJson(ticket, offset, money));
     }
   CDshJsonObject json;
   json.Raw("orders", orders.Text());
   json.Raw("deals", deals.Text());
   json.Bool("truncated", truncated);
   answer = json.Text();
   return true;
  }
//+------------------------------------------------------------------+
