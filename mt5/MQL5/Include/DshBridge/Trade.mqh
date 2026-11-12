//+------------------------------------------------------------------+
//| DshBridge trading (mt5/PROTOCOL.md): the five signed trade        |
//| requests, order.result and symbol.info.                           |
//| A request runs at most once: its id reaches the journal before    |
//| OrderSend, and a repeated id gets the first outcome back, marked  |
//| duplicate. Every check the EA can make runs first: the account,   |
//| the permissions, the symbol's rules and the ticket, then          |
//| OrderCheck, which trades nothing. Lots and prices must already    |
//| sit on the symbol's grid: the EA refuses them, it never rounds.   |
//+------------------------------------------------------------------+
#include "Json.mqh"
#include "Protocol.mqh"
#include "Journal.mqh"
#include "Market.mqh"
#include "Positions.mqh"

#define DSH_RESULT_IDS_MAX    50
#define DSH_DEVIATION_MAX     1000
#define DSH_DEVIATION_DEFAULT 10

//--- What a trade request came to: the result of PROTOCOL.md.
struct SDshOutcome
  {
   string            status;   // done, placed, rejected or unknown
   long              retcode;  // the trade server's return code; 0 when the EA refused the request
   string            code;     // why the EA refused it, or "check" (OrderCheck) or "sent" (OrderSend)
   string            message;
   ulong             order;
   ulong             deal;
   double            price;
   double            volume;
   int               digits;
  };

//--- A trade request's body, read and typed.
struct SDshTradeArgs
  {
   string            login;
   string            server;
   string            symbol;
   string            side;     // order.place: buy or sell
   string            kind;     // order.place: market, limit or stop
   ulong             ticket;
   double            volume;
   double            price;    // 0: none
   double            sl;       // 0: none
   double            tp;       // 0: none
   long              deviation;
  };

//--- The requests that trade. The Desktop signs them, and the EA journals them.
bool DshSignedType(const string type)
  {
   return type == "order.place" || type == "position.close" || type == "position.modify" || type == "order.modify" || type == "order.cancel";
  }

void DshOutcomeStart(SDshOutcome &outcome, const int digits)
  {
   outcome.status = "rejected";
   outcome.retcode = 0;
   outcome.code = "";
   outcome.message = "";
   outcome.order = 0;
   outcome.deal = 0;
   outcome.price = 0.0;
   outcome.volume = 0.0;
   outcome.digits = digits;
  }

//--- Refuse a request before it reaches MT5. Returns false, so a check can end with it.
bool DshRefuse(SDshOutcome &outcome, const string code, const string message)
  {
   outcome.status = "rejected";
   outcome.retcode = 0;
   outcome.code = code;
   outcome.message = message;
   return false;
  }

string DshOutcomeJson(const SDshOutcome &outcome)
  {
   CDshJsonObject json;
   json.Str("status", outcome.status);
   json.Int("retcode", outcome.retcode);
   json.Str("code", outcome.code);
   json.Str("message", outcome.message);
   if(outcome.order == 0)
      json.Null("order");
   else
      json.Str("order", IntegerToString((long)outcome.order));
   if(outcome.deal == 0)
      json.Null("deal");
   else
      json.Str("deal", IntegerToString((long)outcome.deal));
   DshPriceField(json, "price", outcome.price, outcome.digits);
   if(outcome.volume == 0.0)
      json.Null("volume");
   else
      json.Num("volume", outcome.volume, 8);
   return json.Text();
  }

//--- A journaled outcome as the answer's payload: the outcome object plus `duplicate`.
string DshOutcomePayload(const string result, const bool duplicate)
  {
   return StringSubstr(result, 0, StringLen(result) - 1) + ",\"duplicate\":" + (duplicate ? "true" : "false") + "}";
  }

