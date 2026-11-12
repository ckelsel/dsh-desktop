//+------------------------------------------------------------------+
//| DshBridge protocol 2 envelopes (mt5/PROTOCOL.md), one per line:   |
//|   request  {"v":2,"id":...,"type":...,"payload":{...}}            |
//|   response {"v":2,"id":...,"type":"response","ok":true,"payload":...}
//|            {"v":2,"id":...,"type":"response","ok":false,"error":...}
//|   event    {"v":2,"type":...,"payload":{...}}                     |
//+------------------------------------------------------------------+
#include "Json.mqh"

#define DSH_PROTOCOL_VERSION 2
#define DSH_EA_VERSION       "1.2.0"

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

//--- An MQL5 enum constant's name without its prefix, in lowercase: SYMBOL_TRADE_MODE_FULL -> full.
string DshEnumWord(const string name, const string prefix)
  {
   string word = name;
   if(StringFind(word, prefix) == 0)
      word = StringSubstr(word, StringLen(prefix));
   StringToLower(word);
   return word;
  }

//--- Decimals of a symbol's prices.
int DshSymbolDigits(const string symbol)
  {
   long digits = SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   return digits >= 0 && digits <= 10 ? (int)digits : 5;
  }

//--- Decimals of the account currency; money fields use them.
int DshMoneyDigits(void)
  {
   long digits = AccountInfoInteger(ACCOUNT_CURRENCY_DIGITS);
   return digits >= 0 && digits <= 8 ? (int)digits : 2;
  }

//--- Request fields. A missing field takes the fallback; a field of another type fails.
bool DshIntegerField(CDshJson *payload, const string key, const long fallback, long &value)
  {
   value = fallback;
   if(payload == NULL)
      return true;
   CDshJson *field = payload.Get(key);
   if(field == NULL)
      return true;
   if(field.Type() != DSH_JSON_NUMBER)
      return false;
   double number = field.Number();
   if(number != MathFloor(number) || MathAbs(number) > 9007199254740991.0)
      return false;
   value = (long)number;
   return true;
  }

bool DshBoolField(CDshJson *payload, const string key, const bool fallback, bool &value)
  {
   value = fallback;
   if(payload == NULL)
      return true;
   CDshJson *field = payload.Get(key);
   if(field == NULL)
      return true;
   if(field.Type() != DSH_JSON_BOOL)
      return false;
   value = field.Bool();
   return true;
  }

//--- A required string field.
bool DshStringField(CDshJson *payload, const string key, string &value)
  {
   value = "";
   if(payload == NULL)
      return false;
   CDshJson *field = payload.Get(key);
   if(field == NULL || field.Type() != DSH_JSON_STRING)
      return false;
   value = field.String();
   return true;
  }
//+------------------------------------------------------------------+
