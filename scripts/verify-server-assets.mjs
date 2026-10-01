import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const [dir,metadata]=process.argv.slice(2)
const {assets}=JSON.parse(readFileSync(metadata,'utf8'))
const version=JSON.parse(readFileSync('package.json','utf8')).version
for(const arch of ['x86_64','aarch64']) {
  for(const name of [`gpudeck-${version}-linux-${arch}.tar.gz`,`gpudeck-hub-${version}-linux-${arch}.gz`,`gpudeck-agent-${version}-linux-${arch}.gz`,`SHA256SUMS-${version}-linux-${arch}`]) {
    const asset=assets.find(a=>a.name===name)
    const digest='sha256:'+createHash('sha256').update(readFileSync(join(dir,name))).digest('hex')
    if(!asset || asset.digest!==digest)throw Error(`GitHub Assets Digest mismatch or missing: ${name}`)
  }
}
console.log('All eight GitHub Assets digests verified.')