//--- A request id the journal takes: 8 to 64 letters, digits and dashes, as a UUID is.
bool DshValidRequestId(const string id)
  {
   int length = StringLen(id);
   if(length < 8 || length > 64)
      return false;
   for(int i = 0; i < length; i++)
     {
      ushort c = StringGetCharacter(id, i);
      if(!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-'))
         return false;
     }
   return true;
  }

//--- The order comment, so the user can tell in MT5 what the Desktop sent.
string DshTradeComment(const string id)
  {
   return "dsh:" + StringSubstr(id, 0, 8);
  }

//--- A required finite number.
bool DshReadNumber(CDshJson *body, const string key, double &value)
  {
   value = 0.0;
   CDshJson *field = body.Get(key);
   if(field == NULL || field.Type() != DSH_JSON_NUMBER)
      return false;
   value = field.Number();
   return MathIsValidNumber(value);
  }

//--- A price that may be absent: missing or null is 0, MT5's "none"; otherwise a positive number.
bool DshReadPrice(CDshJson *body, const string key, double &value)
  {
   value = 0.0;
   CDshJson *field = body.Get(key);
   if(field == NULL || field.Type() == DSH_JSON_NULL)
      return true;
   if(field.Type() != DSH_JSON_NUMBER)
      return false;
   value = field.Number();
   return MathIsValidNumber(value) && value > 0.0;
  }

//--- A ticket, sent as a decimal string because tickets can exceed what a double holds exactly.
bool DshReadTicket(CDshJson *body, const string key, ulong &ticket)
  {
   ticket = 0;
   string text = "";
   if(!DshStringField(body, key, text) || text == "" || StringLen(text) > 19)
      return false;
   for(int i = 0; i < StringLen(text); i++)
     {
      ushort c = StringGetCharacter(text, i);
      if(c < '0' || c > '9')
         return false;
     }
   ticket = (ulong)StringToInteger(text);
   return ticket > 0;
  }

//--- Read a trade body. Returns "" when it is well formed, else what is wrong with it.
string DshReadTradeArgs(const string type, CDshJson *body, SDshTradeArgs &args)
  {
   args.login = "";
   args.server = "";
   args.symbol = "";
   args.side = "";
   args.kind = "";
   args.ticket = 0;
   args.volume = 0.0;
   args.price = 0.0;
   args.sl = 0.0;
   args.tp = 0.0;
   args.deviation = DSH_DEVIATION_DEFAULT;
   CDshJson *account = body.Get("account");
   if(account == NULL || !account.IsObject() || !DshStringField(account, "login", args.login) || !DshStringField(account, "server", args.server))
      return type + ".account must be {login, server}";
   if(!DshStringField(body, "symbol", args.symbol) || args.symbol == "")
      return type + ".symbol must be a symbol name";
   if(type == "order.place")
     {
      if(!DshStringField(body, "side", args.side) || (args.side != "buy" && args.side != "sell"))
         return "order.place.side must be buy or sell";
      if(!DshStringField(body, "type", args.kind) || (args.kind != "market" && args.kind != "limit" && args.kind != "stop"))
         return "order.place.type must be market, limit or stop";
      if(!DshReadNumber(body, "volume", args.volume) || args.volume <= 0.0)
         return "order.place.volume must be a positive number";
      if(!DshReadPrice(body, "price", args.price) || (args.kind == "market") != (args.price == 0.0))
         return "order.place.price must be a price for limit and stop orders, and null for market orders";
     }
   else
     {
      if(!DshReadTicket(body, "ticket", args.ticket))
         return type + ".ticket must be a ticket number as a decimal string";
      if(type == "position.close" && (!DshReadNumber(body, "volume", args.volume) || args.volume <= 0.0))
         return "position.close.volume must be a positive number";
      if(type == "order.modify" && (!DshReadPrice(body, "price", args.price) || args.price == 0.0))
         return "order.modify.price must be a price";
     }
   if(type == "order.place" || type == "position.modify" || type == "order.modify")
      if(!DshReadPrice(body, "sl", args.sl) || !DshReadPrice(body, "tp", args.tp))
         return type + ".sl and .tp must be null or prices";
   if(type == "order.place" || type == "position.close")
      if(!DshIntegerField(body, "deviation", DSH_DEVIATION_DEFAULT, args.deviation) || args.deviation < 0 || args.deviation > DSH_DEVIATION_MAX)
         return type + ".deviation must be 0 to 1000 points";
   return "";
  }

//--- Whether `value` is a whole number of `step`s, within floating-point noise.
bool DshOnGrid(const double value, const double step)
  {
   if(step <= 0.0)
      return true;
   double steps = value / step;
   return MathAbs(steps - MathRound(steps)) < 1e-6;
  }

//--- Decimals of a step such as 0.01.
int DshStepDigits(const double step)
  {
   int digits = 0;
   double scaled = step;
   while(digits < 8 && MathAbs(scaled - MathRound(scaled)) > 1e-9)
     {
      scaled *= 10.0;
      digits++;
     }
   return digits;
  }

//--- The symbol's price grid: its tick size, or its point when the tick size is unset.
double DshTickSize(const string symbol)
  {
   double tick = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   return tick > 0.0 ? tick : SymbolInfoDouble(symbol, SYMBOL_POINT);
  }

//--- `price` on the symbol's grid, without floating-point noise; 0 (none) stays 0. False when it is off the grid.
bool DshGridPrice(const string symbol, const double price, double &normalized)
  {
   normalized = 0.0;
   if(price == 0.0)
      return true;
   double tick = DshTickSize(symbol);
   if(!DshOnGrid(price, tick))
      return false;
   normalized = NormalizeDouble(tick > 0.0 ? MathRound(price / tick) * tick : price, DshSymbolDigits(symbol));
   return true;
  }

bool DshCheckPrices(const SDshTradeArgs &args, double &price, double &sl, double &tp, SDshOutcome &outcome)
  {
   if(!DshGridPrice(args.symbol, args.price, price) || !DshGridPrice(args.symbol, args.sl, sl) || !DshGridPrice(args.symbol, args.tp, tp))
      return DshRefuse(outcome, "invalid_price", args.symbol + " prices move in steps of " + DshJsonNumber(DshTickSize(args.symbol), 10));
   return true;
  }

bool DshCheckVolume(const string symbol, const double volume, SDshOutcome &outcome)
  {
   double minimum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maximum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(volume < minimum - 1e-9 || (maximum > 0.0 && volume > maximum + 1e-9) || !DshOnGrid(volume, step))
      return DshRefuse(outcome, "invalid_volume", symbol + " trades " + DshJsonNumber(minimum, 8) + " to " + DshJsonNumber(maximum, 8)
                       + " lots in steps of " + DshJsonNumber(step, 8));
   return true;
  }

double DshNormalizeVolume(const string symbol, const double volume)
  {
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0)
      return volume;
   return NormalizeDouble(MathRound(volume / step) * step, DshStepDigits(step));
  }

