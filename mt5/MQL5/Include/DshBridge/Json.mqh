//+------------------------------------------------------------------+
//| DshBridge JSON: a small parser for the frames the Desktop sends   |
//| and a builder for the frames the EA sends. Protocol v1 frames are |
//| one JSON object per line (mt5/PROTOCOL.md).                       |
//+------------------------------------------------------------------+
#define DSH_JSON_MAX_DEPTH 32

enum ENUM_DSH_JSON_TYPE
  {
   DSH_JSON_NULL,
   DSH_JSON_BOOL,
   DSH_JSON_NUMBER,
   DSH_JSON_STRING,
   DSH_JSON_ARRAY,
   DSH_JSON_OBJECT
  };

//+------------------------------------------------------------------+
//| A parsed JSON value; arrays and objects own their children.      |
//+------------------------------------------------------------------+
class CDshJson
  {
private:
   ENUM_DSH_JSON_TYPE m_type;
   bool              m_bool;
   double            m_number;
   string            m_text;
   string            m_keys[];
   CDshJson         *m_items[];

public:
                     CDshJson(void) : m_type(DSH_JSON_NULL), m_bool(false), m_number(0.0), m_text("") {}
                    ~CDshJson(void) { Clear(); }

   void              Clear(void)
     {
      for(int i = 0; i < ArraySize(m_items); i++)
         if(CheckPointer(m_items[i]) == POINTER_DYNAMIC)
            delete m_items[i];
      ArrayResize(m_items, 0);
      ArrayResize(m_keys, 0);
      m_type = DSH_JSON_NULL;
      m_bool = false;
      m_number = 0.0;
      m_text = "";
     }

   ENUM_DSH_JSON_TYPE Type(void) const { return m_type; }
   bool              IsObject(void) const { return m_type == DSH_JSON_OBJECT; }
   int               Size(void) const { return ArraySize(m_items); }
   string            KeyAt(const int index) const { return index >= 0 && index < ArraySize(m_keys) ? m_keys[index] : ""; }
   CDshJson         *At(const int index) { return index >= 0 && index < ArraySize(m_items) ? m_items[index] : NULL; }

   void              SetNull(void) { Clear(); }
   void              SetBool(const bool value) { Clear(); m_type = DSH_JSON_BOOL; m_bool = value; }
   void              SetNumber(const double value, const string source) { Clear(); m_type = DSH_JSON_NUMBER; m_number = value; m_text = source; }
   void              SetString(const string value) { Clear(); m_type = DSH_JSON_STRING; m_text = value; }
   void              SetArray(void) { Clear(); m_type = DSH_JSON_ARRAY; }
   void              SetObject(void) { Clear(); m_type = DSH_JSON_OBJECT; }

   //--- Append a child to an array or object; the value takes ownership of it.
   void              Append(const string key, CDshJson *child)
     {
      int size = ArraySize(m_items);
      ArrayResize(m_items, size + 1);
      ArrayResize(m_keys, size + 1);
      m_items[size] = child;
      m_keys[size] = key;
     }

   //--- An object member, or NULL; the last of duplicate keys wins.
   CDshJson         *Get(const string key)
     {
      if(m_type != DSH_JSON_OBJECT)
         return NULL;
      for(int i = ArraySize(m_keys) - 1; i >= 0; i--)
         if(m_keys[i] == key)
            return m_items[i];
      return NULL;
     }

   bool              Has(const string key) { return Get(key) != NULL; }

   string            String(const string fallback = "") const { return m_type == DSH_JSON_STRING ? m_text : fallback; }
   double            Number(const double fallback = 0.0) const { return m_type == DSH_JSON_NUMBER ? m_number : fallback; }
   bool              Bool(const bool fallback = false) const { return m_type == DSH_JSON_BOOL ? m_bool : fallback; }

   string            GetString(const string key, const string fallback = "")
     {
      CDshJson *value = Get(key);
      return value == NULL ? fallback : value.String(fallback);
     }
   double            GetNumber(const string key, const double fallback = 0.0)
     {
      CDshJson *value = Get(key);
      return value == NULL ? fallback : value.Number(fallback);
     }
   bool              GetBool(const string key, const bool fallback = false)
     {
      CDshJson *value = Get(key);
      return value == NULL ? fallback : value.Bool(fallback);
     }

   //--- Parse `text` into this value. Returns false, with `error` set, on invalid JSON.
   bool              Parse(const string text, string &error);
  };

