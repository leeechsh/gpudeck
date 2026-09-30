import { CheckCircle2, Cpu, UserRound } from 'lucide-react'
import type { Snapshot } from '../types/models'
import { summarizeGpuOccupancy } from '../utils/gpuOccupancy'

interface GpuOccupancyPanelProps {
  snapshots: Record<string, Snapshot>
}

export function GpuOccupancyPanel({ snapshots }: GpuOccupancyPanelProps) {
  const summary = summarizeGpuOccupancy(Object.values(snapshots))
  const availabilityPercent = summary.total > 0 ? Math.round(summary.available / summary.total * 100) : 0

  return (
    <section className="gpu-occupancy-panel" aria-label="GPU 占用总览">
      <header className="gpu-occupancy-panel__header">
        <span><Cpu size={14} />GPU 占用总览</span>
        <strong>{summary.total} 张</strong>
      </header>

      <div className="gpu-occupancy-panel__availability">
        <div className="gpu-occupancy-panel__availability-title">
          <span><CheckCircle2 size={14} />可用 GPU</span>
          <strong>{availabilityPercent}%</strong>
        </div>
        <div className="gpu-occupancy-panel__track" aria-hidden="true"><span style={{ width: `${availabilityPercent}%` }} /></div>
        <div className="gpu-occupancy-panel__availability-count"><strong>{summary.available} / {summary.total}</strong><span>可直接使用</span></div>
      </div>

      <div className="gpu-occupancy-panel__section">
        <div className="gpu-occupancy-panel__section-title"><span>用户占用</span><span>{summary.users.length} 人</span></div>
        {summary.users.length > 0 ? summary.users.map((user) => (
          <div className="gpu-occupancy-panel__row" key={user.username}>
            <span className="gpu-occupancy-panel__name"><UserRound size={13} /><strong>{user.username}</strong></span>
            <b>{user.gpuCount} 张</b>
          </div>
        )) : <p className="gpu-occupancy-panel__empty">当前没有检测到用户进程</p>}
      </div>

      <div className="gpu-occupancy-panel__section">
        <div className="gpu-occupancy-panel__section-title"><span>型号分布</span><span>可用 / 总数</span></div>
        {summary.models.map((model) => (
          <div className="gpu-occupancy-panel__row" key={model.name}>
            <span className="gpu-occupancy-panel__name"><Cpu size={13} /><strong>{model.name}</strong></span>
            <b className={model.available > 0 ? 'is-available' : ''}>{model.available} / {model.total}</b>
          </div>
        ))}
      </div>
    </section>
  )
}