//--- Whether the symbol takes the order types and stops in `need` (SYMBOL_ORDER_* flags).
bool DshCheckOrderMode(const string symbol, const long need, const string what, SDshOutcome &outcome)
  {
   if((SymbolInfoInteger(symbol, SYMBOL_ORDER_MODE) & need) == need)
      return true;
   return DshRefuse(outcome, "order_mode", symbol + " does not take " + what);
  }

long DshStopsMode(const double sl, const double tp)
  {
   long need = 0;
   if(sl > 0.0)
      need |= SYMBOL_ORDER_SL;
   if(tp > 0.0)
      need |= SYMBOL_ORDER_TP;
   return need;
  }

//--- The checks of every trade request: the account it was meant for, the permissions, the symbol.
bool DshCheckCommon(const SDshTradeArgs &args, SDshOutcome &outcome)
  {
   if(args.login != IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) || args.server != AccountInfoString(ACCOUNT_SERVER))
      return DshRefuse(outcome, "account_mismatch", "The request is for another account than the one logged in to the terminal");
   if(TerminalInfoInteger(TERMINAL_CONNECTED) == 0)
      return DshRefuse(outcome, "not_connected", "The terminal is not connected to the trade server");
   if(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) == 0)
      return DshRefuse(outcome, "terminal_trading_off", "Algo Trading is off in the terminal");
   if(MQLInfoInteger(MQL_TRADE_ALLOWED) == 0)
      return DshRefuse(outcome, "ea_trading_off", "Allow Algo Trading is off in the EA's properties");
   if(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) == 0)
      return DshRefuse(outcome, "account_trading_off", "The account cannot trade, for example under an investor password");
   if(AccountInfoInteger(ACCOUNT_TRADE_EXPERT) == 0)
      return DshRefuse(outcome, "expert_trading_off", "The trade server does not let Expert Advisors trade on this account");
   if(!DshServeSymbol(args.symbol))
      return DshRefuse(outcome, "no_symbol", "The terminal has no symbol " + args.symbol);
   if(SymbolInfoInteger(args.symbol, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED)
      return DshRefuse(outcome, "trade_mode", args.symbol + " cannot be traded");
   return true;
  }

