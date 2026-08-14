import { validateLibrary } from '../lib/curriculum-library.mjs'

const report = await validateLibrary()
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exit(1)
