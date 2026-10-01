// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { HubProvider } from './HubFeatures'
import { hubApi, type User } from './api'
import { api } from '../services/api'

vi.mock('../components/SshTerminal', () => ({ SshTerminal: () => null }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
})

it.each(['admin', 'member'] as const)('handles an empty fleet for %s without exposing unauthorized registration', async role => {
  const user = { id: 'user', username: role, displayName: role, role, concurrentGpuLimit: 2, mustChangePassword: false } as User
  vi.spyOn(hubApi, 'resources').mockResolvedValue({ nodes: [], serverTime: new Date().toISOString() })
  vi.spyOn(hubApi, 'reservations').mockResolvedValue([])
  vi.spyOn(hubApi, 'me').mockResolvedValue(user)
  vi.spyOn(hubApi, 'adminNodes').mockResolvedValue({ nodes: [] })
  vi.spyOn(hubApi, 'adminUsers').mockResolvedValue({ users: [] })
  vi.spyOn(hubApi, 'globalSettings').mockResolvedValue({ concurrentGpuLimit: 2 })
  vi.spyOn(api, 'listServers').mockResolvedValue([])
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(<HubProvider user={user} onLogout={() => {}}><App /></HubProvider>))
  expect(host.textContent).toContain('连接第一台服务器')
  expect(host.querySelector('button[aria-label="关于 GPUDeck"]')).toBeNull()
  expect(host.querySelector('div.brand[aria-label="GPUDeck"]')).not.toBeNull()
  const admin = [...host.querySelectorAll('button')].find(button => button.textContent === '管理面板')
  if (role !== 'admin') {
    expect(admin).toBeUndefined()
    expect([...host.querySelectorAll('button')].some(button => button.textContent === '注册服务器节点')).toBe(false)
    return
  }
  expect(admin).toBeDefined()
  await act(async () => admin!.click())
  expect(host.textContent).toContain('Hub 管理面板')
  expect(host.textContent).not.toContain('连接第一台服务器')
  const register = [...host.querySelectorAll('button')].find(button => button.textContent === '注册服务器节点')
  expect(register).toBeDefined()
  await act(async () => register!.click())
  expect(host.querySelector('.hub-node-sheet')).not.toBeNull()
  expect(host.textContent).toContain('生成节点凭据')
})
