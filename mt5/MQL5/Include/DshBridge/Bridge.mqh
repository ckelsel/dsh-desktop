//+------------------------------------------------------------------+
//| DshBridge session: connect to the Desktop, authenticate with      |
//| system.hello, answer the Desktop's requests, ping, and push what  |
//| changes: account state, positions, orders, the subscribed quotes  |
//| and bars, and trade events. Everything runs from OnTimer, so      |
//| nothing blocks the terminal beyond one connect attempt.           |
//+------------------------------------------------------------------+
#include "Json.mqh"
#include "Transport.mqh"
#include "Protocol.mqh"
#include "Account.mqh"
#include "Market.mqh"
#include "Positions.mqh"
#include "History.mqh"

#define DSH_CONNECT_TIMEOUT_MS 1000
#define DSH_HELLO_TIMEOUT_MS   10000
//--- A failed connect is retried within 5 s: the Desktop may be starting, or the terminal's
//--- WebRequest list was just fixed. A refused hello (wrong token, busy) will not change soon.
#define DSH_BACKOFF_MIN_MS     1000
#define DSH_BACKOFF_MAX_MS     5000
#define DSH_REFUSED_RETRY_MS   30000
#define DSH_COMPARE_MS         500
#define DSH_PING_REFRESH_MS    10000
#define DSH_SYMBOLS_PAGE       500
#define DSH_TRADE_QUEUE_MAX    200
//--- system.reload saves the chart as this template and applies it, which loads the EA again
//--- from disk. The template lands in MQL5\Profiles\Templates.
#define DSH_RELOAD_TEMPLATE    "DshBridgeReload"

enum ENUM_DSH_STATE
  {
   DSH_STATE_IDLE,        // waiting to (re)connect
   DSH_STATE_HELLO,       // connected, hello sent
   DSH_STATE_READY        // authenticated
  };

