import { createContext, FormEvent, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, Clock3, Copy, Download, LogOut, Plus, RefreshCw, Server, ShieldCheck, UserRound, X } from 'lucide-react'
import { AdminNode, AdminUser, hubApi, Node, NodeRegistration, Reservation, User } from './api'
import { ReservationTimeline, type ReservationSeed } from './ReservationTimeline'

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

const statusLabel: Record<string, string> = { scheduled: '待开始', active: '进行中', completed: '已结束', cancelled: '已取消', overrun: '已超时' }

export function HubReservationPage({ onCreate }: { onCreate: () => void }) {
  return <ReservationTimeline onCreate={onCreate}/>
}


export function ReservationRow({ reservation }: { reservation: Reservation }) {
  const hub = useHub()!
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const allowed = reservation.ownerId === hub.user.id || hub.user.role === 'admin'
  const action = async (name: 'check-in' | 'end' | 'cancel') => { setBusy(true);setError('');try {await hubApi.action(reservation.id, name); await hub.refresh()} catch(cause) {setError(cause instanceof Error ? cause.message : '操作失败')} finally {setBusy(false)} }
  return <div className="reservation-row"><span className={`reservation-row__status reservation-row__status--${reservation.status === 'active' ? 'active' : reservation.status === 'completed' ? 'completed' : ''}`}><Clock3 size={15}/></span><span className="reservation-row__content"><div><strong>{reservation.projectName}</strong><em>{statusLabel[reservation.status] ?? reservation.status}</em></div><p>{reservation.ownerName} · {reservation.gpuIds.length} 张 GPU · {reservation.purpose}</p><small>{new Date(reservation.startsAt).toLocaleString('zh-CN')} — {new Date(reservation.endsAt).toLocaleString('zh-CN')}</small></span><span className="reservation-row__actions" aria-busy={busy}>{reservation.ownerId === hub.user.id && reservation.status === 'scheduled' && <button className="button button--secondary button--small" disabled={busy} onClick={() => void action('check-in')}>签到</button>}{reservation.ownerId === hub.user.id && reservation.status === 'active' && <button className="button button--secondary button--small" disabled={busy} onClick={() => void action('end')}>结束</button>}{allowed && reservation.status === 'scheduled' && <button className="icon-button reservation-delete" disabled={busy} onClick={() => void action('cancel')} aria-label="取消预约"><X size={14}/></button>}</span>{error && <span role="alert" className="hub-form-error">{error}</span>}</div>
}

const localDate = (hours: number) => { const d = new Date(Date.now() + hours * 3600000); d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

export function HubReservationSheet({ onClose, initial }: { onClose: () => void; initial?: ReservationSeed }) {
  const hub = useHub()!
  const [selected, setSelected] = useState<string[]>(initial?.gpuIds ?? []), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const gpus = hub.nodes.flatMap(node => node.gpus.map(gpu => ({ ...gpu, nodeName: node.name })))
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selected.length) { setError('请至少选择一张 GPU'); return }
    const form = new FormData(event.currentTarget); setBusy(true); setError('')
    try { await hubApi.createReservation({ gpuIds: selected, startsAt: new Date(String(form.get('startsAt'))).toISOString(), endsAt: new Date(String(form.get('endsAt'))).toISOString(), projectName: form.get('projectName'), purpose: form.get('purpose') }); await hub.refresh(); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '预约失败') } finally { setBusy(false) }
  }
  return <div className="scrim" onMouseDown={event => event.target === event.currentTarget && onClose()}><form className="sheet reservation-sheet hub-create-sheet" onSubmit={submit}><header className="sheet__header"><div><p className="eyebrow">协作式预约</p><h2>预约 GPU</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17}/></button></header><div className="reservation-body"><div className="reservation-condition"><span><CalendarDays size={16}/></span><div><strong>提交后自动确认</strong><small>同一 GPU 的时间区间不可重叠；每次最长 48 小时。</small></div></div><label>项目名称<input name="projectName" required maxLength={120} placeholder="例如：RadarDreamer 训练"/></label><div className="hub-form-grid"><label>开始时间<input name="startsAt" type="datetime-local" defaultValue={initial?.startsAt ?? localDate(1)} required/></label><label>结束时间<input name="endsAt" type="datetime-local" defaultValue={initial?.endsAt ?? localDate(5)} required/></label></div><fieldset><legend>选择 GPU</legend><div className="hub-gpu-picker">{gpus.map(gpu => <button type="button" disabled={gpu.maintenance || gpu.missing} className={selected.includes(gpu.id) ? 'is-selected' : ''} key={gpu.id} onClick={() => setSelected(current => current.includes(gpu.id) ? current.filter(id => id !== gpu.id) : [...current, gpu.id])}><span>{selected.includes(gpu.id) && <Check size={13}/>}</span><div><strong>{gpu.nodeName} · GPU {gpu.index}</strong><small>{gpu.name}</small></div></button>)}</div></fieldset><label>用途说明<textarea name="purpose" required maxLength={500} placeholder="训练任务、预计资源需求等"/></label>{error && <div className="hub-form-error">{error}</div>}</div><footer className="sheet__footer"><button type="button" className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={busy}>{busy ? '提交中…' : `确认预约${selected.length ? `（${selected.length} 张）` : ''}`}</button></footer></form></div>
}

