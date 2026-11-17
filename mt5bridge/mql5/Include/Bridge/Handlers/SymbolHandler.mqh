#property strict
// 品种列表 / 属性 / 交易时段。

#include <Bridge/Rpc/RpcReader.mqh>
#include <Bridge/Rpc/RpcWriter.mqh>

string HandleSymbolList(const string request)
{
   const bool view_only=RpcParamString(request,"view_only","false")=="true";
   const int total=SymbolsTotal(view_only);
   string names="";
   for(int i=0;i<total;i++)
   {
      if(i>0) names+=",";
      names+=BridgeJsonQuote(SymbolName(i,view_only));
   }
   return RpcOk(RpcIdEcho(request),"{\"symbols\":["+names+"],\"count\":"+IntegerToString(total)+"}");
}

// 计算模式/执行模式枚举名去 SYMBOL_CALC_/SYMBOL_TRADE_EXECUTION_ 前缀小写
string EnumSuffix(const string full,const string prefix)
{
   string name=full;
   if(StringFind(name,prefix)==0) name=StringSubstr(name,StringLen(prefix));
   StringToLower(name);
   return name;
}

// 单品种全字段（symbol.get 响应体）。margin_* 依赖当前报价，算不出为 null。
string BuildSymbolDetails(const string symbol)
{
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   const long order_mode=SymbolInfoInteger(symbol,SYMBOL_ORDER_MODE);
   string orders="";
   if((order_mode & SYMBOL_ORDER_MARKET)!=0)      orders+=",\"market\"";
   if((order_mode & SYMBOL_ORDER_LIMIT)!=0)       orders+=",\"limit\"";
   if((order_mode & SYMBOL_ORDER_STOP)!=0)        orders+=",\"stop\"";
   if((order_mode & SYMBOL_ORDER_STOP_LIMIT)!=0)  orders+=",\"stop_limit\"";
   if((order_mode & SYMBOL_ORDER_SL)!=0)          orders+=",\"sl\"";
   if((order_mode & SYMBOL_ORDER_TP)!=0)          orders+=",\"tp\"";
   if((order_mode & SYMBOL_ORDER_CLOSEBY)!=0)     orders+=",\"close_by\"";
   if(orders!="") orders=StringSubstr(orders,1);
   MqlTick tick;
   const bool has_tick=SymbolInfoTick(symbol,tick) && tick.time>0;
   double margin_buy=0, margin_sell=0;
   const bool margin_ok=has_tick
      && OrderCalcMargin(ORDER_TYPE_BUY,symbol,1.0,tick.ask,margin_buy)
      && OrderCalcMargin(ORDER_TYPE_SELL,symbol,1.0,tick.bid,margin_sell);
   return "{\"symbol\":"+BridgeJsonQuote(symbol)+
      ",\"description\":"+BridgeJsonQuote(SymbolInfoString(symbol,SYMBOL_DESCRIPTION))+
      ",\"path\":"+BridgeJsonQuote(SymbolInfoString(symbol,SYMBOL_PATH))+
      ",\"digits\":"+IntegerToString(digits)+
      ",\"point\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_POINT),digits+1)+
      ",\"tick_size\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE),digits+1)+
      ",\"spread\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_SPREAD))+
      ",\"trade_mode\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_TRADE_MODE))+
      ",\"execution_mode\":"+BridgeJsonQuote(EnumSuffix(EnumToString((ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(symbol,SYMBOL_TRADE_EXEMODE)),"SYMBOL_TRADE_EXECUTION_"))+
      ",\"currency_base\":"+BridgeJsonQuote(SymbolInfoString(symbol,SYMBOL_CURRENCY_BASE))+
      ",\"currency_profit\":"+BridgeJsonQuote(SymbolInfoString(symbol,SYMBOL_CURRENCY_PROFIT))+
      ",\"currency_margin\":"+BridgeJsonQuote(SymbolInfoString(symbol,SYMBOL_CURRENCY_MARGIN))+
      ",\"volume_min\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN),2)+
      ",\"volume_max\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX),2)+
      ",\"volume_step\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP),2)+
      ",\"volume_limit\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_LIMIT),2)+
      ",\"stops_level\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL))+
      ",\"freeze_level\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL))+
      ",\"contract_size\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_TRADE_CONTRACT_SIZE),2)+
      ",\"calc_mode\":"+BridgeJsonQuote(EnumSuffix(EnumToString((ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(symbol,SYMBOL_TRADE_CALC_MODE)),"SYMBOL_CALC_"))+
      ",\"sector\":"+BridgeJsonQuote(SymbolInfoString(symbol,SYMBOL_SECTOR_NAME))+
      ",\"visible\":"+((SymbolInfoInteger(symbol,SYMBOL_VISIBLE)!=0)?"true":"false")+
      ",\"order_modes\":["+orders+"]"+
      ",\"margin_buy\":"+(margin_ok?DoubleToString(margin_buy,2):"null")+
      ",\"margin_sell\":"+(margin_ok?DoubleToString(margin_sell,2):"null")+
      ",\"filling_mode\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_FILLING_MODE))+
      ",\"swap_long\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_SWAP_LONG),4)+
      ",\"swap_short\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_SWAP_SHORT),4)+"}";
}

string HandleSymbolGet(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   if(symbol=="" || !SymbolSelect(symbol,true))
      return RpcFail(RpcIdEcho(request),-32051,"SYMBOL_NOT_FOUND","symbol not found: "+symbol);
   return RpcOk(RpcIdEcho(request),BuildSymbolDetails(symbol));
}

string HandleSymbolSessions(const string request)
{
   const string symbol=RpcParamString(request,"symbol");
   if(symbol=="")
      return RpcFail(RpcIdEcho(request),-32055,"INVALID_PARAMS","symbol required");

   string days="\"trade\":{";
   string day_names[7]={"sun","mon","tue","wed","thu","fri","sat"};
   for(int day=0;day<7;day++)
   {
      if(day>0) days+=",";
      days+=BridgeJsonQuote(day_names[day])+":[";
      datetime from,to;
      int count=0;
      for(uint session=0;session<32;session++)
      {
         if(!SymbolInfoSessionTrade(symbol,(ENUM_DAY_OF_WEEK)day,session,from,to)) break;
         if(count>0) days+=",";
         days+="{\"from\":"+IntegerToString((long)from%86400)+",\"to\":"+IntegerToString((long)to%86400)+"}";
         count++;
      }
      days+="]";
   }
   days+="}";
   return RpcOk(RpcIdEcho(request),"{"+days+"}");
}
