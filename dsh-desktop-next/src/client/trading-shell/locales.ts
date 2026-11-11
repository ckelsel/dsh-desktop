/** Labels of the trading workspace frame. */
export const zh = {
  'activity.label': '工作区',
  'activity.sessions': '会话列表',
  'activity.chat': '聊天',
  'activity.market': '行情',
}

export const en: Record<keyof typeof zh, string> = {
  'activity.label': 'Workspace',
  'activity.sessions': 'Session list',
  'activity.chat': 'Chat',
  'activity.market': 'Market',
}

/** Label of the session list command the trading layout registers in place of the official layout. */
export const layoutCommandLocales = {
  zh: { toggle: '展开／收起会话列表' },
  en: { toggle: 'Toggle session list' },
}
