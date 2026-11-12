//+------------------------------------------------------------------+
//| DshBridge market data (mt5/PROTOCOL.md, stage 2): the symbol      |
//| catalogue, the quotes and bars the Desktop subscribed to, and     |
//| history bars. The timer scans the subscriptions. Nothing here     |
//| waits for the terminal, so the session keeps its heartbeat: a     |
//| series is read only once it is synchronized, reads stay within    |
//| the bars the terminal has, and older history is downloaded in the |
//| background by the DshBridgeLoader indicator.                      |
//+------------------------------------------------------------------+
#include "Json.mqh"
#include "Protocol.mqh"
#include "Time.mqh"

//--- Compile MQL5\Indicators\DshBridgeLoader.mq5 before the EA, which embeds it.
#resource "\\Indicators\\DshBridgeLoader.ex5"
#define DSH_LOADER           "::Indicators\\DshBridgeLoader.ex5"

#define DSH_SYMBOLS_PAGE_MAX 1000
#define DSH_QUOTES_MAX       500
#define DSH_BAR_STREAMS_MAX  50
#define DSH_HISTORY_BARS_MAX 5000
//--- Series the terminal builds for the EA at a time, and how long one may take.
#define DSH_SERIES_LOADS_MAX 64
#define DSH_SERIES_LOAD_MS   60000
//--- Downloads of older history at a time. A download runs until the series reaches back far
//--- enough or has no older history, however long the network takes, and stops once the Desktop
//--- has not asked for its bars for DSH_DEEPEN_IDLE_MS. The loader asks the terminal again when
//--- the series has not reached further back for DSH_DEEPEN_ASK_MS: the terminal drops a request
//--- that comes while it first synchronizes the symbol's history. Asking again never ends a
//--- download, and an extra request while one is under way does no harm.
#define DSH_DEEPENS_MAX      8
#define DSH_DEEPEN_IDLE_MS   10000
#define DSH_DEEPEN_ASK_MS    3000
//--- A quote without its daily figures is looked at again after this long.
#define DSH_DAY_RETRY_MS     1000
//--- Series calls slower than this are logged: they would mean the terminal waited after all.
#define DSH_SLOW_CALL_US     100000

//--- Wire names of the timeframes the bridge serves.
string DshTimeframeName(const ENUM_TIMEFRAMES timeframe)
  {
   switch(timeframe)
     {
      case PERIOD_M1:
         return "M1";
      case PERIOD_M3:
         return "M3";
      case PERIOD_M5:
         return "M5";
      case PERIOD_M15:
         return "M15";
      case PERIOD_M30:
         return "M30";
      case PERIOD_H1:
         return "H1";
      case PERIOD_H2:
         return "H2";
      case PERIOD_H4:
         return "H4";
      case PERIOD_D1:
         return "D1";
      case PERIOD_W1:
         return "W1";
      default:
         return "";
     }
  }

//--- A served timeframe by its wire name; PERIOD_CURRENT for any other name.
ENUM_TIMEFRAMES DshTimeframe(const string name)
  {
   if(name == "M1")
      return PERIOD_M1;
   if(name == "M3")
      return PERIOD_M3;
   if(name == "M5")
      return PERIOD_M5;
   if(name == "M15")
      return PERIOD_M15;
   if(name == "M30")
      return PERIOD_M30;
   if(name == "H1")
      return PERIOD_H1;
   if(name == "H2")
      return PERIOD_H2;
   if(name == "H4")
      return PERIOD_H4;
   if(name == "D1")
      return PERIOD_D1;
   if(name == "W1")
      return PERIOD_W1;
   return PERIOD_CURRENT;
  }

string DshSymbolTradeMode(const long mode)
  {
   if(mode == SYMBOL_TRADE_MODE_FULL)
      return "full";
   if(mode == SYMBOL_TRADE_MODE_LONGONLY)
      return "long_only";
   if(mode == SYMBOL_TRADE_MODE_SHORTONLY)
      return "short_only";
   if(mode == SYMBOL_TRADE_MODE_CLOSEONLY)
      return "close_only";
   return "disabled";
  }

