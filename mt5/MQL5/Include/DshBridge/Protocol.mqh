//+------------------------------------------------------------------+
//| DshBridge protocol v1 envelopes (mt5/PROTOCOL.md).               |
//|   request  {"v":1,"id":...,"type":...,"payload":{...}}                 |
//|   response {"v":1,"id":...,"type":"response","ok":true,"payload":...}|
//|            {"v":1,"id":...,"type":"response","ok":false,"error":...} |
//|   event    {"v":1,"type":...,"payload":{...}}                        |
//+------------------------------------------------------------------+
#include "Json.mqh"

#define DSH_PROTOCOL_VERSION 1
#define DSH_EA_VERSION       "1.0.0"

string DshRequestFrame(const string id, const string type, const string payloadJson)
  {
   CDshJsonObject frame;
   frame.Int("v", DSH_PROTOCOL_VERSION);
   frame.Str("id", id);
   frame.Str("type", type);
   frame.Raw("payload", payloadJson);
   return frame.Text();
  }

string DshEventFrame(const string type, const string payloadJson)
  {
   CDshJsonObject frame;
   frame.Int("v", DSH_PROTOCOL_VERSION);
   frame.Str("type", type);
   frame.Raw("payload", payloadJson);
   return frame.Text();
  }

string DshOkFrame(const string id, const string payloadJson)
  {
   CDshJsonObject frame;
   frame.Int("v", DSH_PROTOCOL_VERSION);
   frame.Str("id", id);
   frame.Str("type", "response");
   frame.Bool("ok", true);
   frame.Raw("payload", payloadJson);
   return frame.Text();
  }

string DshErrorFrame(const string id, const string code, const string message)
  {
   CDshJsonObject error;
   error.Str("code", code);
   error.Str("message", message);
   CDshJsonObject frame;
   frame.Int("v", DSH_PROTOCOL_VERSION);
   frame.Str("id", id);
   frame.Str("type", "response");
   frame.Bool("ok", false);
   frame.Raw("error", error.Text());
   return frame.Text();
  }

//--- Current UTC time in Unix milliseconds, to the second.
long DshNowMs(void)
  {
   return (long)TimeGMT() * 1000;
  }
//+------------------------------------------------------------------+
