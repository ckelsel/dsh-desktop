import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Mt5Disclaimer } from '../src/client/mt5-disclaimer.tsx'
import { mt5DisclaimerDocument, parseDisclaimer, type DisclaimerContent, type DisclaimerDocument } from '../src/client/mt5-disclaimer-text.ts'

// The real dialog portals into document.body, which a server render lacks; these render in place.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean, title: string, children: ReactNode, footer: ReactNode }) =>
    open ? createElement('div', { role: 'dialog', 'aria-label': title }, children, footer) : null,
  SegmentedControl: ({ value, options }: { value: string, options: ReadonlyArray<{ value: string, label: string }> }) =>
    createElement('div', { role: 'tablist' }, options.map(option => createElement('button', { key: option.value, role: 'tab', 'aria-selected': option.value === value }, option.label))),
  Button: ({ children }: { children: ReactNode }) => createElement('button', null, children),
  Checkbox: ({ label }: { label: string }) => createElement('label', null, label),
}))

/** How many paragraphs and points a document has, and where: what both languages must share. */
const shape = (document: DisclaimerDocument) => {
  const outline = (content: DisclaimerContent) => content.map(item => typeof item === 'string' ? 'p' : item.length)
  return { intro: outline(document.intro), sections: document.sections.map(section => outline(section.content)) }
}

describe('trading risk disclaimer', () => {
  const zh = mt5DisclaimerDocument('zh-CN')
  const en = mt5DisclaimerDocument('en-US')

  it('reads a title, an introduction, sections and the sentence to agree to from both files', () => {
    for (const document of [zh, en]) {
      expect(document.title).not.toBe('')
      expect(document.intro.length).toBeGreaterThan(0)
      expect(document.sections.length).toBeGreaterThan(0)
      expect(document.sections.filter(section => section.title === '' || section.content.length === 0)).toEqual([])
      expect(document.agree).not.toBe('')
    }
    expect(zh).not.toEqual(en)
  })

  it('keeps the two languages in step: the same sections, paragraphs and points', () => {
    expect(shape(en)).toEqual(shape(zh))
  })

  it('opens in the page\'s language, with the switch to the other version and the buttons the text names', () => {
    const render = (language: string, accept?: () => Promise<void>) =>
      renderToStaticMarkup(createElement(Mt5Disclaimer, { open: true, language, onClose: () => undefined, onAccept: accept }))
    const chinese = render('zh-CN', async () => undefined)
    expect(chinese).toContain(`aria-label="${zh.title}"`)
    expect(chinese).toContain('aria-selected="true">中文<')
    expect(chinese).toContain('aria-selected="false">English<')
    expect(chinese).toContain(zh.sections[0]!.title)
    expect(chinese).toContain(zh.agree)
    expect(chinese).toContain('同意并启用交易')
    expect(chinese).not.toContain(en.sections[0]!.title)
    const english = render('en-US')
    expect(english).toContain(`aria-label="${en.title}"`)
    expect(english).toContain('aria-selected="true">English<')
    expect(english).toContain(en.sections[0]!.title)
    // Shown to a user who agreed already: nothing to tick, only Close.
    expect(english).not.toContain(en.agree)
    expect(english).toContain('>Close<')
  })

  it('reads its Markdown subset, drops comments and shows anything else as text', () => {
    expect(parseDisclaimer([
      '<!-- A note for editors,', 'over two lines. -->', '# Title', '', 'Intro.', '- an intro point', '',
      '## 1. First', '', '- a', '* b', '', 'A **paragraph**.', '- c', '### Not a section', '', '---', '', 'I agree.', '',
    ].join('\r\n'))).toEqual({
      title: 'Title',
      intro: ['Intro.', ['an intro point']],
      sections: [{ title: '1. First', content: [['a', 'b'], 'A **paragraph**.', ['c'], '### Not a section'] }],
      agree: 'I agree.',
    })
  })
})