//--- One catalogue entry: what the Desktop needs to list, group, search and format a symbol.
string DshSymbolJson(const string name)
  {
   CDshJsonObject symbol;
   symbol.Str("name", name);
   symbol.Str("description", SymbolInfoString(name, SYMBOL_DESCRIPTION));
   symbol.Str("path", SymbolInfoString(name, SYMBOL_PATH));
   symbol.Str("currency_base", SymbolInfoString(name, SYMBOL_CURRENCY_BASE));
   symbol.Str("currency_profit", SymbolInfoString(name, SYMBOL_CURRENCY_PROFIT));
   symbol.Str("currency_margin", SymbolInfoString(name, SYMBOL_CURRENCY_MARGIN));
   symbol.Int("digits", SymbolInfoInteger(name, SYMBOL_DIGITS));
   symbol.Num("point", SymbolInfoDouble(name, SYMBOL_POINT), 10);
   symbol.Num("tick_size", SymbolInfoDouble(name, SYMBOL_TRADE_TICK_SIZE), 10);
   symbol.Num("contract_size", SymbolInfoDouble(name, SYMBOL_TRADE_CONTRACT_SIZE), 8);
   symbol.Num("volume_min", SymbolInfoDouble(name, SYMBOL_VOLUME_MIN), 8);
   symbol.Num("volume_max", SymbolInfoDouble(name, SYMBOL_VOLUME_MAX), 8);
   symbol.Num("volume_step", SymbolInfoDouble(name, SYMBOL_VOLUME_STEP), 8);
   symbol.Str("trade_mode", DshSymbolTradeMode(SymbolInfoInteger(name, SYMBOL_TRADE_MODE)));
   symbol.Str("calc_mode", DshEnumWord(EnumToString((ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(name, SYMBOL_TRADE_CALC_MODE)), "SYMBOL_CALC_MODE_"));
   symbol.Str("sector", DshEnumWord(EnumToString((ENUM_SYMBOL_SECTOR)SymbolInfoInteger(name, SYMBOL_SECTOR)), "SECTOR_"));
   symbol.Bool("selected", SymbolInfoInteger(name, SYMBOL_SELECT) != 0);
   return symbol.Text();
  }

//--- One page of the broker's catalogue, `symbols.list`. The first page also lists the Market
//--- Watch symbols, in the order the window shows them.
string DshSymbolsPage(const int offset, const int limit)
  {
   int total = SymbolsTotal(false);
   CDshJsonArray symbols;
   for(int i = offset; i < total && i < offset + limit; i++)
     {
      string name = SymbolName(i, false);
      if(name != "")
         symbols.Raw(DshSymbolJson(name));
     }
   CDshJsonObject page;
   page.Int("total", total);
   page.Raw("symbols", symbols.Text());
   if(offset == 0)
     {
      CDshJsonArray watch;
      int selected = SymbolsTotal(true);
      for(int i = 0; i < selected; i++)
         watch.Str(SymbolName(i, true));
      page.Raw("watch", watch.Text());
     }
   return page.Text();
  }

//--- True when the terminal has the symbol; it is added to Market Watch, because the terminal
//--- streams quotes only for the symbols there.
bool DshServeSymbol(const string symbol)
  {
   bool custom = false;
   if(symbol == "" || !SymbolExist(symbol, custom))
      return false;
   return SymbolInfoInteger(symbol, SYMBOL_SELECT) != 0 || SymbolSelect(symbol, true);
  }

struct SDshSeriesLoad
  {
   string            symbol;
   ENUM_TIMEFRAMES   timeframe;
   int               handle;
   ulong             since;
  };

struct SDshDeepen
  {
   string            symbol;
   ENUM_TIMEFRAMES   timeframe;
   datetime          from;          // server time the download should reach back to
   int               handle;        // the loader
   int               attempt;       // how often the loader started
   ulong             asked;         // when the Desktop last asked for these bars
   datetime          first;         // the series' first bar when the loader last asked
   ulong             since;         // when the loader last asked, or the series last reached further back
  };

//+------------------------------------------------------------------+
//| Series the terminal builds for the EA. In an EA, CopyRates and    |
//| CopyTime wait while the terminal builds or downloads a series,    |
//| for seconds or even minutes, and a waiting EA misses its          |
//| heartbeats. Creating an indicator never waits, and the terminal   |
//| builds the series the indicator needs, so the EA asks for a       |
//| series that way and reads it once it is synchronized. Older       |
//| history is downloaded the same way, by DshBridgeLoader.           |
//+------------------------------------------------------------------+
class CDshSeries
  {
private:
   SDshSeriesLoad    m_loads[];
   SDshDeepen        m_deepens[];

   int               FindDeepen(const string symbol, const ENUM_TIMEFRAMES timeframe) const
     {
      for(int i = 0; i < ArraySize(m_deepens); i++)
         if(m_deepens[i].symbol == symbol && m_deepens[i].timeframe == timeframe)
            return i;
      return -1;
     }

   void              RemoveDeepen(const int index)
     {
      IndicatorRelease(m_deepens[index].handle);
      int last = ArraySize(m_deepens) - 1;
      if(index < last)
         m_deepens[index] = m_deepens[last];
      ArrayResize(m_deepens, last);
     }

   static datetime   First(const string symbol, const ENUM_TIMEFRAMES timeframe)
     {
      return (datetime)SeriesInfoInteger(symbol, timeframe, SERIES_FIRSTDATE);
     }

   //--- Start the loader of a download, which asks the terminal once; false when it cannot start.
   //--- The attempt number makes every start a new instance, as iCustom shares an indicator
   //--- that has the same parameters.
   bool              StartLoader(SDshDeepen &deepen)
     {
      deepen.attempt++;
      // The loader runs on another timeframe: an indicator must not ask for its own series.
      deepen.handle = iCustom(deepen.symbol, deepen.timeframe == PERIOD_MN1 ? PERIOD_W1 : PERIOD_MN1, DSH_LOADER,
                              deepen.timeframe, deepen.from, deepen.attempt);
      if(deepen.handle == INVALID_HANDLE)
        {
         Print("DshBridge: cannot start the history loader for ", deepen.symbol, " ", DshTimeframeName(deepen.timeframe), ", error ", GetLastError());
         return false;
        }
      deepen.first = First(deepen.symbol, deepen.timeframe);
      deepen.since = GetTickCount64();
      return true;
     }

   int               Find(const string symbol, const ENUM_TIMEFRAMES timeframe) const
     {
      for(int i = 0; i < ArraySize(m_loads); i++)
         if(m_loads[i].symbol == symbol && m_loads[i].timeframe == timeframe)
            return i;
      return -1;
     }

   void              Remove(const int index)
     {
      IndicatorRelease(m_loads[index].handle);
      int last = ArraySize(m_loads) - 1;
      if(index < last)
         m_loads[index] = m_loads[last];
      ArrayResize(m_loads, last);
     }

public:
                    ~CDshSeries(void) { Clear(); }

   //--- True when the series can be read without waiting. Otherwise the terminal is asked to
   //--- build it, and a later call answers true.
   bool              Ready(const string symbol, const ENUM_TIMEFRAMES timeframe)
     {
      if(SeriesInfoInteger(symbol, timeframe, SERIES_SYNCHRONIZED) != 0)
         return true;
      if(Find(symbol, timeframe) >= 0 || ArraySize(m_loads) >= DSH_SERIES_LOADS_MAX)
         return false;
      int handle = iMA(symbol, timeframe, 1, 0, MODE_SMA, PRICE_CLOSE);
      if(handle == INVALID_HANDLE)
         return false;
      int size = ArraySize(m_loads);
      ArrayResize(m_loads, size + 1);
      m_loads[size].symbol = symbol;
      m_loads[size].timeframe = timeframe;
      m_loads[size].handle = handle;
      m_loads[size].since = GetTickCount64();
      return false;
     }

   //--- True when the series has no older history to download: it reaches back to the first
   //--- bar the server has, or holds as many bars as the terminal allows (Max bars in chart).
   static bool       Exhausted(const string symbol, const ENUM_TIMEFRAMES timeframe)
     {
      datetime first = First(symbol, timeframe);
      datetime serverFirst = (datetime)SeriesInfoInteger(symbol, timeframe, SERIES_SERVER_FIRSTDATE);
      if(first > 0 && serverFirst > 0 && first <= serverFirst + PeriodSeconds(timeframe))
         return true;
      return SeriesInfoInteger(symbol, timeframe, SERIES_BARS_COUNT) >= TerminalInfoInteger(TERMINAL_MAXBARS);
     }

   //--- Have the terminal download the series back to `from` (server time) in the background.
   //--- True while such a download runs, or waits for a free slot; false when the series reaches
   //--- back that far already, or the loader cannot start.
   bool              Deepen(const string symbol, const ENUM_TIMEFRAMES timeframe, datetime from)
     {
      datetime first = First(symbol, timeframe);
      if(first > 0 && first <= from)
         return false;
      datetime serverFirst = (datetime)SeriesInfoInteger(symbol, timeframe, SERIES_SERVER_FIRSTDATE);
      if(serverFirst > 0 && from < serverFirst)
         from = serverFirst;
      ulong now = GetTickCount64();
      int at = FindDeepen(symbol, timeframe);
      if(at >= 0)
        {
         if(m_deepens[at].from <= from)
           {
            m_deepens[at].asked = now;
            return true;
           }
         // It does not reach back far enough: one that does takes its place.
         RemoveDeepen(at);
        }
      // Every slot is downloading: a later request starts this download once one ends.
      if(ArraySize(m_deepens) >= DSH_DEEPENS_MAX)
         return true;
      SDshDeepen deepen;
      deepen.symbol = symbol;
      deepen.timeframe = timeframe;
      deepen.from = from;
      deepen.attempt = 0;
      deepen.asked = now;
      if(!StartLoader(deepen))
         return false;
      int size = ArraySize(m_deepens);
      ArrayResize(m_deepens, size + 1);
      m_deepens[size] = deepen;
      return true;
     }

   //--- Release the indicators of the series that are built, and of the ones that took too long;
   //--- end the downloads that reached back far enough, have no more to download, or that the
   //--- Desktop stopped asking for; ask again for the ones that stopped reaching further back.
   void              Prune(void)
     {
      ulong now = GetTickCount64();
      for(int i = ArraySize(m_loads) - 1; i >= 0; i--)
        {
         bool built = SeriesInfoInteger(m_loads[i].symbol, m_loads[i].timeframe, SERIES_SYNCHRONIZED) != 0;
         if(!built && now - m_loads[i].since < DSH_SERIES_LOAD_MS)
            continue;
         if(!built)
            Print("DshBridge: the terminal did not build ", m_loads[i].symbol, " ", DshTimeframeName(m_loads[i].timeframe), " within ", DSH_SERIES_LOAD_MS / 1000, " s");
         Remove(i);
        }
      for(int i = ArraySize(m_deepens) - 1; i >= 0; i--)
        {
         datetime first = First(m_deepens[i].symbol, m_deepens[i].timeframe);
         if((first > 0 && first <= m_deepens[i].from) || Exhausted(m_deepens[i].symbol, m_deepens[i].timeframe)
            || now - m_deepens[i].asked >= DSH_DEEPEN_IDLE_MS)
           {
            RemoveDeepen(i);
            continue;
           }
         if(first != m_deepens[i].first)
           {
            m_deepens[i].first = first;
            m_deepens[i].since = now;
            continue;
           }
         if(now - m_deepens[i].since < DSH_DEEPEN_ASK_MS)
            continue;
         IndicatorRelease(m_deepens[i].handle);
         if(!StartLoader(m_deepens[i]))
            RemoveDeepen(i);
        }
     }

   void              Clear(void)
     {
      for(int i = ArraySize(m_loads) - 1; i >= 0; i--)
         IndicatorRelease(m_loads[i].handle);
      ArrayResize(m_loads, 0);
      for(int i = ArraySize(m_deepens) - 1; i >= 0; i--)
         IndicatorRelease(m_deepens[i].handle);
      ArrayResize(m_deepens, 0);
     }
  };

//--- True when `serverTime` falls in one of the symbol's trading sessions and the symbol trades.
bool DshTradeSessionOpen(const string symbol, const datetime serverTime)
  {
   if(SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED)
      return false;
   MqlDateTime parts;
   TimeToStruct(serverTime, parts);
   long second = (long)serverTime % 86400;
   datetime from = 0;
   datetime to = 0;
   for(uint session = 0; session < 32 && SymbolInfoSessionTrade(symbol, (ENUM_DAY_OF_WEEK)parts.day_of_week, session, from, to); session++)
     {
      long start = (long)from % 86400;
      long end = (long)to % 86400;
      // A session that runs to midnight ends at 24:00.
      if(end == 0 && to > from)
         end = 86400;
      bool inside = start <= end ? (second >= start && second < end) : (second >= start || second < end);
      if(inside)
         return true;
     }
   return false;
  }

struct SDshQuoteStream
  {
   string            symbol;
   int               digits;
   string            sent;          // the tick last pushed, as JSON; "" until one is
   long              tickMsc;       // server time of the tick last looked at
   bool              open;          // the trading session state for `openMinute`
   long              openMinute;    // the server minute `open` was worked out for; -1: not yet
   bool              dayReady;      // the last tick carried the daily figures
   ulong             dayRetry;      // when to look again for the daily figures
  };

struct SDshBarStream
  {
   string            symbol;
   ENUM_TIMEFRAMES   timeframe;
   int               digits;
   long              tickMsc;       // server time of the tick last looked at
   datetime          time;          // open time of the bar last pushed
   string            sent;          // the bar last pushed, as JSON; "" until one is
  };

//+------------------------------------------------------------------+
//| The subscriptions of one session, and the history requests.      |
//+------------------------------------------------------------------+
class CDshMarket
  {
private:
   SDshQuoteStream   m_quotes[];
   SDshBarStream     m_bars[];
   CDshSeries        m_series;

   static bool       Fail(string &code, string &message, const string failCode, const string failMessage)
     {
      code = failCode;
      message = failMessage;
      return false;
     }

   int               FindQuote(const SDshQuoteStream &list[], const string symbol) const
     {
      for(int i = 0; i < ArraySize(list); i++)
         if(list[i].symbol == symbol)
            return i;
      return -1;
     }

   int               FindBars(const SDshBarStream &list[], const string symbol, const ENUM_TIMEFRAMES timeframe) const
     {
      for(int i = 0; i < ArraySize(list); i++)
         if(list[i].symbol == symbol && list[i].timeframe == timeframe)
            return i;
      return -1;
     }

   static void       AddName(string &names[], const string name)
     {
      for(int i = 0; i < ArraySize(names); i++)
         if(names[i] == name)
            return;
      int size = ArraySize(names);
      ArrayResize(names, size + 1);
      names[size] = name;
     }

   string            TickJson(const int index, const MqlTick &tick, const long offset, const ulong now)
     {
      string symbol = m_quotes[index].symbol;
      int digits = m_quotes[index].digits;
      CDshJsonObject json;
      json.Str("symbol", symbol);
      json.Int("time", DshServerMsToUtc(tick.time_msc, offset));
      json.Num("bid", tick.bid, digits);
      json.Num("ask", tick.ask, digits);
      // The day's figures come from the daily bars, which the terminal keeps in step with ticks.
      MqlRates days[];
      int copied = 0;
      if(m_series.Ready(symbol, PERIOD_D1))
         copied = CopyRates(symbol, PERIOD_D1, 0, 2, days);
      m_quotes[index].dayReady = copied > 0;
      if(copied <= 0)
         m_quotes[index].dayRetry = now + DSH_DAY_RETRY_MS;
      if(copied > 0)
        {
         json.Num("day_open", days[copied - 1].open, digits);
         json.Num("day_high", days[copied - 1].high, digits);
         json.Num("day_low", days[copied - 1].low, digits);
         json.Int("day_volume", days[copied - 1].tick_volume);
        }
      else
        {
         json.Null("day_open");
         json.Null("day_high");
         json.Null("day_low");
         json.Null("day_volume");
        }
      if(copied > 1)
         json.Num("prev_close", days[0].close, digits);
      else
         json.Null("prev_close");
      json.Bool("session_open", m_quotes[index].open);
      return json.Text();
     }

   string            BarJson(const int index, const MqlRates &rate, const long offset)
     {
      int digits = m_bars[index].digits;
      CDshJsonObject json;
      json.Str("symbol", m_bars[index].symbol);
      json.Str("timeframe", DshTimeframeName(m_bars[index].timeframe));
      json.Int("time", DshBarTimeToUtc(rate.time, m_bars[index].timeframe, offset));
      json.Num("open", rate.open, digits);
      json.Num("high", rate.high, digits);
      json.Num("low", rate.low, digits);
      json.Num("close", rate.close, digits);
      json.Int("volume", rate.tick_volume);
      return json.Text();
     }

public:
   int               QuoteCount(void) const { return ArraySize(m_quotes); }
   int               BarCount(void) const { return ArraySize(m_bars); }

   //--- End every subscription; a new session subscribes again.
   void              Clear(void)
     {
      ArrayResize(m_quotes, 0);
      ArrayResize(m_bars, 0);
      m_series.Clear();
     }

   //--- Forget what was pushed, so the next scan pushes every subscription's current value.
   void              Resync(void)
     {
      for(int i = 0; i < ArraySize(m_quotes); i++)
        {
         m_quotes[i].sent = "";
         m_quotes[i].tickMsc = -1;
        }
      for(int i = 0; i < ArraySize(m_bars); i++)
        {
         m_bars[i].sent = "";
         m_bars[i].tickMsc = -1;
         m_bars[i].time = 0;
        }
     }

   //--- `market.subscribe`: replace the subscriptions with the request's. `answer` lists the
   //--- symbols the terminal does not have; the rest are served.
   bool              Subscribe(CDshJson *payload, string &answer, string &code, string &message)
     {
      CDshJson *quotes = NULL;
      CDshJson *bars = NULL;
      if(payload != NULL)
        {
         quotes = payload.Get("quotes");
         bars = payload.Get("bars");
        }
      if(quotes == NULL || bars == NULL || quotes.Type() != DSH_JSON_ARRAY || bars.Type() != DSH_JSON_ARRAY)
         return Fail(code, message, "bad_request", "market.subscribe needs the arrays quotes and bars");
      if(quotes.Size() > DSH_QUOTES_MAX || bars.Size() > DSH_BAR_STREAMS_MAX)
         return Fail(code, message, "bad_request", "At most " + IntegerToString(DSH_QUOTES_MAX) + " quotes and " + IntegerToString(DSH_BAR_STREAMS_MAX) + " bar streams");
      // Check the whole request before changing anything.
      for(int i = 0; i < quotes.Size(); i++)
        {
         CDshJson *item = quotes.At(i);
         if(item.Type() != DSH_JSON_STRING)
            return Fail(code, message, "bad_request", "quotes must be symbol names");
        }
      for(int i = 0; i < bars.Size(); i++)
        {
         CDshJson *item = bars.At(i);
         CDshJson *symbol = NULL;
         if(item.IsObject())
            symbol = item.Get("symbol");
         if(symbol == NULL || symbol.Type() != DSH_JSON_STRING || DshTimeframe(item.GetString("timeframe")) == PERIOD_CURRENT)
            return Fail(code, message, "bad_request", "bars must be {symbol, timeframe} with a timeframe of M1, M3, M5, M15, M30, H1, H2, H4, D1 or W1");
        }
      string unknown[];
      SDshQuoteStream nextQuotes[];
      for(int i = 0; i < quotes.Size(); i++)
        {
         CDshJson *item = quotes.At(i);
         string symbol = item.String();
         if(FindQuote(nextQuotes, symbol) >= 0)
            continue;
         if(!DshServeSymbol(symbol))
           {
            AddName(unknown, symbol);
            continue;
           }
         int at = ArraySize(nextQuotes);
         ArrayResize(nextQuotes, at + 1);
         int kept = FindQuote(m_quotes, symbol);
         if(kept >= 0)
           {
            nextQuotes[at] = m_quotes[kept];
            continue;
           }
         nextQuotes[at].symbol = symbol;
         nextQuotes[at].digits = DshSymbolDigits(symbol);
         nextQuotes[at].sent = "";
         nextQuotes[at].tickMsc = -1;
         nextQuotes[at].open = false;
         nextQuotes[at].openMinute = -1;
         nextQuotes[at].dayReady = false;
         nextQuotes[at].dayRetry = 0;
        }
      SDshBarStream nextBars[];
      for(int i = 0; i < bars.Size(); i++)
        {
         CDshJson *item = bars.At(i);
         string symbol = item.GetString("symbol");
         ENUM_TIMEFRAMES timeframe = DshTimeframe(item.GetString("timeframe"));
         if(FindBars(nextBars, symbol, timeframe) >= 0)
            continue;
         if(!DshServeSymbol(symbol))
           {
            AddName(unknown, symbol);
            continue;
           }
         int at = ArraySize(nextBars);
         ArrayResize(nextBars, at + 1);
         int kept = FindBars(m_bars, symbol, timeframe);
         if(kept >= 0)
           {
            nextBars[at] = m_bars[kept];
            continue;
           }
         nextBars[at].symbol = symbol;
         nextBars[at].timeframe = timeframe;
         nextBars[at].digits = DshSymbolDigits(symbol);
         nextBars[at].tickMsc = -1;
         nextBars[at].time = 0;
         nextBars[at].sent = "";
         m_series.Ready(symbol, timeframe);
        }
      ArrayResize(m_quotes, ArraySize(nextQuotes));
      for(int i = 0; i < ArraySize(nextQuotes); i++)
         m_quotes[i] = nextQuotes[i];
      ArrayResize(m_bars, ArraySize(nextBars));
      for(int i = 0; i < ArraySize(nextBars); i++)
         m_bars[i] = nextBars[i];
      CDshJsonArray names;
      for(int i = 0; i < ArraySize(unknown); i++)
         names.Str(unknown[i]);
      CDshJsonObject json;
      json.Raw("unknown", names.Text());
      answer = json.Text();
      return true;
     }

   //--- The quotes that changed since the last scan, as a `market.tick` payload; "" when none did.
   string            ScanQuotes(void)
     {
      m_series.Prune();
      int count = ArraySize(m_quotes);
      if(count == 0)
         return "";
      long offset = DshServerUtcOffset();
      datetime serverNow = TimeTradeServer();
      long minute = (long)serverNow / 60;
      ulong now = GetTickCount64();
      CDshJsonArray ticks;
      for(int i = 0; i < count; i++)
        {
         // The session state changes without a tick, so it is worked out again every minute.
         bool look = false;
         if(m_quotes[i].openMinute != minute)
           {
            m_quotes[i].open = DshTradeSessionOpen(m_quotes[i].symbol, serverNow);
            m_quotes[i].openMinute = minute;
            look = true;
           }
         MqlTick tick;
         if(!SymbolInfoTick(m_quotes[i].symbol, tick) || (tick.bid == 0.0 && tick.ask == 0.0))
            continue;
         if(tick.time_msc != m_quotes[i].tickMsc)
            look = true;
         if(!m_quotes[i].dayReady && now >= m_quotes[i].dayRetry)
            look = true;
         if(!look)
            continue;
         m_quotes[i].tickMsc = tick.time_msc;
         string json = TickJson(i, tick, offset, now);
         if(json == m_quotes[i].sent)
            continue;
         m_quotes[i].sent = json;
         ticks.Raw(json);
        }
      if(ticks.Count() == 0)
         return "";
      CDshJsonObject payload;
      payload.Raw("ticks", ticks.Text());
      return payload.Text();
     }

   //--- The current bars that changed since the last scan, as a `market.bar` payload; "" when
   //--- none did. When a new bar opens, the final state of the bar before it goes first.
   string            ScanBars(void)
     {
      int count = ArraySize(m_bars);
      if(count == 0)
         return "";
      long offset = DshServerUtcOffset();
      CDshJsonArray bars;
      for(int i = 0; i < count; i++)
        {
         string symbol = m_bars[i].symbol;
         ENUM_TIMEFRAMES timeframe = m_bars[i].timeframe;
         // Bars change only with ticks.
         MqlTick tick;
         if(!SymbolInfoTick(symbol, tick) || tick.time_msc == m_bars[i].tickMsc)
            continue;
         if(!m_series.Ready(symbol, timeframe))
            continue;
         MqlRates current[];
         if(CopyRates(symbol, timeframe, 0, 1, current) != 1)
            continue;
         m_bars[i].tickMsc = tick.time_msc;
         if(current[0].time < m_bars[i].time)
            continue;
         if(m_bars[i].sent != "" && current[0].time > m_bars[i].time)
           {
            MqlRates closed[];
            if(CopyRates(symbol, timeframe, m_bars[i].time, 1, closed) == 1 && closed[0].time == m_bars[i].time)
              {
               string last = BarJson(i, closed[0], offset);
               if(last != m_bars[i].sent)
                  bars.Raw(last);
              }
           }
         string json = BarJson(i, current[0], offset);
         if(json == m_bars[i].sent)
            continue;
         m_bars[i].sent = json;
         m_bars[i].time = current[0].time;
         bars.Raw(json);
        }
      if(bars.Count() == 0)
         return "";
      CDshJsonObject payload;
      payload.Raw("bars", bars.Text());
      return payload.Text();
     }

   //--- `market.history`: the page of at most `count` bars of `symbol` that open before `to`,
   //--- oldest first. The page is complete with `count` bars, or with every bar there is. While
   //--- the terminal lacks some, it downloads older history in the background, and the answer is
   //--- pending; a `partial` request gets the bars there are instead, and whether that is all.
   //--- Answers pending while the series is still being built.
   bool              History(CDshJson *payload, string &answer, string &code, string &message)
     {
      string symbol;
      string name;
      long to = 0;
      long count = 0;
      bool partial = false;
      if(!DshStringField(payload, "symbol", symbol) || !DshStringField(payload, "timeframe", name)
         || !DshIntegerField(payload, "to", 0, to) || !DshIntegerField(payload, "count", 0, count)
         || !DshBoolField(payload, "partial", false, partial))
         return Fail(code, message, "bad_request", "market.history needs symbol, timeframe, to and count, and takes partial");
      ENUM_TIMEFRAMES timeframe = DshTimeframe(name);
      if(timeframe == PERIOD_CURRENT || to <= 0 || count < 1 || count > DSH_HISTORY_BARS_MAX)
         return Fail(code, message, "bad_request", "market.history needs a served timeframe, to > 0 and 1 to " + IntegerToString(DSH_HISTORY_BARS_MAX) + " bars");
      if(!DshServeSymbol(symbol))
         return Fail(code, message, "unknown_symbol", "The terminal has no symbol " + symbol);
      if(!m_series.Ready(symbol, timeframe))
        {
         answer = "{\"pending\":true}";
         return true;
        }
      long offset = DshServerUtcOffset();
      // `to` is exclusive: the last bar opens at least a second earlier.
      datetime last = (datetime)((long)DshUtcToBarTime(to, timeframe, offset) - 1);
      // Only the bars the terminal has: reading further back makes CopyRates wait while the
      // terminal downloads older history, which can take minutes. Bars() never waits.
      bool exhausted = CDshSeries::Exhausted(symbol, timeframe);
      datetime first = (datetime)SeriesInfoInteger(symbol, timeframe, SERIES_FIRSTDATE);
      // The oldest bar can lack the ticks from before the history the terminal has, such as a
      // week it has from Wednesday on, so it is sent only once the history before it is there.
      datetime oldest = exhausted ? first : (datetime)((long)first + 1);
      int local = first > 0 && oldest <= last ? Bars(symbol, timeframe, oldest, last) : 0;
      int wanted = (int)MathMin(count, (long)local);
      bool complete = wanted == count || exhausted;
      if(!complete)
        {
         // How far back the missing bars reach, with room for weekends and holidays.
         datetime start = first > 0 && first <= last ? first : last;
         datetime from = (datetime)((long)start - (count - wanted) * (long)PeriodSeconds(timeframe) * 3 / 2);
         // Without a download nothing older comes, so the bars there are are all there will be.
         if(!m_series.Deepen(symbol, timeframe, from))
            complete = true;
        }
      if(!complete && !partial)
        {
         answer = "{\"pending\":true}";
         return true;
        }
      MqlRates rates[];
      int copied = 0;
      if(wanted > 0)
        {
         ulong started = GetMicrosecondCount();
         copied = CopyRates(symbol, timeframe, last, wanted, rates);
         ulong spent = GetMicrosecondCount() - started;
         if(spent > DSH_SLOW_CALL_US)
            Print("DshBridge: CopyRates(", symbol, ", ", name, ", ", wanted, ") took ", (long)(spent / 1000), " ms and copied ", copied);
         if(copied < 0)
            copied = 0;
        }
      // The series changed in between: the bars that did not come are asked for again.
      if(copied < wanted)
        {
         complete = false;
         if(!partial)
           {
            answer = "{\"pending\":true}";
            return true;
           }
        }
      int digits = DshSymbolDigits(symbol);
      CDshJsonArray list;
      for(int i = 0; i < copied; i++)
        {
         CDshJsonArray bar;
         bar.Int(DshBarTimeToUtc(rates[i].time, timeframe, offset));
         bar.Num(rates[i].open, digits);
         bar.Num(rates[i].high, digits);
         bar.Num(rates[i].low, digits);
         bar.Num(rates[i].close, digits);
         bar.Int(rates[i].tick_volume);
         list.Raw(bar.Text());
        }
      CDshJsonObject json;
      json.Raw("bars", list.Text());
      json.Bool("no_data", copied == 0 && complete);
      json.Bool("complete", complete);
      answer = json.Text();
      return true;
     }
  };
//+------------------------------------------------------------------+
