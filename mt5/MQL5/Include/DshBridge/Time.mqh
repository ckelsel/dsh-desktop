//+------------------------------------------------------------------+
//| DshBridge time: the wire carries UTC Unix milliseconds, while MT5 |
//| stamps quotes, bars and trades in trade server time. Every        |
//| conversion uses the current server offset, so intraday times from |
//| before a daylight-saving change come out an hour off.             |
//+------------------------------------------------------------------+
#include "Account.mqh"

//--- Server milliseconds (tick, position and trade times) to UTC milliseconds.
long DshServerMsToUtc(const long serverMs, const long offset)
  {
   return serverMs - offset * 1000;
  }

//--- A server time to UTC milliseconds.
long DshServerTimeToUtc(const datetime serverTime, const long offset)
  {
   return ((long)serverTime - offset) * 1000;
  }

//--- UTC milliseconds to server time, to the second (rounded down).
datetime DshUtcToServerTime(const long utcMs, const long offset)
  {
   return (datetime)((long)MathFloor(utcMs / 1000.0) + offset);
  }

//--- Daily and weekly bars carry the server date, not a moment.
bool DshDailyTimeframe(const ENUM_TIMEFRAMES timeframe)
  {
   return timeframe == PERIOD_D1 || timeframe == PERIOD_W1 || timeframe == PERIOD_MN1;
  }

//--- A bar's open time in UTC milliseconds. Intraday bars shift by the server offset; daily and
//--- weekly bars are stamped 00:00 UTC of their server date, as TradingView expects.
long DshBarTimeToUtc(const datetime serverTime, const ENUM_TIMEFRAMES timeframe, const long offset)
  {
   if(DshDailyTimeframe(timeframe))
      return (long)serverTime * 1000;
   return DshServerTimeToUtc(serverTime, offset);
  }

//--- The inverse of DshBarTimeToUtc, to the second (rounded down).
datetime DshUtcToBarTime(const long utcMs, const ENUM_TIMEFRAMES timeframe, const long offset)
  {
   if(DshDailyTimeframe(timeframe))
      return DshUtcToServerTime(utcMs, 0);
   return DshUtcToServerTime(utcMs, offset);
  }
//+------------------------------------------------------------------+
