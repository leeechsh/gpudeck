import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

// Only --check is exercised: never install or restart services on the test host.
const dir=mkdtempSync(join(tmpdir(),'gpudeck-install-test-'))
const binary=join(dir,'binary'), config=join(dir,'node.env'), marker=join(dir,'executed')
writeFileSync(binary,'#!/bin/sh\necho gpudeck-test\n',{mode:0o700})
const run=(script,args,success)=>{
  const result=spawnSync('bash',[`deploy/${script}.sh`,'--check','--binary',binary,...args],{encoding:'utf8'})
  assert.equal(result.status===0,success,`${script}: ${result.stdout}${result.stderr}`)
}
const valid='GPUDECK_HUB_URL=http://100.77.69.72:37935\nGPUDECK_NODE_ID=00000000-0000-0000-0000-000000000001\nGPUDECK_AGENT_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789_ABCD\nGPUDECK_SAMPLE_SECONDS=5\nRUST_LOG=gpudeck_agent=info\n'
try {
  for(const url of ['http://localhost:37935','https://gpudeck.example.org','http://[::1]:37935'])run('install-hub',['--public-url',url],true)
  for(const url of ['https://user:password@host','https://host/path','https://host\nOTHER=value'])run('install-hub',['--public-url',url],false)
  run('install-hub',['--listen','0.0.0.0:99999'],false)
  run('install-hub',['--admin','admin\nINJECT=value'],false)
  writeFileSync(config,valid)
  run('install-agent',['--config',config],true)
  run('install-agent',['--config',config,'--hub-url','https://other.example.org'],true)
  writeFileSync(config,valid.replaceAll('\n','\r\n'))
  run('install-agent',['--config',config],true)
  for(const invalid of [valid+'GPUDECK_NODE_ID=duplicate\n',valid.replace('GPUDECK_SAMPLE_SECONDS=5','GPUDECK_SAMPLE_SECONDS=0'),valid.replace('00000000-0000-0000-0000-000000000001','invalid'),valid.replace('abcdefghijklmnopqrstuvwxyz0123456789_ABCD',`$(touch ${marker})`),valid+'LD_PRELOAD=/tmp/evil\n']) {
    writeFileSync(config,invalid)
    run('install-agent',['--config',config],false)
  }
  assert.equal(existsSync(marker),false)
  console.log('Fresh installer validation: 16 cases passed; no services or system files modified.')
} finally {rmSync(dir,{recursive:true,force:true})}
