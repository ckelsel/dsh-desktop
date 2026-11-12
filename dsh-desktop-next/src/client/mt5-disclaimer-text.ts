/**
 * The trading risk disclaimer's text. It lives in `mt5-disclaimer.zh.md` and
 * `mt5-disclaimer.en.md` beside this file, so it can be edited without touching code; the Chinese
 * file's header comment describes the format. The English text prevails.
 */
import en from './mt5-disclaimer.en.md?raw'
import zh from './mt5-disclaimer.zh.md?raw'

/** Paragraphs, and the points of a list, in order. */
export type DisclaimerContent = Array<string | string[]>

export interface DisclaimerDocument {
  title: string
  intro: DisclaimerContent
  sections: Array<{ title: string, content: DisclaimerContent }>
  /** The sentence the user ticks to agree. */
  agree: string
}

/**
 * Reads the disclaimer's Markdown subset: `# ` the title, then the introduction, a section per
 * `## ` holding `- ` points and plain paragraphs, and after `---` the sentence to agree to.
 * Comments are dropped. Any other Markdown shows as plain text, so an edit cannot break the dialog.
 */
export function parseDisclaimer(markdown: string): DisclaimerDocument {
  const result: DisclaimerDocument = { title: '', intro: [], sections: [], agree: '' }
  const agreement: string[] = []
  let content = result.intro
  let agreeing = false
  for (const raw of markdown.replace(/<!--[\s\S]*?-->/gu, '').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '') continue
    if (agreeing) {
      agreement.push(line)
    } else if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(line)) {
      agreeing = true
    } else if (line.startsWith('## ')) {
      content = []
      result.sections.push({ title: line.slice(3).trim(), content })
    } else if (line.startsWith('# ') && result.title === '') {
      result.title = line.slice(2).trim()
    } else {
      const point = /^[-*+]\s+(.+)$/u.exec(line)?.[1]
      const last = content.at(-1)
      if (point === undefined) content.push(line)
      else if (Array.isArray(last)) last.push(point)
      else content.push([point])
    }
  }
  result.agree = agreement.join(' ')
  return result
}

const DOCUMENTS = { zh: parseDisclaimer(zh), en: parseDisclaimer(en) }

/** The disclaimer in the page's language: Chinese for any Chinese locale, else English. */
export const mt5DisclaimerDocument = (language: string): DisclaimerDocument => language.startsWith('zh') ? DOCUMENTS.zh : DOCUMENTS.en
