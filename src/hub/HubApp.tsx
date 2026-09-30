import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3, CalendarDays, Check, ChevronRight, Clock3, Cpu, LayoutDashboard, LogOut, Plus, RefreshCw, Server, ShieldCheck, Users, X } from 'lucide-react'
import { Gpu, hubApi, Node, Reservation, User } from './api'
import './hub.css'

type View = 'dashboard' | 'calendar' | 'statistics'

const fmt = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
const inputDate = (offsetHours: number) => { const d = new Date(Date.now() + offsetHours * 3600000); d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
const statusText: Record<string, string> = { scheduled: '待开始', active: '进行中', completed: '已结束', cancelled: '已取消', overrun: '超时占用' }

export default function HubApp() {
  const [user, setUser] = useState<User | null>(null)
  const [loginError, setLoginError] = useState('')
  const [view, setView] = useState<View>('dashboard')
  const [nodes, setNodes] = useState<Node[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [stats, setStats] = useState<{ username: string; gpuHours: number; coverageSeconds: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date>()

  const load = useCallback(async () => {
    try {
      const [resourceData, reservationData, statsData] = await Promise.all([hubApi.resources(), hubApi.reservations(), hubApi.statistics()])
      setNodes(resourceData.nodes); setReservations(reservationData); setStats(statsData.users); setLastUpdated(new Date()); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : '无法加载数据') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { hubApi.me().then(setUser).then(load).catch(() => setLoading(false)) }, [load])
  useEffect(() => { if (!user) return; const id = window.setInterval(load, 5000); return () => window.clearInterval(id) }, [user, load])

  if (!user) return <Login onLogin={async (name, password) => { try { setLoginError(''); await hubApi.login(name, password); setUser(await hubApi.me()); await load() } catch (e) { setLoginError(e instanceof Error ? e.message : '登录失败') } }} error={loginError} />

  const allGpus = nodes.flatMap(node => node.gpus.map(gpu => ({ ...gpu, node })))
  const active = reservations.filter(r => r.status === 'active' || r.status === 'overrun')
  const busy = allGpus.filter(gpu => gpu.processes.length > 0).length

  return <div className="hub-shell">
    <aside className="hub-sidebar">
      <div className="hub-brand"><div className="hub-mark"><Cpu size={19}/></div><div><strong>RackTop Hub</strong><span>GPU 资源协作平台</span></div></div>
      <nav>
        <Nav active={view === 'dashboard'} icon={<LayoutDashboard/>} label="资源看板" onClick={() => setView('dashboard')}/>
        <Nav active={view === 'calendar'} icon={<CalendarDays/>} label="预约日历" onClick={() => setView('calendar')}/>
        <Nav active={view === 'statistics'} icon={<BarChart3/>} label="使用统计" onClick={() => setView('statistics')}/>
      </nav>
      <div className="hub-policy"><ShieldCheck size={16}/><div><strong>协作式管理</strong><span>系统仅监控与通知，不会终止进程</span></div></div>
      <button className="hub-user" onClick={async () => { await hubApi.logout(); setUser(null) }}><div className="avatar">{user.displayName.slice(0, 1)}</div><div><strong>{user.displayName}</strong><span>{user.linuxUsername} · {user.role}</span></div><LogOut size={16}/></button>
    </aside>
    <main className="hub-main">
      <header><div><h1>{view === 'dashboard' ? '资源看板' : view === 'calendar' ? '预约日历' : '使用统计'}</h1><p>{lastUpdated ? `更新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '正在同步服务器状态'}</p></div><div className="header-actions"><button className="icon-button" onClick={load} aria-label="刷新"><RefreshCw size={17}/></button><button className="primary" onClick={() => setShowCreate(true)}><Plus size={17}/>预约 GPU</button></div></header>
      {error && <div className="hub-alert">{error}</div>}
      {loading ? <div className="hub-empty">正在载入资源状态…</div> : view === 'dashboard' ? <Dashboard nodes={nodes} reservations={reservations} totals={{ gpu: allGpus.length, busy, active: active.length }}/>: view === 'calendar' ? <Calendar nodes={nodes} reservations={reservations}/>: <Statistics rows={stats}/>} 
    </main>
    {showCreate && <CreateModal nodes={nodes} onClose={() => setShowCreate(false)} onCreated={async () => { setShowCreate(false); await load() }}/>} 
  </div>
}

function Login({ onLogin, error }: { onLogin: (name: string, password: string) => Promise<void>; error: string }) {
  const [busy, setBusy] = useState(false)
  return <div className="login-page"><form className="login-card" onSubmit={async e => { e.preventDefault(); setBusy(true); const data = new FormData(e.currentTarget); await onLogin(String(data.get('username')), String(data.get('password'))); setBusy(false) }}><div className="login-logo"><Cpu size={25}/></div><h1>RackTop Hub</h1><p>实验室 GPU 资源协作平台</p><label>用户名<input name="username" autoComplete="username" required autoFocus/></label><label>密码<input name="password" type="password" autoComplete="current-password" required/></label>{error && <div className="form-error">{error}</div>}<button className="primary login-submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button><small>使用管理员分配的门户账号登录</small></form></div>
}

function Nav({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) { return <button className={`hub-nav ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span><ChevronRight size={15}/></button> }

function Dashboard({ nodes, reservations, totals }: { nodes: Node[]; reservations: Reservation[]; totals: { gpu: number; busy: number; active: number } }) {
  const upcoming = reservations.filter(r => ['scheduled','active','overrun'].includes(r.status)).slice(0, 6)
  return <div className="hub-content"><section className="summary-grid"><Summary icon={<Cpu/>} label="GPU 总数" value={totals.gpu} note={`${nodes.length} 台服务器`}/><Summary icon={<Activity/>} label="正在使用" value={totals.busy} note={`${Math.max(0, totals.gpu - totals.busy)} 张空闲`}/><Summary icon={<CalendarDays/>} label="当前预约" value={totals.active} note="自动确认"/><Summary icon={<Users/>} label="使用策略" value="2 张" note="默认并发上限"/></section><div className="dashboard-grid"><section><div className="section-title"><div><h2>服务器与 GPU</h2><p>实时状态、显存与进程</p></div><span className="live"><i/>5 秒刷新</span></div><div className="node-list">{nodes.map(node => <NodeCard key={node.id} node={node}/>)}</div></section><section><div className="section-title"><div><h2>近期预约</h2><p>进行中与即将开始</p></div></div><div className="booking-list">{upcoming.length ? upcoming.map(r => <Booking key={r.id} reservation={r}/>) : <div className="hub-empty compact">暂无预约</div>}</div></section></div></div>
}
function Summary({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string | number; note: string }) { return <div className="summary-card"><div className="summary-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></div> }
function NodeCard({ node }: { node: Node }) { const online = node.lastSeenAt && Date.now() - new Date(node.lastSeenAt).getTime() < 30000; return <article className="node-card"><div className="node-head"><div><Server size={18}/><div><strong>{node.name}</strong><span>{node.hostname}</span></div></div><span className={`status-pill ${online ? 'online' : 'offline'}`}>{online ? '在线' : '离线'}</span></div><div className="gpu-grid">{node.gpus.map(gpu => <GpuCard key={gpu.id} gpu={gpu}/>)}</div></article> }
function GpuCard({ gpu }: { gpu: Gpu }) { const mem = gpu.memoryTotalMb ? Math.round((gpu.memoryUsedMb ?? 0) / gpu.memoryTotalMb * 100) : 0; const owner = [...new Set(gpu.processes.map(p => p.username))].join(', '); return <div className={`gpu-card ${gpu.processes.length ? 'busy' : ''}`} title={gpu.uuid}><div className="gpu-title"><strong>GPU {gpu.index}</strong><span>{gpu.processes.length ? '使用中' : '空闲'}</span></div><p>{gpu.name}</p><div className="meter"><i style={{ width: `${mem}%` }}/></div><div className="gpu-metrics"><span>显存 {mem}%</span><span>利用率 {Math.round(gpu.utilizationPercent ?? 0)}%</span><span>{gpu.temperatureCelsius ? `${Math.round(gpu.temperatureCelsius)}°C` : '—'}</span></div>{owner && <div className="process-user">{owner} · {gpu.processes.length} 个进程</div>}</div> }
function Booking({ reservation }: { reservation: Reservation }) { return <div className="booking"><div className={`booking-status ${reservation.status}`}/><div><div className="booking-title"><strong>{reservation.projectName}</strong><span>{statusText[reservation.status] ?? reservation.status}</span></div><p>{reservation.ownerName} · {reservation.gpuIds.length} 张 GPU</p><small><Clock3 size={13}/>{fmt(reservation.startsAt)} — {fmt(reservation.endsAt)}</small></div></div> }

function Calendar({ nodes, reservations }: { nodes: Node[]; reservations: Reservation[] }) { const gpus = nodes.flatMap(n => n.gpus.map(g => ({...g, nodeName:n.name}))); return <div className="hub-content"><div className="section-title"><div><h2>未来预约</h2><p>以具体 GPU 为单位，冲突由服务端原子校验</p></div></div><div className="calendar-table"><div className="calendar-row calendar-head"><span>资源</span><span>当前状态</span><span>预约区间</span></div>{gpus.map(gpu => { const related=reservations.filter(r=>r.gpuIds.includes(gpu.id)&&['scheduled','active','overrun'].includes(r.status)); return <div className="calendar-row" key={gpu.id}><span><strong>{gpu.nodeName} · GPU {gpu.index}</strong><small>{gpu.name}</small></span><span><i className={`dot ${gpu.processes.length?'used':'free'}`}/>{gpu.processes.length?'使用中':'空闲'}</span><span>{related.length?related.map(r=><span className="slot" key={r.id}><b>{r.ownerName}</b> {fmt(r.startsAt)} → {fmt(r.endsAt)}</span>):<em>暂无预约</em>}</span></div>})}</div></div> }
function Statistics({ rows }: { rows: { username: string; gpuHours: number; coverageSeconds: number }[] }) { const max=Math.max(...rows.map(r=>r.gpuHours),1); return <div className="hub-content"><div className="section-title"><div><h2>近 90 天 GPU 使用量</h2><p>按 Agent 采样汇总；数据覆盖率低时需谨慎解释</p></div></div><div className="stats-card">{rows.length?rows.map((r,i)=><div className="stats-row" key={r.username}><span className="rank">{i+1}</span><strong>{r.username}</strong><div className="stats-bar"><i style={{width:`${r.gpuHours/max*100}%`}}/></div><b>{r.gpuHours.toFixed(1)} h</b><small>覆盖 {(r.coverageSeconds/3600).toFixed(1)} h</small></div>):<div className="hub-empty">尚无统计数据</div>}</div></div> }

function CreateModal({ nodes, onClose, onCreated }: { nodes: Node[]; onClose: () => void; onCreated: () => Promise<void> }) { const [selected,setSelected]=useState<string[]>([]); const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const gpus=useMemo(()=>nodes.flatMap(n=>n.gpus.map(g=>({...g,nodeName:n.name}))),[nodes]); return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><form className="modal" onSubmit={async (e:FormEvent<HTMLFormElement>)=>{e.preventDefault();if(!selected.length){setError('请至少选择一张 GPU');return}const form=new FormData(e.currentTarget);setBusy(true);try{await hubApi.createReservation({gpuIds:selected,startsAt:new Date(String(form.get('startsAt'))).toISOString(),endsAt:new Date(String(form.get('endsAt'))).toISOString(),projectName:form.get('projectName'),purpose:form.get('purpose')});await onCreated()}catch(err){setError(err instanceof Error?err.message:'预约失败')}finally{setBusy(false)}}}><div className="modal-head"><div><h2>预约 GPU</h2><p>提交后自动确认，最长 48 小时</p></div><button type="button" className="icon-button" onClick={onClose}><X size={18}/></button></div><label>项目名称<input name="projectName" required maxLength={120} placeholder="例如：RadarDreamer 训练"/></label><div className="form-grid"><label>开始时间<input name="startsAt" type="datetime-local" defaultValue={inputDate(1)} required/></label><label>结束时间<input name="endsAt" type="datetime-local" defaultValue={inputDate(5)} required/></label></div><fieldset><legend>选择 GPU</legend><div className="gpu-picker">{gpus.map(g=><button type="button" disabled={g.maintenance||g.missing} className={selected.includes(g.id)?'selected':''} key={g.id} onClick={()=>setSelected(s=>s.includes(g.id)?s.filter(id=>id!==g.id):[...s,g.id])}><span>{selected.includes(g.id)?<Check size={14}/>:null}</span><div><strong>{g.nodeName} · GPU {g.index}</strong><small>{g.name}</small></div></button>)}</div></fieldset><label>用途说明<textarea name="purpose" required maxLength={500} placeholder="训练任务、预计资源需求等"/></label>{error&&<div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy?'提交中…':`确认预约${selected.length?`（${selected.length} 张）`:''}`}</button></div></form></div> }
