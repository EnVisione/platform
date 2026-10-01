const { readFileSync, writeFileSync } = require('node:fs')

const path = '/usr/src/app/bundle.js'
const source = readFileSync(path, 'utf8')
const start = 'loginInfo = await (0, import_account.joinWithProvider)('
const oldArgument = '\n            socialKey,\n            signUpDisabled\n          );'
const newArgument = '\n            socialKey,\n            false\n          );'
const position = source.indexOf(start)

if (position < 0 || source.indexOf(start, position + start.length) !== -1) {
  throw new Error('Expected one invited provider login in the pinned Huly account image')
}

const end = source.indexOf('\n          );', position)
if (end < 0) throw new Error('Invited provider login is incomplete')

const call = source.slice(position, end + '\n          );'.length)
if (!call.includes(oldArgument) || call.indexOf(oldArgument) !== call.lastIndexOf(oldArgument)) {
  throw new Error('Pinned Huly account image no longer matches the invite patch')
}

writeFileSync(
  path,
  source.slice(0, position) + call.replace(oldArgument, newArgument) + source.slice(position + call.length)
)
