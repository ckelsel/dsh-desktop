#property strict
// 响应与字符串编码。业务代码禁止在别处手拼 JSON。

// UTF-16 MQL5 字符串 → 合法 JSON 字符串（逐码元转义全部 JSON 控制字符）
string BridgeJsonQuote(const string value)
{
   string result="\"";
   const int length=StringLen(value);
   for(int index=0;index<length;index++)
   {
      const ushort code=StringGetCharacter(value,index);
      switch(code)
      {
         case 0x08: result+="\\b";  break;
         case 0x09: result+="\\t";  break;
         case 0x0A: result+="\\n";  break;
         case 0x0C: result+="\\f";  break;
         case 0x0D: result+="\\r";  break;
         case 0x22: result+="\\\""; break;
         case 0x5C: result+="\\\\"; break;
         default:
            if(code<0x20)
               result+=StringFormat("\\u%04X",(int)code);
            else
               result+=StringSubstr(value,index,1);
            break;
      }
   }
   return result+"\"";
}

// ENUM_ORDER_TYPE 数字 → 小写动作名（"buy_limit" 等；消费方按字符串渲染，不认数字）
string BridgeOrderTypeJson(const long type)
{
   string name=EnumToString((ENUM_ORDER_TYPE)type);   // "ORDER_TYPE_BUY_LIMIT"
   StringToLower(name);
   StringReplace(name,"order_type_","");
   return BridgeJsonQuote(name);
}

// ENUM_DEAL_TYPE 数字 → "buy"/"sell"（同上：消费方期望小写字符串）
string BridgeDealTypeJson(const long type)
{
   string name=EnumToString((ENUM_DEAL_TYPE)type);    // "DEAL_TYPE_BUY"
   StringToLower(name);
   StringReplace(name,"deal_type_","");
   return BridgeJsonQuote(name);
}

// 成功响应 envelope
string RpcOk(const string id_echo, const string result)
{
   return "{\"jsonrpc\":\"2.0\",\"id\":"+id_echo+",\"result\":"+result+"}";
}

// 桥层/业务层错误 envelope（data.name 为稳定字符串码）
string RpcFail(const string id_echo, const int code, const string name, const string message)
{
   return "{\"jsonrpc\":\"2.0\",\"id\":"+id_echo+
          ",\"error\":{\"code\":"+IntegerToString(code)+
          ",\"message\":"+BridgeJsonQuote(message)+
          ",\"data\":{\"name\":"+BridgeJsonQuote(name)+"}}}";
}

// MT5 业务错误：data 携带 retcode / retcode_description / order
string RpcFailMt(const string id_echo, const string name, const string message,
                 const uint retcode, const ulong order=0)
{
   return "{\"jsonrpc\":\"2.0\",\"id\":"+id_echo+
          ",\"error\":{\"code\":-32050"+
          ",\"message\":"+BridgeJsonQuote(message)+
          ",\"data\":{\"name\":"+BridgeJsonQuote(name)+
          ",\"retcode\":"+IntegerToString((long)retcode)+
          ",\"retcode_description\":"+BridgeJsonQuote(RetcodeDescription(retcode))+
          ",\"order\":\""+IntegerToString((long)order)+"\"}}}";
}

string RetcodeDescription(const uint retcode)
{
   switch(retcode)
   {
      case 10004: return "requote";
      case 10006: return "request rejected";
      case 10007: return "request canceled by trader";
      case 10008: return "order placed";
      case 10009: return "request completed";
      case 10010: return "only part of the request was completed";
      case 10011: return "request processing error";
      case 10012: return "request canceled by timeout";
      case 10013: return "invalid request";
      case 10014: return "invalid volume";
      case 10015: return "invalid price";
      case 10016: return "invalid stops";
      case 10017: return "trade disabled";
      case 10018: return "market closed";
      case 10019: return "not enough money";
      case 10020: return "prices changed";
      case 10021: return "no quotes to process request";
      case 10022: return "invalid order expiration";
      case 10023: return "order state changed";
      case 10024: return "too frequent requests";
      case 10025: return "no changes in request";
      case 10026: return "autotrading disabled by server";
      case 10027: return "autotrading disabled by client terminal";
      case 10028: return "locked";
      case 10029: return "frozen";
      case 10030: return "invalid order filling type";
      case 10031: return "no connection with trade server";
      case 10032: return "operation allowed only for live accounts";
      case 10033: return "number of orders exceeded";
      case 10034: return "position volume exceeded";
      case 10035: return "order or position closed";
      case 10036: return "position closed by opposite one";
      case 10038: return "close volume exceeds position volume";
      case 10039: return "close order already closed";
      case 10040: return "order or position in list already";
      case 10041: return "position quantity exceeded";
      case 10042: return "pending order quantity exceeded";
      case 10044: return "position not found";
      default:    return "retcode "+IntegerToString((long)retcode);
   }
}