class CDshBridge
  {
private:
   CDshTransport     m_transport;
   string            m_host;
   uint              m_port;
   string            m_token;
   ENUM_DSH_STATE    m_state;
   ulong             m_nextAttempt;
   uint              m_backoff;
   ulong             m_connectedAt;
   ulong             m_lastReceived;
   ulong             m_lastSent;
   ulong             m_lastCompare;
   ulong             m_lastStatusPush;
   uint              m_heartbeatMs;
   uint              m_idleMs;
   string            m_helloId;
   long              m_sequence;
   //--- What the Desktop last received, so only changes are pushed.
   string            m_sentStatusKey;
   string            m_sentStatus;
   string            m_sentAccount;
   //--- "" until the Desktop asks for them: an older Desktop does not know these events.
   string            m_sentPositions;
   string            m_sentOrders;
   bool              m_dirty;
   CDshMarket        m_market;
   //--- trade.event payloads waiting for the next push.
   string            m_trades[];
   string            m_shown;
   //--- The failure last written to the Experts log: a retry loop logs each reason once.
   string            m_failure;

   string            NextId(const string prefix) { m_sequence++; return prefix + "-" + IntegerToString(m_sequence); }

   void              Show(const string line)
     {
      string text = "DshBridge " + DSH_EA_VERSION + "  ->  " + m_host + ":" + IntegerToString(m_port) + "\n" + line;
      if(text == m_shown)
         return;
      m_shown = text;
      Comment(text);
     }

   //--- Show a failure on the chart, and write it to the Experts log unless it repeats.
   void              Report(const string failure)
     {
      Show(failure);
      if(failure == m_failure)
         return;
      m_failure = failure;
      Print("DshBridge: ", failure);
     }

   bool              Send(const string frame)
     {
      if(!m_transport.SendLine(frame))
        {
         Drop(m_transport.Error());
         return false;
        }
      m_lastSent = GetTickCount64();
      return true;
     }

   void              Schedule(const ulong now)
     {
      m_nextAttempt = now + m_backoff;
      m_backoff = (uint)MathMin(m_backoff * 2, DSH_BACKOFF_MAX_MS);
     }

   //--- Forget the session's subscriptions and everything it was sent.
   void              Forget(void)
     {
      m_sentStatusKey = "";
      m_sentStatus = "";
      m_sentAccount = "";
      m_sentPositions = "";
      m_sentOrders = "";
      m_market.Clear();
      ArrayResize(m_trades, 0);
     }

   void              Drop(const string reason)
     {
      bool wasReady = m_state == DSH_STATE_READY;
      m_transport.Close();
      m_state = DSH_STATE_IDLE;
      Forget();
      if(wasReady)
         m_backoff = DSH_BACKOFF_MIN_MS;
      Schedule(GetTickCount64());
      Report("Disconnected: " + reason);
     }

   void              Connect(const ulong now)
     {
      if(m_token == "")
        {
         m_nextAttempt = now + DSH_REFUSED_RETRY_MS;
         Report("No token: set the EA input Token, or put token=... in MQL5\\Files\\DshBridge\\connection.txt");
         return;
        }
      Show("Connecting...");
      if(!m_transport.Connect(m_host, m_port, DSH_CONNECT_TIMEOUT_MS))
        {
         Schedule(GetTickCount64());
         Report(m_transport.Error());
         return;
        }
      ulong at = GetTickCount64();
      m_state = DSH_STATE_HELLO;
      m_connectedAt = at;
      m_lastReceived = at;
      m_helloId = NextId("hello");
      CDshJsonObject hello;
      hello.Str("token", m_token);
      hello.Int("protocol", DSH_PROTOCOL_VERSION);
      hello.Str("ea_version", DSH_EA_VERSION);
      hello.Int("terminal_build", TerminalInfoInteger(TERMINAL_BUILD));
      hello.Str("terminal_name", TerminalInfoString(TERMINAL_NAME));
      hello.Str("login", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
      hello.Str("server", AccountInfoString(ACCOUNT_SERVER));
      if(Send(DshRequestFrame(m_helloId, "system.hello", hello.Text())))
         Show("Connected; authenticating...");
     }

   void              OnHello(CDshJson *frame)
     {
      if(!frame.GetBool("ok"))
        {
         CDshJson *error = frame.Get("error");
         string code = error == NULL ? "" : error.GetString("code");
         string message = error == NULL ? "" : error.GetString("message");
         // A wrong token or a busy bridge will not change in a second; retry slowly.
         if(code == "auth_failed" || code == "busy" || code == "unsupported_protocol")
            m_backoff = DSH_REFUSED_RETRY_MS;
         Drop(code + ": " + message);
         return;
        }
      CDshJson *payload = frame.Get("payload");
      if(payload != NULL)
        {
         double heartbeat = payload.GetNumber("heartbeat_ms", 5000);
         double idle = payload.GetNumber("idle_ms", 15000);
         m_heartbeatMs = (uint)MathMax(1000, MathMin(heartbeat, 60000));
         m_idleMs = (uint)MathMax(3000, MathMin(idle, 300000));
        }
      m_state = DSH_STATE_READY;
      m_backoff = DSH_BACKOFF_MIN_MS;
      m_failure = "";
      Forget();
      PrintFormat("DshBridge: connected to %s:%u as account %I64d on %s", m_host, m_port, AccountInfoInteger(ACCOUNT_LOGIN), AccountInfoString(ACCOUNT_SERVER));
      Show("Connected: account " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + " on " + AccountInfoString(ACCOUNT_SERVER));
     }

   //--- Answer a request whose payload a handler produced, or the error it reported.
   void              Answer(const string id, const bool ok, const string payload, const string code, const string message)
     {
      if(ok)
         Send(DshOkFrame(id, payload));
      else
         Send(DshErrorFrame(id, code, message));
     }

   //--- system.reload: save this chart as a template and apply it. The terminal then unloads
   //--- the EA and loads it again from disk, with the same inputs.
   void              Reload(const string id)
     {
      ResetLastError();
      if(!ChartSaveTemplate(0, DSH_RELOAD_TEMPLATE))
        {
         Send(DshErrorFrame(id, "not_ready", "Cannot save the chart template, error " + IntegerToString(GetLastError())));
         return;
        }
      if(!Send(DshOkFrame(id, "{}")))
         return;
      Print("DshBridge: reloading from disk");
      ResetLastError();
      if(!ChartApplyTemplate(0, DSH_RELOAD_TEMPLATE + ".tpl"))
         Print("DshBridge: cannot apply the chart template, error ", GetLastError());
     }

   void              OnRequest(const string id, const string type, CDshJson *payload)
     {
      if(m_state != DSH_STATE_READY)
        {
         Send(DshErrorFrame(id, "not_ready", "The EA has not authenticated yet"));
         return;
        }
      string answer = "";
      string code = "";
      string message = "";
      if(type == "system.resync")
        {
         // Forget what was pushed, so every later change reaches the Desktop's fresh state. The
         // subscriptions stay until the Desktop sends its own again.
         m_sentStatusKey = "";
         m_sentStatus = "";
         m_sentAccount = "";
         m_sentPositions = "";
         m_sentOrders = "";
         m_market.Resync();
         Send(DshOkFrame(id, "{}"));
         return;
        }
      if(type == "system.status")
        {
         m_sentStatusKey = DshStatusPayload(false);
         m_sentStatus = DshStatusPayload(true);
         m_lastStatusPush = GetTickCount64();
         Send(DshOkFrame(id, m_sentStatus));
         return;
        }
      if(type == "account.snapshot")
        {
         m_sentAccount = DshAccountPayload();
         Send(DshOkFrame(id, m_sentAccount));
         return;
        }
      if(type == "symbols.list")
        {
         long offset = 0;
         long limit = DSH_SYMBOLS_PAGE;
         if(!DshIntegerField(payload, "offset", 0, offset) || !DshIntegerField(payload, "limit", DSH_SYMBOLS_PAGE, limit)
            || offset < 0 || limit < 1 || limit > DSH_SYMBOLS_PAGE_MAX)
           {
            Send(DshErrorFrame(id, "bad_request", "symbols.list needs offset >= 0 and a limit of 1 to " + IntegerToString(DSH_SYMBOLS_PAGE_MAX)));
            return;
           }
         Send(DshOkFrame(id, DshSymbolsPage((int)offset, (int)limit)));
         return;
        }
      if(type == "positions.snapshot")
        {
         m_sentPositions = DshPositionsPayload();
         Send(DshOkFrame(id, m_sentPositions));
         return;
        }
      if(type == "orders.snapshot")
        {
         m_sentOrders = DshOrdersPayload();
         Send(DshOkFrame(id, m_sentOrders));
         return;
        }
      if(type == "market.subscribe")
        {
         bool ok = m_market.Subscribe(payload, answer, code, message);
         Answer(id, ok, answer, code, message);
         return;
        }
      if(type == "market.history")
        {
         bool ok = m_market.History(payload, answer, code, message);
         Answer(id, ok, answer, code, message);
         return;
        }
      if(type == "history.query")
        {
         bool ok = DshHistoryPayload(payload, answer, code, message);
         Answer(id, ok, answer, code, message);
         return;
        }
      if(type == "system.reload")
        {
         Reload(id);
         return;
        }
      Send(DshErrorFrame(id, "unknown_type", "The EA does not serve " + type));
     }

   void              OnLine(const string line)
     {
      CDshJson frame;
      string error;
      if(!frame.Parse(line, error) || !frame.IsObject() || frame.GetNumber("v") != DSH_PROTOCOL_VERSION)
        {
         Print("DshBridge: ignored an invalid frame: ", error);
         return;
        }
      m_lastReceived = GetTickCount64();
      string type = frame.GetString("type");
      string id = frame.GetString("id");
      if(type == "response")
        {
         if(m_state == DSH_STATE_HELLO && id == m_helloId)
            OnHello(GetPointer(frame));
         return;
        }
      // Events (system.ping included) only keep the session alive in protocol v1.
      if(id == "")
         return;
      CDshJson *payload = frame.Get("payload");
      if(payload != NULL && !payload.IsObject())
        {
         Send(DshErrorFrame(id, "bad_request", "The payload must be an object"));
         return;
        }
      OnRequest(id, type, payload);
     }

   //--- Push what changed since the Desktop last heard. The ping alone refreshes slowly.
   void              PushChanges(const ulong now)
     {
      m_lastCompare = now;
      m_dirty = false;
      string key = DshStatusPayload(false);
      string status = DshStatusPayload(true);
      if(key != m_sentStatusKey || (status != m_sentStatus && now - m_lastStatusPush >= DSH_PING_REFRESH_MS))
        {
         if(!Send(DshEventFrame("system.status", status)))
            return;
         m_sentStatusKey = key;
         m_sentStatus = status;
         m_lastStatusPush = now;
        }
      string account = DshAccountPayload();
      if(account != m_sentAccount)
        {
         if(!Send(DshEventFrame("account.snapshot", account)))
            return;
         m_sentAccount = account;
        }
      if(m_sentPositions != "")
        {
         string positions = DshPositionsPayload();
         if(positions != m_sentPositions)
           {
            if(!Send(DshEventFrame("positions.snapshot", positions)))
               return;
            m_sentPositions = positions;
           }
        }
      if(m_sentOrders != "")
        {
         string orders = DshOrdersPayload();
         if(orders != m_sentOrders)
           {
            if(!Send(DshEventFrame("orders.snapshot", orders)))
               return;
            m_sentOrders = orders;
           }
        }
     }

   //--- Every cycle: queued trade events, then the quotes and bars that changed.
   void              PushMarket(void)
     {
      int queued = ArraySize(m_trades);
      for(int i = 0; i < queued; i++)
         if(!Send(DshEventFrame("trade.event", m_trades[i])))
            return;
      ArrayResize(m_trades, 0);
      string ticks = m_market.ScanQuotes();
      if(ticks != "" && !Send(DshEventFrame("market.tick", ticks)))
         return;
      string bars = m_market.ScanBars();
      if(bars != "")
         Send(DshEventFrame("market.bar", bars));
     }

public:
                     CDshBridge(void) :
                     m_host(""), m_port(0), m_token(""), m_state(DSH_STATE_IDLE), m_nextAttempt(0), m_backoff(DSH_BACKOFF_MIN_MS), m_connectedAt(0),
                     m_lastReceived(0), m_lastSent(0), m_lastCompare(0), m_lastStatusPush(0), m_heartbeatMs(5000), m_idleMs(15000),
                     m_helloId(""), m_sequence(0), m_sentStatusKey(""), m_sentStatus(""), m_sentAccount(""), m_sentPositions(""), m_sentOrders(""),
                     m_dirty(true), m_shown(""), m_failure("") {}

   void              Configure(const string host, const uint port, const string token)
     {
      m_host = host;
      m_port = port;
      m_token = token;
      m_state = DSH_STATE_IDLE;
      m_nextAttempt = 0;
      m_backoff = DSH_BACKOFF_MIN_MS;
     }

   //--- A trade transaction: the account, positions or orders changed, so compare on the next
   //--- tick instead of waiting; a new deal or history order is also announced as trade.event.
   void              OnTrade(const MqlTradeTransaction &trans)
     {
      m_dirty = true;
      string kind = "";
      if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
         kind = "deal_add";
      else if(trans.type == TRADE_TRANSACTION_HISTORY_ADD)
         kind = "history_add";
      if(kind == "" || m_state != DSH_STATE_READY || ArraySize(m_trades) >= DSH_TRADE_QUEUE_MAX)
         return;
      CDshJsonObject event;
      event.Str("type", kind);
      event.Str("deal", IntegerToString((long)trans.deal));
      event.Str("order", IntegerToString((long)trans.order));
      event.Str("position", IntegerToString((long)trans.position));
      event.Str("symbol", trans.symbol);
      int size = ArraySize(m_trades);
      ArrayResize(m_trades, size + 1);
      m_trades[size] = event.Text();
     }

   void              Tick(void)
     {
      ulong now = GetTickCount64();
      if(m_state == DSH_STATE_IDLE)
        {
         if(now >= m_nextAttempt)
            Connect(now);
         return;
        }
      string lines[];
      int count = m_transport.ReadLines(lines);
      if(count < 0)
        {
         Drop(m_transport.Error());
         return;
        }
      for(int i = 0; i < count && m_state != DSH_STATE_IDLE; i++)
         OnLine(lines[i]);
      if(m_state == DSH_STATE_IDLE)
         return;
      now = GetTickCount64();
      if(m_state == DSH_STATE_HELLO)
        {
         if(now - m_connectedAt > DSH_HELLO_TIMEOUT_MS)
            Drop("The Desktop did not answer the hello");
         return;
        }
      if(now - m_lastReceived > m_idleMs)
        {
         Drop("The Desktop went silent");
         return;
        }
      if(now - m_lastSent >= m_heartbeatMs)
        {
         CDshJsonObject ping;
         ping.Int("time", DshNowMs());
         if(!Send(DshEventFrame("system.ping", ping.Text())))
            return;
        }
      if(m_dirty || now - m_lastCompare >= DSH_COMPARE_MS)
         PushChanges(now);
      if(m_state == DSH_STATE_READY)
         PushMarket();
     }

   void              Shutdown(void)
     {
      m_transport.Close();
      m_state = DSH_STATE_IDLE;
      Comment("");
     }
  };
//+------------------------------------------------------------------+
