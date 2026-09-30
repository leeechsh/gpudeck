import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import App from '../App'
import { hubApi, User } from './api'
import { HubPasswordChange, HubProvider } from './HubFeatures'
import './hub.css'

export default function HubApp() {
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { hubApi.me().then(setUser).catch(() => undefined).finally(() => setLoading(false)) }, [])

  if (loading) return <div className="hub-gate"><span className="brand__mark"><Activity size={22}/></span><p>正在连接 GPUDeck Hub…</p></div>
  if (user?.mustChangePassword) return <HubPasswordChange user={user} onChanged={setUser}/>
  if (user) return <HubProvider user={user} onLogout={() => setUser(null)}><App /></HubProvider>

  return <div className="hub-gate"><form className="panel hub-login" onSubmit={async event => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setLoading(true); setError('')
    try {
      await hubApi.login(String(form.get('username')), String(form.get('password')))
      setUser(await hubApi.me())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败')
    } finally { setLoading(false) }
  }}>
    <span className="brand__mark hub-login__mark"><Activity size={24}/></span>
    <h1>GPUDeck</h1><p>Collaborative GPU Resource Management</p>
    <label>用户名<input name="username" autoComplete="username" required autoFocus/></label>
    <label>密码<input name="password" type="password" autoComplete="current-password" required/></label>
    {error && <div className="hub-login__error">{error}</div>}
    <button className="button button--primary" disabled={loading}>{loading ? '登录中…' : '登录'}</button>
  </form></div>
}
