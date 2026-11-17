#property strict
// MT5 Bridge native ABI：仅 #import 与字节收发辅助。不出现业务语义。

#define BRIDGE_ROLE_SERVICE 0
#define BRIDGE_ROLE_CONTROL 1   // 预留：V1 无 ControlEA
#define BRIDGE_ROLE_MARKET  2

#define BRIDGE_QUEUE_RELIABLE  0
#define BRIDGE_QUEUE_CONFLATED 1

#import "mt5bridge.dll"
int  Bridge_Version(uchar &buffer[], int capacity);
long Bridge_Register(int role, string terminal_id, string instance_key);
int  Bridge_Unregister(long handle);
int  Bridge_PeekSize(long handle);
int  Bridge_Poll(long handle, uchar &buffer[], int capacity);
int  Bridge_Reply(long handle, uchar &buffer[], int length);
int  Bridge_Emit(long handle, uchar &buffer[], int length, int queue_class);
int  Bridge_Status();
int  Bridge_LastError(uchar &buffer[], int capacity);
#import

string BridgeTerminalId()
{
   return TerminalInfoString(TERMINAL_DATA_PATH);
}

// 回包（Reply）。返回值 false 表示 DLL 拒收（如 runtime 已停止）。
bool BridgeWriteReply(const long handle, const string text)
{
   uchar bytes[];
   int count=StringToCharArray(text,bytes,0,WHOLE_ARRAY,CP_UTF8);
   if(count<=0) return false;
   count--; // 去掉结尾 NUL
   return Bridge_Reply(handle,bytes,count)==0;
}

// 事件（Emit）。queue_class 见 BRIDGE_QUEUE_*。同样永不阻塞。
bool BridgeWriteEvent(const long handle, const string text, const int queue_class)
{
   uchar bytes[];
   int count=StringToCharArray(text,bytes,0,WHOLE_ARRAY,CP_UTF8);
   if(count<=0) return false;
   count--;
   return Bridge_Emit(handle,bytes,count,queue_class)==0;
}

// 非阻塞取一条入站请求；空队列返回 ""。
string BridgeReadText(const long handle)
{
   int size=Bridge_PeekSize(handle);
   if(size<=0) return "";
   uchar bytes[];
   ArrayResize(bytes,size+1);
   int copied=Bridge_Poll(handle,bytes,size);
   if(copied<=0) return "";
   return CharArrayToString(bytes,0,copied,CP_UTF8);
}

// 组件失活自愈：DLL 清理失活组件后 PeekSize 恒 -2（实测：宿主被杀且未 Unregister 场景）。
// 检测到即重注册，返回有效 handle；0 = 注册失败。
long BridgeEnsureComponent(const long handle, const int role, const string terminal_id, const string instance_key)
{
   if(handle>0 && Bridge_PeekSize(handle)>=0) return handle;   // -2=组件已被清理 -3=锁异常
   if(handle>0) Bridge_Unregister(handle);                     // 幂等清理（-2 时为空操作）
   return Bridge_Register(role,terminal_id,instance_key);
}