export function HubAdminPage({ onRegister }: { onRegister: () => void }) {
  const hub = useHub()!
  const [nodes, setNodes] = useState<AdminNode[]>([]), [users, setUsers] = useState<AdminUser[]>([]), [error, setError] = useState(''), [syncing, setSyncing] = useState(false), [notice, setNotice] = useState('')
  const load = useCallback(() => Promise.all([hubApi.adminNodes(), hubApi.adminUsers()]).then(([nodeResult,userResult]) => { setNodes(nodeResult.nodes); setUsers(userResult.users); setError('') }).catch(cause => setError(cause instanceof Error ? cause.message : '无法加载管理数据')), [])
  useEffect(() => { void load() }, [load, hub.nodes])
  return <div className="detail-page hub-admin-page"><header className="hub-admin-heading"><div><p className="eyebrow">管理员</p><h2>Hub 管理面板</h2><small>注册 GPU 服务器，并将节点上的普通 Linux 用户同步为 Hub 账号。</small></div><button className="button button--primary" onClick={onRegister}><Plus size={15}/>注册服务器节点</button></header>{error && <div className="hub-form-error">{error}</div>}{notice&&<div className="hub-sync-notice"><Check size={14}/>{notice}</div>}<section className="panel hub-admin-card"><header><Server size={17}/><div><strong>服务器节点</strong><small>{nodes.length} 个已注册节点</small></div><button className="icon-button" onClick={() => void load()} aria-label="刷新节点"><RefreshCw size={14}/></button></header><div className="hub-admin-table"><div className="hub-admin-row hub-admin-row--head"><span>节点</span><span>主机名</span><span>状态</span><span>最近上报</span></div>{nodes.map(node => <div className="hub-admin-row" key={node.id}><span><i className={`server-row__status server-row__status--${node.lastSeenAt && Date.now()-new Date(node.lastSeenAt).getTime()<30000?'online':'offline'}`}/><strong>{node.name}</strong><small>{node.id}</small></span><span>{node.hostname}</span><span className={`status-pill status-pill--${node.enabled?'online':'offline'}`}><i className="status-pill__dot"/>{node.enabled?'已启用':'已停用'}</span><span>{node.lastSeenAt?new Date(node.lastSeenAt).toLocaleString('zh-CN'):'尚未接入'}</span></div>)}</div></section><section className="panel hub-admin-card"><header><UserRound size={17}/><div><strong>Hub 用户</strong><small>{users.length} 个账号 · Linux 用户名去重</small></div><button className="button button--secondary button--small" disabled={syncing} onClick={async()=>{setSyncing(true);try{const result=await hubApi.syncSystemUsers();setNotice(result.createdCount?`已创建 ${result.createdCount} 个账号：${result.created.join('、')}`:'没有需要创建的新账号');await load()}catch(cause){setError(cause instanceof Error?cause.message:'同步失败')}finally{setSyncing(false)}}}><RefreshCw className={syncing?'spin':''} size={13}/>{syncing?'同步中…':'同步系统用户'}</button></header><div className="hub-user-table"><div className="hub-user-row hub-admin-row--head"><span>登录名</span><span>Linux 用户</span><span>角色</span><span>密码状态</span></div>{users.map(user=><div className="hub-user-row" key={user.id}><span><strong>{user.displayName}</strong><small>{user.username}</small></span><span>{user.linuxUsername}</span><span>{user.role==='admin'?'管理员':'普通用户'}</span><span className={`status-pill status-pill--${user.mustChangePassword?'warning':'online'}`}><i className="status-pill__dot"/>{user.mustChangePassword?'首次登录需改密':'正常'}</span></div>)}</div></section><section className="panel hub-admin-notice"><ShieldCheck size={18}/><div><strong>默认账号规则</strong><p>采集 UID ≥ 1000 且拥有可登录 Shell 的用户；初始密码为“用户名@123456”，首次登录必须修改。</p></div></section></div>
}

