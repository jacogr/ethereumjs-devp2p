const { EventEmitter } = require('events')
const dgram = require('dgram')
const ms = require('ms')
const createDebugLogger = require('debug')
const LRUCache = require('lru-cache')
const message = require('./message')
const { pk2id, createDeferred } = require('../util')

const debug = createDebugLogger('devp2p:dpt:server')

const VERSION = 0x04
const DEFAULT_CACHE_OPTS = {
  max: 1000,
  maxAge: ms('1s'),
  stale: false
}
const DEFAULT_CREATE_SOCKET = () => dgram.createSocket('udp4')
const DEFAULT_ENDPOINT = {
  address: '0.0.0.0',
  udpPort: null,
  tcpPort: null
}
const DEFAULT_TIMEOUT = ms('10s')

class Server extends EventEmitter {
  constructor (dpt, privateKey, options) {
    super()

    this._dpt = dpt
    this._privateKey = privateKey

    this._createSocket = options.createSocket || DEFAULT_CREATE_SOCKET
    this._timeout = options.timeout || DEFAULT_TIMEOUT
    this._endpoint = options.endpoint || DEFAULT_ENDPOINT
    this._requests = new Map()
    this._requestsCache = new LRUCache(DEFAULT_CACHE_OPTS)

    this._socket = this._createSocket()
    this._socket.once('listening', () => this.emit('listening'))
    this._socket.once('close', () => this.emit('close'))
    this._socket.on('error', (err) => this.emit('error', err))
    this._socket.on('message', (msg, rinfo) => {
      try {
        this._handler(msg, rinfo)
      } catch (err) {
        this.emit('error', err)
      }
    })
  }

  bind (...args) {
    this._isAliveCheck()
    debug('call .bind')

    this._socket.bind(...args)
  }

  destroy (...args) {
    this._isAliveCheck()
    debug('call .destroy')

    this._socket.close(...args)
    this._socket = null
  }

  async ping (peer) {
    this._isAliveCheck()

    const rckey = `${peer.address}:${peer.udpPort}`
    const promise = this._requestsCache.get(rckey)
    if (promise !== undefined) return await promise

    const hash = this._send(peer, 'ping', {
      version: VERSION,
      from: this._endpoint,
      to: peer
    })

    const deferred = createDeferred()
    const rkey = hash.toString('hex')
    this._requests.set(rkey, {
      peer,
      deferred,
      timeoutId: setTimeout(() => {
        debug(`ping timeout: ${peer.address}:${peer.udpPort} ${peer.id && peer.id.toString('hex')}`)
        this._requests.delete(rkey)
        deferred.reject(new Error(`Timeout error: ping ${peer.address}:${peer.udpPort}`))
      }, this._timeout)
    })
    this._requestsCache.set(rckey, deferred.promise)
    return await deferred.promise
  }

  findneighbours (peer, id) {
    this._isAliveCheck()
    this._send(peer, 'findneighbours', { id })
  }

  _isAliveCheck () {
    if (this._socket === null) throw new Error('Server already destroyed')
  }

  _send (peer, typename, data) {
    debug(`send ${typename} to ${peer.address}:${peer.udpPort} (peerId: ${peer.id && peer.id.toString('hex')})`)

    const msg = message.encode(typename, data, this._privateKey)
    this._socket.send(msg, 0, msg.length, peer.udpPort, peer.address)
    return msg.slice(0, 32) // message id
  }

  _handler (msg, rinfo) {
    const info = message.decode(msg)
    const peerId = pk2id(info.publicKey)
    debug(`received ${info.typename} from ${rinfo.address}:${rinfo.port} (peerId: ${peerId.toString('hex')})`)

    // add peer if not in our table
    const peer = this._dpt.getPeer(peerId)
    if (peer === null && info.typename === 'ping' && info.data.from.udpPort !== null) {
      setTimeout(() => this.emit('peers', [ info.data.from ]), ms('100ms'))
    }

    switch (info.typename) {
      case 'ping':
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port })
        this._send(rinfo, 'pong', {
          to: {
            address: rinfo.address,
            udpPort: rinfo.port,
            tcpPort: info.data.from.tcpPort
          },
          hash: msg.slice(0, 32)
        })
        break

      case 'pong':
        const rkey = info.data.hash.toString('hex')
        const request = this._requests.get(rkey)
        if (request) {
          this._requests.delete(rkey)
          request.deferred.resolve({
            id: peerId,
            address: request.peer.address,
            udpPort: request.peer.udpPort,
            tcpPort: request.peer.tcpPort
          })
        }
        break

      case 'findneighbours':
        Object.assign(rinfo, { id: peerId, udpPort: rinfo.port })
        this._send(rinfo, 'neighbours', {
          peers: this._dpt.getClosestPeers(info.data.id)
        })
        break

      case 'neighbours':
        this.emit('peers', info.data.peers.map((peer) => peer.endpoint))
        break
    }
  }
}

module.exports = Server
