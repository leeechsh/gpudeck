import { describe, expect, it } from 'vitest'
import { reservationChecks } from './reservationChecks'
import { reservationWindowStart } from './reservationTime'
import type { Node, Reservation, User } from './api'
const now=Date.now(), start=now+3600000, middle=start+3600000, end=middle+3600000
const user={id:'alice',concurrentGpuLimit:2} as User
const nodes: Node[]=[{id:'n',name:'Lab',hostname:'lab',lastSeenAt:new Date(now).toISOString(),gpus:[0,1,2].map(index=>({id:`g${index}`,uuid:`uuid${index}`,index,name:'L40S',memoryTotalMb:46080,processes:[],maintenance:false,missing:false}))}]
const item=(id:string,gpu:string,a:number,b:number):Reservation=>({id,ownerId:'alice',ownerName:'Alice',projectName:'Train',purpose:'Training',status:'scheduled',gpuIds:[gpu],startsAt:new Date(a).toISOString(),endsAt:new Date(b).toISOString()})
const check=(ids:string[],a:number,b:number,bookings:Reservation[])=>reservationChecks(ids,new Date(a).toISOString(),new Date(b).toISOString(),bookings,nodes,user,now)
describe('reservation checks',()=>{
  it('allows the current half-hour window but rejects earlier windows and elapsed ends',()=>{
    const current=reservationWindowStart(now)
    expect(check(['g0'],current,current+3600000,[]).errors).toEqual([])
    expect(check(['g0'],current-1,current+3600000,[]).errors).toContain('开始时间必须在当前半小时窗口或未来 14 天内')
    expect(check(['g0'],current,now,[]).errors).not.toEqual([])
    const boundary=current+1800000
    expect(reservationWindowStart(boundary)).toBe(boundary)
    expect(reservationChecks(['g0'],new Date(current).toISOString(),new Date(boundary+3600000).toISOString(),[],nodes,user,boundary).errors).toContain('开始时间必须在当前半小时窗口或未来 14 天内')
  })
  it('reports exact card, owner and time; touching boundaries are allowed',()=>{
    expect(check(['g0'],start,end,[item('a','g0',middle,end)]).errors[0]).toContain('Lab · GPU 0 与 Alice')
    expect(check(['g0'],start,middle,[item('a','g0',middle,end)]).errors).toEqual([])
  })
  it('uses actual concurrent peak rather than all cards seen across the interval',()=>{
    expect(check(['g2'],start,end,[item('a','g0',start,middle),item('b','g1',middle,end)]).errors).toEqual([])
    expect(check(['g2'],start,end,[item('a','g0',start,end),item('b','g1',middle,end)]).errors).toContain('并发预约将达到 3 张 GPU，超过你的 2 张上限')
  })
  it('ignores cancelled/completed bookings and checks duration/future horizon',()=>{
    expect(check(['g0'],start,end,[{...item('a','g0',start,end),status:'cancelled'},{...item('b','g0',start,end),status:'completed'}]).errors).toEqual([])
    expect(check(['g0'],start,start+49*3600000,[]).errors).toContain('每次预约最长 48 小时')
    expect(check(['g0'],now+15*86400000,now+15*86400000+3600000,[]).errors).toContain('开始时间必须在当前半小时窗口或未来 14 天内')
  })
  it('distinguishes actual occupancy warnings from reservation conflicts',()=>{
    const result=reservationChecks(['g0'],new Date(start).toISOString(),new Date(end).toISOString(),[],[{...nodes[0],gpus:[{...nodes[0].gpus[0],memoryUsedMb:4096}]}],user,now)
    expect(result.errors).toEqual([]);expect(result.warnings[0]).toContain('预约不会停止现有任务')
  })
})
