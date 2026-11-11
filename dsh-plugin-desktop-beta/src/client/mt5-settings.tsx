/**
 * Settings → MT5 connection. The bridge is the TCP server the DshBridge EA in MetaTrader 5 dials:
 * whether it runs, whether an EA on another computer may connect, the port, the addresses an EA may
 * connect from, the token the EA presents, and where the bridge stands. A change restarts only the
 * bridge's server, never the Host. The token stays out of the general Desktop state; this section
 * asks the bridge for it.
 */
import { useEffect, useState } from 'react'
import { useClipboardCopy } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopPreferences, DesktopState } from '../desktop-contract.ts'
import { formatAddressList, parseAddressList } from '../mt5/addresses.ts'
import type { Mt5RejectReason, Mt5RendererBridge, Mt5Status } from '../mt5/contract.ts'
import { DesktopSettingsToggleRow } from './DesktopSettingsSection.tsx'
import { desktopMt5Bridge } from './market/data/mt5-bridge.ts'

export type Mt5PreferencePatch = Partial<Pick<DesktopPreferences, 'mt5Enabled' | 'mt5Exposure' | 'mt5Port' | 'mt5AllowedAddresses'>>

type Translate = (cn: string, en: string) => string

/** The bridge status, following its pushes; null until the first answer or without a bridge. */
function useMt5Status(bridge: Mt5RendererBridge | null): Mt5Status | null {
  const [status, setStatus] = useState<Mt5Status | null>(null)
  useEffect(() => {
    if (bridge === null) return
    let active = true
    const stop = bridge.onStatus((next) => { if (active) setStatus(next) })
    bridge.status().then((next) => { if (active) setStatus(next) }, () => {})
    return () => {
      active = false
      stop()
    }
  }, [bridge])
  return status
}

const REJECTIONS: Record<Mt5RejectReason, [string, string]> = {
  address: ['来源地址不在允许列表中', 'address not allowed'],
  token: ['令牌错误', 'wrong token'],
  protocol: ['协议版本不兼容', 'incompatible protocol version'],
  busy: ['已有另一个账户连接', 'another account is connected'],
  'handshake-timeout': ['握手超时', 'handshake timed out'],
  invalid: ['握手消息无效', 'invalid handshake'],
}

const clock = (at: number): string => new Date(at).toLocaleTimeString()

/** Port text as the preference takes it; null when it is not a port. */
export function parsePort(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,5}$/u.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= 65_535 ? value : null
}

