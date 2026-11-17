/* MT5 Bridge native ABI（MQL5 #import 的 C 视图，仅供参考文档）。
 * role: 0=SERVICE, 2=MARKET；queue_class: 0=RELIABLE, 1=CONFLATED
 */
#ifndef MT5BRIDGE_ABI_H
#define MT5BRIDGE_ABI_H
#ifdef __cplusplus
extern "C" {
#endif

__declspec(dllexport) int        __stdcall Bridge_Version(char* buffer, int capacity);
__declspec(dllexport) long long  __stdcall Bridge_Register(int role, const unsigned short* terminal_id, const unsigned short* instance_key);
__declspec(dllexport) int        __stdcall Bridge_Unregister(long long handle);
__declspec(dllexport) int        __stdcall Bridge_PeekSize(long long handle);
__declspec(dllexport) int        __stdcall Bridge_Poll(long long handle, unsigned char* buffer, int capacity);
__declspec(dllexport) int        __stdcall Bridge_Reply(long long handle, const unsigned char* data, int length);
__declspec(dllexport) int        __stdcall Bridge_Emit(long long handle, const unsigned char* data, int length, int queue_class);
__declspec(dllexport) int        __stdcall Bridge_Status(void);
__declspec(dllexport) int        __stdcall Bridge_LastError(char* buffer, int capacity);

#ifdef __cplusplus
}
#endif
#endif /* MT5BRIDGE_ABI_H */
