import { createContext, FormEvent, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, Clock3, Copy, Download, LogOut, Plus, RefreshCw, Server, ShieldCheck, X } from 'lucide-react'
import { AdminNode, hubApi, Node, NodeRegistration, Reservation, User } from './api'

type HubState = {
  user: User
  nodes: Node[]
  reservations: Reservation[]
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const HubContext = createContext<HubState | null>(null)
export const useHub = () => useContext(HubContext)

export function HubProvider({ user, onLogout, children }: { user: User; onLogout: () => void; children: ReactNode }) {
  const [nodes, setNodes] = useState<Node[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    const [resources, bookings] = await Promise.all([hubApi.resources(), hubApi.reservations()])
    setNodes(resources.nodes); setReservations(bookings); setLoading(false)
  }, [])
  useEffect(() => { void refresh(); const id = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(id) }, [refresh])
  const logout = async () => { await hubApi.logout(); onLogout() }
  return <HubContext.Provider value={{ user, nodes, reservations, loading, refresh, logout }}>{children}</HubContext.Provider>
}

export function HubAccount() {
  const hub = useHub()
  if (!hub) return null
  return <div className="hub-account"><span className="hub-account__avatar">{hub.user.displayName.slice(0, 1)}</span><span><strong>{hub.user.displayName}</strong><small>{hub.user.role} · {hub.user.concurrentGpuLimit} GPU 上限</small></span><button className="icon-button" onClick={() => void hub.logout()} aria-label="退出登录" title="退出登录"><LogOut size={14}/></button></div>
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
const statusLabel: Record<string, string> = { scheduled: '待开始', active: '进行中', completed: '已结束', cancelled: '已取消', overrun: '已超时' }

export function HubReservationPage({ onCreate }: { onCreate: () => void }) {
  const hub = useHub()
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + index); return d }), [])
  if (!hub) return null
  const visible = hub.reservations.filter(item => !['cancelled', 'completed'].includes(item.status))
  return <div className="detail-page hub-calendar-page">
    <div className="hub-calendar-toolbar"><div><strong>未来 7 天</strong><small>预约按开始日期排列，时间冲突由 Hub 自动校验</small></div><div><button className="button button--secondary" onClick={() => void hub.refresh()}><RefreshCw size={14}/>刷新</button><button className="button button--primary" onClick={onCreate}><Plus size={15}/>预约 GPU</button></div></div>
    <section className="panel hub-week"><header>{days.map((day, index) => <div className={index === 0 ? 'is-today' : ''} key={dayKey(day)}><small>{index === 0 ? '今天' : new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(day)}</small><strong>{day.getMonth() + 1}/{day.getDate()}</strong></div>)}</header><div className="hub-week__grid">{days.map(day => {
      const rows = visible.filter(item => dayKey(new Date(item.startsAt)) === dayKey(day))
      return <div className="hub-week__day" key={dayKey(day)}>{rows.map(item => <ReservationCard key={item.id} reservation={item}/>) }{!rows.length && <span className="hub-week__empty">无预约</span>}</div>
    })}</div></section>
    <section className="panel hub-booking-list"><header><CalendarDays size={16}/><div><strong>全部近期预约</strong><small>{visible.length} 项待开始或进行中</small></div></header>{visible.length ? visible.map(item => <ReservationRow key={item.id} reservation={item}/>) : <div className="hub-feature-empty"><CalendarDays size={25}/><strong>暂无预约</strong><p>创建预约后会显示在这里。</p></div>}</section>
  </div>
}

function ReservationCard({ reservation }: { reservation: Reservation }) {
  return <article className={`hub-calendar-card hub-calendar-card--${reservation.status}`} title={reservation.purpose}><strong>{reservation.projectName}</strong><span><Clock3 size={11}/>{formatTime(reservation.startsAt)}–{formatTime(reservation.endsAt)}</span><small>{reservation.ownerName} · {reservation.gpuIds.length} GPU</small></article>
}

