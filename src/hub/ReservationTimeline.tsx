import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, RefreshCw, X } from 'lucide-react'
import { HubReservationSheet, ReservationRow, useHub } from './HubFeatures'
import type { Reservation } from './api'

export type ReservationSeed = { gpuIds: string[]; startsAt: string; endsAt: string }
export const dateInput = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
export function reservationPosition(reservation: Reservation, start: number, end: number) {
  const left = Math.max(start, new Date(reservation.startsAt).getTime())
  const right = Math.min(end, new Date(reservation.endsAt).getTime())
  if (!Number.isFinite(left + right) || right <= left) return null
  return { left: (left - start) / (end - start) * 100, width: (right - left) / (end - start) * 100 }
}
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
const statusText: Record<string, string> = { scheduled: '待开始', active: '进行中', overrun: '超时', completed: '已结束' }

export function ReservationTimeline({ onCreate }: { onCreate: () => void }) {
  const hub = useHub()!
  const [date, setDate] = useState(midnight)
  const [days, setDays] = useState(1)
  const [nodeId, setNodeId] = useState('')
  const [mine, setMine] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [seed, setSeed] = useState<ReservationSeed | null>(null)
  const [now, setNow] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const pageRef = useRef<HTMLDivElement>(null)
  const modalOpen = Boolean(detailId || seed)
  useEffect(() => {
    if (!modalOpen) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = pageRef.current?.querySelector<HTMLElement>('[role="dialog"], .hub-create-sheet')
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]') ?? [])
    controls()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = controls(), first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus()}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus()}
    }
    window.addEventListener('keydown', trap)
    return () => {window.removeEventListener('keydown', trap);previous?.focus()}
  }, [modalOpen])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') {setDetailId(null);setSeed(null)} }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])
  const endDate = new Date(date); endDate.setDate(endDate.getDate() + days)
  const start = date.getTime(), end = endDate.getTime()
  const slots = days === 1 ? 48 : days * 4
  const slotMs = (end - start) / slots
  const nodes = hub.nodes.filter(node => !nodeId || node.id === nodeId)
  const bookings = hub.reservations.filter(item => item.status !== 'cancelled' && (!mine || item.ownerId === hub.user.id) && (!nodeId || nodes.some(node => node.gpus.some(gpu => item.gpuIds.includes(gpu.id)))) && reservationPosition(item, start, end))
  const detail = hub.reservations.find(item => item.id === detailId)
  const ownBookings = hub.reservations.filter(item => item.ownerId === hub.user.id && !['cancelled', 'completed'].includes(item.status))
  const move = (direction: number) => { const next = new Date(date); next.setDate(next.getDate() + direction * days); setDate(next) }
  const online = (lastSeenAt?: string) => !!lastSeenAt && now - new Date(lastSeenAt).getTime() < 30000
  return <div ref={pageRef} className="detail-page hub-calendar-page">
    <div className="hub-calendar-toolbar timeline-toolbar">
      <div><strong>GPU 资源时间表</strong><small>预约与实际占用分别显示 · 点击空白时段预约 · 时区 {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></div>
      <div><button className="button button--secondary" disabled={refreshing} onClick={async () => {setRefreshing(true);setError('');try {await hub.refresh()} catch(cause) {setError(cause instanceof Error ? cause.message : '刷新失败')} finally {setRefreshing(false)}}}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/>刷新</button><button className="button button--primary" onClick={onCreate}><Plus size={15}/>预约 GPU</button></div>
    </div>
    <div className="timeline-controls">
      <button className="icon-button" aria-label="上一时段" onClick={() => move(-1)}><ChevronLeft size={16}/></button><button className="button button--secondary" onClick={() => setDate(midnight())}>今天</button><button className="icon-button" aria-label="下一时段" onClick={() => move(1)}><ChevronRight size={16}/></button>
      <input aria-label="查看日期" type="date" value={dateInput(date).slice(0,10)} onChange={event => { if (event.target.value) setDate(new Date(`${event.target.value}T00:00:00`)) }}/>
      <div className="timeline-views" role="group" aria-label="时间范围">{[[1,'日'],[3,'3 天'],[7,'周']].map(([value,label]) => <button className="button button--secondary" aria-pressed={days === value} key={value} onClick={() => setDays(Number(value))}>{label}</button>)}</div>
      <select aria-label="服务器筛选" value={nodeId} onChange={event => setNodeId(event.target.value)}><option value="">全部服务器</option>{hub.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select>
      <label><input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)}/>只看我的预约</label>
    </div>
    {error && <p role="alert" className="hub-form-error">{error}</p>}
    <div className="timeline-legend">{Object.entries(statusText).map(([status,label]) => <span key={status}><i className={`timeline-status timeline-status--${status}`}/>{label}</span>)}<span>边框强调：我的预约</span><span>空白时段：无预约，实际占用请看行头</span></div>
    <section className="panel timeline-scroll" aria-label="GPU 预约时间表"><div className="timeline-grid" style={{minWidth: days === 1 ? 1440 : days === 3 ? 1440 : 1900}}>
      <header className="timeline-header"><div className="timeline-label">服务器 / GPU</div><div className="timeline-axis">{Array.from({length: days === 1 ? 24 : days * 4},(_,index) => {
        const time = new Date(start + index * (end-start)/(days === 1 ? 24 : days*4))
        return <span key={index} style={{left: `${index/(days === 1 ? 24 : days*4)*100}%`}}>{days === 1 ? `${String(time.getHours()).padStart(2,'0')}:00` : `${time.getMonth()+1}/${time.getDate()} ${String(time.getHours()).padStart(2,'0')}:00`}</span>
      })}</div></header>
      {nodes.map(node => <div key={node.id}><div className="timeline-node"><strong>{node.name}</strong><small>{online(node.lastSeenAt) ? '在线' : '离线'} · {node.gpus.length} 张 GPU</small></div>
        {node.gpus.map(gpu => <div className="timeline-row" key={gpu.id}>
          <div className="timeline-label"><strong>GPU {gpu.index} · {gpu.name}</strong><small>{(gpu.memoryTotalMb/1024).toFixed(0)} GB · {gpu.maintenance ? '维护' : gpu.missing ? '不可用' : !online(node.lastSeenAt) ? '离线' : gpu.processes.length || (gpu.memoryUsedMb ?? 0) > 256 ? '实际有占用' : '实际空闲'}</small></div>
          <div className="timeline-track" style={{backgroundSize:`${100/slots}% 100%`}}>
            <div className="timeline-slots">{Array.from({length:slots},(_,index) => {
              const slotStart=start+index*slotMs, slotEnd=slotStart+slotMs
              const occupied=hub.reservations.some(item => !['cancelled','completed'].includes(item.status) && item.gpuIds.includes(gpu.id) && new Date(item.startsAt).getTime()<slotEnd && new Date(item.endsAt).getTime()>slotStart)
              const disabled=slotEnd<=Math.ceil(now/1800000)*1800000 || occupied || gpu.maintenance || gpu.missing || !online(node.lastSeenAt)
              return <button key={index} disabled={disabled} aria-label={`预约 ${node.name} GPU ${gpu.index} ${new Date(slotStart).toLocaleString('zh-CN')}`} onClick={() => {
                const startsAt=Math.max(slotStart, Math.ceil(Date.now()/1800000)*1800000)
                setSeed({gpuIds:[gpu.id],startsAt:dateInput(new Date(startsAt)),endsAt:dateInput(new Date(Math.min(startsAt+3600000,slotEnd > startsAt ? slotEnd : startsAt+1800000)))})
              }}/>
            })}</div>
            {bookings.filter(item => item.gpuIds.includes(gpu.id)).map(item => {
              const position=reservationPosition(item,start,end)!
              return <button key={item.id} className={`timeline-booking timeline-booking--${item.status} ${item.ownerId===hub.user.id?'is-mine':''} ${hovered===item.id?'is-highlighted':''}`} style={{left:`${position.left}%`,width:`${position.width}%`}} onMouseEnter={() => setHovered(item.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(item.id)} onBlur={() => setHovered(null)} onClick={() => setDetailId(item.id)} title={`${item.ownerName} · ${item.projectName}\n${new Date(item.startsAt).toLocaleString('zh-CN')} — ${new Date(item.endsAt).toLocaleString('zh-CN')}`}><strong>{new Date(item.startsAt).getTime()<start?'‹ ':''}{item.ownerName} · {item.projectName}{new Date(item.endsAt).getTime()>end?' ›':''}</strong><small>{statusText[item.status]} · {item.gpuIds.length} GPU</small></button>
            })}
            {now>=start && now<end && <span className="timeline-now" style={{left:`${(now-start)/(end-start)*100}%`}} aria-label="当前时间"/>}
          </div>
        </div>)}
      </div>)}
      {!nodes.length && <div className="hub-feature-empty">暂无已接入服务器</div>}
    </div></section>
    <section className="panel hub-booking-list timeline-mobile-list"><header><strong>所选时段预约</strong></header>{bookings.filter(item => !nodeId || hub.nodes.find(node => node.id===nodeId)?.gpus.some(gpu => item.gpuIds.includes(gpu.id))).sort((a,b) => a.startsAt.localeCompare(b.startsAt)).map(item => <button className="timeline-mobile-booking" key={item.id} onClick={() => setDetailId(item.id)}><strong>{item.ownerName} · {item.projectName}</strong><span>{new Date(item.startsAt).toLocaleString('zh-CN')} — {new Date(item.endsAt).toLocaleString('zh-CN')}</span><small>{item.gpuIds.length} GPU · {statusText[item.status]}</small></button>)}{!bookings.length && <p>所选时段暂无预约</p>}</section>
    <section className="panel hub-booking-list"><header><strong>我的预约</strong><small>{ownBookings.length} 项待开始或进行中</small></header>{ownBookings.length ? ownBookings.map(item => <ReservationRow key={item.id} reservation={item}/>) : <p className="hub-feature-empty">暂无我的预约，点击时间表空白区域创建。</p>}</section>
    {seed && <HubReservationSheet initial={seed} onClose={() => setSeed(null)}/>}
    {detail && <div className="scrim" onMouseDown={event => event.target===event.currentTarget && setDetailId(null)}><section className="sheet reservation-sheet" role="dialog" aria-modal="true" aria-label="预约详情"><header className="sheet__header"><h2>预约详情</h2><button className="icon-button" aria-label="关闭预约详情" onClick={() => setDetailId(null)}><X size={17}/></button></header><div className="reservation-body"><ReservationRow reservation={detail}/><strong>预约 GPU</strong>{hub.nodes.flatMap(node => node.gpus.filter(gpu => detail.gpuIds.includes(gpu.id)).map(gpu => <p key={gpu.id}>{node.name} · GPU {gpu.index} · {gpu.name}</p>))}</div></section></div>}
  </div>
}