//--- order.place: a market order, or a limit or stop order that lasts until cancelled where the
//--- symbol allows that, else until the end of the day.
bool DshBuildPlace(const string id, const SDshTradeArgs &args, MqlTradeRequest &request, SDshOutcome &outcome)
  {
   string symbol = args.symbol;
   bool buy = args.side == "buy";
   long mode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if(mode == SYMBOL_TRADE_MODE_CLOSEONLY || (mode == SYMBOL_TRADE_MODE_LONGONLY && !buy) || (mode == SYMBOL_TRADE_MODE_SHORTONLY && buy))
      return DshRefuse(outcome, "trade_mode", symbol + " allows " + DshSymbolTradeMode(mode) + " trading");
   long need = args.kind == "market" ? SYMBOL_ORDER_MARKET : (args.kind == "limit" ? SYMBOL_ORDER_LIMIT : SYMBOL_ORDER_STOP);
   if(!DshCheckOrderMode(symbol, need | DshStopsMode(args.sl, args.tp), args.kind + " orders with these stops", outcome))
      return false;
   if(!DshCheckVolume(symbol, args.volume, outcome))
      return false;
   double price = 0.0;
   double sl = 0.0;
   double tp = 0.0;
   if(!DshCheckPrices(args, price, sl, tp, outcome))
      return false;
   request.symbol = symbol;
   request.volume = DshNormalizeVolume(symbol, args.volume);
   request.sl = sl;
   request.tp = tp;
   request.comment = DshTradeComment(id);
   if(args.kind == "market")
     {
      MqlTick tick;
      if(!SymbolInfoTick(symbol, tick) || (buy ? tick.ask : tick.bid) <= 0.0)
         return DshRefuse(outcome, "no_quote", "There is no quote for " + symbol);
      request.action = TRADE_ACTION_DEAL;
      request.type = buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      request.price = buy ? tick.ask : tick.bid;
      request.deviation = (ulong)args.deviation;
      return true;
     }
   long expiration = SymbolInfoInteger(symbol, SYMBOL_EXPIRATION_MODE);
   if((expiration & SYMBOL_EXPIRATION_GTC) != 0)
      request.type_time = ORDER_TIME_GTC;
   else
      if((expiration & SYMBOL_EXPIRATION_DAY) != 0)
         request.type_time = ORDER_TIME_DAY;
      else
         return DshRefuse(outcome, "expiration", symbol + " takes pending orders only with an expiry date");
   request.action = TRADE_ACTION_PENDING;
   if(args.kind == "limit")
      request.type = buy ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_SELL_LIMIT;
   else
      request.type = buy ? ORDER_TYPE_BUY_STOP : ORDER_TYPE_SELL_STOP;
   request.price = price;
   return true;
  }

