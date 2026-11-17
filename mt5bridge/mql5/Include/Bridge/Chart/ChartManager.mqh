#property strict
// 订阅 → 隐藏图表 → 模板挂 MarketEA 的生命周期。引用计数，归零关图。
// 订阅表是唯一状态源；Watchdog 对账用。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>
#include <Bridge/Handlers/MarketHandler.mqh>

#define BRIDGE_SUB_MAX 128
#define BRIDGE_MARKET_TEMPLATE "BridgeMarket.tpl"

string   g_sub_symbols[BRIDGE_SUB_MAX];
int      g_sub_periods[BRIDGE_SUB_MAX];   // ENUM_TIMEFRAMES
long     g_sub_charts[BRIDGE_SUB_MAX];
int      g_sub_refs[BRIDGE_SUB_MAX];
int      g_sub_count=0;

int SubFind(const string symbol, const int period)
{
   for(int i=0;i<g_sub_count;i++)
      if(g_sub_symbols[i]==symbol && g_sub_periods[i]==period) return i;
   return -1;
}

// 打开隐藏图表并挂模板（EA 注册是异步的，ready 由 event.component 通知）
long SubOpenChart(const string symbol, const ENUM_TIMEFRAMES period)
{
   long chart=ChartOpen(symbol,period);
   if(chart<=0) return 0;
   ChartSetInteger(chart,CHART_SHOW,false);          // 隐藏，零渲染开销
   ChartSetInteger(chart,CHART_FOREGROUND,false);
   if(!ChartApplyTemplate(chart,BRIDGE_MARKET_TEMPLATE))
   {
      PrintFormat("[MT5Bridge] apply template failed on %s %s: %d",
                  symbol,TimeframeName(period),GetLastError());
      ChartClose(chart);
      return 0;
   }
   ChartRedraw(chart);
   return chart;
}

string HandleMarketSubscribe(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   const string period_name=RpcParamString(request,"period","M1");
   const ENUM_TIMEFRAMES period=TimeframeFromName(period_name);
   if(symbol=="")
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","symbol required");

   int index=SubFind(symbol,(int)period);
   const bool existed=(index>=0);
   bool chart_created=false;

   if(!existed)
   {
      if(g_sub_count>=BRIDGE_SUB_MAX)
         return RpcFail(RpcIdEcho(request),-32004,"INTERNAL","subscription table full");
      long chart=SubOpenChart(symbol,period);
      if(chart<=0)
         return RpcFailMt(RpcIdEcho(request),"CHART_OPEN_FAILED","cannot open chart for "+symbol,0);
      index=g_sub_count;
      g_sub_symbols[index]=symbol;
      g_sub_periods[index]=(int)period;
      g_sub_charts[index]=chart;
      g_sub_refs[index]=0;
      g_sub_count++;
      chart_created=true;
   }
   g_sub_refs[index]++;

   return RpcOk(RpcIdEcho(request),
      "{\"subscription_id\":"+BridgeJsonQuote(symbol+":"+TimeframeName(period))+
      ",\"status\":\"provisioning\""+
      ",\"chart_created\":"+(chart_created?"true":"false")+
      ",\"refs\":"+IntegerToString(g_sub_refs[index])+"}");
}

string HandleMarketUnsubscribe(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   const string period_name=RpcParamString(request,"period","M1");
   const ENUM_TIMEFRAMES period=TimeframeFromName(period_name);

   int index=SubFind(symbol,(int)period);
   if(index<0)
      return RpcFail(RpcIdEcho(request),-32053,"SUBSCRIPTION_NOT_FOUND","no subscription for "+symbol);

   g_sub_refs[index]--;
   bool closed=false;
   if(g_sub_refs[index]<=0)
   {
      if(g_sub_charts[index]>0) closed=ChartClose(g_sub_charts[index]);
      // 紧凑删除
      for(int i=index;i<g_sub_count-1;i++)
      {
         g_sub_symbols[i]=g_sub_symbols[i+1];
         g_sub_periods[i]=g_sub_periods[i+1];
         g_sub_charts[i]=g_sub_charts[i+1];
         g_sub_refs[i]=g_sub_refs[i+1];
      }
      g_sub_count--;
   }
   return RpcOk(RpcIdEcho(request),
      "{\"closed\":"+(closed?"true":"false")+
      ",\"remaining_refs\":"+(index<g_sub_count ? IntegerToString(g_sub_refs[index]) : "0")+"}");
}

string HandleMarketSubscriptions(const string request)
{
   string items="";
   for(int i=0;i<g_sub_count;i++)
   {
      if(items!="") items+=",";
      items+="{\"subscription_id\":"+BridgeJsonQuote(g_sub_symbols[i]+":"+TimeframeName((ENUM_TIMEFRAMES)g_sub_periods[i]))+
         ",\"symbol\":"+BridgeJsonQuote(g_sub_symbols[i])+
         ",\"period\":"+BridgeJsonQuote(TimeframeName((ENUM_TIMEFRAMES)g_sub_periods[i]))+
         ",\"refs\":"+IntegerToString(g_sub_refs[i])+
         ",\"chart\":\""+IntegerToString(g_sub_charts[i])+"\"}";
   }
   return RpcOk(RpcIdEcho(request),"{\"subscriptions\":["+items+"]}");
}

// Watchdog：图表被手关/失效（ChartSymbol 为空）则重开重挂。返回重挂数量。
int SubscriptionsWatchdog()
{
   int repaired=0;
   for(int i=0;i<g_sub_count;i++)
   {
      if(g_sub_charts[i]>0 && ChartSymbol(g_sub_charts[i])!="") continue;
      long chart=SubOpenChart(g_sub_symbols[i],(ENUM_TIMEFRAMES)g_sub_periods[i]);
      if(chart>0)
      {
         g_sub_charts[i]=chart;
         repaired++;
         PrintFormat("[MT5Bridge] watchdog repaired chart %s %s",
                     g_sub_symbols[i],TimeframeName((ENUM_TIMEFRAMES)g_sub_periods[i]));
      }
   }
   return repaired;
}
