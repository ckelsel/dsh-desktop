//+------------------------------------------------------------------+
//| DshBridge transport: one TCP connection to the Desktop, framed as |
//| UTF-8 lines. Reads never block: the timer polls for whatever the  |
//| socket holds and returns the lines it completes.                  |
//+------------------------------------------------------------------+

#define DSH_MAX_LINE_BYTES  (2 * 1024 * 1024)
#define DSH_SEND_TIMEOUT_MS 5000

class CDshTransport
  {
private:
   int               m_socket;
   uchar             m_pending[];
   int               m_pendingLength;
   string            m_error;

   void              Keep(const uchar &bytes[], const int start, const int count)
     {
      if(count <= 0)
         return;
      ArrayResize(m_pending, m_pendingLength + count, 4096);
      ArrayCopy(m_pending, bytes, m_pendingLength, start, count);
      m_pendingLength += count;
     }

public:
                     CDshTransport(void) : m_socket(INVALID_HANDLE), m_pendingLength(0), m_error("") {}
                    ~CDshTransport(void) { Close(); }

   bool              IsOpen(void) const { return m_socket != INVALID_HANDLE; }
   string            Error(void) const { return m_error; }

   //--- Connect, waiting at most `timeoutMs`. Sets Error() on failure.
   bool              Connect(const string host, const uint port, const uint timeoutMs)
     {
      Close();
      ResetLastError();
      m_socket = SocketCreate();
      if(m_socket == INVALID_HANDLE)
        {
         m_error = "SocketCreate failed, error " + IntegerToString(GetLastError());
         return false;
        }
      if(!SocketConnect(m_socket, host, port, timeoutMs))
        {
         int code = GetLastError();
         if(code == 4014)
            m_error = "The terminal does not allow this address: add " + host + " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL";
         else
            m_error = "Cannot connect to " + host + ":" + IntegerToString(port) + ", error " + IntegerToString(code);
         Close();
         return false;
        }
      SocketTimeouts(m_socket, DSH_SEND_TIMEOUT_MS, DSH_SEND_TIMEOUT_MS);
      m_error = "";
      return true;
     }

   void              Close(void)
     {
      if(m_socket != INVALID_HANDLE)
         SocketClose(m_socket);
      m_socket = INVALID_HANDLE;
      ArrayResize(m_pending, 0);
      m_pendingLength = 0;
     }

   //--- Send one frame as a line. Returns false, and closes, when the socket fails.
   bool              SendLine(const string json)
     {
      if(m_socket == INVALID_HANDLE)
         return false;
      uchar bytes[];
      // StringToCharArray copies the terminating zero, which the newline replaces.
      int length = StringToCharArray(json, bytes, 0, WHOLE_ARRAY, CP_UTF8);
      if(length <= 0)
         return true;
      bytes[length - 1] = '\n';
      int sent = 0;
      while(sent < length)
        {
         uchar rest[];
         int count = length - sent;
         if(sent > 0)
            ArrayCopy(rest, bytes, 0, sent, count);
         ResetLastError();
         int written = sent == 0 ? SocketSend(m_socket, bytes, (uint)count) : SocketSend(m_socket, rest, (uint)count);
         if(written <= 0)
           {
            m_error = "SocketSend failed, error " + IntegerToString(GetLastError());
            Close();
            return false;
           }
         sent += written;
        }
      return true;
     }

   //--- Read what the socket holds. Returns the number of complete lines in `lines`,
   //--- or -1 when the connection is gone or broke the frame limit (Error() says which).
   int               ReadLines(string &lines[])
     {
      ArrayResize(lines, 0);
      if(m_socket == INVALID_HANDLE)
         return -1;
      int count = 0;
      while(true)
        {
         uint available = SocketIsReadable(m_socket);
         if(available == 0)
           {
            if(!SocketIsConnected(m_socket))
              {
               m_error = "The Desktop closed the connection";
               Close();
               return -1;
              }
            return count;
           }
         uchar chunk[];
         ResetLastError();
         int read = SocketRead(m_socket, chunk, available, 100);
         if(read <= 0)
           {
            m_error = "SocketRead failed, error " + IntegerToString(GetLastError());
            Close();
            return -1;
           }
         int start = 0;
         for(int i = 0; i < read; i++)
           {
            if(chunk[i] != '\n')
               continue;
            Keep(chunk, start, i - start);
            start = i + 1;
            int length = m_pendingLength;
            if(length > 0 && m_pending[length - 1] == '\r')
               length--;
            if(length > 0)
              {
               ArrayResize(lines, count + 1, 16);
               lines[count++] = CharArrayToString(m_pending, 0, length, CP_UTF8);
              }
            ArrayResize(m_pending, 0, 4096);
            m_pendingLength = 0;
           }
         Keep(chunk, start, read - start);
         if(m_pendingLength > DSH_MAX_LINE_BYTES)
           {
            m_error = "A Desktop frame exceeded " + IntegerToString(DSH_MAX_LINE_BYTES) + " bytes";
            Close();
            return -1;
           }
        }
      return count;
     }
  };
//+------------------------------------------------------------------+
