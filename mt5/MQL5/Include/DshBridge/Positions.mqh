//+------------------------------------------------------------------+
//| DshBridge open positions and pending orders: the                  |
//| `positions.snapshot` and `orders.snapshot` payloads               |
//| (mt5/PROTOCOL.md, stage 2).                                       |
//+------------------------------------------------------------------+
#include "Json.mqh"
#include "Protocol.mqh"
#include "Time.mqh"

//--- A price, or null for MT5's 0: no stop loss, no take profit, no limit price.
void DshPriceField(CDshJsonObject &json, const string key, const double price, const int digits)
  {
   if(price == 0.0)
      json.Null(key);
   else
      json.Num(key, price, digits);
  }

string DshOrderTypeName(const long type)
  {
   return DshEnumWord(EnumToString((ENUM_ORDER_TYPE)type), "ORDER_TYPE_");
  }

string DshOrderStateName(const long state)
  {
   return DshEnumWord(EnumToString((ENUM_ORDER_STATE)state), "ORDER_STATE_");
  }

bool DshStopLimitType(const long type)
  {
   return type == ORDER_TYPE_BUY_STOP_LIMIT || type == ORDER_TYPE_SELL_STOP_LIMIT;
  }

//--- The six pending order types. Market orders still executing and close-by orders are not pending.
bool DshPendingType(const long type)
  {
   return type == ORDER_TYPE_BUY_LIMIT || type == ORDER_TYPE_SELL_LIMIT || type == ORDER_TYPE_BUY_STOP
          || type == ORDER_TYPE_SELL_STOP || DshStopLimitType(type);
  }

//--- `positions.snapshot`.
string DshPositionsPayload(void)
  {
   long offset = DshServerUtcOffset();
   int money = DshMoneyDigits();
   CDshJsonArray positions;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      string symbol = PositionGetString(POSITION_SYMBOL);
      int digits = DshSymbolDigits(symbol);
      CDshJsonObject position;
      position.Str("ticket", IntegerToString((long)ticket));
      position.Str("symbol", symbol);
      position.Str("side", PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL ? "sell" : "buy");
      position.Num("volume", PositionGetDouble(POSITION_VOLUME), 8);
      // A netting position's price is an average, with more decimals than the symbol's.
      position.Num("price_open", PositionGetDouble(POSITION_PRICE_OPEN), digits + 3);
      DshPriceField(position, "sl", PositionGetDouble(POSITION_SL), digits);
      DshPriceField(position, "tp", PositionGetDouble(POSITION_TP), digits);
      position.Num("price_current", PositionGetDouble(POSITION_PRICE_CURRENT), digits);
      position.Num("profit", PositionGetDouble(POSITION_PROFIT), money);
      position.Num("swap", PositionGetDouble(POSITION_SWAP), money);
      position.Int("time", DshServerMsToUtc(PositionGetInteger(POSITION_TIME_MSC), offset));
      position.Str("comment", PositionGetString(POSITION_COMMENT));
      position.Int("magic", PositionGetInteger(POSITION_MAGIC));
      positions.Raw(position.Text());
     }
   CDshJsonObject payload;
   payload.Raw("positions", positions.Text());
   return payload.Text();
  }

//--- `orders.snapshot`: the pending orders.
string DshOrdersPayload(void)
  {
   long offset = DshServerUtcOffset();
   CDshJsonArray orders;
   int total = OrdersTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0)
         continue;
      long type = OrderGetInteger(ORDER_TYPE);
      if(!DshPendingType(type))
         continue;
      string symbol = OrderGetString(ORDER_SYMBOL);
      int digits = DshSymbolDigits(symbol);
      CDshJsonObject order;
      order.Str("ticket", IntegerToString((long)ticket));
      order.Str("symbol", symbol);
      order.Str("type", DshOrderTypeName(type));
      order.Str("state", DshOrderStateName(OrderGetInteger(ORDER_STATE)));
      order.Num("volume", OrderGetDouble(ORDER_VOLUME_CURRENT), 8);
      order.Num("volume_initial", OrderGetDouble(ORDER_VOLUME_INITIAL), 8);
      order.Num("price", OrderGetDouble(ORDER_PRICE_OPEN), digits);
      DshPriceField(order, "stop_limit", DshStopLimitType(type) ? OrderGetDouble(ORDER_PRICE_STOPLIMIT) : 0.0, digits);
      DshPriceField(order, "sl", OrderGetDouble(ORDER_SL), digits);
      DshPriceField(order, "tp", OrderGetDouble(ORDER_TP), digits);
      order.Num("price_current", OrderGetDouble(ORDER_PRICE_CURRENT), digits);
      order.Int("time", DshServerMsToUtc(OrderGetInteger(ORDER_TIME_SETUP_MSC), offset));
      order.Str("time_type", DshEnumWord(EnumToString((ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME)), "ORDER_TIME_"));
      long expiration = OrderGetInteger(ORDER_TIME_EXPIRATION);
      if(expiration > 0)
         order.Int("expiration", DshServerTimeToUtc((datetime)expiration, offset));
      else
         order.Null("expiration");
      order.Str("comment", OrderGetString(ORDER_COMMENT));
      order.Int("magic", OrderGetInteger(ORDER_MAGIC));
      orders.Raw(order.Text());
     }
   CDshJsonObject payload;
   payload.Raw("orders", orders.Text());
   return payload.Text();
  }
//+------------------------------------------------------------------+
