import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, RefreshCw, X } from 'lucide-react'
import { HubReservationSheet, ReservationRow, useHub } from './HubFeatures'
import type { Reservation } from './api'
import { reservationChecks } from './reservationChecks'
import { reservationWindowStart } from './reservationTime'
import type { PointerEvent as ReactPointerEvent } from 'react'

export type ReservationSeed = { gpuIds: string[]; startsAt: string; endsAt: string }
export const dateInput = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
export function reservationPosition(reservation: Pick<Reservation,'startsAt'|'endsAt'>, start: number, end: number) {
  const left = Math.max(start, new Date(reservation.startsAt).getTime())
  const right = Math.min(end, new Date(reservation.endsAt).getTime())
  if (!Number.isFinite(left + right) || right <= left) return null
  return { left: (left - start) / (end - start) * 100, width: (right - left) / (end - start) * 100 }
}
const HOUR = 3600000
const LABEL_WIDTH = 210
export function centeredTimelineStart(time: number, hours: number) {
  return reservationWindowStart(time) - hours * 1.5 * HOUR
}
const statusText: Record<string, string> = { scheduled: '待开始', active: '进行中', overrun: '超时', completed: '已结束' }

export function ReservationTimeline({ onCreate }: { onCreate: () => void }) {
  const hub = useHub()!
  const [hours, setHours] = useState(24)
  const [start, setStart] = useState(() => centeredTimelineStart(Date.now(), 24))
  const [viewportWidth, setViewportWidth] = useState(1200)
  const measuredWidth = useRef(1200)
  const scrollRef = useRef<HTMLElement>(null)
  const pendingCenter = useRef<number | null>(Date.now())
  const viewportCenter = useRef(Date.now())
  const pendingScroll = useRef<number | null>(null)
  const rebasing = useRef(false)
  const programmaticScroll = useRef(false)
  const [nodeId, setNodeId] = useState('')
  const [mine, setMine] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [seed, setSeed] = useState<ReservationSeed | null>(null)
  const [selection, setSelection] = useState<ReservationSeed | null>(null)
  const dragRef = useRef<{ pointerId:number; anchorTime:number; anchorGpu:string; x:number; y:number; moved:boolean; seed:ReservationSeed } | null>(null)
  const ignoreClickUntil = useRef(0)
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
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pageRef.current?.querySelector('.hub-create-sheet[aria-busy="true"]')) {setDetailId(null);setSeed(null);dragRef.current=null;setSelection(null)} }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])
  const windowMs = hours * HOUR
  const end = start + windowMs * 3
  const slots = hours * 6
  const slotMs = (end - start) / slots
  const windowWidth = Math.max(1, viewportWidth - LABEL_WIDTH)
  const [visibleStart, setVisibleStart] = useState(() => Date.now() - 12 * HOUR)
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const resize = () => {
      if (element.clientWidth > LABEL_WIDTH && element.clientWidth !== measuredWidth.current) {
        measuredWidth.current = element.clientWidth
        pendingCenter.current = viewportCenter.current
        setViewportWidth(element.clientWidth)
      }
    }
    resize()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    // Browser scroll events are asynchronous. Do not interpret scroll events
    // from the previous geometry as user navigation during a resize/rebase.
    programmaticScroll.current = typeof window.requestAnimationFrame === 'function'
    if (pendingScroll.current !== null && pendingCenter.current === null) {
      element.scrollLeft = pendingScroll.current
      pendingScroll.current = null
    } else {
      // Always restore the logical center when geometry changes. In StrictMode
      // effects can replay before the measured-width state update commits.
      element.scrollLeft = ((pendingCenter.current ?? viewportCenter.current) - start) / windowMs * windowWidth - windowWidth / 2
      pendingCenter.current = null
    }
    setVisibleStart(start + element.scrollLeft / windowWidth * windowMs)
    viewportCenter.current = start + element.scrollLeft / windowWidth * windowMs + windowMs / 2
    rebasing.current = false
    if (programmaticScroll.current) {
      const frame = window.requestAnimationFrame(() => { programmaticScroll.current = false })
      return () => window.cancelAnimationFrame(frame)
    }
  }, [start, windowWidth, windowMs])
  const center = (time: number, nextHours = hours) => {
    pendingCenter.current = time
    pendingScroll.current = null
    setHours(nextHours)
    setStart(centeredTimelineStart(time, nextHours))
    // Clicking "now" again must work even if the buffered start is unchanged.
    if (start === centeredTimelineStart(time, nextHours) && hours === nextHours && scrollRef.current) {
      scrollRef.current.scrollLeft = (time - start) / windowMs * windowWidth - windowWidth / 2
      pendingCenter.current = null
      setVisibleStart(time - windowMs / 2)
    }
  }
  const scroll = () => {
    const element = scrollRef.current
    if (!element || rebasing.current || programmaticScroll.current) return
    setVisibleStart(start + element.scrollLeft / windowWidth * windowMs)
    viewportCenter.current = start + element.scrollLeft / windowWidth * windowMs + windowMs / 2
    // Recycle three windows instead of appending unbounded DOM nodes.
    if (dragRef.current) return
    const direction = element.scrollLeft < windowWidth / 2 ? -1 : element.scrollLeft > windowWidth * 1.5 ? 1 : 0
    if (direction) {
      rebasing.current = true
      pendingScroll.current = element.scrollLeft - direction * windowWidth
      setStart(current => current + direction * windowMs)
    }
  }
  const nodes = hub.nodes.filter(node => !nodeId || node.id === nodeId)
  const bookings = hub.reservations.filter(item => item.status !== 'cancelled' && (!mine || item.ownerId === hub.user.id) && (!nodeId || nodes.some(node => node.gpus.some(gpu => item.gpuIds.includes(gpu.id)))) && reservationPosition(item, start, end))
  const visibleBookings = bookings.filter(item => reservationPosition(item, visibleStart, visibleStart + windowMs))
  const detail = hub.reservations.find(item => item.id === detailId)
  const ownBookings = hub.reservations.filter(item => item.ownerId === hub.user.id && !['cancelled', 'completed'].includes(item.status))
  const move = (direction: number) => center(visibleStart + windowMs / 2 + direction * windowMs)
  const online = (lastSeenAt?: string) => !!lastSeenAt && now - new Date(lastSeenAt).getTime() < 30000
  const selectionChecks = selection ? reservationChecks(selection.gpuIds,selection.startsAt,selection.endsAt,hub.reservations,hub.nodes,hub.user) : null
  const dragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLButtonElement>('.timeline-slots button')
    if (!cell || cell.disabled || event.button !== 0 || dragRef.current) return
    const track = cell.closest<HTMLElement>('.timeline-track')!, row=cell.closest<HTMLElement>('.timeline-row')!
    const rect=track.getBoundingClientRect()
    const anchorTime = Math.max(reservationWindowStart(), start + Math.floor((event.clientX-rect.left)/rect.width*(end-start)/1800000)*1800000)
    const first={gpuIds:[row.dataset.gpuId!],startsAt:dateInput(new Date(anchorTime)),endsAt:dateInput(new Date(anchorTime+1800000))}
    dragRef.current={pointerId:event.pointerId,anchorTime,anchorGpu:row.dataset.gpuId!,x:event.clientX,y:event.clientY,moved:false,seed:first}
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const dragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag=dragRef.current
    if (!drag || drag.pointerId!==event.pointerId) return
    if (Math.abs(event.clientX-drag.x)>5 || Math.abs(event.clientY-drag.y)>5) drag.moved=true
    if (!drag.moved) return
    const rows=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.timeline-row'))
    const anchorIndex=rows.findIndex(row=>row.dataset.gpuId===drag.anchorGpu)
    if(anchorIndex<0) return
    const rect=rows[anchorIndex].querySelector('.timeline-track')!.getBoundingClientRect()
    const time=start+Math.max(0,Math.min(Math.ceil((end-start)/1800000)-1,Math.floor((event.clientX-rect.left)/rect.width*(end-start)/1800000)))*1800000
    const targetIndex=rows.reduce((best,row,index)=>Math.abs(event.clientY-(row.getBoundingClientRect().top+row.getBoundingClientRect().height/2))<Math.abs(event.clientY-(rows[best].getBoundingClientRect().top+rows[best].getBoundingClientRect().height/2))?index:best,anchorIndex)
    drag.seed={gpuIds:rows.slice(Math.min(anchorIndex,targetIndex),Math.max(anchorIndex,targetIndex)+1).map(row=>row.dataset.gpuId!),startsAt:dateInput(new Date(Math.min(drag.anchorTime,time))),endsAt:dateInput(new Date(Math.max(drag.anchorTime,time)+1800000))}
    setSelection(drag.seed)
  }
  const dragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag=dragRef.current
    if(!drag || drag.pointerId!==event.pointerId) return
    dragRef.current=null;setSelection(null)
    ignoreClickUntil.current=Date.now()+500;setSeed(drag.seed)
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div ref={pageRef} className="detail-page hub-calendar-page">
    <div className="hub-calendar-toolbar timeline-toolbar">
      <div><strong>GPU 资源时间表</strong><small>空白处拖动选择时间与多张 GPU · 30 分钟对齐 · 时区 {Intl.DateTimeFormat().resolvedOptions().timeZone}</small></div>
      <div><button className="button button--secondary" disabled={refreshing} onClick={async () => {setRefreshing(true);setError('');try {await hub.refresh()} catch(cause) {setError(cause instanceof Error ? cause.message : '刷新失败')} finally {setRefreshing(false)}}}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/>刷新</button><button className="button button--primary" onClick={onCreate}><Plus size={15}/>预约 GPU</button></div>
    </div>
    <div className="timeline-controls">
      <button className="icon-button" aria-label="上一时段" onClick={() => move(-1)}><ChevronLeft size={16}/></button><button className="button button--secondary" onClick={() => center(Date.now())}>回到现在</button><button className="icon-button" aria-label="下一时段" onClick={() => move(1)}><ChevronRight size={16}/></button>
      <input aria-label="查看日期" type="date" value={dateInput(new Date(visibleStart + windowMs / 2)).slice(0,10)} onChange={event => { if (event.target.value) center(new Date(`${event.target.value}T12:00:00`).getTime()) }}/>
      <div className="timeline-views" role="group" aria-label="时间范围">{[[24,'24 小时'],[72,'3 天'],[168,'7 天']].map(([value,label]) => <button className="button button--secondary" aria-pressed={hours === value} key={value} onClick={() => center(visibleStart + windowMs / 2, Number(value))}>{label}</button>)}</div>
      <select aria-label="服务器筛选" value={nodeId} onChange={event => setNodeId(event.target.value)}><option value="">全部服务器</option>{hub.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select>
      <label><input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)}/>只看我的预约</label>
    </div>
    {error && <p role="alert" className="hub-form-error">{error}</p>}
    <p className="timeline-range" role="status">{dateInput(new Date(visibleStart)).replace('T',' ')} — {dateInput(new Date(visibleStart + windowMs)).replace('T',' ')} · 左右滚动连续跨日期（触控板横滑 / Shift + 滚轮）</p>
    {selection && <div className={`timeline-drag-feedback ${selectionChecks?.errors.length ? 'hub-form-error' : 'timeline-selection-summary'}`} role="status"><strong>已选 {selection.gpuIds.length} 张 GPU · {selection.startsAt.replace('T',' ')} — {selection.endsAt.replace('T',' ')}</strong>{selectionChecks?.errors.map(message=><p key={message}>{message}</p>)}</div>}
    <div className="timeline-legend">{Object.entries(statusText).map(([status,label]) => <span key={status}><i className={`timeline-status timeline-status--${status}`}/>{label}</span>)}<span>边框强调：我的预约</span><span>空白时段：无预约，实际占用请看行头</span></div>
    <section ref={scrollRef} onScroll={scroll} className="panel timeline-scroll" tabIndex={0} aria-label="GPU 预约时间表" onKeyDown={event => {if (event.target !== event.currentTarget) return; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {event.preventDefault();move(event.key === 'ArrowLeft' ? -1 : 1)} }}><div className={`timeline-grid ${selection?'is-selecting':''}`} style={{width: LABEL_WIDTH + windowWidth * 3}} onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={() => {dragRef.current=null;setSelection(null)}} onLostPointerCapture={() => {dragRef.current=null;setSelection(null)}}>
      <header className="timeline-header"><div className="timeline-label">服务器 / GPU</div><div className="timeline-axis">{Array.from({length: hours * 3},(_,index) => {
        const timestamp = start + index * HOUR
        const time = new Date(timestamp)
        const step = Math.max(1, Math.ceil(72 * hours / windowWidth))
        if (index % step) return null
        return <span key={timestamp} style={{left: `${index/(hours*3)*100}%`}}>{time.getMonth()+1}/{time.getDate()} {String(time.getHours()).padStart(2,'0')}:{String(time.getMinutes()).padStart(2,'0')}</span>
      })}</div></header>
      {nodes.map(node => <div key={node.id}><div className="timeline-node"><strong>{node.name}</strong><small>{online(node.lastSeenAt) ? '在线' : '离线'} · {node.gpus.length} 张 GPU</small></div>
        {node.gpus.map(gpu => <div className="timeline-row" data-gpu-id={gpu.id} key={gpu.id}>
          <div className="timeline-label"><strong>GPU {gpu.index} · {gpu.name}</strong><small>{(gpu.memoryTotalMb/1024).toFixed(0)} GB · {gpu.maintenance ? '维护' : gpu.missing ? '不可用' : !online(node.lastSeenAt) ? '离线' : gpu.processes.length || (gpu.memoryUsedMb ?? 0) > 256 ? '实际有占用' : '实际空闲'}</small></div>
          <div className="timeline-track" style={{backgroundSize:`${100/slots}% 100%`}}>
            <div className="timeline-slots">{Array.from({length:slots},(_,index) => {
              const slotStart=start+index*slotMs, slotEnd=slotStart+slotMs
              const occupied=hub.reservations.some(item => !['cancelled','completed'].includes(item.status) && item.gpuIds.includes(gpu.id) && new Date(item.startsAt).getTime()<slotEnd && new Date(item.endsAt).getTime()>slotStart)
              const disabled=slotEnd<=reservationWindowStart(now) || occupied || gpu.maintenance || gpu.missing || !online(node.lastSeenAt)
              return <button key={index} disabled={disabled} aria-label={`预约 ${node.name} GPU ${gpu.index} ${new Date(slotStart).toLocaleString('zh-CN')}`} onClick={event => {
                if(event.detail>0 && Date.now()<ignoreClickUntil.current) return
                const startsAt=Math.max(slotStart, reservationWindowStart())
                setSeed({gpuIds:[gpu.id],startsAt:dateInput(new Date(startsAt)),endsAt:dateInput(new Date(Math.min(startsAt+3600000,slotEnd > startsAt ? slotEnd : startsAt+1800000)))})
              }}/>
            })}</div>
            {selection?.gpuIds.includes(gpu.id) && (()=>{const position=reservationPosition(selection,start,end);return position && <div className={`timeline-selection ${selectionChecks?.errors.length?'has-conflict':''}`} style={{left:`${position.left}%`,width:`${position.width}%`}}/>})()}
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
    <section className="panel hub-booking-list timeline-mobile-list"><header><strong>所选时段预约</strong></header>{visibleBookings.sort((a,b) => a.startsAt.localeCompare(b.startsAt)).map(item => <button className="timeline-mobile-booking" key={item.id} onClick={() => setDetailId(item.id)}><strong>{item.ownerName} · {item.projectName}</strong><span>{new Date(item.startsAt).toLocaleString('zh-CN')} — {new Date(item.endsAt).toLocaleString('zh-CN')}</span><small>{item.gpuIds.length} GPU · {statusText[item.status]}</small></button>)}{!visibleBookings.length && <p>所选时段暂无预约</p>}</section>
    <section className="panel hub-booking-list"><header><strong>我的预约</strong><small>{ownBookings.length} 项待开始或进行中</small></header>{ownBookings.length ? ownBookings.map(item => <ReservationRow key={item.id} reservation={item}/>) : <p className="hub-feature-empty">暂无我的预约，点击时间表空白区域创建。</p>}</section>
    {seed && <HubReservationSheet initial={seed} onClose={() => setSeed(null)}/>}
    {detail && <div className="scrim" onMouseDown={event => event.target===event.currentTarget && setDetailId(null)}><section className="sheet reservation-sheet" role="dialog" aria-modal="true" aria-label="预约详情"><header className="sheet__header"><h2>预约详情</h2><button className="icon-button" aria-label="关闭预约详情" onClick={() => setDetailId(null)}><X size={17}/></button></header><div className="reservation-body"><ReservationRow reservation={detail}/><strong>预约 GPU</strong>{hub.nodes.flatMap(node => node.gpus.filter(gpu => detail.gpuIds.includes(gpu.id)).map(gpu => <p key={gpu.id}>{node.name} · GPU {gpu.index} · {gpu.name}</p>))}</div></section></div>}
  </div>
}