//--- position.close: the opposite deal on the position's ticket, all of it or part. A netting
//--- account applies it to its one position on the symbol.
bool DshBuildClose(const string id, const SDshTradeArgs &args, MqlTradeRequest &request, SDshOutcome &outcome)
  {
   string ticket = IntegerToString((long)args.ticket);
   if(!PositionSelectByTicket(args.ticket))
      return DshRefuse(outcome, "no_position", "There is no position #" + ticket);
   string symbol = PositionGetString(POSITION_SYMBOL);
   if(symbol != args.symbol)
      return DshRefuse(outcome, "symbol_mismatch", "Position #" + ticket + " is on " + symbol + ", not " + args.symbol);
   double held = PositionGetDouble(POSITION_VOLUME);
   double minimum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double rest = held - args.volume;
   if(rest < -1e-9 || (rest > 1e-9 && rest < minimum - 1e-9))
      return DshRefuse(outcome, "invalid_volume", "Position #" + ticket + " holds " + DshJsonNumber(held, 8) + " lots: close all of them, or leave at least "
                       + DshJsonNumber(minimum, 8));
   bool all = MathAbs(rest) <= 1e-9;
   if(!all && !DshCheckVolume(symbol, args.volume, outcome))
      return false;
   MqlTick tick;
   bool buy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
   if(!SymbolInfoTick(symbol, tick) || (buy ? tick.bid : tick.ask) <= 0.0)
      return DshRefuse(outcome, "no_quote", "There is no quote for " + symbol);
   request.action = TRADE_ACTION_DEAL;
   request.position = args.ticket;
   request.symbol = symbol;
   request.volume = all ? held : DshNormalizeVolume(symbol, args.volume);
   request.type = buy ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price = buy ? tick.bid : tick.ask;
   request.deviation = (ulong)args.deviation;
   request.comment = DshTradeComment(id);
   return true;
  }

//--- position.modify: the position's stop loss and take profit; 0 removes either.
bool DshBuildModifyPosition(const SDshTradeArgs &args, MqlTradeRequest &request, SDshOutcome &outcome)
  {
   string ticket = IntegerToString((long)args.ticket);
   if(!PositionSelectByTicket(args.ticket))
      return DshRefuse(outcome, "no_position", "There is no position #" + ticket);
   string symbol = PositionGetString(POSITION_SYMBOL);
   if(symbol != args.symbol)
      return DshRefuse(outcome, "symbol_mismatch", "Position #" + ticket + " is on " + symbol + ", not " + args.symbol);
   if(!DshCheckOrderMode(symbol, DshStopsMode(args.sl, args.tp), "these stops", outcome))
      return false;
   double price = 0.0;
   double sl = 0.0;
   double tp = 0.0;
   if(!DshCheckPrices(args, price, sl, tp, outcome))
      return false;
   request.action = TRADE_ACTION_SLTP;
   request.position = args.ticket;
   request.symbol = symbol;
   request.sl = sl;
   request.tp = tp;
   return true;
  }

//--- A pending order of `args.symbol`, selected. False, refused, when there is none.
bool DshSelectPending(const SDshTradeArgs &args, SDshOutcome &outcome)
  {
   string ticket = IntegerToString((long)args.ticket);
   if(!OrderSelect(args.ticket) || !DshPendingType(OrderGetInteger(ORDER_TYPE)))
      return DshRefuse(outcome, "no_order", "There is no pending order #" + ticket);
   string symbol = OrderGetString(ORDER_SYMBOL);
   if(symbol != args.symbol)
      return DshRefuse(outcome, "symbol_mismatch", "Order #" + ticket + " is on " + symbol + ", not " + args.symbol);
   return true;
  }

//--- order.modify: a pending order's price, stop loss and take profit. Its expiry and its
//--- stop-limit price stay as they are.
bool DshBuildModifyOrder(const SDshTradeArgs &args, MqlTradeRequest &request, SDshOutcome &outcome)
  {
   if(!DshSelectPending(args, outcome))
      return false;
   if(!DshCheckOrderMode(args.symbol, DshStopsMode(args.sl, args.tp), "these stops", outcome))
      return false;
   double price = 0.0;
   double sl = 0.0;
   double tp = 0.0;
   if(!DshCheckPrices(args, price, sl, tp, outcome))
      return false;
   request.action = TRADE_ACTION_MODIFY;
   request.order = args.ticket;
   request.symbol = args.symbol;
   request.price = price;
   request.sl = sl;
   request.tp = tp;
   request.type_time = (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME);
   request.expiration = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);
   request.stoplimit = OrderGetDouble(ORDER_PRICE_STOPLIMIT);
   return true;
  }

//--- order.cancel.
bool DshBuildCancel(const SDshTradeArgs &args, MqlTradeRequest &request, SDshOutcome &outcome)
  {
   if(!DshSelectPending(args, outcome))
      return false;
   request.action = TRADE_ACTION_REMOVE;
   request.order = args.ticket;
   request.symbol = args.symbol;
   return true;
  }