//+------------------------------------------------------------------+
//| Recursive descent parser over the UTF-16 code units of a string. |
//+------------------------------------------------------------------+
class CDshJsonParser
  {
private:
   ushort            m_chars[];
   int               m_length;
   int               m_pos;
   string            m_error;

   void              SkipSpace(void)
     {
      while(m_pos < m_length)
        {
         ushort c = m_chars[m_pos];
         if(c != ' ' && c != '\t' && c != '\n' && c != '\r')
            break;
         m_pos++;
        }
     }

   bool              Fail(const string message)
     {
      if(m_error == "")
         m_error = message + " at " + IntegerToString(m_pos);
      return false;
     }

   bool              Literal(const string word)
     {
      int length = StringLen(word);
      if(m_pos + length > m_length)
         return false;
      for(int i = 0; i < length; i++)
         if(m_chars[m_pos + i] != StringGetCharacter(word, i))
            return false;
      m_pos += length;
      return true;
     }

   static int        HexValue(const ushort c)
     {
      if(c >= '0' && c <= '9')
         return c - '0';
      if(c >= 'a' && c <= 'f')
         return c - 'a' + 10;
      if(c >= 'A' && c <= 'F')
         return c - 'A' + 10;
      return -1;
     }

   bool              ParseString(string &out)
     {
      // The caller has seen the opening quote.
      m_pos++;
      out = "";
      int run = m_pos;
      while(m_pos < m_length)
        {
         ushort c = m_chars[m_pos];
         if(c == '"')
           {
            if(m_pos > run)
               StringAdd(out, ShortArrayToString(m_chars, run, m_pos - run));
            m_pos++;
            return true;
           }
         if(c < 0x20)
            return Fail("control character in string");
         if(c != '\\')
           {
            m_pos++;
            continue;
           }
         if(m_pos > run)
            StringAdd(out, ShortArrayToString(m_chars, run, m_pos - run));
         m_pos++;
         if(m_pos >= m_length)
            return Fail("unterminated escape");
         ushort e = m_chars[m_pos];
         m_pos++;
         switch(e)
           {
            case '"':
               StringAdd(out, "\"");
               break;
            case '\\':
               StringAdd(out, "\\");
               break;
            case '/':
               StringAdd(out, "/");
               break;
            case 'b':
               StringAdd(out, ShortToString(0x08));
               break;
            case 'f':
               StringAdd(out, ShortToString(0x0C));
               break;
            case 'n':
               StringAdd(out, "\n");
               break;
            case 'r':
               StringAdd(out, "\r");
               break;
            case 't':
               StringAdd(out, "\t");
               break;
            case 'u':
              {
               if(m_pos + 4 > m_length)
                  return Fail("short unicode escape");
               int code = 0;
               for(int i = 0; i < 4; i++)
                 {
                  int digit = HexValue(m_chars[m_pos + i]);
                  if(digit < 0)
                     return Fail("invalid unicode escape");
                  code = code * 16 + digit;
                 }
               m_pos += 4;
               // MQL5 strings are UTF-16, so surrogate pairs pass through unit by unit.
               StringAdd(out, ShortToString((ushort)code));
               break;
              }
            default:
               return Fail("invalid escape");
           }
         run = m_pos;
        }
      return Fail("unterminated string");
     }

   bool              ParseNumber(CDshJson *value)
     {
      int start = m_pos;
      if(m_pos < m_length && m_chars[m_pos] == '-')
         m_pos++;
      int digits = 0;
      while(m_pos < m_length && m_chars[m_pos] >= '0' && m_chars[m_pos] <= '9')
        {
         m_pos++;
         digits++;
        }
      if(digits == 0)
         return Fail("invalid number");
      if(m_pos < m_length && m_chars[m_pos] == '.')
        {
         m_pos++;
         int fraction = 0;
         while(m_pos < m_length && m_chars[m_pos] >= '0' && m_chars[m_pos] <= '9')
           {
            m_pos++;
            fraction++;
           }
         if(fraction == 0)
            return Fail("invalid number");
        }
      if(m_pos < m_length && (m_chars[m_pos] == 'e' || m_chars[m_pos] == 'E'))
        {
         m_pos++;
         if(m_pos < m_length && (m_chars[m_pos] == '+' || m_chars[m_pos] == '-'))
            m_pos++;
         int exponent = 0;
         while(m_pos < m_length && m_chars[m_pos] >= '0' && m_chars[m_pos] <= '9')
           {
            m_pos++;
            exponent++;
           }
         if(exponent == 0)
            return Fail("invalid number");
        }
      string source = ShortArrayToString(m_chars, start, m_pos - start);
      value.SetNumber(StringToDouble(source), source);
      return true;
     }

   bool              ParseValue(CDshJson *value, const int depth)
     {
      if(depth > DSH_JSON_MAX_DEPTH)
         return Fail("nesting too deep");
      SkipSpace();
      if(m_pos >= m_length)
         return Fail("unexpected end");
      ushort c = m_chars[m_pos];
      if(c == '{')
         return ParseObject(value, depth);
      if(c == '[')
         return ParseArray(value, depth);
      if(c == '"')
        {
         string text;
         if(!ParseString(text))
            return false;
         value.SetString(text);
         return true;
        }
      if(c == '-' || (c >= '0' && c <= '9'))
         return ParseNumber(value);
      if(Literal("true"))
        {
         value.SetBool(true);
         return true;
        }
      if(Literal("false"))
        {
         value.SetBool(false);
         return true;
        }
      if(Literal("null"))
        {
         value.SetNull();
         return true;
        }
      return Fail("unexpected character");
     }

   bool              ParseArray(CDshJson *value, const int depth)
     {
      value.SetArray();
      m_pos++;
      SkipSpace();
      if(m_pos < m_length && m_chars[m_pos] == ']')
        {
         m_pos++;
         return true;
        }
      while(true)
        {
         CDshJson *child = new CDshJson();
         value.Append("", child);
         if(!ParseValue(child, depth + 1))
            return false;
         SkipSpace();
         if(m_pos >= m_length)
            return Fail("unterminated array");
         ushort c = m_chars[m_pos++];
         if(c == ']')
            return true;
         if(c != ',')
            return Fail("expected , or ]");
        }
      return false;
     }

   bool              ParseObject(CDshJson *value, const int depth)
     {
      value.SetObject();
      m_pos++;
      SkipSpace();
      if(m_pos < m_length && m_chars[m_pos] == '}')
        {
         m_pos++;
         return true;
        }
      while(true)
        {
         SkipSpace();
         if(m_pos >= m_length || m_chars[m_pos] != '"')
            return Fail("expected a key");
         string key;
         if(!ParseString(key))
            return false;
         SkipSpace();
         if(m_pos >= m_length || m_chars[m_pos] != ':')
            return Fail("expected :");
         m_pos++;
         CDshJson *child = new CDshJson();
         value.Append(key, child);
         if(!ParseValue(child, depth + 1))
            return false;
         SkipSpace();
         if(m_pos >= m_length)
            return Fail("unterminated object");
         ushort c = m_chars[m_pos++];
         if(c == '}')
            return true;
         if(c != ',')
            return Fail("expected , or }");
        }
      return false;
     }

public:
   bool              Run(const string text, CDshJson *value, string &error)
     {
      m_error = "";
      m_pos = 0;
      m_length = StringLen(text);
      StringToShortArray(text, m_chars);
      bool ok = ParseValue(value, 0);
      if(ok)
        {
         SkipSpace();
         if(m_pos != m_length)
            ok = Fail("trailing characters");
        }
      if(!ok)
         value.Clear();
      error = m_error;
      return ok;
     }
  };

