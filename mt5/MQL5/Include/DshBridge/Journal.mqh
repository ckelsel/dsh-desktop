//+------------------------------------------------------------------+
//| DshBridge request journal, MQL5\Files\DshBridge\requests.log:    |
//| JSON lines in UTF-8. The first line names the EA instance that    |
//| owns the journal and since when it is complete; every other line  |
//| is a trade request's state. "sending" reaches the disk before     |
//| OrderSend and the outcome after it, so no request id runs twice,  |
//| and a restart knows which request it may have left half done.     |
//| A new or unreadable journal gets a new instance id: the Desktop   |
//| trusts "no such request" only from the instance that got it.     |
//| The EA keeps the file open, so a second DshBridge in the same     |
//| terminal cannot open it and stays offline.                        |
//+------------------------------------------------------------------+
#include <Generic\HashMap.mqh>
#include "Json.mqh"
#include "Protocol.mqh"
#include "Crypto.mqh"

#define DSH_JOURNAL_FOLDER  "DshBridge"
#define DSH_JOURNAL_FILE    "DshBridge\\requests.log"
#define DSH_JOURNAL_TEMP    "DshBridge\\requests.tmp"
#define DSH_JOURNAL_BAD     "DshBridge\\requests.bad"
#define DSH_JOURNAL_VERSION 1
//--- Requests kept when the journal is rewritten, and the length that triggers it.
#define DSH_JOURNAL_KEEP    1000
#define DSH_JOURNAL_COMPACT 2000

