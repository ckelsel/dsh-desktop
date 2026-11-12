/**
 * The trading risk disclaimer every MT5 account needs agreed to before it trades
 * (`MT5_DISCLAIMER_VERSION`; a change of substance raises the version). The Chinese text prevails.
 * The market page and Settings → MT5 connection share the dialog. Agreeing only records the
 * agreement: the action that prompted it is not carried out until the user repeats it.
 */
import { useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

interface Section { title: string; points: readonly string[] }

interface DisclaimerText {
  title: string
  intro: string
  sections: readonly Section[]
  agree: string
  accept: string
  accepting: string
  cancel: string
  close: string
}

const ZH: DisclaimerText = {
  title: '交易风险提示与免责声明',
  intro: '开始交易前，请完整阅读以下内容。勾选并点击「同意并启用交易」，即表示您已阅读、理解并接受全部内容。',
  sections: [
    { title: '交易风险很高。', points: [
      '外汇、贵金属、指数、商品、股票差价合约和加密货币等产品通常带有杠杆。价格可能在短时间内大幅波动，您可能很快损失大量资金。',
      '多数零售投资者交易杠杆产品时是亏损的。',
      '亏损可能超过账户里的资金，这取决于经纪商是否提供负余额保护。',
      '请只用您能承受损失的资金交易。',
      '过去的盈利和模拟账户的表现，都不代表真实账户将来的结果。',
    ] },
    { title: '本软件是什么，不是什么。', points: [
      '本软件是操作您的 MetaTrader 5（MT5）终端的工具。',
      '本软件不是经纪商、金融机构或投资顾问，不持有您的资金，也不提供投资、财务、税务或法律方面的建议。',
      '界面上的任何内容都不是买卖建议，包括 AI 助手生成的内容。',
      '本软件不核实您的经纪商是否受到监管，请自行选择可靠的经纪商。',
    ] },
    { title: '执行和数据都以 MT5 和经纪商为准。', points: [
      '订单由您的 MT5 终端发给经纪商，由经纪商执行。',
      '成交价格、滑点、拒单、部分成交、保证金、强制平仓、手续费和隔夜利息，都以 MT5 和经纪商的记录为准。',
      '本软件显示的行情、K 线、盈亏、保证金和点值来自 MT5、经纪商和第三方组件，比如图表组件。这些内容可能有延迟、误差或缺失，本软件不保证其准确、完整、及时。',
    ] },
    { title: '交易依赖 MT5、EA 和两者之间的连接。', points: [
      '只有满足以下全部条件时，本软件才能交易：MT5 正在运行，并且已登录账户；DshBridge EA 正在运行，并且允许算法交易；本软件与 MT5 之间的连接正常。两者通常在同一台电脑上；MT5 在另一台电脑上时，还依赖两台电脑之间的网络。',
      '任何一项出了问题，本软件就既不能交易，也看不到最新状态。',
      '已经设置好的止损和止盈保存在 MT5 和经纪商那里，一般由经纪商的服务器执行，不依赖本软件。',
      '以下故障可能导致订单发不出去、成交被延迟，或者结果暂时无法确认：电脑、MT5 或 EA 出现故障，网络中断，经纪商服务器异常。',
      '结果无法确认时，本软件不会自动重发请求，会提示您到持仓和历史记录中核对。一切以 MT5 和经纪商的记录为准。',
    ] },
    { title: '连接安全依赖令牌。', points: [
      '本软件与 MT5 之间的连接经过 TLS 加密。双方用令牌互相验证身份，每个交易请求都带有签名。',
      '但任何拿到令牌的人，都可能冒充本软件或 EA。请妥善保管令牌，不要告诉他人。怀疑令牌泄露时，请立即在「设置 → MT5 连接」中重新生成。',
      '令牌只保存在您的电脑上，EA 的请求记录保存在 MT5 的数据目录里。',
      '如果运行 MT5 或本软件的电脑本身被入侵，以上措施无法保护您。',
    ] },
    { title: '同意后可以交易真实资金账户。', points: [
      '同意后，本软件可以在模拟账户、比赛账户和真实资金账户上下单、平仓、修改和撤单。',
      '真实账户里的每一笔交易用的都是真实资金。',
      '下单面板会标出当前账户的类型，请在每次下单前核对。',
    ] },
    { title: '按现状提供，责任有限。', points: [
      '本软件按现状提供，可能存在缺陷或错误，功能也可能变化。',
      '本软件不保证不间断运行、没有错误，也不保证通信完整及时。',
      '在法律允许的范围内，开发者不承担因使用或无法使用本软件造成的任何直接或间接损失，包括但不限于交易亏损和利润损失、数据丢失，以及中断或延迟造成的损失。',
      '如果您所在地区的法律不允许这样限制责任，则在法律允许的最大范围内限制。',
    ] },
    { title: '您对自己的交易负责。', points: [
      '每一笔交易都由您自己决定。',
      '通过本软件进行的全部交易，以及交易的结果，都由您承担全部责任，包括参考 AI 助手内容后做出的交易。',
      '请遵守您所在地区的法律。当地法律限制交易这类产品时，请不要使用本软件交易。',
    ] },
    { title: '变更与撤回。', points: [
      '本声明的内容有实质变化时，本软件会请您重新阅读并同意。',
      '您可以随时在「设置 → MT5 连接」中撤回同意。撤回后不能再交易，但仍然可以看盘。',
    ] },
    { title: '语言。', points: [
      '本声明有中文和英文两个版本。两者不一致时，以中文版为准。',
    ] },
  ],
  agree: '我已阅读并理解以上内容，自愿承担交易风险。',
  accept: '同意并启用交易',
  accepting: '正在保存…',
  cancel: '取消',
  close: '关闭',
}

const EN: DisclaimerText = {
  title: 'Trading risk warning and disclaimer',
  intro: 'Read all of the following before you trade. By ticking the box and clicking "Agree and enable trading", you confirm that you have read, understood and accepted all of it.',
  sections: [
    { title: 'Trading carries high risk.', points: [
      'Forex, precious metals, indices, commodities, share CFDs and cryptocurrencies are usually traded with leverage. Prices can move sharply in a short time, and you can lose a large amount of money quickly.',
      'Most retail investors lose money trading leveraged products.',
      'Losses can exceed the funds in your account, depending on whether your broker offers negative balance protection.',
      'Trade only with money you can afford to lose.',
      'Past profits and results on demo accounts do not predict future results on a real account.',
    ] },
    { title: 'What this software is, and is not.', points: [
      'This software is a tool that operates your MetaTrader 5 (MT5) terminal.',
      'It is not a broker, a financial institution or an investment adviser. It does not hold your money and gives no investment, financial, tax or legal advice.',
      'Nothing on screen is a recommendation to buy or sell, including content the AI assistant generates.',
      'This software does not check whether your broker is regulated. Choose a reliable broker yourself.',
    ] },
    { title: 'MT5 and your broker decide execution and data.', points: [
      'Your MT5 terminal sends orders to your broker, and your broker executes them.',
      'Fill prices, slippage, rejections, partial fills, margin, stop outs, commissions and swaps are as MT5 and your broker record them.',
      'The quotes, charts, profit and loss, margin and pip values shown here come from MT5, your broker and third-party components such as the chart. They may be delayed, inaccurate or missing, and this software does not guarantee that they are accurate, complete or timely.',
    ] },
    { title: 'Trading depends on MT5, the EA and the connection between them.', points: [
      'This software can trade only while all of the following hold: MT5 is running and logged in to the account; the DshBridge EA is running with algorithmic trading allowed; and the connection between this software and MT5 works. Both usually run on the same computer; when MT5 runs on another computer, the network between the two computers is needed as well.',
      'If any of these fails, this software can neither trade nor see the latest state.',
      'Stop losses and take profits already set are held by MT5 and your broker, and your broker\'s server normally executes them without this software.',
      'Failures of the computer, MT5 or the EA, network outages and broker server problems can stop an order from being sent, delay its execution, or leave its outcome unconfirmed for a while.',
      'When an outcome cannot be confirmed, this software never resends the request, and asks you to check your positions and history. MT5\'s and your broker\'s records prevail.',
    ] },
    { title: 'The token secures the connection.', points: [
      'The connection between this software and MT5 is encrypted with TLS. Both sides prove their identity to each other with the token, and every trade request is signed.',
      'Anyone who obtains the token can impersonate this software or the EA. Keep it safe and do not share it. If you suspect it has leaked, regenerate it at once in Settings → MT5 connection.',
      'The token is kept only on your computers, and the EA keeps its request log in MT5\'s data folder.',
      'None of this protects you if a computer running MT5 or this software is itself compromised.',
    ] },
    { title: 'After you agree, real-money accounts can trade.', points: [
      'Once you agree, this software can place, close, modify and cancel orders on demo, contest and real-money accounts.',
      'Every trade on a real account uses real money.',
      'The order ticket shows the account type. Check it before every order.',
    ] },
    { title: 'Provided as is, with limited liability.', points: [
      'This software is provided as is. It may contain defects or errors, and its features may change.',
      'It is not guaranteed to run without interruption or errors, nor that communication is complete and timely.',
      'To the extent the law allows, the developers are not liable for any direct or indirect loss from using or being unable to use this software, including but not limited to trading losses and lost profits, lost data, and losses from interruptions or delays.',
      'Where the law of your jurisdiction does not allow liability to be limited this way, it is limited to the greatest extent the law allows.',
    ] },
    { title: 'You are responsible for your trades.', points: [
      'You make every trading decision yourself.',
      'You bear full responsibility for all trades made through this software and their results, including trades made after considering content from the AI assistant.',
      'Comply with the laws where you live. Do not use this software to trade where local law restricts trading these products.',
    ] },
    { title: 'Changes and withdrawal.', points: [
      'When this disclaimer changes in substance, this software asks you to read and agree to it again.',
      'You can withdraw your agreement at any time in Settings → MT5 connection. After that you cannot trade, but you can still view the markets.',
    ] },
    { title: 'Language.', points: [
      'This disclaimer has a Chinese and an English version. Where they differ, the Chinese version prevails.',
    ] },
  ],
  agree: 'I have read and understood the above, and I accept the risks of trading.',
  accept: 'Agree and enable trading',
  accepting: 'Saving…',
  cancel: 'Cancel',
  close: 'Close',
}

export const mt5DisclaimerText = (language: string): DisclaimerText => language.startsWith('zh') ? ZH : EN

/** Its own styles: the dialog opens over the market page and over Settings, which load different style sheets. */
const STYLES = `
.dshMt5Disclaimer[role="dialog"] { width: min(680px, calc(100vw - 48px)); }
.dshMt5DisclaimerBody { max-height: min(62dvh, 600px); overflow-y: auto; overscroll-behavior: contain; font-size: 13px; line-height: 1.65; }
.dshMt5DisclaimerBody > p { margin: 0 0 10px; }
.dshMt5DisclaimerList { margin: 0 0 12px; padding-left: 22px; }
.dshMt5DisclaimerList > li { margin: 0 0 10px; }
.dshMt5DisclaimerList ul { margin: 4px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); }
.dshMt5DisclaimerList ul > li { margin: 2px 0; }
.dshMt5DisclaimerAgree { margin: 4px 0 2px; font-weight: 600; }
`

/**
 * The disclaimer dialog. With `onAccept` it asks for agreement behind a checkbox; without it, it
 * only shows the text, for a user who agreed already.
 */
export function Mt5Disclaimer({ open, language, onClose, onAccept }: {
  open: boolean
  language: string
  onClose(): void
  /** Records the agreement; the dialog closes once it resolves and stays open with the error otherwise. */
  onAccept?: () => Promise<void>
}) {
  const text = mt5DisclaimerText(language)
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = (): void => {
    if (saving) return
    setChecked(false)
    setError(null)
    onClose()
  }
  const accept = (): void => {
    if (onAccept === undefined || !checked || saving) return
    setSaving(true)
    setError(null)
    onAccept().then(() => {
      setChecked(false)
      onClose()
    }, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setSaving(false) })
  }
  const footer = onAccept === undefined
    ? <Button variant="primary" size="sm" onClick={close} data-modal-autofocus="">{text.close}</Button>
    : <>
      <Button variant="ghost" size="sm" disabled={saving} onClick={close}>{text.cancel}</Button>
      <Button variant="primary" size="sm" disabled={!checked || saving} onClick={accept}>{saving ? text.accepting : text.accept}</Button>
    </>
  return <Modal open={open} onClose={close} title={text.title} closeLabel={text.close} className="dshMt5Disclaimer" contentClassName="dshMt5DisclaimerBody" footer={footer}>
    <style>{STYLES}</style>
    <p>{text.intro}</p>
    <ol className="dshMt5DisclaimerList">
      {text.sections.map(section => <li key={section.title}>
        <strong>{section.title}</strong>
        <ul>{section.points.map(point => <li key={point}>{point}</li>)}</ul>
      </li>)}
    </ol>
    {onAccept !== undefined && <Checkbox checked={checked} onChange={setChecked} label={text.agree} disabled={saving} className="dshMt5DisclaimerAgree" />}
    {error !== null && <p role="alert" className="dshDesktopSettingsError">{error}</p>}
  </Modal>
}