function ReservationRow({ reservation }: { reservation: Reservation }) {
  const hub = useHub()!
  const action = async (name: 'check-in' | 'end' | 'cancel') => { await hubApi.action(reservation.id, name); await hub.refresh() }
  return <div className="reservation-row"><span className={`reservation-row__status reservation-row__status--${reservation.status === 'active' ? 'active' : reservation.status === 'completed' ? 'completed' : ''}`}><Clock3 size={15}/></span><span className="reservation-row__content"><div><strong>{reservation.projectName}</strong><em>{statusLabel[reservation.status] ?? reservation.status}</em></div><p>{reservation.ownerName} · {reservation.gpuIds.length} 张 GPU · {reservation.purpose}</p><small>{new Date(reservation.startsAt).toLocaleString('zh-CN')} — {new Date(reservation.endsAt).toLocaleString('zh-CN')}</small></span><span className="reservation-row__actions">{reservation.status === 'scheduled' && <button className="button button--secondary button--small" onClick={() => void action('check-in')}>签到</button>}{['active','overrun'].includes(reservation.status) && <button className="button button--secondary button--small" onClick={() => void action('end')}>结束</button>}{reservation.status === 'scheduled' && <button className="icon-button reservation-delete" onClick={() => void action('cancel')} aria-label="取消预约"><X size={14}/></button>}</span></div>
}

const localDate = (hours: number) => { const d = new Date(Date.now() + hours * 3600000); d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

export function HubReservationSheet({ onClose }: { onClose: () => void }) {
  const hub = useHub()!
  const [selected, setSelected] = useState<string[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const gpus = hub.nodes.flatMap(node => node.gpus.map(gpu => ({ ...gpu, nodeName: node.name })))
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selected.length) { setError('请至少选择一张 GPU'); return }
    const form = new FormData(event.currentTarget); setBusy(true); setError('')
    try { await hubApi.createReservation({ gpuIds: selected, startsAt: new Date(String(form.get('startsAt'))).toISOString(), endsAt: new Date(String(form.get('endsAt'))).toISOString(), projectName: form.get('projectName'), purpose: form.get('purpose') }); await hub.refresh(); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '预约失败') } finally { setBusy(false) }
  }
  return <div className="scrim" onMouseDown={event => event.target === event.currentTarget && onClose()}><form className="sheet reservation-sheet hub-create-sheet" onSubmit={submit}><header className="sheet__header"><div><p className="eyebrow">协作式预约</p><h2>预约 GPU</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17}/></button></header><div className="reservation-body"><div className="reservation-condition"><span><CalendarDays size={16}/></span><div><strong>提交后自动确认</strong><small>同一 GPU 的时间区间不可重叠；每次最长 48 小时。</small></div></div><label>项目名称<input name="projectName" required maxLength={120} placeholder="例如：RadarDreamer 训练"/></label><div className="hub-form-grid"><label>开始时间<input name="startsAt" type="datetime-local" defaultValue={localDate(1)} required/></label><label>结束时间<input name="endsAt" type="datetime-local" defaultValue={localDate(5)} required/></label></div><fieldset><legend>选择 GPU</legend><div className="hub-gpu-picker">{gpus.map(gpu => <button type="button" disabled={gpu.maintenance || gpu.missing} className={selected.includes(gpu.id) ? 'is-selected' : ''} key={gpu.id} onClick={() => setSelected(current => current.includes(gpu.id) ? current.filter(id => id !== gpu.id) : [...current, gpu.id])}><span>{selected.includes(gpu.id) && <Check size={13}/>}</span><div><strong>{gpu.nodeName} · GPU {gpu.index}</strong><small>{gpu.name}</small></div></button>)}</div></fieldset><label>用途说明<textarea name="purpose" required maxLength={500} placeholder="训练任务、预计资源需求等"/></label>{error && <div className="hub-form-error">{error}</div>}</div><footer className="sheet__footer"><button type="button" className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={busy}>{busy ? '提交中…' : `确认预约${selected.length ? `（${selected.length} 张）` : ''}`}</button></footer></form></div>
}

