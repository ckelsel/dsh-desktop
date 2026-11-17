#property strict
// 账户变化：轮询对比（~500ms）。resync 强制全量重推。

#include <Bridge/Rpc/RpcEventWriter.mqh>
#include <Bridge/Handlers/AccountHandler.mqh>

double   g_watch_balance=-1;
double   g_watch_equity=-1;
double   g_watch_margin=-1;
double   g_watch_margin_free=-1;
double   g_watch_profit=-1;
long     g_watch_login=-1;
ulong    g_watch_last_ms=0;

void AccountWatcherReset()
{
   g_watch_balance=-1;
   g_watch_equity=-1;
   g_watch_margin=-1;
   g_watch_margin_free=-1;
   g_watch_profit=-1;
   g_watch_login=-1;
}

void AccountWatcherTick(const long handle, const bool resync=false)
{
   const ulong now=GetTickCount64();
   if(!resync && g_watch_last_ms!=0 && now-g_watch_last_ms<500) return;
   g_watch_last_ms=now;

   const long login=AccountInfoInteger(ACCOUNT_LOGIN);
   const double balance=AccountInfoDouble(ACCOUNT_BALANCE);
   const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   const double margin=AccountInfoDouble(ACCOUNT_MARGIN);
   const double margin_free=AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   const double profit=AccountInfoDouble(ACCOUNT_PROFIT);

   string changed="[";
   int changes=0;
   if(resync || g_watch_login!=login)     { if(changes>0) changed+=","; changed+="\"login\""; changes++; }
   if(resync || g_watch_balance!=balance) { if(changes>0) changed+=","; changed+="\"balance\""; changes++; }
   if(resync || g_watch_equity!=equity)   { if(changes>0) changed+=","; changed+="\"equity\""; changes++; }
   if(resync || g_watch_margin!=margin)   { if(changes>0) changed+=","; changed+="\"margin\""; changes++; }
   if(resync || g_watch_margin_free!=margin_free) { if(changes>0) changed+=","; changed+="\"margin_free\""; changes++; }
   if(resync || g_watch_profit!=profit)   { if(changes>0) changed+=","; changed+="\"profit\""; changes++; }
   changed+="]";

   const bool first=(g_watch_balance==-1 && !resync);
   g_watch_login=login;
   g_watch_balance=balance;
   g_watch_equity=equity;
   g_watch_margin=margin;
   g_watch_margin_free=margin_free;
   g_watch_profit=profit;

   if(first) return;   // 首次仅建立基线，不广播
   if(changes==0 && !resync) return;

   BridgeEmitEvent(handle,"event.account.changed",
      "{\"changed_fields\":"+changed+",\"account\":"+AccountEntryJson()+"}");
}
