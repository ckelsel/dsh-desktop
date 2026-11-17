/** Account/Market/Trading 与 Mt5Bridge 之间的内部接口（不对外导出）。 */
export interface BridgeCore {
  /** 发起 RPC；terminalId 省略时路由到默认终端（真实优先）。 */
  call(method: string, params: Record<string, unknown>, terminalId?: string, timeoutMs?: number): Promise<unknown>
  addSubscription(terminalId: string, symbol: string, period: string): Promise<void>
  removeSubscription(terminalId: string, symbol: string, period: string): Promise<void>
}