export function Mt5Settings({ state, language, save }: { state: DesktopState; language: string; save(patch: Mt5PreferencePatch): Promise<void> }) {
  const t: Translate = (cn, en) => language.startsWith('zh') ? cn : en
  const [bridge] = useState(desktopMt5Bridge)
  const status = useMt5Status(bridge)
  const preferences = state.preferences
  const locked = state.safeMode
  const [port, setPort] = useState(String(preferences.mt5Port))
  const [addresses, setAddresses] = useState(preferences.mt5AllowedAddresses)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => { setPort(String(preferences.mt5Port)) }, [preferences.mt5Port])
  useEffect(() => { setAddresses(preferences.mt5AllowedAddresses) }, [preferences.mt5AllowedAddresses])

  const portValue = parsePort(port)
  const parsed = parseAddressList(addresses)
  const normalized = formatAddressList(parsed.addresses)
  const draftError = portValue === null
    ? t('端口须为 1–65535 之间的整数。', 'The port must be an integer from 1 through 65535.')
    : parsed.invalid.length > 0 ? t(`不是 IPv4 地址：${parsed.invalid.join(', ')}`, `Not an IPv4 address: ${parsed.invalid.join(', ')}`) : ''
  const dirty = portValue !== preferences.mt5Port || normalized !== preferences.mt5AllowedAddresses
  const apply = async (patch: Mt5PreferencePatch): Promise<void> => {
    setSaving(true); setFailure('')
    try { await save(patch) } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) }
  }
  const disabled = locked || saving || state.busy

  return <section className="dshDesktopSettingsGroup" data-next-mt5="" aria-labelledby="dsh-desktop-mt5-title">
    <div>
      <h3 id="dsh-desktop-mt5-title">{t('MT5 连接', 'MT5 connection')}</h3>
      <p className="dshDesktopSettingsGroupIntro">{t(
        '在 MetaTrader 5 中运行 DshBridge EA，行情页即可读取账户。EA 主动连接本机：参数 DesktopHost 填本机地址，DesktopPort 填下方端口，Token 填下方令牌。',
        'Run the DshBridge EA in MetaTrader 5 and the market page reads its account. The EA dials this computer: set its DesktopHost input to an address of this computer, DesktopPort to the port below, and Token to the token below.',
      )}</p>
    </div>
    {failure && <p role="alert" className="dshDesktopSettingsError">{failure}</p>}
    <DesktopSettingsToggleRow
      label={t('启用 MT5 连接', 'Enable the MT5 connection')}
      description={locked
        ? t('安全模式下 MT5 连接保持关闭。', 'Safe Mode keeps the MT5 connection off.')
        : t('关闭后行情页显示演示账户。', 'When off, the market page shows the demo account.')}
      checked={preferences.mt5Enabled && !locked}
      disabled={disabled}
      onChange={(mt5Enabled) => { void apply({ mt5Enabled }) }}
    />
    <DesktopSettingsToggleRow
      label={t('允许局域网连接', 'Allow LAN connections')}
      description={t(
        '开启后在所有网卡上监听，另一台电脑上的 MT5 才能连接；关闭时只接受本机的 EA。连接不加密，请只在可信的局域网中开启。',
        'Listen on every network interface so MT5 on another computer can connect; when off, only an EA on this computer can. The connection is not encrypted, so turn this on only in a trusted network.',
      )}
      checked={preferences.mt5Exposure === 'lan'}
      disabled={disabled || !preferences.mt5Enabled}
      onChange={(lan) => { void apply({ mt5Exposure: lan ? 'lan' : 'loopback' }) }}
    />
    <form className="dshDesktopSettingsForm" data-next-mt5-address="" onSubmit={(event) => {
      event.preventDefault()
      if (draftError === '' && dirty && portValue !== null) void apply({ mt5Port: portValue, mt5AllowedAddresses: normalized })
    }}>
      <label className="dshDesktopSettingsField" data-narrow="">
        {t('端口', 'Port')}
        <input className="dshDesktopSettingsInput" value={port} inputMode="numeric" autoComplete="off" maxLength={5} disabled={disabled}
          onChange={(event) => { setPort(event.currentTarget.value) }} />
      </label>
      <label className="dshDesktopSettingsField">
        {t('允许连接的 EA 地址', 'EA addresses allowed to connect')}
        <input className="dshDesktopSettingsInput" value={addresses} autoComplete="off" spellCheck={false} maxLength={1024} disabled={disabled}
          placeholder={t('例如 10.0.0.13；留空表示任何地址（仍需令牌）', 'For example 10.0.0.13; empty admits any address (the token is still required)')}
          onChange={(event) => { setAddresses(event.currentTarget.value) }} />
      </label>
      <button type="submit" className="dshDesktopSettingsButton" disabled={disabled || !dirty || draftError !== ''}>{t('保存', 'Save')}</button>
    </form>
    {draftError && <p className="dshDesktopSettingsHint" role="status">{draftError}</p>}
    {bridge !== null && <Mt5Token bridge={bridge} t={t} disabled={locked} onError={setFailure} />}
    {bridge !== null && status !== null && <Mt5StatusBox status={status} t={t} />}
  </section>
}

