import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpudeck-publisher-test-'))
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version
try {
  const assets=path.join(dir,'assets'),bin=path.join(dir,'bin');fs.mkdirSync(assets);fs.mkdirSync(bin)
  const metadata=[]
  for(const arch of ['x86_64','aarch64']){
    const names=[`gpudeck-${version}-linux-${arch}.tar.gz`,`gpudeck-hub-${version}-linux-${arch}.gz`,`gpudeck-agent-${version}-linux-${arch}.gz`]
    let sums=''
    for(const name of names){fs.writeFileSync(path.join(assets,name),'fixture');sums+=crypto.createHash('sha256').update('fixture').digest('hex')+'  '+name+'\n'}
    fs.writeFileSync(path.join(assets,`SHA256SUMS-${version}-linux-${arch}`),sums)
  }
  for(const name of fs.readdirSync(assets))metadata.push({name,digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(assets,name))).digest('hex')})
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({assets:metadata}))
  // Emulate a draft that resolves in gh but cannot be fetched by tag REST API.
  fs.writeFileSync(path.join(bin,'gh'),`#!/bin/bash
set -euo pipefail
if [[ "$1" == api ]]; then
  [[ "$2" == https://api.github.com/repos/leeechsh/gpudeck/releases/12345 ]] || exit 44
  cat "$TEST_RELEASE_DIR/metadata.json"
elif [[ "$2" == view ]]; then
  case "$*" in *apiUrl*) echo https://api.github.com/repos/leeechsh/gpudeck/releases/12345;; *isDraft*) echo true;; *) echo verified;; esac
elif [[ "$2" == download ]]; then
  name=''; dest=''
  while [[ $# -gt 0 ]]; do case "$1" in --pattern) name=$2;shift 2;; --dir) dest=$2;shift 2;; *) shift;; esac; done
  cp "$TEST_RELEASE_DIR/assets/$name" "$dest/$name"
elif [[ "$2" == edit ]]; then
  touch "$TEST_RELEASE_DIR/published"
elif [[ "$2" != upload ]]; then exit 45
fi
`,{mode:0o700})
  const result=spawnSync('bash',['scripts/publish-server-release.sh',assets],{env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_RELEASE_DIR:dir,RELEASE_TAG:'v'+version,GITHUB_REPOSITORY:'leeechsh/gpudeck'},encoding:'utf8'})
  assert.equal(result.status,0,result.stdout+result.stderr)
  assert.equal(fs.existsSync(path.join(dir,'published')),true)
  console.log('Draft-release ID metadata lookup and eight-asset verification passed (mock GitHub; no external writes).')
} finally {fs.rmSync(dir,{recursive:true,force:true})}
