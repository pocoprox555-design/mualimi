import { installAgentHttp } from './lib/agent-http.mjs'

export function chatPlugin(opts = {}) {
  return {
    name: 'mualimi-chat-proxy',
    configureServer(server) {
      installAgentHttp(server.middlewares, opts)
    },
    configurePreviewServer(server) {
      installAgentHttp(server.middlewares, opts)
    },
  }
}

export { installAgentHttp }