bool CDshJson::Parse(const string text, string &error)
  {
   CDshJsonParser parser;
   return parser.Run(text, GetPointer(this), error);
  }

//+------------------------------------------------------------------+
//| Writing                                                          |
//+------------------------------------------------------------------+

//--- `value` as a JSON string literal.
string DshJsonQuote(const string value)
  {
   ushort chars[];
   int length = StringLen(value);
   StringToShortArray(value, chars);
   string out = "\"";
   int run = 0;
   for(int i = 0; i < length; i++)
     {
      ushort c = chars[i];
      string escape = "";
      if(c == '"')
         escape = "\\\"";
      else if(c == '\\')
         escape = "\\\\";
      else if(c == '\n')
         escape = "\\n";
      else if(c == '\r')
         escape = "\\r";
      else if(c == '\t')
         escape = "\\t";
      else if(c < 0x20)
         escape = StringFormat("\\u%04x", c);
      else
         continue;
      if(i > run)
         StringAdd(out, ShortArrayToString(chars, run, i - run));
      StringAdd(out, escape);
      run = i + 1;
     }
   if(length > run)
      StringAdd(out, ShortArrayToString(chars, run, length - run));
   StringAdd(out, "\"");
   return out;
  }

//--- A finite number with `digits` decimals, trailing zeros removed; `null` when it is not finite.
string DshJsonNumber(const double value, const int digits)
  {
   if(!MathIsValidNumber(value))
      return "null";
   string text = DoubleToString(value, digits);
   if(StringFind(text, ".") >= 0)
     {
      int end = StringLen(text);
      while(end > 0 && StringGetCharacter(text, end - 1) == '0')
         end--;
      if(end > 0 && StringGetCharacter(text, end - 1) == '.')
         end--;
      text = StringSubstr(text, 0, end);
     }
   if(text == "-0")
      text = "0";
   return text;
  }