function Mt5Token({ bridge, t, disabled, onError }: { bridge: Mt5RendererBridge; t: Translate; disabled: boolean; onError(message: string): void }) {
  const [token, setToken] = useState('')
  const [shown, setShown] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const copy = useClipboardCopy(token)
  useEffect(() => {
    let active = true
    bridge.token().then((value) => { if (active) setToken(value) }, (error: unknown) => { if (active) onError(String(error)) })
    return () => { active = false }
  }, [bridge, onError])
  const regenerate = (): void => {
    setBusy(true)
    bridge.regenerateToken().then((value) => { setToken(value); setShown(true) }, (error: unknown) => { onError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setBusy(false); setConfirming(false) })
  }
  return <div className="dshDesktopSettingsUpdateRow" data-next-mt5-token="">
    <span className="dshDesktopSettingsToggleCopy">
      <span className="dshDesktopSettingsToggleLabel">{t('EA 令牌', 'EA token')}</span>
      <code className="dshDesktopSettingsDataPath">{token === '' ? '—' : shown ? token : '•'.repeat(24)}</code>
      <p className="dshDesktopSettingsToggleDescription">{confirming
        ? t('重新生成后，正在连接的 EA 会断开，需要在 EA 参数中填入新令牌。', 'The connected EA disconnects and needs the new token in its inputs.')
        : t('填入 EA 的 Token 参数。不要分享给他人。', 'Enter it as the EA\'s Token input. Do not share it.')}</p>
    </span>
    <span className="dshDesktopSettingsRowActions">
      {confirming ? <>
        <button type="button" className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary" disabled={busy} onClick={() => { setConfirming(false) }}>{t('取消', 'Cancel')}</button>
        <button type="button" className="dshDesktopSettingsButton" disabled={busy} onClick={regenerate}>{t('确认重新生成', 'Regenerate')}</button>
      </> : <>
        <button type="button" className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary" disabled={token === ''} onClick={() => { setShown(value => !value) }}>{shown ? t('隐藏', 'Hide') : t('显示', 'Show')}</button>
        <button type="button" className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary" disabled={token === ''} onClick={copy.onCopy}>{copy.copied ? t('已复制', 'Copied') : t('复制', 'Copy')}</button>
        <button type="button" className="dshDesktopSettingsButton dshDesktopSettingsButtonSecondary" disabled={disabled || token === ''} onClick={() => { setConfirming(true) }}>{t('重新生成', 'Regenerate')}</button>
      </>}
    </span>
  </div>
}

function Mt5StatusBox({ status, t }: { status: Mt5Status; t: Translate }) {
  const { phase, listen, peer, account, lastRejection } = status
  const label = {
    disabled: t('已关闭', 'Off'),
    error: t('无法监听', 'Cannot listen'),
    listening: t('等待 EA 连接', 'Waiting for the EA'),
    handshaking: t('正在验证 EA', 'Checking the EA'),
    syncing: t('正在同步账户', 'Syncing the account'),
    ready: t('已连接', 'Connected'),
  }[phase]
  const tone = phase === 'ready' ? 'ready' : phase === 'error' ? 'failed' : 'pending'
  return <div className="dshDesktopSettingsLanStatus" data-state={tone} data-next-mt5-status="" role="status">
    <span><span className="dshDesktopSettingsBadge">{label}</span></span>
    {phase === 'error' && status.error !== null && <span>{status.error}</span>}
    {listen !== null && <span>{t('监听', 'Listening on')} <code>{`${listen.host}:${listen.port}`}</code></span>}
    {listen !== null && listen.host !== '127.0.0.1' && listen.addresses.length > 0 && <span>
      {t('EA 的 DesktopHost 可填', 'The EA\'s DesktopHost can be')} <code>{listen.addresses.join(', ')}</code>
    </span>}
    {peer !== null && <span>
      {t('EA', 'EA')} <code>{peer.address}</code> · {peer.eaVersion}
      {account !== null && <> · {t('账户', 'account')} <code>{account.login}</code> @ {account.server}</>}
    </span>}
    {lastRejection !== null && (peer === null || lastRejection.at >= peer.connectedAt) && <span>
      {t('最近拒绝', 'Last refused')} <code>{lastRejection.address}</code>{t('：', ': ')}{t(...REJECTIONS[lastRejection.reason])}{t(`（${clock(lastRejection.at)}）`, ` (${clock(lastRejection.at)})`)}
    </span>}
  </div>
}
