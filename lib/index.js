/**
 * dsh-auto-continue — 非正常结束的轮次自动续行。
 *
 * 触发条件（默认）：某一 turn 的 `turn/end` 原因为
 *   - `max-tokens`：模型回复被输出 token 上限截断；
 *   - `error`：该轮因模型请求失败 / 步骤抛错而中止。
 * 可选：`aborted`（非用户主动停止的中断）。
 *
 * 机制：观察到目标 `turn/end` 后，等该 Agent 回到 `idle`，用
 * `agent.followup(...)` 排入一条带 `<auto_continue>` 标记的 user 消息，
 * 于是同一会话继续推进。
 *
 * 「连续异常有多长」**从会话历史推导**：从尾部数会被接手的 `turn/end`，
 * 遇到 `completed` / `blocked` 或人类消息即归零；插件内存里另有一份计数兜底
 * （历史读不到时仍然收手）。因为读的是持久会话日志，插件热重载、宿主重启、
 * 会话 resume 之后上限依然成立，不会因为状态丢失而无限续行。
 *
 * 失败类续行（error / aborted）先退避再重试，避免模型或网络故障时把 API 打爆。
 *
 * 与 `@deepseek-ai/dsh-goal-round-driver` 的关系：那个驱动负责 goal 轮次，
 * 且它明确在 `max-tokens` 时自行停用；本插件不读写 goal 状态，只补上
 * 「非正常结束 → 继续」这一环。goal 处于 armed 时，本插件的排队消息会被
 * 它的竞争检测看到，不会互相抢轮次。
 *
 * 零外部依赖：只用 node 内置模块与注入的 host 服务，便于 link 装配。
 *
 * @module dsh-auto-continue
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Cordis 插件名，用于 loader 诊断与日志前缀。 */
export const name = 'auto-continue'

/** 本插件消费的 host 服务：Agent 注册表（live agent 的唯一权威来源）。 */
export const inject = ['agents']

/** 续行消息的 source.kind：同时是会话日志里的持久标记。 */
const SOURCE_KIND = 'auto-continue'

/** Cordis fiber 处于 ACTIVE 时的状态值（与 goal-round-driver 保持一致）。 */
const FIBER_ACTIVE = 2

/** 续行消息文案里错误信息的最大字符数，避免把整段堆栈塞进上下文。 */
const FAILURE_TEXT_LIMIT = 300

/** 推导连续续行次数时最多回看的会话事件数（正常只需几条）。 */
const HISTORY_SCAN_LIMIT = 400

/** 默认配置；patch/loader 传入的 config 覆盖之。 */
const DEFAULT_SETTINGS = {
  /** 总开关。 */
  enabled: true,
  /** 输出 token 上限截断后自动续行。 */
  onMaxTokens: true,
  /** 本轮报错（error）后自动续行。 */
  onError: true,
  /** 非用户原因的中断（aborted）后自动续行。 */
  onAborted: false,
  /** 连续自动续行次数上限；到顶即停，等待人类。 */
  maxContinuations: 3,
  /** 是否也接管子代理（subagent）会话；默认只管顶层会话。 */
  includeSubagents: false,
  /** 到顶停止时，是否在会话里留一条可见通知（不唤醒新一轮）。 */
  notifyOnLimit: true,
  /** 失败类续行前的首次退避毫秒数（0 = 不退避）：每次翻倍，封顶 10 倍。 */
  retryBackoffMs: 500,
  /** 诊断用：非空时把每次决策追加写入该文件（默认关闭）。 */
  debugLog: null,
}

const BOOLEAN_KEYS = ['enabled', 'onMaxTokens', 'onError', 'onAborted', 'includeSubagents', 'notifyOnLimit']
const NUMBER_KEYS = ['maxContinuations', 'retryBackoffMs']

/** 人类指令的 source kind；这类消息出现即视为用户接管。 */
function isHumanMessageSource(source) {
  return typeof source === 'object' && source !== null && source.kind === 'user'
}

/** 渲染任意抛出值，用于日志。 */
function renderThrown(value) {
  if (value instanceof Error) return value.message
  return String(value)
}

/** 递归冻结一份消息，与 dsh-llm 的 createMessage 行为一致（不引入包依赖）。 */
function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/** 构造一条已冻结、带稳定 id 的 user 消息。 */
function createUserMessage(input) {
  return deepFreeze({
    ...structuredClone(input),
    id: randomUUID(),
    role: 'user',
  })
}

/**
 * 校验并归一化插件配置。
 * @param config - loader 传入的原始 config。
 * @returns 补齐默认值后的设置。
 * @throws 当出现未知键或类型/取值非法时（插件激活失败，而不是静默降级）。
 */
