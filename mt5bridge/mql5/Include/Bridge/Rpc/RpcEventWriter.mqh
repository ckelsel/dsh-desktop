#property strict
// 事件编码与发布。事件无 id；seq 由 DLL 注入。

#include <Bridge/Abi/BridgeApi.mqh>

string RpcEventText(const string method, const string params_json)
{
   return "{\"jsonrpc\":\"2.0\",\"method\":\""+method+"\",\"params\":"+params_json+"}";
}

// conflated=true → 同 method|symbol 覆盖旧值（tick / 当前 bar）
bool BridgeEmitEvent(const long handle, const string method, const string params_json,
                     const bool conflated=false)
{
   return BridgeWriteEvent(handle, RpcEventText(method,params_json),
                           conflated ? BRIDGE_QUEUE_CONFLATED : BRIDGE_QUEUE_RELIABLE);
}
