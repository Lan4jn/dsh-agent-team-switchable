// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { TeamModelSummary } from '../../src/client/TeamModelSummary.tsx'
import { en, zh } from '../../src/client/locales.ts'

function makeTranslate(dictionary: typeof zh): ComponentProps<typeof TeamModelSummary>['t'] {
  return (key, values) => dictionary[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    String(values?.[name] ?? placeholder),
  )
}

const t = makeTranslate(zh)
afterEach(cleanup)

describe('TeamModelSummary', () => {
  it('renders no fake model information when both routes are absent', () => {
    const view = render(<TeamModelSummary t={t} />)
    expect(view.container.textContent).toBe('')
  })

  it('distinguishes same model IDs from different providers for assistive technology', () => {
    render(<TeamModelSummary t={t} current={{ provider: 'p1', model: 'same-id' }} next={{ provider: 'p2', model: 'same-id' }} />)
    const current = screen.getByRole('button', { name: /最近已使用.*p1\/same-id/u })
    const next = screen.getByRole('button', { name: /下轮模型.*p2\/same-id/u })
    fireEvent.click(current)
    fireEvent.click(next)
    expect(screen.getByText('p1/same-id')).toBeTruthy()
    expect(screen.getByText('p2/same-id')).toBeTruthy()
  })

  it('shows only a known current route and omits unspecified reasoning effort', () => {
    render(<TeamModelSummary t={t} current={{ provider: 'p', model: 'current-only' }} />)
    expect(screen.getByText('current-only')).toBeTruthy()
    expect(screen.queryByText(zh['model.next'])).toBeNull()
    expect(screen.queryByText(zh['model.reasoning'])).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('p/current-only')).toBeTruthy()
  })

  it('keeps original long IDs and explicit effort lossless in expanded details', () => {
    const provider = 'long-provider-'.repeat(20)
    const model = 'long-model-'.repeat(20)
    const effort = 'explicit-effort-'.repeat(20)
    render(<TeamModelSummary t={makeTranslate(en)} current={{ provider, model, reasoningEffort: effort }} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(screen.getByText(`${provider}/${model}`)).toBeTruthy()
    expect(screen.getByText(`Reasoning effort: ${effort}`)).toBeTruthy()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(`${provider}/${model}`)).toBeNull()
  })
})