export function HubNodeRegistrationSheet({ onClose }: { onClose: () => void }) {
  const hub = useHub()!
  const [registration, setRegistration] = useState<NodeRegistration | null>(null), [nodeName, setNodeName] = useState(''), [hostname, setHostname] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState('')
  const envText = registration ? `GPUDECK_HUB_URL=${registration.hubUrl}\nGPUDECK_NODE_ID=${registration.id}\nGPUDECK_AGENT_TOKEN=${registration.token}\nGPUDECK_SAMPLE_SECONDS=5\nRUST_LOG=gpudeck_agent=info\n` : ''
  const copy = async (value: string, label: string) => { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(''), 1500) }
  const download = () => { const url=URL.createObjectURL(new Blob([envText],{type:'text/plain'})); const link=document.createElement('a'); link.href=url; link.download=`gpudeck-agent-${nodeName || 'node'}.env`; link.click(); URL.revokeObjectURL(url) }
  return <div className="scrim" onMouseDown={event => event.target===event.currentTarget && !registration && onClose()}><form className="sheet hub-node-sheet" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { setRegistration(await hubApi.registerNode(nodeName, hostname)); await hub.refresh() } catch(cause){setError(cause instanceof Error?cause.message:'节点注册失败')} finally{setBusy(false)} }}><header className="sheet__header"><div><p className="eyebrow">管理员 · 节点接入</p><h2>{registration?'保存 Agent 凭据':'注册服务器节点'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17}/></button></header>{registration?<div className="hub-node-result"><div className="hub-secret-warning"><ShieldCheck size={18}/><div><strong>凭据只显示这一次</strong><p>关闭窗口前请下载或复制配置；Token 无法再次查询。</p></div></div><label>Node ID<div className="hub-copy-field"><code>{registration.id}</code><button type="button" className="icon-button" onClick={()=>void copy(registration.id,'Node ID')}><Copy size={14}/></button></div></label><label>Agent Token<div className="hub-copy-field"><code>{registration.token}</code><button type="button" className="icon-button" onClick={()=>void copy(registration.token,'Token')}><Copy size={14}/></button></div></label><label>完整环境配置<textarea readOnly value={envText}/></label>{copied&&<span className="hub-copy-success"><Check size={13}/>{copied} 已复制</span>}</div>:<div className="hub-node-form"><div className="reservation-condition"><span><Server size={16}/></span><div><strong>为每台物理服务器单独注册</strong><small>注册后 Agent 使用只读权限采集 GPU 和进程遥测。</small></div></div><label>节点显示名称<input value={nodeName} onChange={event=>setNodeName(event.target.value)} required maxLength={120} placeholder="例如：WHUServer-H200"/></label><label>服务器主机名<input value={hostname} onChange={event=>setHostname(event.target.value)} required maxLength={255} placeholder="例如：WHUServer-H200 或 Tailscale DNS 名称"/></label>{error&&<div className="hub-form-error">{error}</div>}</div>}<footer className="sheet__footer">{registration?<><button type="button" className="button button--secondary" onClick={()=>void copy(envText,'完整配置')}><Copy size={14}/>复制配置</button><button type="button" className="button button--primary" onClick={download}><Download size={14}/>下载配置</button></>:<><button type="button" className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={busy}>{busy?'注册中…':'生成节点凭据'}</button></>}</footer></form></div>
}

export function HubPasswordChange({ user, onChanged }: { user: User; onChanged: (user: User) => void }) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  return <div className="scrim hub-password-scrim"><form className="sheet hub-password-sheet" onSubmit={async event=>{event.preventDefault();const form=new FormData(event.currentTarget), next=String(form.get('newPassword')), confirm=String(form.get('confirmPassword'));if(next!==confirm){setError('两次输入的新密码不一致');return}setBusy(true);setError('');try{await hubApi.changePassword(String(form.get('currentPassword')),next);onChanged(await hubApi.me())}catch(cause){setError(cause instanceof Error?cause.message:'修改密码失败')}finally{setBusy(false)}}}><header className="sheet__header"><div><p className="eyebrow">首次登录</p><h2>请修改初始密码</h2></div></header><div className="hub-node-form"><div className="hub-secret-warning"><ShieldCheck size={18}/><div><strong>{user.displayName}，初始密码不能继续使用</strong><p>新密码至少 12 个字符，修改完成后进入 GPUDeck Hub。</p></div></div><label>当前密码<input name="currentPassword" type="password" required autoFocus/></label><label>新密码<input name="newPassword" type="password" minLength={12} required/></label><label>确认新密码<input name="confirmPassword" type="password" minLength={12} required/></label>{error&&<div className="hub-form-error">{error}</div>}</div><footer className="sheet__footer"><button className="button button--primary" disabled={busy}>{busy?'保存中…':'修改密码并继续'}</button></footer></form></div>
}
