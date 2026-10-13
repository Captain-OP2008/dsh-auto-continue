/**
 * dsh-auto-continue 离线状态机测试。
 *
 * 用假的 cordis ctx 与假 Agent 驱动插件：不启动真实会话，只验证
 * 「哪个 turn/end 会触发续行、什么时候排队、什么时候收手、计数从哪来」。
 *
 * 假会话维护真实的事件数组，因此「连续续行次数从会话历史推导」这条
 * 也能被真实验证（含插件重载后计数不失真的情形）。
 *
 * 运行：node tests/state-machine.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, name, inject } from '../lib/index.js'

/** 等待微任务与一次宏任务，让驱动的异步链跑完。 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 假 Agent：会话带事件日志，只实现本插件用到的面。 */
function createAgent(id) {
  const events = []
  const session = {
    id,
    get seq() {
      return events.length
    },
    eventAt: (seq) => events[seq],
    /** 测试直接写这个数组来模拟会话落盘。 */
    __events: events,
  }
  const agent = {
    id,
    session,
    status: 'idle',
    followups: [],
    claimed: 0,
    sends: [],
    followup(message) {
      agent.followups.push(message)
    },
    send(message, target, wakeup) {
      agent.sends.push({ message, target, wakeup })
    },
  }
  return agent
}

