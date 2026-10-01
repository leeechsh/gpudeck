import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpudeck-release-installer-test-'))
const files=['target/release/gpudeck-hub','target/release/gpudeck-agent','deploy/install-hub.sh','deploy/install-agent.sh','deploy/gpudeck-hub.service','deploy/gpudeck-agent.service','docs/QUICKSTART.md']
const tag='v9.8.7', repo='leeechsh/gpudeck'
try {
  const bin=path.join(dir,'bin'),pkg=path.join(dir,'pkg')
  fs.mkdirSync(bin);fs.mkdirSync(pkg)
  for(const file of files){const target=path.join(pkg,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.endsWith('.sh')?'#!/bin/bash\nprintf "validated installer args: %s\\n" "$*"\n':'fixture',{mode:0o700})}
  fs.writeFileSync(path.join(bin,'uname'),'#!/bin/bash\nif [[ "$1" == -s ]]; then echo Linux; else echo "$TEST_ARCH"; fi\n',{mode:0o700})
  fs.writeFileSync(path.join(bin,'curl'),`#!/bin/bash
set -eu
url=''; output=''
while [[ $# -gt 0 ]]; do
case "$1" in -o) output=$2;shift 2;; https://*) url=$1;shift;; *) shift;; esac
done
echo "$url" >> "$TEST_FIXTURES/downloads"
url=\${url#https://gh-proxy.com/}
if [[ "$url" == https://api.github.com/* ]]; then cp "$TEST_FIXTURES/release.json" "$output"; else cp "$TEST_FIXTURES/$(basename "$url")" "$output"; fi
`,{mode:0o700})
  for(const arch of ['x86_64','aarch64']){
    const name=`gpudeck-9.8.7-linux-${arch}.tar.gz`,sum=`SHA256SUMS-9.8.7-linux-${arch}`
    assert.equal(cp.spawnSync('tar',['-czf',path.join(dir,name),...files],{cwd:pkg}).status,0)
    fs.writeFileSync(path.join(dir,sum),crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex')+'  '+name+'\n')
  }
  let count=0
  const run=(arch,success,extra=[])=>{
    fs.writeFileSync(path.join(dir,'downloads'),'')
    const result=cp.spawnSync('bash',['deploy/install-from-release.sh','--component','hub','--check',...extra],{env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_ARCH:arch,TEST_FIXTURES:dir},encoding:'utf8'})
    assert.equal(result.status===0,success,result.stdout+result.stderr)
    if(success)assert.match(result.stdout,/validated installer args/)
    if(success && extra.includes('--download-prefix')) {
      const urls=fs.readFileSync(path.join(dir,'downloads'),'utf8').trim().split('\n')
      assert.equal(urls.length,3)
      assert.ok(urls.every(url=>url.startsWith('https://gh-proxy.com/https://')))
      assert.match(urls[0], /\/https:\/\/api.github.com\//)
      assert.doesNotMatch(result.stdout.split('validated installer args:')[1], /download-prefix/)
    }
    count++
  }
  const assets=[]
  for(const arch of ['x86_64','aarch64'])for(const name of [`gpudeck-9.8.7-linux-${arch}.tar.gz`,`SHA256SUMS-9.8.7-linux-${arch}`])assets.push({name,browser_download_url:`https://github.com/${repo}/releases/download/${tag}/${name}`})
  const meta={tag_name:tag,draft:false,assets}
  fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify(meta))
  run('x86_64',true,['--download-prefix','https://gh-proxy.com/'])
  run('aarch64',true,['--download-prefix','https://gh-proxy.com'])
  run('x86_64',false,['--download-prefix','http://gh-proxy.com/'])
  run('x86_64',false,['--download-prefix','https://gh-proxy.com.evil/'])
  run('x86_64',true);run('aarch64',true);run('arm64',true,['--version',tag]);run('riscv64',false);run('x86_64',false,['--version','v1.0.0'])
  fs.writeFileSync(path.join(dir,'SHA256SUMS-9.8.7-linux-x86_64'),'0'.repeat(64)+'  gpudeck-9.8.7-linux-x86_64.tar.gz\n')
  run('x86_64',false)
  meta.assets=[];fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify(meta));run('aarch64',false)
  meta.assets=assets;fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify(meta))
  run('aarch64',true,['--component','agent','--config','/tmp/node config.env'])
  const archive='gpudeck-9.8.7-linux-aarch64.tar.gz', checksum='SHA256SUMS-9.8.7-linux-aarch64'
  const rebuild=(members)=>{
    assert.equal(cp.spawnSync('tar',['-czf',path.join(dir,archive),...members],{cwd:pkg}).status,0)
    fs.writeFileSync(path.join(dir,checksum),crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,archive))).digest('hex')+'  '+archive+'\n')
  }
  fs.writeFileSync(path.join(pkg,'unexpected'),'fixture');rebuild([...files,'unexpected']);run('aarch64',false)
  fs.unlinkSync(path.join(pkg,files[0]));fs.symlinkSync('/etc/passwd',path.join(pkg,files[0]));rebuild(files);run('aarch64',false)
  console.log(`Release installer: ${count} download/architecture/version/checksum cases passed; no services modified.`)
} finally {fs.rmSync(dir,{recursive:true,force:true})}
