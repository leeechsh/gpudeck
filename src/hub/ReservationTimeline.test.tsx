// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HubProvider, HubReservationSheet } from './HubFeatures'
import { HubApiError, hubApi, type Reservation, type User } from './api'
import { ReservationTimeline, dateInput, reservationPosition } from './ReservationTimeline'
import { reservationWindowStart } from './reservationTime'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./api', async () => ({...await vi.importActual('./api'),hubApi: { me: vi.fn(), resources: vi.fn(), reservations: vi.fn(), action: vi.fn(), createReservation: vi.fn() }}))
afterEach(() => vi.clearAllMocks())
const user = {id:'alice',username:'alice',linuxUsername:'alice',displayName:'Alice',role:'member',concurrentGpuLimit:2} as User
beforeEach(() => vi.mocked(hubApi.me).mockResolvedValue(user))
const today = new Date(); today.setHours(0,0,0,0)
const booking = {id:'booking',ownerId:'bob',ownerName:'Bob',projectName:'Train',purpose:'Training',gpuIds:['g0','g1'],startsAt:new Date(today.getTime()+3600000).toISOString(),endsAt:new Date(today.getTime()+7200000).toISOString(),status:'scheduled'} as Reservation
describe('reservation timeline', () => {
  it('enables and prefills the current window instead of skipping to the next one', async () => {
    const clock=vi.spyOn(Date,'now').mockReturnValue(today.getTime()+15*3600000+47*60000)
    const current=reservationWindowStart(Date.now())
    vi.mocked(hubApi.resources).mockResolvedValue({serverTime:new Date(Date.now()).toISOString(),nodes:[{id:'node',name:'Lab',hostname:'lab',lastSeenAt:new Date(Date.now()).toISOString(),gpus:[{id:'g0',uuid:'uuid0',index:0,name:'L40S',memoryTotalMb:46080,processes:[],maintenance:false,missing:false}]}]})
    vi.mocked(hubApi.reservations).mockResolvedValue([])
    const host=document.createElement('div'),root=createRoot(host)
    try {
      await act(async()=>root.render(<HubProvider user={user} onLogout={()=>{}}><ReservationTimeline onCreate={()=>{}}/></HubProvider>))
      const first=host.querySelector('.timeline-slots button:not(:disabled)') as HTMLButtonElement
      expect(Array.from(host.querySelectorAll('.timeline-slots button')).indexOf(first)).toBe(31)
      await act(async()=>first.click())
      expect((host.querySelector('input[name="startsAt"]') as HTMLInputElement).value).toBe(dateInput(new Date(current)))
      expect(host.querySelector('input[type="datetime-local"]')).toBeNull()
      expect(host.textContent).not.toContain('开始时间必须在')
    } finally {await act(async()=>root.unmount());clock.mockRestore()}
  })
  it('does not retry creation when only the post-success refresh fails', async () => {
    const startsAt=dateInput(new Date(Date.now()+3600000)),endsAt=dateInput(new Date(Date.now()+7200000))
    vi.mocked(hubApi.resources).mockResolvedValueOnce({serverTime:new Date().toISOString(),nodes:[{id:'node',name:'Lab',hostname:'lab',lastSeenAt:new Date().toISOString(),gpus:[{id:'g0',uuid:'uuid0',index:0,name:'L40S',memoryTotalMb:46080,processes:[],maintenance:false,missing:false}]}]}).mockRejectedValueOnce(new Error('Refresh failed'))
    vi.mocked(hubApi.reservations).mockResolvedValue([])
    vi.mocked(hubApi.createReservation).mockResolvedValueOnce({id:'created'})
    const host=document.createElement('div');const root=createRoot(host);const close=vi.fn()
    try {
      await act(async()=>root.render(<HubProvider user={user} onLogout={()=>{}}><HubReservationSheet initial={{gpuIds:['g0'],startsAt,endsAt}} onClose={close}/></HubProvider>))
      await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
      expect(hubApi.createReservation).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce()
      expect(host.querySelector('.reservation-submit-error')).toBeNull()
    } finally {await act(async()=>root.unmount())}
  })
  it('refreshes after a server race conflict and retains the form with detailed blocking feedback', async () => {
    const startsAt=dateInput(new Date(Date.now()+3600000)),endsAt=dateInput(new Date(Date.now()+7200000))
    const resources={serverTime:new Date().toISOString(),nodes:[{id:'node',name:'Lab',hostname:'lab',lastSeenAt:new Date().toISOString(),gpus:[{id:'g0',uuid:'uuid0',index:0,name:'L40S',memoryTotalMb:46080,processes:[],maintenance:false,missing:false}]}]}
    vi.mocked(hubApi.resources).mockResolvedValue(resources)
    vi.mocked(hubApi.reservations).mockResolvedValueOnce([]).mockResolvedValue([{...booking,startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString()}])
    vi.mocked(hubApi.createReservation).mockRejectedValueOnce(new HubApiError('GPU 0 已被预约',409))
    const host=document.createElement('div');const root=createRoot(host)
    try {
      await act(async()=>root.render(<HubProvider user={user} onLogout={()=>{}}><HubReservationSheet initial={{gpuIds:['g0'],startsAt,endsAt}} onClose={()=>{throw new Error('must stay open')}}/></HubProvider>))
      await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
      expect(hubApi.createReservation).toHaveBeenCalledOnce()
      expect(host.textContent).toContain('预约状态已刷新')
      expect(host.textContent).toContain('Lab · GPU 0 与 Bob')
      expect((host.querySelector('button[type="submit"],.sheet__footer .button--primary') as HTMLButtonElement).disabled).toBe(true)
    } finally {await act(async()=>root.unmount())}
  })
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