//--- OrderCheck, which trades nothing. A deal or a pending order tries the symbol's filling
//--- policies in turn: Fill or Kill, Immediate or Cancel, then Return.
bool DshOrderCheck(MqlTradeRequest &request, SDshOutcome &outcome)
  {
   ENUM_ORDER_TYPE_FILLING policies[3];
   int count = 0;
   if(request.action == TRADE_ACTION_DEAL || request.action == TRADE_ACTION_PENDING)
     {
      long modes = SymbolInfoInteger(request.symbol, SYMBOL_FILLING_MODE);
      if((modes & SYMBOL_FILLING_FOK) != 0)
         policies[count++] = ORDER_FILLING_FOK;
      if((modes & SYMBOL_FILLING_IOC) != 0)
         policies[count++] = ORDER_FILLING_IOC;
      policies[count++] = ORDER_FILLING_RETURN;
     }
   else
      policies[count++] = request.type_filling;
   MqlTradeCheckResult check;
   ZeroMemory(check);
   int error = 0;
   for(int i = 0; i < count; i++)
     {
      request.type_filling = policies[i];
      ZeroMemory(check);
      ResetLastError();
      bool passed = OrderCheck(request, check);
      error = GetLastError();
      if(passed && (check.retcode == 0 || check.retcode == TRADE_RETCODE_DONE))
         return true;
      if(check.retcode != TRADE_RETCODE_INVALID_FILL)
         break;
     }
   outcome.status = "rejected";
   outcome.retcode = (long)check.retcode;
   outcome.code = "check";
   outcome.message = check.comment != "" ? check.comment : "OrderCheck failed, error " + IntegerToString(error);
   return false;
  }

//--- A market price may have moved since OrderCheck.
void DshRefreshPrice(MqlTradeRequest &request)
  {
   if(request.action != TRADE_ACTION_DEAL)
      return;
   MqlTick tick;
   if(!SymbolInfoTick(request.symbol, tick))
      return;
   double price = request.type == ORDER_TYPE_BUY ? tick.ask : tick.bid;
   if(price > 0.0)
      request.price = price;
  }

//--- What OrderSend came to. 10008 to 10010 succeeded. 10011, 10012 and 10031 (an error in the
//--- terminal, a timeout, no connection) may or may not have reached the trade server, so they
//--- are unknown. Any other code was a rejection, and so was a request the terminal kept.
void DshClassify(const MqlTradeRequest &request, const MqlTradeResult &result, const bool accepted, const int error, SDshOutcome &outcome)
  {
   outcome.retcode = (long)result.retcode;
   outcome.code = "sent";
   outcome.order = result.order;
   outcome.deal = result.deal;
   outcome.price = result.price;
   outcome.volume = result.volume;
   outcome.message = result.comment;
   switch(result.retcode)
     {
      case TRADE_RETCODE_PLACED:
         outcome.status = "placed";
         break;
      case TRADE_RETCODE_DONE:
      case TRADE_RETCODE_DONE_PARTIAL:
         outcome.status = request.action == TRADE_ACTION_PENDING ? "placed" : "done";
         break;
      case TRADE_RETCODE_ERROR:
      case TRADE_RETCODE_TIMEOUT:
      case TRADE_RETCODE_CONNECTION:
         outcome.status = "unknown";
         break;
      case 0:
         // Without a return code, OrderSend fails only on a request it did not send.
         outcome.status = accepted ? "unknown" : "rejected";
         outcome.code = accepted ? "sent" : "not_sent";
         if(outcome.message == "")
            outcome.message = "OrderSend failed, error " + IntegerToString(error);
         break;
      default:
         outcome.status = "rejected";
     }
  }

