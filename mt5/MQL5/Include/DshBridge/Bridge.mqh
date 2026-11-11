//+------------------------------------------------------------------+
//| DshBridge session: connect to the Desktop, authenticate with      |
//| system.hello, answer the Desktop's requests, ping, and push the   |
//| account state whenever it changes. Everything runs from OnTimer,  |
//| so nothing blocks the terminal beyond one connect attempt.        |
//+------------------------------------------------------------------+
#include "Json.mqh"
#include "Transport.mqh"
#include "Protocol.mqh"
#include "Account.mqh"

#define DSH_CONNECT_TIMEOUT_MS 1000
#define DSH_HELLO_TIMEOUT_MS   10000
//--- A failed connect is retried within 10 s: the Desktop may be restarting, or the terminal's
//--- WebRequest list was just fixed. A refused hello (wrong token, busy) will not change soon.
#define DSH_BACKOFF_MIN_MS     1000
#define DSH_BACKOFF_MAX_MS     10000
#define DSH_REFUSED_RETRY_MS   30000
#define DSH_COMPARE_MS         500
#define DSH_PING_REFRESH_MS    10000

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
   bool              m_dirty;
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

   void              Drop(const string reason)
     {
      bool wasReady = m_state == DSH_STATE_READY;
      m_transport.Close();
      m_state = DSH_STATE_IDLE;
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
      m_sentStatusKey = "";
      m_sentStatus = "";
      m_sentAccount = "";
      PrintFormat("DshBridge: connected to %s:%u as account %I64d on %s", m_host, m_port, AccountInfoInteger(ACCOUNT_LOGIN), AccountInfoString(ACCOUNT_SERVER));
      Show("Connected: account " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + " on " + AccountInfoString(ACCOUNT_SERVER));
     }

   void              OnRequest(const string id, const string type)
     {
      if(m_state != DSH_STATE_READY)
        {
         Send(DshErrorFrame(id, "not_ready", "The EA has not authenticated yet"));
         return;
        }
      if(type == "system.resync")
        {
         // Forget what was pushed, so every later change reaches the Desktop's fresh state.
         m_sentStatusKey = "";
         m_sentStatus = "";
         m_sentAccount = "";
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
      OnRequest(id, type);
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
     }

public:
                     CDshBridge(void) :
                     m_host(""), m_port(0), m_token(""), m_state(DSH_STATE_IDLE), m_nextAttempt(0), m_backoff(DSH_BACKOFF_MIN_MS), m_connectedAt(0),
                     m_lastReceived(0), m_lastSent(0), m_lastCompare(0), m_lastStatusPush(0), m_heartbeatMs(5000), m_idleMs(15000),
                     m_helloId(""), m_sequence(0), m_sentStatusKey(""), m_sentStatus(""), m_sentAccount(""), m_dirty(true), m_shown(""), m_failure("") {}

   void              Configure(const string host, const uint port, const string token)
     {
      m_host = host;
      m_port = port;
      m_token = token;
      m_state = DSH_STATE_IDLE;
      m_nextAttempt = 0;
      m_backoff = DSH_BACKOFF_MIN_MS;
     }

   //--- The account changed; push on the next tick instead of waiting for the comparison.
   void              MarkDirty(void) { m_dirty = true; }

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
     }

   void              Shutdown(void)
     {
      m_transport.Close();
      m_state = DSH_STATE_IDLE;
      Comment("");
     }
  };
//+------------------------------------------------------------------+
