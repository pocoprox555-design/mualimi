import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import connect from 'connect'
import sirv from 'sirv'
import { installAgentHttp } from './lib/agent-http.mjs'

try { process.loadEnvFile(path.join(process.cwd(), '.env')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
}

// فك تشفير بسيط للمفتاح: يدعم base64 (بادئة b64:) أو نص عادي
if (process.env.AI_API_KEY && process.env.AI_API_KEY.startsWith('b64:')) {
  process.env.AI_API_KEY = Buffer.from(process.env.AI_API_KEY.slice(4), 'base64').toString('utf8')
}

const port = Number(process.env.PORT || 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port')

const app = connect()
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  next()
})

installAgentHttp(app, { env: process.env })
app.use(sirv(path.join(process.cwd(), 'dist'), {
  etag: true,
  gzip: true,
  brotli: true,
  single: true,
  maxAge: process.env.NODE_ENV === 'production' ? 3600 : 0,
}))
app.use((req, res) => {
  res.statusCode = 404
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: 'not_found' }))
})

const server = http.createServer(app)
// مهلة الطلب يجب أن تتجاوز AgentRunner.maxRuntimeMs (300 ثانية) + هامش
server.requestTimeout = 360_000
server.headersTimeout = 10_000
server.keepAliveTimeout = 620_000
server.listen(port, '0.0.0.0', () => {
  console.log(`Mualimi server listening on port ${port}`)
})

function shutdown(signal) {
  console.log(`${signal} received, closing server`)
  server.close((error) => {
    if (error) { console.error(error); process.exit(1) }
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
