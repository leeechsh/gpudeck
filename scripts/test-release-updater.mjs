import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpudeck-updater-test-'))
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o755 }) }
try {
  const bin = path.join(dir, 'bin'), fixtures = path.join(dir, 'fixtures')
  fs.mkdirSync(bin); fs.mkdirSync(fixtures)
  write(`${bin}/uname`, '#!/bin/bash\nif [[ "$1" == -s ]]; then echo Linux; else echo "$TEST_ARCH"; fi\n')
  write(`${bin}/id`, '#!/bin/bash\necho 0\n')
  write(`${bin}/sleep`, '#!/bin/bash\nexit 0\n')
  write(`${bin}/install`, '#!/bin/bash\nargs=()\nwhile [[ $# -gt 0 ]]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done\n/usr/bin/install "${args[@]}"\n')
  write(`${bin}/curl`, `#!/bin/bash
url=''; output=''
while [[ $# -gt 0 ]]; do case "$1" in -o) output=$2; shift 2;; http*) url=$1; shift;; *) shift;; esac; done
if [[ "$url" == */healthz ]]; then
  if [[ -f "$TEST_ROOT/new-started" && "$TEST_FAIL_HEALTH" == 1 ]]; then exit 22; fi
  echo ok; exit 0
fi
echo "$url" >> "$TEST_ROOT/downloads"
url=\${url#https://gh-proxy.com/}
if [[ "$url" == https://api.github.com/* ]]; then cp "$TEST_FIXTURES/release.json" "$output"; else cp "$TEST_FIXTURES/$(basename "$url")" "$output"; fi
`)
  write(`${bin}/systemctl`, `#!/bin/bash
echo "$*" >> "$TEST_ROOT/calls"
case "$1" in
show) case "$*" in *ExecStart*) echo "{ path=$TEST_ROOT/usr/local/bin/gpudeck-$TEST_COMPONENT ; argv[]=fixture ; }";; *MainPID*) echo 123;; *) echo 0;; esac;;
start) if "$TEST_ROOT/usr/local/bin/gpudeck-$TEST_COMPONENT" --version | /usr/bin/grep -q 9.8.7; then touch "$TEST_ROOT/new-started"; fi;;
esac
`)
  const script = fs.readFileSync('deploy/update-from-release.sh', 'utf8')
    .replaceAll('/usr/local/bin/', `${dir}/root/usr/local/bin/`)
    .replaceAll('/etc/gpudeck', `${dir}/root/etc/gpudeck`)
    .replaceAll('/var/lib/gpudeck', `${dir}/root/var/lib/gpudeck`)
    .replaceAll('/run/gpudeck-', `${dir}/root/run/gpudeck-`)
  write(`${dir}/update.sh`, script)
  let count = 0
  function run({ component = 'hub', arch = 'x86_64', check = false, badHash = false, failHealth = false, legacy = false, old = '1.0.0', missing = false, evilUrl = false, prefix = '', expected = true } = {}) {
    const root = `${dir}/root`
    fs.rmSync(root, { recursive: true, force: true })
    for (const folder of ['usr/local/bin', 'etc/gpudeck', 'var/lib/gpudeck', 'run/lock']) fs.mkdirSync(`${root}/${folder}`, { recursive: true })
    const binary = `${root}/usr/local/bin/gpudeck-${component}`
    const original = legacy ? '#!/bin/bash\nexit 1\n' : `#!/bin/bash\necho 'gpudeck-${component} ${old}'\n`
    write(binary, original)
    const config = component === 'hub' ? `${root}/etc/gpudeck/hub.env` : `${root}/etc/gpudeck-agent.env`
    const configText = `GPUDECK_LISTEN=100.77.69.72:37935\nDATABASE_URL=sqlite://${root}/var/lib/gpudeck/gpudeck.sqlite\n`
    write(config, configText); write(`${root}/var/lib/gpudeck/gpudeck.sqlite`, 'database unchanged')
    const asset = `gpudeck-${component}-9.8.7-linux-${arch === 'arm64' ? 'aarch64' : arch}.gz`
    const archive = zlib.gzipSync(Buffer.from(`#!/bin/bash\necho 'gpudeck-${component} 9.8.7'\n`))
    fs.writeFileSync(`${fixtures}/${asset}`, archive)
    const sum = `SHA256SUMS-9.8.7-linux-${arch === 'arm64' ? 'aarch64' : arch}`
    write(`${fixtures}/${sum}`, `${badHash ? '0'.repeat(64) : crypto.createHash('sha256').update(archive).digest('hex')}  ${asset}\n`)
    write(`${fixtures}/release.json`, JSON.stringify({ draft: false, tag_name: 'v9.8.7', assets: missing ? [] : [asset, sum].map(name => ({ name, browser_download_url: `https://${evilUrl ? 'evil.example' : 'github.com'}/leeechsh/gpudeck/releases/download/v9.8.7/${name}` })) }))
    const result = cp.spawnSync('bash', [`${dir}/update.sh`, '--component', component, ...(check ? ['--check'] : []), ...(prefix ? ['--download-prefix', prefix] : [])], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, TEST_FIXTURES: fixtures, TEST_ARCH: arch, TEST_COMPONENT: component, TEST_FAIL_HEALTH: failHealth ? '1' : '0' } })
    assert.equal(result.status === 0, expected, result.stdout + result.stderr)
    assert.equal(fs.readFileSync(config, 'utf8'), configText)
    assert.equal(fs.readFileSync(`${root}/var/lib/gpudeck/gpudeck.sqlite`, 'utf8'), 'database unchanged')
    if (!expected || check || old === '9.8.7') assert.equal(fs.readFileSync(binary, 'utf8'), original)
    else assert.match(fs.readFileSync(binary, 'utf8'), /9\.8\.7/)
    if (check || badHash || missing || evilUrl) assert.equal(fs.existsSync(`${root}/calls`), false)
    if (failHealth) assert.match(result.stderr, /restoring executable/)
    if (expected && prefix) {
      const urls = fs.readFileSync(`${root}/downloads`, 'utf8').trim().split('\n')
      assert.equal(urls.length, 3)
      assert.ok(urls.every(url => url.startsWith('https://gh-proxy.com/https://')))
    }
    count++
  }
  run(); run({ component: 'agent' }); run({ component: 'agent', legacy: true })
  run({ arch: 'aarch64', check: true }); run({ arch: 'arm64', check: true })
  run({ badHash: true, expected: false }); run({ missing: true, expected: false }); run({ evilUrl: true, expected: false })
  run({ old: '9.8.7' }); run({ old: '99.0.0', expected: false }); run({ failHealth: true, expected: false })
  run({ arch: 'riscv64', expected: false })
  run({ prefix: 'https://gh-proxy.com/' }); run({ component: 'agent', prefix: 'https://gh-proxy.com', check: true })
  run({ prefix: 'http://gh-proxy.com/', expected: false }); run({ prefix: 'https://gh-proxy.com.evil/', expected: false })
  console.log(`Release updater: ${count} isolated cases passed; no host services changed.`)
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