export function HubAdminPage({ onRegister }: { onRegister: () => void }) {
  const hub = useHub()!
  const [nodes, setNodes] = useState<AdminNode[]>([]), [error, setError] = useState('')
  const load = useCallback(() => hubApi.adminNodes().then(result => { setNodes(result.nodes); setError('') }).catch(cause => setError(cause instanceof Error ? cause.message : '无法加载节点')), [])
  useEffect(() => { void load() }, [load, hub.nodes])
  return <div className="detail-page hub-admin-page"><header className="hub-admin-heading"><div><p className="eyebrow">管理员</p><h2>Hub 管理面板</h2><small>注册 GPU 服务器并生成每台节点独立的 Agent 凭据。</small></div><button className="button button--primary" onClick={onRegister}><Plus size={15}/>注册服务器节点</button></header>{error && <div className="hub-form-error">{error}</div>}<section className="panel hub-admin-card"><header><Server size={17}/><div><strong>服务器节点</strong><small>{nodes.length} 个已注册节点</small></div><button className="icon-button" onClick={() => void load()} aria-label="刷新节点"><RefreshCw size={14}/></button></header><div className="hub-admin-table"><div className="hub-admin-row hub-admin-row--head"><span>节点</span><span>主机名</span><span>状态</span><span>最近上报</span></div>{nodes.map(node => <div className="hub-admin-row" key={node.id}><span><i className={`server-row__status server-row__status--${node.lastSeenAt && Date.now()-new Date(node.lastSeenAt).getTime()<30000?'online':'offline'}`}/><strong>{node.name}</strong><small>{node.id}</small></span><span>{node.hostname}</span><span className={`status-pill status-pill--${node.enabled?'online':'offline'}`}><i className="status-pill__dot"/>{node.enabled?'已启用':'已停用'}</span><span>{node.lastSeenAt?new Date(node.lastSeenAt).toLocaleString('zh-CN'):'尚未接入'}</span></div>)}</div></section><section className="panel hub-admin-notice"><ShieldCheck size={18}/><div><strong>节点凭据安全</strong><p>每个节点必须使用独立 Token。Token 仅在注册成功时显示一次，Hub 数据库只保存哈希值。</p></div></section></div>
}

export function HubNodeRegistrationSheet({ onClose }: { onClose: () => void }) {
  const hub = useHub()!
  const [registration, setRegistration] = useState<NodeRegistration | null>(null), [nodeName, setNodeName] = useState(''), [hostname, setHostname] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState('')
  const envText = registration ? `RACKTOP_HUB_URL=${registration.hubUrl}\nRACKTOP_NODE_ID=${registration.id}\nRACKTOP_AGENT_TOKEN=${registration.token}\nRACKTOP_SAMPLE_SECONDS=5\nRUST_LOG=racktop_agent=info\n` : ''
  const copy = async (value: string, label: string) => { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(''), 1500) }
  const download = () => { const url=URL.createObjectURL(new Blob([envText],{type:'text/plain'})); const link=document.createElement('a'); link.href=url; link.download=`racktop-agent-${nodeName || 'node'}.env`; link.click(); URL.revokeObjectURL(url) }
  return <div className="scrim" onMouseDown={event => event.target===event.currentTarget && !registration && onClose()}><form className="sheet hub-node-sheet" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { setRegistration(await hubApi.registerNode(nodeName, hostname)); await hub.refresh() } catch(cause){setError(cause instanceof Error?cause.message:'节点注册失败')} finally{setBusy(false)} }}><header className="sheet__header"><div><p className="eyebrow">管理员 · 节点接入</p><h2>{registration?'保存 Agent 凭据':'注册服务器节点'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17}/></button></header>{registration?<div className="hub-node-result"><div className="hub-secret-warning"><ShieldCheck size={18}/><div><strong>凭据只显示这一次</strong><p>关闭窗口前请下载或复制配置；Token 无法再次查询。</p></div></div><label>Node ID<div className="hub-copy-field"><code>{registration.id}</code><button type="button" className="icon-button" onClick={()=>void copy(registration.id,'Node ID')}><Copy size={14}/></button></div></label><label>Agent Token<div className="hub-copy-field"><code>{registration.token}</code><button type="button" className="icon-button" onClick={()=>void copy(registration.token,'Token')}><Copy size={14}/></button></div></label><label>完整环境配置<textarea readOnly value={envText}/></label>{copied&&<span className="hub-copy-success"><Check size={13}/>{copied} 已复制</span>}</div>:<div className="hub-node-form"><div className="reservation-condition"><span><Server size={16}/></span><div><strong>为每台物理服务器单独注册</strong><small>注册后 Agent 使用只读权限采集 GPU 和进程遥测。</small></div></div><label>节点显示名称<input value={nodeName} onChange={event=>setNodeName(event.target.value)} required maxLength={120} placeholder="例如：WHUServer-H200"/></label><label>服务器主机名<input value={hostname} onChange={event=>setHostname(event.target.value)} required maxLength={255} placeholder="例如：WHUServer-H200 或 Tailscale DNS 名称"/></label>{error&&<div className="hub-form-error">{error}</div>}</div>}<footer className="sheet__footer">{registration?<><button type="button" className="button button--secondary" onClick={()=>void copy(envText,'完整配置')}><Copy size={14}/>复制配置</button><button type="button" className="button button--primary" onClick={download}><Download size={14}/>下载配置</button></>:<><button type="button" className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={busy}>{busy?'注册中…':'生成节点凭据'}</button></>}</footer></form></div>
}
