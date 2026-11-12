//+------------------------------------------------------------------+
//| DshBridge: connects this terminal to DSH Desktop, which then      |
//| shows the account, quotes, charts, positions and history, and in  |
//| a later version trades through it.                                |
//| Attach it to any one chart. The EA dials the Desktop (MQL5        |
//| sockets cannot listen); add the Desktop's address under           |
//| Tools > Options > Expert Advisors > Allow WebRequest for listed   |
//| URL. Protocol: mt5/PROTOCOL.md in the DSH Desktop repository.     |
//+------------------------------------------------------------------+
#property copyright "DSH Desktop"
#property version   "1.10"
#property description "Connects this MetaTrader 5 terminal to DSH Desktop."
#property description "Empty inputs are read from MQL5\\Files\\DshBridge\\connection.txt (host=, port=, token=)."

#include <DshBridge/Bridge.mqh>

input string DesktopHost = "";    // Desktop address (empty: connection.txt, else 127.0.0.1)
input int    DesktopPort = 0;     // Desktop port (0: connection.txt, else 19500)
input string Token       = "";    // Bridge token from Desktop Settings > MT5 connection
input int    TimerMs     = 100;   // Poll interval, ms

#define DSH_CONNECTION_FILE "DshBridge\\connection.txt"
#define DSH_DEFAULT_HOST    "127.0.0.1"
#define DSH_DEFAULT_PORT    19500

CDshBridge bridge;

//--- Read host=, port= and token= lines from the connection file, when it exists.
void ReadConnectionFile(string &host, int &port, string &token)
  {
   if(!FileIsExist(DSH_CONNECTION_FILE))
      return;
   int handle = FileOpen(DSH_CONNECTION_FILE, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(handle == INVALID_HANDLE)
     {
      PrintFormat("DshBridge: cannot read %s, error %d", DSH_CONNECTION_FILE, GetLastError());
      return;
     }
   while(!FileIsEnding(handle))
     {
      string line = FileReadString(handle);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(line == "" || StringGetCharacter(line, 0) == '#')
         continue;
      int equals = StringFind(line, "=");
      if(equals <= 0)
         continue;
      string key = StringSubstr(line, 0, equals);
      string value = StringSubstr(line, equals + 1);
      StringTrimRight(key);
      StringTrimLeft(value);
      StringToLower(key);
      if(key == "host")
         host = value;
      else if(key == "port")
         port = (int)StringToInteger(value);
      else if(key == "token")
         token = value;
     }
   FileClose(handle);
  }

int OnInit(void)
  {
   if(MQLInfoInteger(MQL_TESTER) != 0)
     {
      Print("DshBridge: network functions are unavailable in the Strategy Tester");
      return INIT_FAILED;
     }
   string host = "";
   int port = 0;
   string token = "";
   ReadConnectionFile(host, port, token);
   if(DesktopHost != "")
      host = DesktopHost;
   if(DesktopPort != 0)
      port = DesktopPort;
   if(Token != "")
      token = Token;
   if(host == "")
      host = DSH_DEFAULT_HOST;
   if(port <= 0 || port > 65535)
      port = DSH_DEFAULT_PORT;
   bridge.Configure(host, (uint)port, token);
   if(!EventSetMillisecondTimer((uint)MathMax(20, TimerMs)))
     {
      PrintFormat("DshBridge: cannot start the timer, error %d", GetLastError());
      return INIT_FAILED;
     }
   PrintFormat("DshBridge %s: connecting to %s:%d", DSH_EA_VERSION, host, port);
   bridge.Tick();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   bridge.Shutdown();
  }

void OnTimer(void)
  {
   bridge.Tick();
  }

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   bridge.OnTrade(trans);
  }

void OnTick(void)
  {
  }
//+------------------------------------------------------------------+
