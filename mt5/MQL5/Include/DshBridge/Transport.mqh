//+------------------------------------------------------------------+
//| DshBridge transport: one TLS connection to the Desktop, framed as |
//| UTF-8 lines. Reads never block: the timer polls for whatever the  |
//| connection holds and returns the lines it completes.              |
//| The terminal accepts any certificate, so TLS alone only encrypts. |
//| The handshake authenticates the Desktop: its proof binds the      |
//| fingerprint of the certificate seen here (mt5/PROTOCOL.md).       |
//+------------------------------------------------------------------+
#include "Crypto.mqh"

#define DSH_MAX_LINE_BYTES  (2 * 1024 * 1024)
#define DSH_SEND_TIMEOUT_MS 5000
#define DSH_READ_CHUNK      1048576

class CDshTransport
  {
private:
   int               m_socket;
   uchar             m_pending[];
   int               m_pendingLength;
   string            m_error;
   //--- SHA-1 of the Desktop certificate, lowercase hex.
   string            m_fingerprint;
   //--- The connection ended behind the lines the last read returned; the next read reports it.
   bool              m_ended;

   void              Keep(const uchar &bytes[], const int start, const int count)
     {
      if(count <= 0)
         return;
      ArrayResize(m_pending, m_pendingLength + count, 4096);
      ArrayCopy(m_pending, bytes, m_pendingLength, start, count);
      m_pendingLength += count;
     }

public:
                     CDshTransport(void) : m_socket(INVALID_HANDLE), m_pendingLength(0), m_error(""), m_fingerprint(""), m_ended(false) {}
                    ~CDshTransport(void) { Close(); }

   bool              IsOpen(void) const { return m_socket != INVALID_HANDLE; }
   string            Error(void) const { return m_error; }
   string            Fingerprint(void) const { return m_fingerprint; }

   //--- Connect and secure the connection, waiting at most `timeoutMs` for the TCP connect.
   //--- Sets Error() on failure.
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
      string address = host + ":" + IntegerToString(port);
      if(!SocketConnect(m_socket, host, port, timeoutMs))
        {
         int code = GetLastError();
         if(code == 4014)
            m_error = "The terminal does not allow this address: add " + host + " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL";
         else
            m_error = "Cannot connect to " + address + ", error " + IntegerToString(code);
         Close();
         return false;
        }
      SocketTimeouts(m_socket, DSH_SEND_TIMEOUT_MS, DSH_SEND_TIMEOUT_MS);
      ResetLastError();
      if(!SocketTlsHandshake(m_socket, host))
        {
         m_error = "TLS handshake with " + address + " failed, error " + IntegerToString(GetLastError())
                   + ": DSH Desktop may be older than this EA, or another program uses the port";
         Close();
         return false;
        }
      string subject = "";
      string issuer = "";
      string serial = "";
      string thumbprint = "";
      datetime expiration = 0;
      ResetLastError();
      if(!SocketTlsCertificate(m_socket, subject, issuer, serial, thumbprint, expiration))
        {
         m_error = "Cannot read the Desktop's certificate, error " + IntegerToString(GetLastError());
         Close();
         return false;
        }
      string fingerprint = DshHexDigits(thumbprint);
      if(StringLen(fingerprint) != 40)
        {
         m_error = "The Desktop's certificate has no SHA-1 thumbprint";
         Close();
         return false;
        }
      m_fingerprint = fingerprint;
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
      m_fingerprint = "";
      m_ended = false;
     }

   //--- Send one frame as a line. Returns false, and closes, when the connection fails.
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
         int written = sent == 0 ? SocketTlsSend(m_socket, bytes, (uint)count) : SocketTlsSend(m_socket, rest, (uint)count);
         if(written <= 0)
           {
            m_error = "Sending to the Desktop failed, error " + IntegerToString(GetLastError());
            Close();
            return false;
           }
         sent += written;
        }
      return true;
     }

   //--- Read what the connection holds. Returns the number of complete lines in `lines`, or -1
   //--- when the connection is gone or broke the frame limit (Error() says which). Lines that
   //--- arrived just before the Desktop closed are returned first: they may say why it closed.
   int               ReadLines(string &lines[])
     {
      ArrayResize(lines, 0);
      if(m_socket == INVALID_HANDLE)
         return -1;
      if(m_ended)
        {
         Close();
         return -1;
        }
      int count = 0;
      while(true)
        {
         uchar chunk[];
         ResetLastError();
         int read = SocketTlsReadAvailable(m_socket, chunk, DSH_READ_CHUNK);
         int code = GetLastError();
         bool connected = SocketIsConnected(m_socket);
         if(read == 0 && connected)
            return count;
         if(read <= 0)
           {
            // The terminal reports the Desktop's close as a failed read (error 5273).
            m_error = !connected ? "The Desktop closed the connection" : "Reading from the Desktop failed, error " + IntegerToString(code);
            if(count > 0)
              {
               m_ended = true;
               return count;
              }
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
