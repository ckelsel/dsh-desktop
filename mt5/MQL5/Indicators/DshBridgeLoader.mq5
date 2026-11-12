//+------------------------------------------------------------------+
//| DshBridgeLoader: has the terminal download older history of one   |
//| series for the DshBridge EA. An EA that asks for bars the         |
//| terminal does not have waits, sometimes for minutes, until they   |
//| are downloaded. An indicator never waits: its request starts the  |
//| download and returns. The EA embeds this indicator as a resource  |
//| and runs it with iCustom on another timeframe of the symbol.      |
//|                                                                   |
//| The indicator asks once, when it starts: without a chart it gets  |
//| no timer events. The terminal drops a request that comes while it |
//| first synchronizes the symbol's history, so the EA starts the     |
//| indicator again when the series stops reaching further back.      |
//+------------------------------------------------------------------+
#property copyright   "DSH Desktop"
#property version     "1.20"
#property description "Downloads older history for the DshBridge EA, which starts and stops it."
#property indicator_chart_window
#property indicator_buffers 0
#property indicator_plots   0

input ENUM_TIMEFRAMES LoadPeriod = PERIOD_D1;   // Timeframe to load, of this symbol
input datetime        LoadFrom   = 0;           // Server time to load back to
input int             Attempt    = 0;           // Start number, so a restart is a new instance

int OnInit(void)
  {
   // An indicator must not ask for its own series.
   if(LoadPeriod == _Period || LoadPeriod == PERIOD_CURRENT || LoadFrom <= 0)
      return INIT_PARAMETERS_INCORRECT;
   // Ask for the bar at LoadFrom. In an indicator the call returns at once, and the download goes on.
   datetime first = (datetime)SeriesInfoInteger(_Symbol, LoadPeriod, SERIES_FIRSTDATE);
   if(first == 0 || first > LoadFrom)
     {
      datetime times[];
      CopyTime(_Symbol, LoadPeriod, LoadFrom, 1, times);
     }
   return INIT_SUCCEEDED;
  }

int OnCalculate(const int rates_total, const int prev_calculated, const int begin, const double &price[])
  {
   return rates_total;
  }
//+------------------------------------------------------------------+
