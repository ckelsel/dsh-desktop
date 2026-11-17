#property strict
// 请求读取：envelope id/method 与 params 取值。JSON 解析只在本层与 RpcWriter。

#include <Bridge/Rpc/Json.mqh>

CBridgeJson *RpcParamValue(CBridgeJson &root, const string name)
{
   CBridgeJson *params=root.Get("params");
   if(params!=NULL && params.IsObject())
   {
      CBridgeJson *value=params.Get(name);
      if(value!=NULL) return value;
   }
   return root.Get(name);
}

string RpcMethod(const string request)
{
   CBridgeJson root;
   string error;
   if(!root.Parse(request,error) || !root.IsObject()) return "";
   CBridgeJson *method=root.Get("method");
   return method==NULL ? "" : method.String();
}

// id 回显文本（DLL 已将入站 id 改写为整型 rid，此处按数字回显）
string RpcIdEcho(const string request)
{
   CBridgeJson root;
   string error;
   if(!root.Parse(request,error) || !root.IsObject()) return "null";
   CBridgeJson *id=root.Get("id");
   if(id==NULL) return "null";
   if(id.Type()==BRIDGE_JSON_NUMBER) return DoubleToString(id.Number(),0);
   return "null";
}

string RpcParamString(const string request, const string name, const string fallback="")
{
   CBridgeJson root;
   string error;
   if(!root.Parse(request,error) || !root.IsObject()) return fallback;
   CBridgeJson *value=RpcParamValue(root,name);
   if(value==NULL) return fallback;
   if(value.Type()==BRIDGE_JSON_STRING) return value.String(fallback);
   return fallback;
}

long RpcParamLong(const string request, const string name, const long fallback=0)
{
   CBridgeJson root;
   string error;
   if(!root.Parse(request,error) || !root.IsObject()) return fallback;
   CBridgeJson *value=RpcParamValue(root,name);
   if(value==NULL) return fallback;
   if(value.Type()==BRIDGE_JSON_NUMBER) return (long)value.Number((double)fallback);
   if(value.Type()==BRIDGE_JSON_STRING) return StringToInteger(value.String());
   return fallback;
}

// ticket 类大整数按字符串传输（避免 JS 精度丢失）
ulong RpcParamUlong(const string request, const string name, const ulong fallback=0)
{
   CBridgeJson root;
   string error;
   if(!root.Parse(request,error) || !root.IsObject()) return fallback;
   CBridgeJson *value=RpcParamValue(root,name);
   if(value==NULL) return fallback;
   if(value.Type()==BRIDGE_JSON_STRING)
   {
      string text=value.String();
      if(text=="") return fallback;
      for(int i=0;i<StringLen(text);i++)
      {
         ushort c=StringGetCharacter(text,i);
         if(c<'0' || c>'9') return fallback;
      }
      return (ulong)StringToInteger(text);
   }
   if(value.Type()==BRIDGE_JSON_NUMBER && value.Number()>=0.0)
      return (ulong)value.Number();
   return fallback;
}

double RpcParamDouble(const string request, const string name, const double fallback=0.0)
{
   CBridgeJson root;
   string error;
   if(!root.Parse(request,error) || !root.IsObject()) return fallback;
   CBridgeJson *value=RpcParamValue(root,name);
   if(value==NULL) return fallback;
   if(value.Type()==BRIDGE_JSON_NUMBER) return value.Number(fallback);
   if(value.Type()==BRIDGE_JSON_STRING) return StringToDouble(value.String());
   return fallback;
}