function resolveSettings(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError('auto-continue: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`auto-continue: unknown config key "${key}"`)
  }
  const settings = { ...DEFAULT_SETTINGS }
  for (const key of BOOLEAN_KEYS) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new TypeError(`auto-continue: config "${key}" must be a boolean`)
    settings[key] = value
  }
  for (const key of NUMBER_KEYS) {
    const value = config[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`auto-continue: config "${key}" must be a non-negative safe integer`)
    }
    settings[key] = value
  }
  if (config.debugLog !== undefined) {
    if (config.debugLog !== null && typeof config.debugLog !== 'string') {
      throw new TypeError('auto-continue: config "debugLog" must be a path string or null')
    }
    settings.debugLog = config.debugLog
  }
  return settings
}

/**
 * 数一数从最近一次正常收尾（或人类接管）以来，已经有多少个 turn 会被本插件接手。
 *
 * 为什么数 `turn/end` 而不是数自己排入的续行消息：**本轮以 `error` 收场时，
 * 步骤在领取消息之前就失败了，续行消息根本不会落进会话日志**。数消息会永远
 * 得到 0，于是无限续行；数「会被接手的 turn」在两种场景下都成立，而且它在
 * `completed` / `blocked` 或人类消息处终止，语义正好是「这一段连续异常有多长」。
 *
 * 因为读的是持久会话日志，插件重载、宿主重启、会话 resume 都不会让上限失效。
 *
 * @param session - 目标 agent 的会话。
 * @param isContinuable - 判断某个 `turn/end` reason 是否属于本插件接手的类型。
 * @returns 含当前这次在内的连续异常 turn 数（0 表示没有异常）。
 */
function countRecentFailures(session, isContinuable) {
  let count = 0
  const floor = Math.max(0, session.seq - HISTORY_SCAN_LIMIT)
  for (let seq = session.seq - 1; seq >= floor; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    if (event.type === 'user/message') {
      if (isHumanMessageSource(event.data?.source)) return count
      continue
    }
    if (event.type !== 'turn/end') continue
    const kind = event.data?.reason?.kind
    if (kind === 'completed' || kind === 'blocked') return count
    if (isContinuable(event.data.reason)) count += 1
  }
  return count
}

/**
 * 失败类的续行先退避再重试：模型/网络故障时立刻重打会把 API 打爆。
 * 输出被截断（max-tokens）说明模型工作正常，不需要等待。
 * @param reason - 续行原因。
 * @param attempt - 第几次续行（从 1 开始）。
 * @param base - 首次退避毫秒数（0 表示不退避）。
 * @returns 需要等待的毫秒数。
 */
function backoffMs(reason, attempt, base) {
  if (reason === 'max-tokens' || base <= 0) return 0
  return Math.min(base * 2 ** (Math.max(1, attempt) - 1), base * 10)
}

/** 可被生命周期信号打断的等待。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal.aborted) done()
    else signal.addEventListener('abort', done, { once: true })
  })
}

/** 一句话摘要，供 Chat 的 notice 折叠行展示。 */
const SUMMARY_BY_REASON = {
  'max-tokens': 'output token limit reached',
  error: 'previous turn failed',
  aborted: 'previous turn interrupted',
}

/** 把一次失败渲染成简短的括号说明，或空串。 */
function renderFailure(failure) {
  if (typeof failure !== 'object' || failure === null) return ''
  const code = typeof failure.code === 'string' && failure.code !== '' ? failure.code : undefined
  const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : undefined
  const detail = [code, message === undefined ? undefined : message.slice(0, FAILURE_TEXT_LIMIT)]
    .filter((part) => part !== undefined)
    .join(': ')
  return detail === '' ? '' : ` (${detail})`
}

/** 模型可见的续行指令；按原因区分措辞。 */
function continuationText(reason, attempt, maxAttempts, turn, failure) {
  const head = `<auto_continue reason="${reason}" attempt="${attempt}/${maxAttempts}" turn="${turn}">`
  const tail = '</auto_continue>'
  if (reason === 'max-tokens') {
    return `${head}
Your previous reply was cut off because it reached the output token limit. Continue the same task from exactly where it stopped; do not repeat work that is already finished.
Keep each step inside the output budget: write bulky content to files instead of printing it, split large edits, and let tools carry the heavy output. If the task is already complete, say so plainly and stop.
${tail}`
  }
  if (reason === 'error') {
    return `${head}
The previous turn failed before it finished${renderFailure(failure)}. Recover and continue the task: retry a transient failure, route around a persistent one, and keep the progress already made.
If the failure needs a decision only the user can make, stop and state exactly what you need instead of retrying blindly.
${tail}`
  }
  return `${head}
The previous turn was interrupted before it finished. Re-check the workspace and the durable session state, then continue the task from the true current state instead of assuming earlier narration still holds.
${tail}`
}

