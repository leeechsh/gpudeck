import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState, shouldShowGuidedEmptyState } from '../App'

describe('EmptyState', () => {
  it('keeps onboarding visible above the first-server action', () => {
    const markup = renderToStaticMarkup(<EmptyState onboarding={<section>五步新手引导</section>} onAdd={vi.fn()} onImport={vi.fn()} />)

    expect(markup).toContain('五步新手引导')
    expect(markup).toContain('连接第一台服务器')
    expect(markup).toContain('添加服务器')
    expect(markup.indexOf('五步新手引导')).toBeLessThan(markup.indexOf('连接第一台服务器'))
  })

  it('hides desktop connection actions in Hub mode', () => {
    const markup = renderToStaticMarkup(
      <EmptyState showConnectionActions={false} onAdd={vi.fn()} onImport={vi.fn()} />,
    )

    expect(markup).toContain('请联系管理员在管理面板注册服务器节点')
    expect(markup).not.toContain('添加服务器')
    expect(markup).not.toContain('导入配置')
  })

  it('uses the guided empty state only for the zero-server fleet overview', () => {
    expect(shouldShowGuidedEmptyState('fleet', 0)).toBe(true)
    expect(shouldShowGuidedEmptyState('fleet', 1)).toBe(false)
    expect(shouldShowGuidedEmptyState('projects', 0)).toBe(false)
  })
})
