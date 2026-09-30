import { useEffect, useState, type FormEvent } from 'react'
import { ShieldCheck } from 'lucide-react'
import { hubApi } from './api'

export function GlobalReservationSettings({ onSaved }: { onSaved: () => Promise<void> }) {
  const [limit, setLimit] = useState('')
  const [savedLimit, setSavedLimit] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = async () => {
    setError('')
    try {
      const settings = await hubApi.globalSettings()
      setLimit(String(settings.concurrentGpuLimit))
      setSavedLimit(settings.concurrentGpuLimit)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法加载全局设置') }
  }
  useEffect(() => { void load() }, [])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const value = Number(limit)
    if (!Number.isInteger(value) || value < 1 || value > 14) {
      setError('并发 GPU 上限必须为 1–14 的整数'); return
    }
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await hubApi.saveGlobalSettings(value)
      setLimit(String(result.concurrentGpuLimit)); setSavedLimit(result.concurrentGpuLimit)
      setNotice(`已将 ${result.updatedUserCount} 个账号的并发上限统一设为 ${result.concurrentGpuLimit} 张 GPU。`)
      // Saving succeeded even if subsequent telemetry/profile refresh fails.
      await onSaved().catch(() => setNotice(`设置已保存为 ${result.concurrentGpuLimit} 张 GPU；账号信息暂未刷新，请刷新页面。`))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试') }
    finally { setBusy(false) }
  }
  return <section className="panel hub-admin-card">
    <header><ShieldCheck size={17}/><div><strong>全局预约设置</strong><small>统一管理所有账号的预约并发上限</small></div></header>
    <form className="hub-global-settings" onSubmit={save}>
      <label htmlFor="global-gpu-limit">每个账号的并发 GPU 上限</label>
      <div className="hub-global-settings__controls">
        <input id="global-gpu-limit" type="number" required min={1} max={14} step={1} value={limit} disabled={busy || savedLimit === null} onChange={event => { setLimit(event.target.value); setNotice(''); setError('') }} aria-describedby="global-gpu-limit-help"/>
        <span>张 GPU</span>
        <button className="button button--primary" disabled={busy || savedLimit === null || Number(limit) === savedLimit}>{busy ? '保存中…' : '保存并应用到所有用户'}</button>
      </div>
      <p id="global-gpu-limit-help">可设置 1–14 张，适用于所有账号（包含管理员）。新注册或同步的账号自动继承；按同一时刻预约的 GPU 总数计算，不限制实际进程。</p>
      <p>降低上限不会取消或缩减已有预约；新预约会按新上限校验。</p>
      {savedLimit === null && !error && <p role="status">正在加载全局设置…</p>}
      {notice && <div className="hub-sync-notice" role="status">{notice}</div>}
      {error && <div className="hub-form-error" role="alert">{error}{savedLimit === null && <button type="button" className="button button--secondary button--small" onClick={() => void load()}>重新加载</button>}</div>}
    </form>
  </section>
}
