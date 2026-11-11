/** Left activity bar: independent toggles for the session list, the chat column and the market page. */
import type { ReactNode } from 'react'
import { CandlestickChart, MessagesSquare, PanelLeft } from 'lucide-react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Activity bar state and actions; each flag reports what is visible now. */
export interface ActivityBarProps {
  t: TranslateNS<'desktop-trading'>
  sessions: boolean
  chat: boolean
  market: boolean
  onSessions(): void
  onChat(): void
  onMarket(): void
}

function ActivityButton({ label, pressed, onClick, children, id }: { label: string; pressed: boolean; onClick(): void; children: ReactNode; id: string }) {
  return <Tooltip label={label} side="right" delayMs={400}>
    <button
      type="button"
      className="dshTwActivityButton"
      data-activity={id}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  </Tooltip>
}

/**
 * The bar's three toggles. Hiding the last visible of market and chat shows the other one, so the
 * frame is never empty.
 */
export function ActivityBar({ t, sessions, chat, market, onSessions, onChat, onMarket }: ActivityBarProps) {
  return <nav className="dshTwActivityBar" aria-label={t('activity.label')}>
    <ActivityButton id="sessions" label={t('activity.sessions')} pressed={sessions} onClick={onSessions}>
      <PanelLeft size={18} strokeWidth={1.75} />
    </ActivityButton>
    <ActivityButton id="chat" label={t('activity.chat')} pressed={chat} onClick={onChat}>
      <MessagesSquare size={18} strokeWidth={1.75} />
    </ActivityButton>
    <ActivityButton id="market" label={t('activity.market')} pressed={market} onClick={onMarket}>
      <CandlestickChart size={18} strokeWidth={1.75} />
    </ActivityButton>
  </nav>
}
