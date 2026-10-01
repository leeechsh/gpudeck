import type { Node, Reservation, User } from './api'
import { reservationWindowStart } from './reservationTime'

export const overlaps = (start: number, end: number, otherStart: number, otherEnd: number) => start < otherEnd && otherStart < end
export function reservationChecks(gpuIds: string[], startsAt: string, endsAt: string, reservations: Reservation[], nodes: Node[], user: User, now = Date.now()) {
  const start = new Date(startsAt).getTime(), end = new Date(endsAt).getTime()
  const errors: string[] = []
  if (!Number.isFinite(start + end) || end <= start) return { errors: ['结束时间必须晚于开始时间'], warnings: [] as string[] }
  if (start < reservationWindowStart(now) || start > now + 14 * 86400000) errors.push('开始时间必须在当前半小时窗口或未来 14 天内')
  if (end <= now) errors.push('结束时间必须晚于当前时间')
  if (end - start > 48 * 3600000) errors.push('每次预约最长 48 小时')
  if (!gpuIds.length) errors.push('请至少选择一张 GPU')
  const active = reservations.filter(item => !['cancelled','completed'].includes(item.status) && overlaps(start,end,new Date(item.startsAt).getTime(),new Date(item.endsAt).getTime()))
  const warnings: string[] = []
  for (const id of gpuIds) {
    const node = nodes.find(node => node.gpus.some(gpu => gpu.id === id)), gpu = node?.gpus.find(gpu => gpu.id === id)
    const label = `${node?.name ?? '未知节点'} · GPU ${gpu?.index ?? id}`
    if (!gpu || gpu.maintenance || gpu.missing) errors.push(`${label} 不可预约（维护或不可用）`)
    for (const item of active.filter(item => item.gpuIds.includes(id))) errors.push(`${label} 与 ${item.ownerName} 的“${item.projectName}”冲突：${new Date(item.startsAt).toLocaleString('zh-CN')} — ${new Date(item.endsAt).toLocaleString('zh-CN')}`)
    if (node && (!node.lastSeenAt || now - new Date(node.lastSeenAt).getTime() >= 30000)) warnings.push(`${label} 节点离线，实际占用状态需确认`)
    else if (gpu && (gpu.processes.length > 0 || (gpu.memoryUsedMb ?? 0) > 256)) warnings.push(`${label} 当前有进程或显存占用；预约不会停止现有任务`)
  }
  const own = active.filter(item => item.ownerId === user.id)
  const points = [start, ...own.map(item => Math.max(start,new Date(item.startsAt).getTime()))]
  const peak = Math.max(gpuIds.length,...points.filter(time => time < end).map(time => new Set([...gpuIds,...own.filter(item => new Date(item.startsAt).getTime() <= time && time < new Date(item.endsAt).getTime()).flatMap(item => item.gpuIds)]).size))
  if (peak > user.concurrentGpuLimit) errors.push(`并发预约将达到 ${peak} 张 GPU，超过你的 ${user.concurrentGpuLimit} 张上限`)
  return {errors:[...new Set(errors)], warnings:[...new Set(warnings)]}
}
