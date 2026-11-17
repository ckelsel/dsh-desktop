/** 桥侧错误。message 形如 "NAME: detail"（网关/EA/DLL 的既有惯例），拆成两个字段方便判断。 */
export class Mt5Error extends Error {
  readonly code: number
  readonly label: string
  readonly detail: string

  constructor(code: number, message: string) {
    super(message)
    this.name = 'Mt5Error'
    this.code = code
    const split = message.indexOf(': ')
    this.label = split > 0 ? message.slice(0, split) : message
    this.detail = split > 0 ? message.slice(split + 2) : ''
  }
}
