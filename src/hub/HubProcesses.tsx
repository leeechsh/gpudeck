import { useState } from 'react'
import { RefreshCw, UserRound } from 'lucide-react'
import type { Server, Snapshot } from '../types/models'
import { ProcessBlocks } from '../components/ProcessBlocks'

export function HubProcesses({ servers, snapshots, username, onRefresh }: {
  servers: Server[]
  snapshots: Record<string, Snapshot>
  username: string
  onRefresh: () => Promise<void>
}) {
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const entries = servers.flatMap(server => {
    const snapshot = snapshots[server.id]
    if (!snapshot) return []
    const processes = snapshot.processes.filter(process => process.username === username)
    return processes.length ? [{ server, snapshot: { ...snapshot, processes, cpuProcesses: [] } }] : []
  })
  const count = entries.reduce((sum, entry) => sum + new Set(entry.snapshot.processes.map(process => process.pid)).size, 0)
  const cards = entries.reduce((sum, entry) => sum + new Set(entry.snapshot.processes.map(process => process.gpuUuid)).size, 0)
  return <div className="detail-page mine-process-page">
    <section className="panel"><header className="panel__header"><div><h2>我的 GPU 进程</h2><p>系统用户名：{username} · {count} 个进程 · {cards} 张 GPU · {entries.length} 台服务器</p></div><button className="button button--secondary" disabled={refreshing} onClick={async () => {
      setRefreshing(true); setError('')
      try { await onRefresh() } catch (cause) { setError(cause instanceof Error ? cause.message : '刷新失败，请重试') } finally { setRefreshing(false) }
    }}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/>{refreshing ? '正在刷新…' : '刷新进程'}</button></header></section>
    {error && <p role="alert">{error}</p>}
    {servers.some(server => server.status !== 'online') && <p role="status">离线节点的进程为最后一次采样结果，请在节点恢复后确认。</p>}
    {entries.length ? <div className="mine-process-list">{entries.map(({ server, snapshot }) => <section className="mine-process-server" key={server.id}>
      <header className="panel__header"><div><h2>{server.name}</h2><p>{server.host} · {server.status === 'online' ? '在线' : '离线'} · 最近采样 {new Date(snapshot.timestamp * 1000).toLocaleString('zh-CN')}</p></div></header>
      <ProcessBlocks snapshot={snapshot} hideEmptyBlocks loading={refreshing}/>
    </section>)}</div> : <div className="mine-process-empty" role="status"><UserRound size={28}/><strong>没有我的 GPU 进程</strong><p>已接入节点尚未检测到系统用户 {username} 的 GPU 进程。Agent 当前仅采集 GPU 进程。</p></div>}
  </div>
}