class CDshJournal
  {
private:
   int                      m_handle;
   string                   m_instance;
   //--- Unix ms; requests that reached the EA before it may be missing from the journal.
   long                     m_since;
   int                      m_lines;
   //--- The file ends inside a line that a crash cut short; the next line starts on its own.
   bool                     m_torn;
   //--- The file exists but could not be opened: another DshBridge holds it.
   bool                     m_inUse;
   CHashMap<string, string> m_records;
   //--- Request ids, oldest first.
   string                   m_order[];
   string                   m_error;

   string            Header(void) const
     {
      CDshJsonObject header;
      header.Int("journal", DSH_JOURNAL_VERSION);
      header.Str("instance", m_instance);
      header.Int("since", m_since);
      return header.Text();
     }

   //--- Keep `line` as the latest state of request `id`.
   void              Index(const string id, const string line)
     {
      if(m_records.ContainsKey(id))
        {
         m_records.TrySetValue(id, line);
         return;
        }
      m_records.Add(id, line);
      int size = ArraySize(m_order);
      ArrayResize(m_order, size + 1, 256);
      m_order[size] = id;
     }

   //--- Write `text` as UTF-8 at the file position of `handle`.
   static bool       Write(const int handle, const string text)
     {
      uchar bytes[];
      DshUtf8(text, bytes);
      int size = ArraySize(bytes);
      return size > 0 && FileWriteArray(handle, bytes, 0, size) == (uint)size;
     }

   bool              Append(const string line)
     {
      if(m_handle == INVALID_HANDLE)
        {
         // Keep the reason it could not be opened.
         if(m_error == "")
            m_error = "the request journal is not open";
         return false;
        }
      ResetLastError();
      if(!FileSeek(m_handle, 0, SEEK_END) || !Write(m_handle, (m_torn ? "\r\n" : "") + line + "\r\n"))
        {
         m_error = "cannot write the request journal, error " + IntegerToString(GetLastError());
         // Part of the line may have reached the file.
         m_torn = true;
         return false;
        }
      FileFlush(m_handle);
      m_torn = false;
      m_lines++;
      return true;
     }

   bool              OpenForAppend(void)
     {
      ResetLastError();
      m_handle = FileOpen(DSH_JOURNAL_FILE, FILE_READ | FILE_WRITE | FILE_BIN | FILE_SHARE_READ);
      if(m_handle == INVALID_HANDLE)
        {
         m_error = "cannot open " + DSH_JOURNAL_FILE + " for writing, error " + IntegerToString(GetLastError());
         return false;
        }
      return true;
     }

   //--- A new journal and instance. It knows no earlier request.
   bool              Create(void)
     {
      m_instance = DshNonce();
      m_since = DshNowMs();
      m_records.Clear();
      ArrayResize(m_order, 0);
      m_lines = 0;
      m_torn = false;
      FolderCreate(DSH_JOURNAL_FOLDER);
      ResetLastError();
      int handle = FileOpen(DSH_JOURNAL_FILE, FILE_WRITE | FILE_BIN);
      if(handle == INVALID_HANDLE)
        {
         m_error = "cannot create " + DSH_JOURNAL_FILE + ", error " + IntegerToString(GetLastError());
         return false;
        }
      bool written = Write(handle, Header() + "\r\n");
      FileClose(handle);
      if(!written)
        {
         m_error = "cannot write " + DSH_JOURNAL_FILE;
         return false;
        }
      return OpenForAppend();
     }

   //--- Read the journal: 1 when read, 0 when missing or not a journal, -1 when it cannot be opened.
   int               Load(void)
     {
      if(!FileIsExist(DSH_JOURNAL_FILE))
         return 0;
      ResetLastError();
      int handle = FileOpen(DSH_JOURNAL_FILE, FILE_READ | FILE_BIN | FILE_SHARE_READ);
      if(handle == INVALID_HANDLE)
        {
         m_inUse = true;
         m_error = "cannot open " + DSH_JOURNAL_FILE + ", error " + IntegerToString(GetLastError())
                   + ": DshBridge may already run on another chart of this terminal";
         return -1;
        }
      uchar data[];
      int size = (int)FileSize(handle);
      int length = size > 0 ? (int)FileReadArray(handle, data, 0, size) : 0;
      FileClose(handle);
      if(length != size)
        {
         m_error = "cannot read " + DSH_JOURNAL_FILE;
         return -1;
        }
      int start = 0;
      // A byte order mark, if an editor saved the file.
      if(length >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF)
         start = 3;
      bool header = false;
      for(int i = start; i <= length; i++)
        {
         if(i < length && data[i] != '\n')
            continue;
         int end = i;
         // Bytes after the last line break: a write that a crash cut short, before OrderSend.
         if(i == length && end > start)
            m_torn = true;
         if(end > start && data[end - 1] == '\r')
            end--;
         string line = end > start ? CharArrayToString(data, start, end - start, CP_UTF8) : "";
         start = i + 1;
         if(line == "")
            continue;
         CDshJson json;
         string error;
         bool parsed = json.Parse(line, error) && json.IsObject();
         if(!header)
           {
            string instance = parsed ? json.GetString("instance") : "";
            if(!parsed || json.GetNumber("journal") != DSH_JOURNAL_VERSION || !DshIsHex32(instance))
               return 0;
            m_instance = instance;
            m_since = (long)json.GetNumber("since");
            header = true;
            continue;
           }
         string id = parsed ? json.GetString("id") : "";
         if(id == "")
            continue;
         Index(id, line);
         m_lines++;
        }
      return header ? 1 : 0;
     }

   //--- Requests an earlier run left at "sending" stopped inside OrderSend: their outcome is unknown.
   void              SettleInterrupted(void)
     {
      string pending[];
      for(int i = 0; i < ArraySize(m_order); i++)
        {
         string line = "";
         if(!m_records.TryGetValue(m_order[i], line))
            continue;
         CDshJson json;
         string error;
         if(!json.Parse(line, error) || json.GetString("state") != "sending")
            continue;
         int size = ArraySize(pending);
         ArrayResize(pending, size + 1);
         pending[size] = m_order[i];
        }
      for(int i = 0; i < ArraySize(pending); i++)
        {
         CDshJsonObject result;
         result.Str("status", "unknown");
         result.Int("retcode", 0);
         result.Str("code", "interrupted");
         result.Str("message", "The EA stopped while MT5 executed this request; check the positions and the history");
         Finish(pending[i], "unknown", result.Text());
        }
     }

   //--- Rewrite the journal with its newest requests once it grows long. Requests that reached the
   //--- EA before the rewrite may be gone from it afterwards, so the header's `since` moves to now.
   void              Compact(void)
     {
      int total = ArraySize(m_order);
      if(m_handle == INVALID_HANDLE || m_lines <= DSH_JOURNAL_COMPACT || total == 0)
         return;
      int start = MathMax(0, total - DSH_JOURNAL_KEEP);
      long previous = m_since;
      m_since = DshNowMs();
      ResetLastError();
      int handle = FileOpen(DSH_JOURNAL_TEMP, FILE_WRITE | FILE_BIN);
      bool written = handle != INVALID_HANDLE && Write(handle, Header() + "\r\n");
      for(int i = start; written && i < total; i++)
        {
         string line = "";
         if(m_records.TryGetValue(m_order[i], line))
            written = Write(handle, line + "\r\n");
        }
      int error = GetLastError();
      if(handle != INVALID_HANDLE)
         FileClose(handle);
      if(!written)
        {
         m_since = previous;
         FileDelete(DSH_JOURNAL_TEMP);
         Print("DshBridge: cannot rewrite the request journal, error ", error);
         return;
        }
      FileClose(m_handle);
      m_handle = INVALID_HANDLE;
      ResetLastError();
      if(!FileMove(DSH_JOURNAL_TEMP, 0, DSH_JOURNAL_FILE, FILE_REWRITE))
        {
         m_since = previous;
         Print("DshBridge: cannot replace the request journal, error ", GetLastError());
         FileDelete(DSH_JOURNAL_TEMP);
         OpenForAppend();
         return;
        }
      string kept[];
      ArrayResize(kept, total - start);
      for(int i = 0; i < total; i++)
        {
         if(i < start)
            m_records.Remove(m_order[i]);
         else
            kept[i - start] = m_order[i];
        }
      ArrayFree(m_order);
      ArrayCopy(m_order, kept);
      m_lines = total - start;
      m_torn = false;
      OpenForAppend();
     }

public:
                     CDshJournal(void) : m_handle(INVALID_HANDLE), m_instance(""), m_since(0), m_lines(0), m_torn(false), m_inUse(false), m_error("") {}
                    ~CDshJournal(void) { Close(); }

   //--- Open the journal, or start one. False when it cannot be written: the EA then refuses
   //--- trades, under an instance of its own that knows only the requests this run sees.
   bool              Open(void)
     {
      Close();
      m_records.Clear();
      ArrayResize(m_order, 0);
      m_lines = 0;
      m_torn = false;
      m_inUse = false;
      m_error = "";
      m_instance = "";
      m_since = 0;
      bool open = false;
      int loaded = Load();
      if(loaded > 0)
         open = OpenForAppend();
      else
         if(loaded == 0)
           {
            // A file that is not a journal stays for inspection, and a new instance starts.
            ResetLastError();
            if(FileIsExist(DSH_JOURNAL_FILE) && !FileMove(DSH_JOURNAL_FILE, 0, DSH_JOURNAL_BAD, FILE_REWRITE))
               m_error = "cannot set aside the unreadable " + DSH_JOURNAL_FILE + ", error " + IntegerToString(GetLastError());
            else
               open = Create();
           }
      if(!open)
        {
         Close();
         m_instance = DshNonce();
         m_since = DshNowMs();
        }
      SettleInterrupted();
      Compact();
      return open;
     }

   bool              IsOpen(void) const { return m_handle != INVALID_HANDLE; }
   bool              InUse(void) const { return m_inUse; }
   string            Instance(void) const { return m_instance; }
   long              Since(void) const { return m_since; }
   string            Error(void) const { return m_error; }

   //--- The state of request `id` ("sending", "done" or "unknown") and its result as JSON, "" while
   //--- it is sending. False when the journal does not have it.
   bool              Lookup(const string id, string &state, string &result)
     {
      state = "";
      result = "";
      string line = "";
      if(!m_records.TryGetValue(id, line))
         return false;
      CDshJson json;
      string error;
      state = json.Parse(line, error) ? json.GetString("state") : "unknown";
      // Finish writes the result last; the body of a "sending" line is a string, whose quotes are escaped.
      int at = StringFind(line, ",\"result\":");
      if(at >= 0)
         result = StringSubstr(line, at + 10, StringLen(line) - at - 11);
      return true;
     }

   //--- Before OrderSend. False when the line did not reach the file: the request must not be sent.
   bool              Begin(const string id, const string type, const string body)
     {
      CDshJsonObject record;
      record.Str("id", id);
      record.Str("state", "sending");
      record.Str("type", type);
      record.Int("at", DshNowMs());
      record.Str("body", body);
      string line = record.Text();
      if(!Append(line))
         return false;
      Index(id, line);
      return true;
     }

   //--- The outcome: "done" with the result, or "unknown" when MT5 could not tell. It is kept in
   //--- memory even if the file refuses it, so this run still answers a repeated id correctly.
   bool              Finish(const string id, const string state, const string result)
     {
      CDshJsonObject record;
      record.Str("id", id);
      record.Str("state", state);
      record.Int("at", DshNowMs());
      record.Raw("result", result);
      string line = record.Text();
      Index(id, line);
      bool written = Append(line);
      Compact();
      return written;
     }

   void              Close(void)
     {
      if(m_handle != INVALID_HANDLE)
         FileClose(m_handle);
      m_handle = INVALID_HANDLE;
     }
  };
//+------------------------------------------------------------------+
