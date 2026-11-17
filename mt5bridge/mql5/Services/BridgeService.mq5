#property strict
#property version   "0.2.0"
#property description "MT5 Bridge Service - all RPC + polled events on ws://127.0.0.1:18850"

#include <Bridge/Core/ServiceLoop.mqh>

void OnStart()
{
   BridgeServiceRun();
}
