import { describe, expect, it } from 'vitest'
import { canViewDetailTab } from './detailTabs'

describe('server detail tab permissions', () => {
  it('hides terminal and configuration from Hub ordinary users', () => {
    expect(canViewDetailTab('terminal', true, false)).toBe(false)
    expect(canViewDetailTab('connection', true, false)).toBe(false)
    expect(canViewDetailTab('overview', true, false)).toBe(true)
  })

  it('keeps configuration available to Hub administrators', () => {
    expect(canViewDetailTab('connection', true, true)).toBe(true)
    expect(canViewDetailTab('terminal', true, true)).toBe(true)
  })

  it('does not change standalone desktop permissions', () => {
    expect(canViewDetailTab('terminal', false, false)).toBe(true)
    expect(canViewDetailTab('connection', false, false)).toBe(true)
  })
})
