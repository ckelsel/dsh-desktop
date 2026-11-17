/**
 * The trading risk disclaimer every MT5 account needs agreed to before it trades
 * (`MT5_DISCLAIMER_VERSION`). Its text comes from `mt5-disclaimer.zh.md` and `mt5-disclaimer.en.md`.
 * The dialog opens in the page's language, and a switch at its top shows the other version, since
 * the English one prevails. The market page and Settings → MT5 connection share the dialog.
 * Agreeing only records the agreement: the action that prompted it is not carried out until the
 * user repeats it.
 */
import { useId, useState } from 'react'
import { Button, Checkbox, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { mt5DisclaimerDocument, type DisclaimerContent } from './mt5-disclaimer-text.ts'

type DisclaimerLanguage = 'zh' | 'en'

/** The dialog's own words, in the language it shows: the text names the agree button. */
const LABELS = {
  zh: { accept: '同意并启用交易', accepting: '正在保存…', cancel: '取消', close: '关闭', language: '语言' },
  en: { accept: 'Agree and enable trading', accepting: 'Saving…', cancel: 'Cancel', close: 'Close', language: 'Language' },
}

/** The versions, each named in its own language. */
const LANGUAGES = [{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }] as const

/** Its own styles: the dialog opens over the market page and over Settings, which load different style sheets. */
const STYLES = `
.dshMt5Disclaimer[role="dialog"] { width: min(680px, calc(100vw - 48px)); }
.dshMt5DisclaimerBody { max-height: min(62dvh, 600px); overflow-y: auto; overscroll-behavior: contain; font-size: 13px; line-height: 1.65; }
.dshMt5DisclaimerBody p { margin: 0 0 10px; }
.dshMt5DisclaimerBody h3 { margin: 0 0 4px; font-size: inherit; font-weight: 600; }
.dshMt5DisclaimerBody ul { margin: 0 0 12px; padding-left: 18px; color: var(--dsw-alias-label-secondary); }
.dshMt5DisclaimerBody li { margin: 2px 0; }
.dshMt5DisclaimerLanguage { margin: 0 0 12px; }
.dshMt5DisclaimerAgree { margin: 4px 0 2px; font-weight: 600; }
`

/** Paragraphs and lists, in the order the file gives them. */
const contentNodes = (content: DisclaimerContent) => content.map((item, index) => typeof item === 'string'
  ? <p key={index}>{item}</p>
  : <ul key={index}>{item.map((point, at) => <li key={at}>{point}</li>)}</ul>)

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
  const pageLanguage: DisclaimerLanguage = language.startsWith('zh') ? 'zh' : 'en'
  const [shown, setShown] = useState(pageLanguage)
  const [opened, setOpened] = useState(false)
  // Each opening starts in the page's language.
  if (open !== opened) {
    setOpened(open)
    if (open) setShown(pageLanguage)
  }
  const id = useId()
  const text = mt5DisclaimerDocument(shown)
  const labels = LABELS[shown]
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
    ? <Button variant="primary" size="sm" onClick={close} data-modal-autofocus="">{labels.close}</Button>
    : <>
      <Button variant="ghost" size="sm" disabled={saving} onClick={close}>{labels.cancel}</Button>
      <Button variant="primary" size="sm" disabled={!checked || saving} onClick={accept}>{saving ? labels.accepting : labels.accept}</Button>
    </>
  return <Modal open={open} onClose={close} title={text.title} closeLabel={labels.close} className="dshMt5Disclaimer" contentClassName="dshMt5DisclaimerBody" footer={footer}>
    <style>{STYLES}</style>
    <div className="dshMt5DisclaimerLanguage">
      <SegmentedControl id={id} value={shown} options={LANGUAGES} onChange={setShown} label={labels.language} />
    </div>
    <div id={`${id}-${shown}-panel`} role="tabpanel" aria-labelledby={`${id}-${shown}`} lang={shown === 'zh' ? 'zh-CN' : 'en'}>
      {contentNodes(text.intro)}
      {text.sections.map((section, index) => <section key={index}>
        <h3>{section.title}</h3>
        {contentNodes(section.content)}
      </section>)}
    </div>
    {onAccept !== undefined && <Checkbox checked={checked} onChange={setChecked} label={text.agree} disabled={saving} className="dshMt5DisclaimerAgree" />}
    {error !== null && <p role="alert" className="dshDesktopSettingsError">{error}</p>}
  </Modal>
}