//--- A signed trade request whose MAC held. Returns false, with code and message, only for a
//--- malformed request, which is not journaled; any other request answers with its outcome.
bool DshTrade(CDshJournal &journal, const string id, const string type, CDshJson *body, const string text, string &answer, string &code, string &message)
  {
   string state = "";
   string recorded = "";
   if(journal.Lookup(id, state, recorded))
     {
      // This id ran, or was refused, before: it never runs again.
      if(recorded == "")
        {
         SDshOutcome running;
         DshOutcomeStart(running, 5);
         running.status = "unknown";
         running.code = "interrupted";
         running.message = "The request did not finish";
         recorded = DshOutcomeJson(running);
        }
      answer = DshOutcomePayload(recorded, true);
      return true;
     }
   if(!DshValidRequestId(id))
     {
      code = "bad_request";
      message = "A trade request id must be 8 to 64 letters, digits or dashes";
      return false;
     }
   SDshTradeArgs args;
   string problem = DshReadTradeArgs(type, body, args);
   if(problem != "")
     {
      code = "bad_request";
      message = problem;
      return false;
     }
   SDshOutcome outcome;
   DshOutcomeStart(outcome, DshSymbolDigits(args.symbol));
   MqlTradeRequest request;
   ZeroMemory(request);
   bool ready = journal.IsOpen() || DshRefuse(outcome, "journal_unavailable", "The EA cannot write its request journal: " + journal.Error());
   ready = ready && DshCheckCommon(args, outcome);
   if(ready)
     {
      if(type == "order.place")
         ready = DshBuildPlace(id, args, request, outcome);
      else
         if(type == "position.close")
            ready = DshBuildClose(id, args, request, outcome);
         else
            if(type == "position.modify")
               ready = DshBuildModifyPosition(args, request, outcome);
            else
               if(type == "order.modify")
                  ready = DshBuildModifyOrder(args, request, outcome);
               else
                  ready = DshBuildCancel(args, request, outcome);
     }
   if(ready && request.action != TRADE_ACTION_REMOVE)
      ready = DshOrderCheck(request, outcome);
   if(ready && !journal.Begin(id, type, text))
      ready = DshRefuse(outcome, "journal_unavailable", "The EA cannot write its request journal: " + journal.Error());
   if(!ready)
     {
      string refused = DshOutcomeJson(outcome);
      journal.Finish(id, "done", refused);
      answer = DshOutcomePayload(refused, false);
      return true;
     }
   DshRefreshPrice(request);
   MqlTradeResult result;
   ZeroMemory(result);
   ResetLastError();
   bool accepted = OrderSend(request, result);
   int error = GetLastError();
   DshClassify(request, result, accepted, error, outcome);
   string outcomeJson = DshOutcomeJson(outcome);
   journal.Finish(id, outcome.status == "unknown" ? "unknown" : "done", outcomeJson);
   answer = DshOutcomePayload(outcomeJson, false);
   return true;
  }

//--- order.result {ids}: what the journal knows of each request. "none" is evidence that a
//--- request never ran only when `instance` is the one that got it and it was sent after `since`.
bool DshRequestResults(CDshJournal &journal, CDshJson *payload, string &answer, string &code, string &message)
  {
   CDshJson *ids = payload == NULL ? NULL : payload.Get("ids");
   if(ids == NULL || ids.Type() != DSH_JSON_ARRAY || ids.Size() > DSH_RESULT_IDS_MAX)
     {
      code = "bad_request";
      message = "order.result needs ids: an array of up to " + IntegerToString(DSH_RESULT_IDS_MAX) + " request ids";
      return false;
     }
   CDshJsonArray results;
   for(int i = 0; i < ids.Size(); i++)
     {
      CDshJson *item = ids.At(i);
      string id = item == NULL ? "" : item.String();
      if(id == "")
        {
         code = "bad_request";
         message = "order.result.ids must be strings";
         return false;
        }
      string state = "";
      string result = "";
      CDshJsonObject entry;
      entry.Str("id", id);
      if(!journal.Lookup(id, state, result))
        {
         entry.Str("state", "none");
         entry.Null("result");
        }
      else
        {
         // A request still at "sending" stopped inside OrderSend.
         entry.Str("state", state == "done" ? "done" : "unknown");
         if(result == "")
            entry.Null("result");
         else
            entry.Raw("result", result);
        }
      results.Raw(entry.Text());
     }
   CDshJsonObject reply;
   reply.Str("instance", journal.Instance());
   reply.Int("since", journal.Since());
   reply.Raw("results", results.Text());
   answer = reply.Text();
   return true;
  }

