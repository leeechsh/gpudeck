import { expect, it, vi } from 'vitest'

it('defaults to large and preserves an explicitly saved standard size', async () => {
  vi.resetModules()
  const { api } = await import('./api')
  const initial = await api.getSettings()
  expect(initial.fontSize).toBe('large')
  await api.saveSettings({ ...initial, fontSize: 'standard' })
  expect((await api.getSettings()).fontSize).toBe('standard')
})
