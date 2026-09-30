// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalReservationSettings } from './GlobalReservationSettings'
import { hubApi } from './api'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./api', () => ({ hubApi: { globalSettings: vi.fn(), saveGlobalSettings: vi.fn() } }))
afterEach(() => vi.resetAllMocks())

async function setup(onSaved = vi.fn().mockResolvedValue(undefined)) {
  const host = document.createElement('div'), root = createRoot(host)
  await act(async () => root.render(<GlobalReservationSettings onSaved={onSaved}/>))
  const input = host.querySelector('input')!
  const change = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = async () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  return { host, input, change, submit, close: () => act(async () => root.unmount()) }
}
describe('global reservation settings', () => {
  it('loads the current limit and applies a change to all accounts', async () => {
    vi.mocked(hubApi.globalSettings).mockResolvedValue({ concurrentGpuLimit: 2 })
    vi.mocked(hubApi.saveGlobalSettings).mockResolvedValue({ concurrentGpuLimit: 4, updatedUserCount: 42 })
    const refresh = vi.fn().mockResolvedValue(undefined), ui = await setup(refresh)
    try {
      expect(ui.input.value).toBe('2')
      expect(ui.host.textContent).toContain('包含管理员')
      await ui.change('4'); await ui.submit()
      expect(hubApi.saveGlobalSettings).toHaveBeenCalledWith(4)
      expect(ui.host.querySelector('[role="status"]')?.textContent).toContain('42 个账号')
      expect(refresh).toHaveBeenCalledOnce()
      expect(ui.host.querySelector('button')!.disabled).toBe(true)
    } finally { await ui.close() }
  })
  it('rejects invalid input and keeps the draft when saving fails', async () => {
    vi.mocked(hubApi.globalSettings).mockResolvedValue({ concurrentGpuLimit: 2 })
    const ui = await setup()
    try {
      for (const value of ['0', '15', '1.5', '']) {
        await ui.change(value); await ui.submit()
        expect(hubApi.saveGlobalSettings).not.toHaveBeenCalled()
        expect(ui.host.querySelector('[role="alert"]')).not.toBeNull()
      }
      vi.mocked(hubApi.saveGlobalSettings).mockRejectedValue(new Error('保存失败'))
      await ui.change('4'); await ui.submit()
      expect(ui.input.value).toBe('4')
      expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
      expect(ui.host.querySelector('button')!.disabled).toBe(false)
    } finally { await ui.close() }
  })
  it('allows retrying a failed load', async () => {
    vi.mocked(hubApi.globalSettings).mockRejectedValueOnce(new Error('连接失败')).mockResolvedValueOnce({ concurrentGpuLimit: 3 })
    const ui = await setup()
    try {
      expect(ui.input.disabled).toBe(true)
      await act(async () => (ui.host.querySelector('[role="alert"] button') as HTMLButtonElement).click())
      expect(ui.input.value).toBe('3'); expect(ui.input.disabled).toBe(false)
    } finally { await ui.close() }
  })
  it('does not report a saved change as failed when only refresh fails', async () => {
    vi.mocked(hubApi.globalSettings).mockResolvedValue({ concurrentGpuLimit: 2 })
    vi.mocked(hubApi.saveGlobalSettings).mockResolvedValue({ concurrentGpuLimit: 4, updatedUserCount: 42 })
    const ui = await setup(vi.fn().mockRejectedValue(new Error('刷新失败')))
    try {
      await ui.change('4'); await ui.submit()
      expect(ui.host.querySelector('[role="alert"]')).toBeNull()
      expect(ui.host.textContent).toContain('设置已保存为 4 张 GPU')
      expect(hubApi.saveGlobalSettings).toHaveBeenCalledOnce()
    } finally { await ui.close() }
  })
})