//--- The names of the flags set in `mask`.
string DshFlagNames(const long mask, const long &flags[], const string &names[])
  {
   CDshJsonArray list;
   for(int i = 0; i < ArraySize(flags) && i < ArraySize(names); i++)
      if((mask & flags[i]) != 0)
         list.Str(names[i]);
   return list.Text();
  }

//--- symbol.info {symbol}: the trade rules the order ticket checks before it sends.
bool DshSymbolInfo(CDshJson *payload, string &answer, string &code, string &message)
  {
   string symbol = "";
   if(!DshStringField(payload, "symbol", symbol) || symbol == "")
     {
      code = "bad_request";
      message = "symbol.info needs a symbol";
      return false;
     }
   if(!DshServeSymbol(symbol))
     {
      code = "unknown_symbol";
      message = "The terminal has no symbol " + symbol;
      return false;
     }
   // SYMBOL_FILLING_FOK, _IOC and _BOC; SYMBOL_ORDER_*; SYMBOL_EXPIRATION_*.
   long fillings[] = {1, 2, 4};
   string fillingNames[] = {"fok", "ioc", "boc"};
   long orders[] = {SYMBOL_ORDER_MARKET, SYMBOL_ORDER_LIMIT, SYMBOL_ORDER_STOP, SYMBOL_ORDER_STOP_LIMIT, SYMBOL_ORDER_SL, SYMBOL_ORDER_TP, SYMBOL_ORDER_CLOSEBY};
   string orderNames[] = {"market", "limit", "stop", "stop_limit", "sl", "tp", "close_by"};
   long expirations[] = {SYMBOL_EXPIRATION_GTC, SYMBOL_EXPIRATION_DAY, SYMBOL_EXPIRATION_SPECIFIED, SYMBOL_EXPIRATION_SPECIFIED_DAY};
   string expirationNames[] = {"gtc", "day", "specified", "specified_day"};
   int money = DshMoneyDigits();
   CDshJsonObject info;
   info.Str("symbol", symbol);
   info.Int("digits", DshSymbolDigits(symbol));
   info.Num("point", SymbolInfoDouble(symbol, SYMBOL_POINT), 10);
   info.Num("tick_size", SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE), 10);
   info.Num("contract_size", SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE), 8);
   info.Num("volume_min", SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN), 8);
   info.Num("volume_max", SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX), 8);
   info.Num("volume_step", SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP), 8);
   info.Num("volume_limit", SymbolInfoDouble(symbol, SYMBOL_VOLUME_LIMIT), 8);
   info.Int("stops_level", SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL));
   info.Int("freeze_level", SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL));
   info.Str("trade_mode", DshSymbolTradeMode(SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE)));
   info.Str("execution", DshEnumWord(EnumToString((ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(symbol, SYMBOL_TRADE_EXEMODE)), "SYMBOL_TRADE_EXECUTION_"));
   info.Raw("filling", DshFlagNames(SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE), fillings, fillingNames));
   info.Raw("order_modes", DshFlagNames(SymbolInfoInteger(symbol, SYMBOL_ORDER_MODE), orders, orderNames));
   info.Raw("expiration_modes", DshFlagNames(SymbolInfoInteger(symbol, SYMBOL_EXPIRATION_MODE), expirations, expirationNames));
   // The margin of one lot at the current price, in the account currency.
   MqlTick tick;
   bool quoted = SymbolInfoTick(symbol, tick);
   double margin = 0.0;
   if(quoted && tick.ask > 0.0 && OrderCalcMargin(ORDER_TYPE_BUY, symbol, 1.0, tick.ask, margin))
      info.Num("margin_buy", margin, money);
   else
      info.Null("margin_buy");
   if(quoted && tick.bid > 0.0 && OrderCalcMargin(ORDER_TYPE_SELL, symbol, 1.0, tick.bid, margin))
      info.Num("margin_sell", margin, money);
   else
      info.Null("margin_sell");
   info.Bool("session_open", DshTradeSessionOpen(symbol, TimeTradeServer()));
   answer = info.Text();
   return true;
  }
//+------------------------------------------------------------------+
