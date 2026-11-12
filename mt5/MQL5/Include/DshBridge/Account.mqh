//+------------------------------------------------------------------+
//| DshBridge account state: the `system.status` and                  |
//| `account.snapshot` payloads (mt5/PROTOCOL.md).                    |
//+------------------------------------------------------------------+
#include "Json.mqh"
#include "Protocol.mqh"

//--- Trade server time minus UTC, in seconds, rounded to the quarter hour: both clocks are
//--- derived from the local clock, so their difference jitters by a second or so.
long DshServerUtcOffset(void)
  {
   long offset = (long)(TimeTradeServer() - TimeGMT());
   return (long)MathRound(offset / 900.0) * 900;
  }

//--- `system.status`. Without `withPing` the payload omits the ping, which changes constantly,
//--- so the EA can tell a real change from ping jitter.
string DshStatusPayload(const bool withPing)
  {
   CDshJsonObject status;
   bool connected = TerminalInfoInteger(TERMINAL_CONNECTED) != 0;
   status.Bool("terminal_connected", connected);
   status.Bool("terminal_trade_allowed", TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0);
   status.Bool("ea_trade_allowed", MQLInfoInteger(MQL_TRADE_ALLOWED) != 0);
   status.Int("terminal_build", TerminalInfoInteger(TERMINAL_BUILD));
   status.Str("terminal_name", TerminalInfoString(TERMINAL_NAME));
   status.Str("terminal_company", TerminalInfoString(TERMINAL_COMPANY));
   if(withPing)
     {
      // TERMINAL_PING_LAST is in microseconds.
      long ping = TerminalInfoInteger(TERMINAL_PING_LAST);
      if(connected && ping > 0)
         status.Num("ping_ms", ping / 1000.0, 1);
      else
         status.Null("ping_ms");
     }
   status.Int("server_utc_offset", DshServerUtcOffset());
   return status.Text();
  }

string DshTradeModeName(const long mode)
  {
   if(mode == ACCOUNT_TRADE_MODE_DEMO)
      return "demo";
   if(mode == ACCOUNT_TRADE_MODE_CONTEST)
      return "contest";
   return "real";
  }

string DshMarginModeName(const long mode)
  {
   if(mode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
      return "hedging";
   if(mode == ACCOUNT_MARGIN_MODE_EXCHANGE)
      return "exchange";
   return "netting";
  }

//--- `account.snapshot`; money in the account currency with its decimals.
string DshAccountPayload(void)
  {
   int digits = DshMoneyDigits();
   CDshJsonObject account;
   account.Str("login", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
   account.Str("name", AccountInfoString(ACCOUNT_NAME));
   account.Str("server", AccountInfoString(ACCOUNT_SERVER));
   account.Str("company", AccountInfoString(ACCOUNT_COMPANY));
   account.Str("currency", AccountInfoString(ACCOUNT_CURRENCY));
   account.Int("currency_digits", digits);
   account.Int("leverage", AccountInfoInteger(ACCOUNT_LEVERAGE));
   account.Str("trade_mode", DshTradeModeName(AccountInfoInteger(ACCOUNT_TRADE_MODE)));
   account.Str("margin_mode", DshMarginModeName(AccountInfoInteger(ACCOUNT_MARGIN_MODE)));
   account.Bool("trade_allowed", AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) != 0);
   account.Bool("trade_expert", AccountInfoInteger(ACCOUNT_TRADE_EXPERT) != 0);
   account.Int("limit_orders", AccountInfoInteger(ACCOUNT_LIMIT_ORDERS));
   account.Num("balance", AccountInfoDouble(ACCOUNT_BALANCE), digits);
   account.Num("credit", AccountInfoDouble(ACCOUNT_CREDIT), digits);
   account.Num("profit", AccountInfoDouble(ACCOUNT_PROFIT), digits);
   account.Num("equity", AccountInfoDouble(ACCOUNT_EQUITY), digits);
   account.Num("margin", AccountInfoDouble(ACCOUNT_MARGIN), digits);
   account.Num("margin_free", AccountInfoDouble(ACCOUNT_MARGIN_FREE), digits);
   account.Num("margin_level", AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2);
   account.Num("margin_so_call", AccountInfoDouble(ACCOUNT_MARGIN_SO_CALL), 2);
   account.Num("margin_so_so", AccountInfoDouble(ACCOUNT_MARGIN_SO_SO), 2);
   account.Str("margin_so_mode", AccountInfoInteger(ACCOUNT_MARGIN_SO_MODE) == ACCOUNT_STOPOUT_MODE_MONEY ? "money" : "percent");
   return account.Text();
  }
//+------------------------------------------------------------------+
