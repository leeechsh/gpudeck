// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { HubProvider, ReservationRow } from './HubFeatures'
import { hubApi, type Reservation, type User } from './api'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./api', async () => ({ ...await vi.importActual('./api'), hubApi: { me: vi.fn(), resources: vi.fn(), reservations: vi.fn() } }))

it('removes manual check-in and displays automatic usage detection', async () => {
  const host = document.createElement('div'), root = createRoot(host)
  const user = { id: 'alice', username: 'alice', linuxUsername: 'alice', displayName: 'Alice', role: 'member', concurrentGpuLimit: 2 } as User
  vi.mocked(hubApi.me).mockResolvedValue(user)
  vi.mocked(hubApi.resources).mockResolvedValue({ nodes: [], serverTime: new Date().toISOString() })
  vi.mocked(hubApi.reservations).mockResolvedValue([])
  const render = (reservation: Reservation) => root.render(<HubProvider user={user} onLogout={() => {}}><ReservationRow reservation={reservation}/></HubProvider>)
  const booking: Reservation = { id: 'booking', ownerId: 'alice', ownerName: 'Alice', gpuIds: ['gpu'], startsAt: new Date().toISOString(), endsAt: new Date().toISOString(), projectName: 'Training', purpose: 'Test', status: 'scheduled' }
  await act(async () => render(booking))
  expect(host.textContent).not.toContain('签到')
  expect(host.querySelector('[aria-label="取消预约"]')).not.toBeNull()
  await act(async () => render({ ...booking, status: 'active' }))
  expect(host.textContent).toContain('待检测使用')
  expect(host.textContent).toContain('结束')
  await act(async () => render({ ...booking, status: 'active', checkedInAt: new Date().toISOString() }))
  expect(host.textContent).toContain('已检测到使用')
  await act(async () => root.unmount())
})