/** 假 cordis 上下文。 */
function createHarness(config) {
  const handlers = new Map()
  const logs = { info: [], warn: [] }
  const agents = new Map()
  let roots = []
  let teardown
  const ctx = {
    logger: {
      info: (line) => logs.info.push(String(line)),
      warn: (line) => logs.warn.push(String(line)),
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    agents: {
      get: (id) => agents.get(id),
      roots: () => [...roots],
      withoutInitiator: (operation) => operation(),
    },
    fiber: { state: 2 },
    effect(fn) {
      const generator = fn()
      const first = generator.next()
      teardown = async () => {
        // generator 第一次 next() 停在 `yield <teardown>`：first.value 就是卸载函数本身。
        await first.value()
        await generator.next()
      }
    },
  }
  apply(ctx, config)
  return {
    ctx,
    logs,
    agents,
    add(agent, { root = true } = {}) {
      agents.set(agent.id, agent)
      if (root) roots = [...roots, agent]
      return agent
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    async stop() {
      if (teardown !== undefined) await teardown()
    },
  }
}

/** 模拟 agent 把已排队的续行消息 claim 进新的 turn（真实系统如此落盘）。 */
function claimQueued(agent) {
  while (agent.claimed < agent.followups.length) {
    const message = agent.followups[agent.claimed]
    agent.claimed += 1
    agent.session.__events.push({
      type: 'user/message',
      seq: agent.session.__events.length,
      time: Date.now(),
      data: message,
    })
  }
}

/** 交一次 turn/end（默认先 claim 上一轮排队的续行消息，再结束本轮）。 */
function endTurn(harness, agent, reason, turn = 1, { claim = true } = {}) {
  if (claim) claimQueued(agent)
  const event = {
    type: 'turn/end',
    seq: agent.session.__events.length,
    time: Date.now(),
    data: { turn, reason },
  }
  agent.session.__events.push(event)
  harness.emit('session/event', agent.session, event)
}

/** 交一条人类消息。 */
function humanMessage(harness, agent, text = 'stop, do something else') {
  const event = {
    type: 'user/message',
    seq: agent.session.__events.length,
    time: Date.now(),
    data: {
      id: `human-${agent.session.__events.length}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
  agent.session.__events.push(event)
  harness.emit('session/event', agent.session, event)
}

/** 让 agent 走完 turn 后回到 idle，并等驱动跑完。 */
async function goIdle(harness, agent) {
  agent.status = 'idle'
  harness.emit('agent/status', { agent, status: 'idle' })
  await settle()
}

/** 组装「已跑完 n 轮 max-tokens 续行」的 agent。 */
async function runContinuations(harness, agent, times) {
  for (let turn = 1; turn <= times; turn += 1) {
    endTurn(harness, agent, { kind: 'max-tokens' }, turn)
    await goIdle(harness, agent)
  }
}

/** 注册假 agent（会话事件数组由 createAgent 建好，测试直接往里写）。 */
function install(harness, agent, options) {
  harness.add(agent, options)
  return agent
}

test('导出面符合 bundle 约定', () => {
  assert.equal(name, 'auto-continue')
  assert.deepEqual(inject, ['agents'])
  assert.equal(typeof apply, 'function')
})

test('max-tokens：等 agent 空闲后排入一条续行消息', async () => {
  const harness = createHarness()
  const agent = install(harness, createAgent('s1'))
  agent.status = 'running'

  endTurn(harness, agent, { kind: 'max-tokens' })
  await settle()
  assert.equal(agent.followups.length, 0, 'turn 仍在进行时不得排队')

  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 1)
  const [message] = agent.followups
  assert.match(message.content[0].text, /<auto_continue reason="max-tokens" attempt="1\/3" turn="1">/)
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'auto-continue')
  assert.equal(message.source.attempt, 1)
  assert.equal(harness.logs.info.length, 1)
  await harness.stop()
})

test('error：续行消息带上失败原因', async () => {
  const harness = createHarness({ retryBackoffMs: 0 })
  const agent = install(harness, createAgent('s2'))

  endTurn(harness, agent, { kind: 'error', error: { code: 'RATE_LIMIT', message: 'rate limited' } })
  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 1)
  assert.match(agent.followups[0].content[0].text, /RATE_LIMIT: rate limited/)
  assert.equal(agent.followups[0].source.reason, 'error')
  await harness.stop()
})

test('error 连打：消息根本没落盘也不会无限续行（回归）', async () => {
  // 真实形态：turn 在领取消息之前就失败了，会话里只有 turn/start + turn/end(error)，
  // 见不到任何 auto-continue 消息。按「数消息」推导会永远算作第 1 次，从而无限续行。
  const harness = createHarness({ maxContinuations: 3, retryBackoffMs: 0 })
  const agent = install(harness, createAgent('s18'))

  for (let turn = 1; turn <= 12; turn += 1) {
    endTurn(harness, agent, { kind: 'error', error: { code: 'NO_MODEL', message: 'no such model' } }, turn, { claim: false })
    await goIdle(harness, agent)
  }

  assert.equal(agent.followups.length, 3, '最多只续行到配置上限')
  assert.equal(agent.sends.length, 1, '到顶后只留一条通知')
  assert.ok(harness.logs.warn.some((line) => line.includes('waiting for the user')))
  await harness.stop()
})

test('失败类续行先退避再重试', async () => {
  const harness = createHarness({ retryBackoffMs: 25 })
  const agent = install(harness, createAgent('s19'))

  const started = Date.now()
  endTurn(harness, agent, { kind: 'error', error: { code: 'X', message: 'boom' } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const elapsed = Date.now() - started

  assert.equal(agent.followups.length, 1)
  assert.ok(elapsed >= 25, `应当等待退避时间，实际 ${elapsed}ms`)
  await harness.stop()
})

test('completed / blocked：不续行，并把连续计数清零', async () => {
  const harness = createHarness()
  const agent = install(harness, createAgent('s3'))

  await runContinuations(harness, agent, 1)
  assert.equal(agent.followups.length, 1)

  endTurn(harness, agent, { kind: 'completed' }, 2)
  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 1, 'completed 不该续行')

  endTurn(harness, agent, { kind: 'max-tokens' }, 3)
  await goIdle(harness, agent)
  assert.equal(agent.followups[1].source.attempt, 1, '正常收尾后计数应从 1 重新开始')
  await harness.stop()
})

test('人类消息：放弃排队中的续行并让计数归零', async () => {
  const harness = createHarness()
  const agent = install(harness, createAgent('s4'))

  await runContinuations(harness, agent, 2)
  assert.equal(agent.followups[1].source.attempt, 2)

  // 第三次 max-tokens 后、agent 还没空闲时，用户插话。
  endTurn(harness, agent, { kind: 'max-tokens' }, 3)
  humanMessage(harness, agent, '换个思路')
  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 2, '用户接管后不得再自动续行')

  endTurn(harness, agent, { kind: 'max-tokens' }, 4)
  await goIdle(harness, agent)
  assert.equal(agent.followups[2].source.attempt, 1, '人类消息之后计数从头开始')
  await harness.stop()
})

test('自动续行的消息本身不被当成用户接管', async () => {
  const harness = createHarness()
  const agent = install(harness, createAgent('s5'))

  await runContinuations(harness, agent, 2)
  endTurn(harness, agent, { kind: 'max-tokens' }, 3)
  await goIdle(harness, agent)
  assert.equal(agent.followups[2].source.attempt, 3, '自己排的消息不该清零计数')
  await harness.stop()
})

test('到顶即停：留一条不唤醒的通知，且此后不再续行', async () => {
  const harness = createHarness({ maxContinuations: 2 })
  const agent = install(harness, createAgent('s6'))

  await runContinuations(harness, agent, 3)
  assert.equal(agent.followups.length, 2, '只能续行到配置的上限')
  assert.equal(agent.sends.length, 1)
  assert.equal(agent.sends[0].target, 'next-turn')
  assert.equal(agent.sends[0].wakeup, false, '通知不得自己唤醒新一轮')
  assert.match(agent.sends[0].message.content[0].text, /<auto_continue_notice/)
  assert.ok(harness.logs.warn.some((line) => line.includes('waiting for the user')))

  // 通知躺在队列里（未被 claim），再来一次 max-tokens 仍不续行、也不重复通知。
  endTurn(harness, agent, { kind: 'max-tokens' }, 4)
  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 2)
  assert.equal(agent.sends.length, 1, '同一段连续异常只通知一次')
  await harness.stop()
})

test('到顶通知同样只在 agent 空闲后入队', async () => {
  const harness = createHarness({ maxContinuations: 1 })
  const agent = install(harness, createAgent('s6b'))

  await runContinuations(harness, agent, 1)
  agent.status = 'running'
  endTurn(harness, agent, { kind: 'max-tokens' }, 2)
  await settle()
  assert.equal(agent.sends.length, 0, '运行中的 turn 不得看见通知入队')
  await goIdle(harness, agent)
  assert.equal(agent.sends.length, 1)
  await harness.stop()
})

test('maxContinuations = 0 时一次都不续行', async () => {
  const harness = createHarness({ maxContinuations: 0 })
  const agent = install(harness, createAgent('s7'))

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 0)
  assert.equal(agent.sends.length, 1)
  await harness.stop()
})

test('aborted：默认不续行，onAborted 打开后只接管非用户中断', async () => {
  const off = createHarness()
  const a1 = install(off, createAgent('s8'))
  endTurn(off, a1, { kind: 'aborted', reason: { kind: 'legacy' } })
  await goIdle(off, a1)
  assert.equal(a1.followups.length, 0)
  await off.stop()

  const on = createHarness({ onAborted: true, retryBackoffMs: 0 })
  const a2 = install(on, createAgent('s9'))
  endTurn(on, a2, { kind: 'aborted', reason: { kind: 'parent' } })
  await goIdle(on, a2)
  assert.equal(a2.followups.length, 1, '父级中断可以续行')

  const human = install(on, createAgent('s10'))
  endTurn(on, human, { kind: 'aborted', reason: { kind: 'user' } })
  await goIdle(on, human)
  assert.equal(human.followups.length, 0, '人类按停止永远不自动续行')
  await on.stop()
})

test('开关：enabled / onMaxTokens / onError 关闭后不动作', async () => {
  const disabled = createHarness({ enabled: false })
  const a1 = install(disabled, createAgent('s11'))
  endTurn(disabled, a1, { kind: 'max-tokens' })
  await goIdle(disabled, a1)
  assert.equal(a1.followups.length, 0)
  await disabled.stop()

  const noError = createHarness({ onError: false })
  const a2 = install(noError, createAgent('s12'))
  endTurn(noError, a2, { kind: 'error', error: { code: 'X', message: 'boom' } })
  await goIdle(noError, a2)
  assert.equal(a2.followups.length, 0)
  await noError.stop()
})

test('子代理：默认不接管，includeSubagents 打开后接管', async () => {
  const harness = createHarness()
  const child = install(harness, createAgent('s13'), { root: false })
  endTurn(harness, child, { kind: 'max-tokens' })
  await goIdle(harness, child)
  assert.equal(child.followups.length, 0)
  await harness.stop()

  const withChildren = createHarness({ includeSubagents: true })
  const child2 = install(withChildren, createAgent('s14'), { root: false })
  endTurn(withChildren, child2, { kind: 'max-tokens' })
  await goIdle(withChildren, child2)
  assert.equal(child2.followups.length, 1)
  await withChildren.stop()
})

test('agent 被回收：不再续行，也不会写坏状态', async () => {
  const harness = createHarness()
  const agent = install(harness, createAgent('s15'))
  agent.status = 'running'
  endTurn(harness, agent, { kind: 'max-tokens' })
  harness.emit('agent/disposed', { agent })
  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 0)
  await harness.stop()
})

test('插件重载：计数从会话历史恢复，不会多续一轮', async () => {
  const first = createHarness({ maxContinuations: 2 })
  const agent = install(first, createAgent('s16'))
  await runContinuations(first, agent, 2)
  assert.equal(agent.followups.length, 2)
  await first.stop()

  // 新实例（等价于热重载 / 宿主重启后 resume）：内存状态为空，但会话历史还在。
  const second = createHarness({ maxContinuations: 2 })
  install(second, agent)
  endTurn(second, agent, { kind: 'max-tokens' }, 3)
  await goIdle(second, agent)
  assert.equal(agent.followups.length, 2, '重载后仍应认得已经到顶')
  assert.equal(agent.sends.length, 1, '重载后应补上到顶通知')
  await second.stop()
})

test('插件卸载：排空驱动且不再排队', async () => {
  const harness = createHarness()
  const agent = install(harness, createAgent('s17'))
  await harness.stop()

  endTurn(harness, agent, { kind: 'max-tokens' })
  await goIdle(harness, agent)
  assert.equal(agent.followups.length, 0)
})

test('配置校验：未知键与非法值让插件激活失败', () => {
  assert.throws(() => createHarness({ nope: 1 }), /unknown config key/)
  assert.throws(() => createHarness({ maxContinuations: -1 }), /non-negative safe integer/)
  assert.throws(() => createHarness({ onError: 'yes' }), /must be a boolean/)
  assert.throws(() => createHarness({ debugLog: 7 }), /path string or null/)
})
