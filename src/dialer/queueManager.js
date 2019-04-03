'use strict'

const once = require('once')
const Queue = require('./queue')
const { DIAL_ABORTED, DIAL_QUEUE_MANAGER_STOPPED } = require('../errors')
const nextTick = require('async/nextTick')
const retimer = require('retimer')
const { QUARTER_HOUR } = require('../constants')
const noop = () => {}

class DialQueueManager {
  /**
   * @constructor
   * @param {Switch} _switch
   */
  constructor (_switch) {
    this._queue = new Set()
    this._coldCallQueue = new Set()
    this._dialingQueues = new Set()
    this._queues = {}
    this.switch = _switch
    this._cleanInterval = retimer(this._clean.bind(this), QUARTER_HOUR)
    this._isRunning = false
  }

  start () {
    this._isRunning = true
  }

  /**
   * Runs through all queues, aborts and removes them if they
   * are no longer valid. A queue that is blacklisted indefinitely,
   * is considered no longer valid.
   * @private
   */
  _clean () {
    const queues = Object.values(this._queues)
    queues.forEach(dialQueue => {
      // Clear if the queue has reached max blacklist
      if (dialQueue.blackListed === Infinity) {
        dialQueue.abort()
        delete this._queues[dialQueue.id]
        return
      }

      // Keep track of blacklisted queues
      if (dialQueue.blackListed) return

      // Clear if peer is no longer active
      // To avoid reallocating memory, dont delete queues of
      // connected peers, as these are highly likely to leverage the
      // queues in the immediate term
      if (!dialQueue.isRunning && dialQueue.length < 1) {
        let isConnected = false
        try {
          const peerInfo = this.switch._peerBook.get(dialQueue.id)
          isConnected = Boolean(peerInfo.isConnected())
        } catch (_) {
          // If we get an error, that means the peerbook doesnt have the peer
        }

        if (!isConnected) {
          dialQueue.abort()
          delete this._queues[dialQueue.id]
        }
      }
    })

    this._cleanInterval.reschedule(QUARTER_HOUR)
  }

  /**
   * Iterates over all items in the DialerQueue
   * and executes there callback with an error.
   *
   * This causes the entire DialerQueue to be drained
   */
  stop () {
    this._isRunning = false

    // Clear the general queue
    this._queue.clear()
    // Clear the cold call queue
    this._coldCallQueue.clear()

    this._cleanInterval.clear()

    // Abort the individual peer queues
    const queues = Object.values(this._queues)
    queues.forEach(dialQueue => {
      dialQueue.abort()
      delete this._queues[dialQueue.id]
    })
  }

  /**
   * Adds the `dialRequest` to the queue and ensures queue is running
   *
   * @param {DialRequest} dialRequest
   * @returns {void}
   */
  add ({ peerInfo, protocol, useFSM, callback }) {
    callback = callback ? once(callback) : noop

    if (!this._isRunning) {
      return callback(DIAL_QUEUE_MANAGER_STOPPED())
    }

    // Add the dial to its respective queue
    const targetQueue = this.getQueue(peerInfo)
    // If we have too many cold calls, abort the dial immediately
    if (this._coldCallQueue.size >= this.switch.dialer.MAX_COLD_CALLS && !protocol) {
      return nextTick(callback, DIAL_ABORTED())
    }

    targetQueue.add(protocol, useFSM, callback)

    // If we're already connected to the peer, start the queue now
    // While it might cause queues to go over the max parallel amount,
    // it avoids blocking peers we're already connected to
    if (peerInfo.isConnected()) {
      targetQueue.start()
      return
    }

    // If dialing is not allowed, abort
    if (!targetQueue.isDialAllowed()) {
      return
    }

    // Add the id to its respective queue set if the queue isn't running
    if (!targetQueue.isRunning) {
      if (protocol) {
        this._queue.add(targetQueue.id)
        this._coldCallQueue.delete(targetQueue.id)
      // Only add it to the cold queue if it's not in the normal queue
      } else if (!this._queue.has(targetQueue.id)) {
        this._coldCallQueue.add(targetQueue.id)
      // The peer is already in the normal queue, abort the cold call
      } else {
        return nextTick(callback, DIAL_ABORTED())
      }
    }

    this.run()
  }

  /**
   * Will execute up to `MAX_PARALLEL_DIALS` dials
   */
  run () {
    if (!this._isRunning) {
      return
    }

    if (this._dialingQueues.size < this.switch.dialer.MAX_PARALLEL_DIALS) {
      let nextQueue = { done: true }
      // Check the queue first and fall back to the cold call queue
      if (this._queue.size > 0) {
        nextQueue = this._queue.values().next()
        this._queue.delete(nextQueue.value)
      } else if (this._coldCallQueue.size > 0) {
        nextQueue = this._coldCallQueue.values().next()
        this._coldCallQueue.delete(nextQueue.value)
      }

      if (nextQueue.done) {
        return
      }

      let targetQueue = this._queues[nextQueue.value]
      this._dialingQueues.add(targetQueue.id)
      targetQueue.start()
    }
  }

  /**
   * Will remove the `peerInfo` from the dial blacklist
   * @param {PeerInfo} peerInfo
   */
  clearBlacklist (peerInfo) {
    const queue = this.getQueue(peerInfo)
    queue.blackListed = null
    queue.blackListCount = 0
  }

  /**
   * A handler for when dialing queues stop. This will trigger
   * `run()` in order to keep the queue processing.
   * @private
   * @param {string} id peer id of the queue that stopped
   */
  _onQueueStopped (id) {
    this._dialingQueues.delete(id)
    this.run()
  }

  /**
   * Returns the `Queue` for the given `peerInfo`
   * @param {PeerInfo} peerInfo
   * @returns {Queue}
   */
  getQueue (peerInfo) {
    const id = peerInfo.id.toB58String()

    this._queues[id] = this._queues[id] || new Queue(id, this.switch, this._onQueueStopped.bind(this))
    return this._queues[id]
  }
}

module.exports = DialQueueManager