/** 构造续行消息（模型看到指令，Chat 折成一行 notice）。 */
function createContinuationMessage({ reason, attempt, maxAttempts, turn, failure }) {
  return createUserMessage({
    content: [{ type: 'text', text: continuationText(reason, attempt, maxAttempts, turn, failure) }],
    source: {
      kind: SOURCE_KIND,
      reason,
      attempt,
      maxAttempts,
      turn,
      form: 'notice',
      summary: `Auto-continue ${attempt}/${maxAttempts} — ${SUMMARY_BY_REASON[reason] ?? reason}`,
    },
  })
}

/** 构造「已到上限」通知；只入队、不唤醒，让会话与用户看得见。 */
function createLimitNotice({ reason, attempts, turn }) {
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: `<auto_continue_notice reason="${reason}" attempts="${attempts}" turn="${turn}">
Automatic continuation stopped: this session reached its configured limit of ${attempts} consecutive continuation(s) after "${reason}". No reply is required — the user can resume the task manually or change what the agent should do.
</auto_continue_notice>`,
      },
    ],
    source: {
      kind: SOURCE_KIND,
      reason: 'limit-reached',
      attempts,
      turn,
      form: 'notice',
      summary: `Auto-continue stopped after ${attempts} attempt(s)`,
    },
  })
}