//+------------------------------------------------------------------+
//| Builds one JSON object, member by member.                        |
//+------------------------------------------------------------------+
class CDshJsonObject
  {
private:
   string            m_text;
   bool              m_empty;

   void              Key(const string key)
     {
      if(!m_empty)
         StringAdd(m_text, ",");
      m_empty = false;
      StringAdd(m_text, DshJsonQuote(key));
      StringAdd(m_text, ":");
     }

public:
                     CDshJsonObject(void) : m_text("{"), m_empty(true) {}

   void              Raw(const string key, const string json) { Key(key); StringAdd(m_text, json); }
   void              Str(const string key, const string value) { Key(key); StringAdd(m_text, DshJsonQuote(value)); }
   void              Int(const string key, const long value) { Key(key); StringAdd(m_text, IntegerToString(value)); }
   void              Num(const string key, const double value, const int digits) { Key(key); StringAdd(m_text, DshJsonNumber(value, digits)); }
   void              Bool(const string key, const bool value) { Key(key); StringAdd(m_text, value ? "true" : "false"); }
   void              Null(const string key) { Key(key); StringAdd(m_text, "null"); }
   string            Text(void) const { return m_text + "}"; }
  };

//+------------------------------------------------------------------+
//| Builds one JSON array, element by element.                       |
//+------------------------------------------------------------------+
class CDshJsonArray
  {
private:
   string            m_text;
   int               m_count;

   void              Next(void)
     {
      if(m_count > 0)
         StringAdd(m_text, ",");
      m_count++;
     }

public:
                     CDshJsonArray(void) : m_text("["), m_count(0) {}

   void              Raw(const string json) { Next(); StringAdd(m_text, json); }
   void              Str(const string value) { Next(); StringAdd(m_text, DshJsonQuote(value)); }
   void              Int(const long value) { Next(); StringAdd(m_text, IntegerToString(value)); }
   void              Num(const double value, const int digits) { Next(); StringAdd(m_text, DshJsonNumber(value, digits)); }
   int               Count(void) const { return m_count; }
   int               Length(void) const { return StringLen(m_text); }
   string            Text(void) const { return m_text + "]"; }
  };
//+------------------------------------------------------------------+
