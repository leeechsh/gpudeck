import { expect, it, vi } from 'vitest'

it('defaults to standard and preserves an explicitly saved large size', async () => {
  vi.resetModules()
  const { api } = await import('./api')
  const initial = await api.getSettings()
  expect(initial.fontSize).toBe('standard')
  await api.saveSettings({ ...initial, fontSize: 'large' })
  expect((await api.getSettings()).fontSize).toBe('large')
})