/**
 * 安装自动续行：监听 turn 结束、驱动排队、到顶停止。
 * @param ctx - 插件上下文；所有监听器随它释放。
 * @param config - 见 {@link DEFAULT_SETTINGS}。
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const debugLog = settings.debugLog
  let debugReady = false
  /** 诊断轨迹：只在配置了 debugLog 时写文件（默认零开销）。 */
  function trace(line) {
    if (debugLog === null) return
    try {
      if (!debugReady) {
        mkdirSync(dirname(debugLog), { recursive: true })
        debugReady = true
      }
      appendFileSync(debugLog, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* 诊断写入失败不影响续行 */
    }
  }
  trace(`apply: maxContinuations=${settings.maxContinuations} enabled=${settings.enabled}`)
  /** 每个 live agent 一份驱动状态；agent 对象本身是键。 */
  const states = new Map()
  /** 插件生命周期信号：卸载后不再有新的排队。 */
  const lifetime = new AbortController()
  /** 进行中的驱动任务，卸载时排空。 */
  const active = new Set()

  /** 取得（或建立）某个 agent 的状态。 */
  function stateFor(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = { agent, pending: undefined, driven: 0, limitNotified: false, run: undefined, requested: false, stopping: false }
      states.set(agent, state)
    }
    return state
  }

  /** 该 agent 是否在本插件的管辖范围（顶层会话 / 可选子代理）。 */
  function isEligibleAgent(agent) {
    if (settings.includeSubagents) return true
    return ctx.agents.roots().includes(agent)
  }

  /** 把一次非正常结束映射为续行原因，未启用则返回 null。 */
  function continuationReason(reason) {
    switch (reason?.kind) {
      case 'max-tokens':
        return settings.onMaxTokens ? 'max-tokens' : null
      case 'error':
        return settings.onError ? 'error' : null
      case 'aborted':
        // 人类主动停止永远不自动续行，即便 onAborted 打开。
        if (reason.reason?.kind === 'user') return null
        return settings.onAborted ? 'aborted' : null
      default:
        return null
    }
  }

  /** 记录一次待排队动作；超过上限则改为排队一条到顶通知。 */
  function planContinuation(state, reason, turn, failure) {
    if (!settings.enabled || state.stopping || lifetime.signal.aborted) return
    if (!isEligibleAgent(state.agent)) return
    // 会话历史给出「这一段连续异常有多长」；内存计数兜住历史读不到的情形
    // （例如刚被重载、或会话日志被裁剪），两者取大值：只会更早收手，不会失控。
    const failures = countRecentFailures(state.agent.session, (candidate) => continuationReason(candidate) !== null)
    const attempt = Math.max(failures, state.driven + 1)
    if (attempt > settings.maxContinuations) {
      const driven = Math.max(state.driven, failures - 1, 0)
      ctx.logger.warn(
        `auto-continue: session "${state.agent.id}" stopped after ${driven} continuation(s) (last cause: ${reason}, turn ${turn}); waiting for the user`,
      )
      trace(`limit reached turn=${turn} failures=${failures} driven=${state.driven}`)
      if (!settings.notifyOnLimit || state.limitNotified) {
        state.pending = undefined
        return
      }
      state.limitNotified = true
      state.pending = {
        kind: 'notice',
        message: createLimitNotice({ reason, attempts: driven, turn }),
        reason,
        attempt: driven,
        turn,
      }
      requestDrive(state)
      return
    }
    state.pending = {
      kind: 'continue',
      message: createContinuationMessage({
        reason,
        attempt,
        maxAttempts: settings.maxContinuations,
        turn,
        failure,
      }),
      reason,
      attempt,
      turn,
    }
    requestDrive(state)
  }

  /** 唯一真正入队的地方：只在 agent 空闲、仍是同一个 live agent 时执行。 */
  async function drive(state) {
    // 让出当前同步分发栈：followup 会立刻唤醒 driver 并再次 emit agent/status。
    await Promise.resolve()
    const pending = state.pending
    if (pending === undefined) return
    if (state.stopping || lifetime.signal.aborted) return
    if (ctx.fiber.state !== FIBER_ACTIVE) return
    if (ctx.agents.get(state.agent.id) !== state.agent) {
      state.pending = undefined
      return
    }
    // 非空闲时不入队：turn 结束会 emit agent/status(idle)，那时再驱动。
    if (state.agent.status !== 'idle') {
      trace(`drive: not idle (${state.agent.status}) for ${pending.kind} attempt=${pending.attempt}`)
      return
    }
    state.pending = undefined
    try {
      if (pending.kind === 'continue') {
        const wait = backoffMs(pending.reason, pending.attempt, settings.retryBackoffMs)
        if (wait > 0) {
          trace(`backoff ${wait}ms before attempt ${pending.attempt}`)
          await sleep(wait, lifetime.signal)
          // 等待期间用户可能接管、agent 可能被回收、插件可能被卸载。
          if (state.stopping || lifetime.signal.aborted) return
          if (state.agent.status !== 'idle') return
          if (ctx.agents.get(state.agent.id) !== state.agent) return
        }
        state.agent.followup(pending.message)
        state.driven += 1
        trace(`followup attempt=${pending.attempt} reason=${pending.reason} turn=${pending.turn}`)
      } else {
        // 到顶通知：next-turn + 不唤醒，因此绝不自开新一轮。
        state.agent.send(pending.message, 'next-turn', false)
        trace(`limit notice queued (turn=${pending.turn})`)
      }
    } catch (error) {
      ctx.logger.warn(`auto-continue: could not queue a ${pending.kind} for session "${state.agent.id}": ${renderThrown(error)}`)
      trace(`drive: ${pending.kind} threw: ${renderThrown(error)}`)
      return
    }
    if (pending.kind === 'continue') {
      ctx.logger.info(
        `auto-continue: session "${state.agent.id}" continuing after ${pending.reason} (${pending.attempt}/${settings.maxContinuations}, turn ${pending.turn})`,
      )
    }
  }

  /** 合并同一 agent 上的驱动请求，串行执行。 */
  function requestDrive(state) {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error) {
            ctx.logger.warn(`auto-continue: driver failed for session "${state.agent.id}": ${renderThrown(error)}`)
          }
        }
      })
    } catch (error) {
      ctx.logger.warn(`auto-continue: could not start the driver for session "${state.agent.id}": ${renderThrown(error)}`)
      return
    }
    state.run = run
    active.add(run)
    const retire = () => {
      state.run = undefined
      active.delete(run)
      if (state.requested && !state.stopping) requestDrive(state)
    }
    run.then(retire, (error) => {
      ctx.logger.warn(`auto-continue: driver rejected for session "${state.agent.id}": ${renderThrown(error)}`)
      retire()
    })
  }

  ctx.effect(function* () {
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      if (event.type === 'turn/end') {
        const reason = event.data.reason
        const kind = continuationReason(reason)
        if (kind === null) {
          // 正常收尾（或本插件不接管的收尾）：这一段连续异常到此为止。
          const state = states.get(agent)
          if (state !== undefined) {
            state.driven = 0
            state.limitNotified = false
          }
          trace(`turn/end ${String(reason?.kind)} ignored (turn ${event.data.turn})`)
          return
        }
        planContinuation(stateFor(agent), kind, event.data.turn, kind === 'error' ? reason.error : undefined)
        return
      }
      if (event.type === 'user/message') {
        // 用户接管：放弃尚未入队的续行；连续计数由历史自然归零。
        if (!isHumanMessageSource(event.data.source)) return
        const state = states.get(agent)
        if (state === undefined) return
        state.driven = 0
        state.limitNotified = false
        if (state.pending !== undefined) {
          trace('pending dropped: human message')
          state.pending = undefined
        }
      }
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const state = states.get(agent)
      if (state === undefined || state.pending === undefined) return
      requestDrive(state)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      const state = states.get(agent)
      if (state !== undefined) state.stopping = true
      states.delete(agent)
    })

    yield async () => {
      for (const state of states.values()) {
        state.stopping = true
        state.pending = undefined
      }
      lifetime.abort(new Error('auto-continue plugin disposed'))
      await Promise.allSettled([...active])
      states.clear()
    }
  }, 'auto-continue lifecycle')
}
