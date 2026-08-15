#!/usr/bin/env node
/**
 * Fake `dsh web` for gateway tests: parses `web --host H --port N`, starts a
 * minimal HTTP server on 127.0.0.1:N, and answers `/` (200 HTML), `/api/me`
 * (JSON echoing DSH_HOME so tests can assert per-user isolation), and a
 * WebSocket echo at `/api/events.mux`.
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const args = process.argv.slice(2)
let host = '127.0.0.1'
let port = 0
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--host' && args[i + 1] !== undefined) host = args[i + 1]
  if (arg === '--port' && args[i + 1] !== undefined) port = Number(args[i + 1])
}

const dshHome = process.env.DSH_HOME ?? ''

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${String(port)}`)
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body>fake dsh web</body></html>')
    return
  }
  if (url.pathname === '/api/me') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ home: dshHome }))
    return
  }
  res.writeHead(404)
  res.end('not found')
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${host}:${String(port)}`)
  if (url.pathname === '/api/events.mux') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(`echo:${String(data)}`))
    })
    return
  }
  socket.destroy()
})

server.listen(port, host, () => {
  const address = server.address()
  const actual = typeof address === 'object' && address !== null ? address.port : port
  console.log(`fake dsh web: http://${host}:${String(actual)}`)
})
