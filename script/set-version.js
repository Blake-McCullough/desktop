// Stamp a version into app/package.json before a release build, e.g.
// `node script/set-version.js 3.6.11-custom1-b00042`.
const fs = require('fs')
const path = require('path')

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+)?$/.test(version || '')) {
  console.error(`Invalid version: ${version}`)
  process.exit(1)
}

const file = path.join(__dirname, '..', 'app', 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.version = version
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log(`Version set to ${version}`)
