// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HubProvider } from './HubFeatures'
import { hubApi, type Reservation, type User } from './api'
import { ReservationTimeline, reservationPosition } from './ReservationTimeline'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./api', () => ({hubApi: { resources: vi.fn(), reservations: vi.fn(), action: vi.fn(), createReservation: vi.fn() }}))
afterEach(() => vi.clearAllMocks())
const user = {id:'alice',username:'alice',linuxUsername:'alice',displayName:'Alice',role:'member'} as User
const today = new Date(); today.setHours(0,0,0,0)
const booking = {id:'booking',ownerId:'bob',ownerName:'Bob',projectName:'Train',purpose:'Training',gpuIds:['g0','g1'],startsAt:new Date(today.getTime()+3600000).toISOString(),endsAt:new Date(today.getTime()+7200000).toISOString(),status:'scheduled'} as Reservation
describe('reservation timeline', () => {
  it('clips crossing bookings and excludes non-overlapping or invalid ranges', () => {
    expect(reservationPosition({...booking,startsAt:new Date(0).toISOString(),endsAt:new Date(200).toISOString()},100,300)).toEqual({left:0,width:50})
    expect(reservationPosition({...booking,startsAt:new Date(200).toISOString(),endsAt:new Date(400).toISOString()},100,300)).toEqual({left:50,width:50})
    expect(reservationPosition({...booking,startsAt:new Date(300).toISOString(),endsAt:new Date(400).toISOString()},100,300)).toBeNull()
    expect(reservationPosition({...booking,startsAt:'invalid'},100,300)).toBeNull()
  })
  it('renders each GPU, links multi-card highlights, opens details without another owner actions, and prefills a free slot', async () => {
    vi.mocked(hubApi.resources).mockResolvedValue({serverTime:new Date().toISOString(),nodes:[{id:'node',name:'Lab',hostname:'lab',lastSeenAt:new Date().toISOString(),gpus:[0,1].map(index => ({id:`g${index}`,uuid:`uuid${index}`,index,name:'L40S',memoryTotalMb:46080,processes:[],maintenance:false,missing:false}))}]})
    vi.mocked(hubApi.reservations).mockResolvedValue([booking])
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
    try {
      await act(async () => root.render(<HubProvider user={user} onLogout={() => {}}><ReservationTimeline onCreate={() => {}}/></HubProvider>))
      expect(host.querySelectorAll('.timeline-row')).toHaveLength(2)
      expect(host.querySelectorAll('.timeline-booking')).toHaveLength(2)
      await act(async () => (host.querySelector('.timeline-booking') as HTMLButtonElement).focus())
      expect(host.querySelectorAll('.timeline-booking.is-highlighted')).toHaveLength(2)
      await act(async () => (host.querySelector('.timeline-booking') as HTMLButtonElement).click())
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain('GPU 1')
      expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('签到')
      await act(async () => (host.querySelector('[aria-label="关闭预约详情"]') as HTMLButtonElement).click())
      await act(async () => (host.querySelector('[aria-label="下一时段"]') as HTMLButtonElement).click())
      await act(async () => (host.querySelector('.timeline-slots button:not(:disabled)') as HTMLButtonElement).click())
      expect(host.querySelector('.hub-gpu-picker .is-selected')?.textContent).toContain('GPU 0')
      const start=host.querySelector('input[name="startsAt"]') as HTMLInputElement
      const end=host.querySelector('input[name="endsAt"]') as HTMLInputElement
      expect(new Date(end.value).getTime()).toBeGreaterThan(new Date(start.value).getTime())
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})))
      expect(host.querySelector('.hub-create-sheet')).toBeNull()
    } finally {await act(async () => root.unmount());host.remove()}
  })
})
