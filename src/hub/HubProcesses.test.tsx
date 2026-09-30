// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { HubProcesses } from './HubProcesses'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const server = { id: 'node', name: 'L40S', host: 'lab', status: 'online' } as Server
const snapshot = { serverId: 'node', hostname: 'lab', username: 'alice', osId: 'linux', osName: 'Linux', status: 'online', nvidiaSmi: 'available', disks: [],
  system: { cpuModel: '', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
  timestamp: 1, acceleratorVendor: 'nvidia', gpus: [], cpuProcesses: [], processes: [
  { gpuUuid: 'gpu1', gpuIndex: 0, pid: 12, username: 'alice', command: 'python train.py', memoryUsedMb: 1024, cpuPercent: 0, elapsed: '—', isCurrentUser: true },
  { gpuUuid: 'gpu2', gpuIndex: 1, pid: 12, username: 'alice', command: 'python train.py', memoryUsedMb: 2048, cpuPercent: 0, elapsed: '—', isCurrentUser: true },
  { gpuUuid: 'gpu3', gpuIndex: 2, pid: 13, username: 'bob', command: 'private-task', memoryUsedMb: 2048, cpuPercent: 0, elapsed: '—', isCurrentUser: false },
] } as unknown as Snapshot
describe('Hub processes', () => {
  it('filters by system identity, counts distinct PIDs and GPUs, expands rows and refreshes', async () => {
    const host = document.createElement('div'); const root = createRoot(host); const refresh = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(<HubProcesses servers={[server]} snapshots={{ node: snapshot }} username="alice" onRefresh={refresh}/>))
    expect(host.textContent).toContain('1 个进程 · 2 张 GPU')
    expect(host.textContent).not.toContain('private-task')
    expect(host.textContent).not.toContain('启动任务')
    await act(async () => (host.querySelector('tr[tabindex]') as HTMLElement).click())
    expect(host.querySelector('.process-detail-row')).not.toBeNull()
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(refresh).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })
  it('shows an explicit empty state and refresh failure', async () => {
    const host = document.createElement('div'); const root = createRoot(host)
    await act(async () => root.render(<HubProcesses servers={[{ ...server, status: 'offline' }]} snapshots={{ node: snapshot }} username="nobody" onRefresh={async () => { throw new Error('连接失败') }}/>))
    expect(host.textContent).toContain('没有我的 GPU 进程')
    expect(host.textContent).toContain('离线节点')
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('连接失败')
    await act(async () => root.unmount())
  })
})
