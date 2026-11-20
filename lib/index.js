/**
 * dsh-team-member-model 0.3.0 —— 子 agent 模型路由（创建期决策 + 运行期回退）。
 *
 * 0.2.1 只解决了「团队成员能不能指定模型」。0.3.0 按 magpie 的思路把它做成**路由**：
 * 一处配置「谁跑哪个模型」，在子 agent 创建时刻按规则命中决定，运行期失败按候选顺序回退。
 * Lead 自己的模型永不参与路由（用户明确要求，且由 `session.header.origin` 硬隔离）。
 *
 * 设计依据与不搬清单见 `docs/spec.md`；引擎（纯函数）在 `lib/rules.js`。
 *
 * 契约依据（2026-10-16 从安装包实体核实，非类型猜测）：
 * - `subagents.startContinuable(spec)` 读 `spec.request.agentOptions`（dsh-subagent:1671-1683）；
 *   `subagents.start(name, request)` 读 `request.agentOptions`（dsh-tool-subagent:495-520）。
 * - `fork` 与 `spawn` 两个 provider 都声明 `capabilities.agentOptions: true`
 *   （dsh-subagent-fork-in-process:37、dsh-subagent-spawn-in-process:23）——
 *   官方只是在**工具 schema 层**没给 fork 暴露模型选择，服务层是支持的。
 * - 新版 DSH 在 preStep 固定模型：选模仅在 agent/created 与同步 inbox/claimed 中完成。
 *   agent/request 只记录实际配置；跨模型回退延期至下一轮，不接管同一步骤重试。
 * - 子 agent 可结构化识别：`session.header.origin === 'subagent'` / `delegationDepth`。
 *
 * 作者：hwj
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { TeamStateStore } from './team-state.js'
import { resolveTeamRoute, isManualFixedRoute, extractExplicitRoute } from './team-routing.js'
import { loadSkillFile } from './skill.js'
import {
	attributeChild,
	countersFromUsage,
	emptyUsage,
	foldTokenUsage,
	loadUsage,
	serializeUsage,
	shouldCountCall,
	usageReport,
} from './usage.js'
import {
	collectIntents,
	describeRule,
	emptyPolicy,
	isRetryableFailure,
	memberKey,
	normalizeMembers,
	normalizePolicy,
	parseMemberRef,
	normalizeRoute,
	normalizeRoutes,
	normalizeRule,
	parseIntent,
	planRoute,
	restDelayMs,
	shouldSink,
	shortText,
	teammateNameFromPrompt,
} from './rules.js'

/** Cordis 插件名：仅供日志与诊断辨认，与 profile 组合行 id 无关。 */
export const name = 'team-member-model'

/** 强依赖注册表：三个服务任一缺失即保持等待，而不是带着残缺能力启动。 */
export const inject = ['tools', 'subagents', 'webServer', 'sessionController', 'agentTeams', 'llm']

/** 本插件注册的工具名。刻意与官方 `spawn_teammate` 并存而不是覆盖，避免注册冲突。 */
const TOOL_NAME = 'spawn_modeled_teammate'

/** 设置页读写接口前缀；客户端半侧（lib/client.js）按同一常量拼接。 */
const API_BASE = '/api/dsh-team-member-model'

/** 写接口自定义标记头：挡住浏览器里被第三方页面顺手 POST 的路径（与官方 skills-hub 同思路）。 */
const MUTATION_HEADER = 'x-dsh-team-member-model'

/** 成员名规则：与官方 `memberName()` 一致（lower-kebab-case、≤64、不得为 lead）。 */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MEMBER_NAME_LIMIT = 64

/** 单条路由的字段上限：与官方 `requiredText(request.provider, "provider", 200)` 对齐。 */
const FIELD_LIMIT = 200

/** HTTP 请求体上限：策略是几十条短字符串，1 MiB 足够且能挡住误发的巨体。 */
const BODY_LIMIT = 1024 * 1024

/** trace 环形缓冲长度：够看清「刚才为什么这么路由」，又不至于把设置页撑爆。 */
const TRACE_LIMIT = 60

/** 目录缓存时长：`policy.match` 扩充候选要用目录，但不必每次创建都去问一遍。 */
const CATALOG_TTL_MS = 60_000

/** 推理档解析缓存时长：档位是适配器的静态声明，5 分钟内不必重复问。 */
const EFFORT_TTL_MS = 5 * 60_000

/** 分类器回答缓存上限：同一条任务文本重复创建时不再多打一次模型调用。 */
const INTENT_CACHE_LIMIT = 200

/**
 * 成员身份提示：使用当前 subagent 名称寻址契约，不依赖旧 Team 工具参数。
 *
 * @param {string} memberName - 成员名（已由官方与本地双重校验）。
 * @returns {string} 置于初始任务之前的身份文本块。
 */
export function identityPrefix(memberName) {
	return `<system-reminder>
You are teammate "${memberName}".
Your Team Lead is named "lead".
Use list_agents({}) or the start receipt to find the exact agent name or path.
To message another agent, pass its listed name, path, or known historical Session id: send_message({ agent: "<name-path-or-session-id>", message: "..." }).
</system-reminder>

`
}

/** 策略文件路径：跟随 DSH_HOME，避免写进可能被包管理器清理的 node_modules。 */

function teamsPath() {
	return join(dshHome(), 'team-member-model', 'teams.json')
}
function policyPath() {
	return join(dshHome(), 'team-member-model', 'policy.json')
}

/** 随包分发的技能文件：唯一事实源，Host 启动时读它并注册进 ctx.skills。 */
const SKILL_URL = new URL('../skills/model-routing/SKILL.md', import.meta.url)

/** 用量统计的落盘路径：与策略、状态同目录，重启不清零。 */
function usagePath() {
	return join(dshHome(), 'team-member-model', 'usage.json')
}

/** 用量落盘节流：会话事件很密集，攒一会儿再写，避免把磁盘打满。 */
const USAGE_PERSIST_MS = 15_000

/** 启动失败现场：诊断辅助，写不进去也不影响宿主。 */
function statusPath() {
	return join(dshHome(), 'team-member-model', 'status.json')
}

/** DSH_HOME 解析：取不到就退回 ~/.dsh。 */
function dshHome() {
	const fromEnv = process.env.DSH_HOME === undefined ? '' : process.env.DSH_HOME.trim()
	return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}

/**
 * 解析组合行 config 里的策略种子。
 *
 * 与 HTTP 入参刻意不同：组合行不写 `config` 是**正常**情况（宿主传 `{}` 或 undefined），
 * 此时应当「没有种子」而不是报错——2026-10-09 首版正是在这里把 undefined 当非法输入，
 * 导致 Host 半侧启动失败、设置页 404（status.json 记下现场）。
 *
 * @param {unknown} value - `config.allowedModels` 或整套策略。
 * @returns {{ routes: Array<object>, errors: string[] }} 兼容 0.2.1 的返回形状。
 */
export function resolveSeed(value) {
	if (value === undefined || value === null) return { routes: [], errors: [] }
	return normalizeRoutes(value)
}

/**
 * 判断一次 `startContinuable` 调用是否命中暂存路由（0.2.1 的显式指定路径）。
 *
 * 双条件（名字 + description）是刻意的：只靠名字的话，官方 `spawn_teammate` 若恰好与
 * 本插件正在创建的成员同名，会误领路由；只靠 description 又不唯一。
 *
 * @param {unknown} spec - `startContinuable` 的入参。
 * @param {Map<string, object>} staging - 成员名 → 待注入路由。
 * @returns {object | null} 命中的暂存项，或 null。
 */
export function pickStagedRoute(spec, staging) {
	if (spec === null || typeof spec !== 'object') return null
	const request = spec.request
	if (request === null || typeof request !== 'object') return null
	if (request.parent === undefined || request.parent === null) return null
	const memberName = teammateNameFromPrompt(request.prompt)
	if (memberName === null) return null
	const entry = staging.get(memberName)
	if (entry === undefined) return null
	if (typeof entry.description === 'string' && entry.description !== '' && spec.label !== entry.description) return null
	return entry
}

/**
 * 生成注入了 agentOptions 的 `startContinuable` 入参副本。
 *
 * 不原地改入参：调用方（官方运行时）可能持有同一个对象，改写会让它在失败排查时看到
 * 从未请求过的路由。浅拷贝 spec 与 request 两层即可，agentOptions 由本插件新建。
 *
 * @param {object} spec - 原始入参。
 * @param {{ provider: string, model: string, reasoningEffort?: string }} route - 命中的路由。
 * @returns {object} 新的入参对象。
 */
export function withAgentOptions(spec, route) {
	return { ...spec, request: { ...spec.request, agentOptions: routeToAgentOptions(route) } }
}

/** 生成注入了 agentOptions 的 `start` 请求副本（一次性 / fork / workflow 走这条）。 */
export function withRequestAgentOptions(request, route) {
	return { ...request, agentOptions: routeToAgentOptions(route) }
}

/** 路由 → 官方 `AgentOptions`（effort 省略时交给所选模型的默认值）。 */
function routeToAgentOptions(route) {
	return {
		provider: route.provider,
		model: route.model,
		...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
	}
}

/**
 * 取服务的**本体**（未经 cordis traceable 包装的那个对象）。
 *
 * 为什么必须绕开 `ctx.subagents`：cordis 的 Context 代理会把每个服务值再套一层
 * `createTraceable`（cordis `src/utils.ts:165-218`），而这一层的两个陷阱恰好让「就地改方法」失效：
 *   - `set`：`Reflect.set(target, prop, value, shadow)` —— 写入落到派生的 shadow 上，target 不变（:201-212）；
 *   - `get`：函数属性每次读取都被重新包一层 shadow-method 代理（:194-196），
 *     所以连「读回比对」都不相等——2026-10-09 首版正是栽在这里，报「服务对象不可写」。
 * 服务本体存在反射服务的实现表里（cordis `src/reflect.ts:116-125` 的 `Impl.value`，表在 :208-211）。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {string} serviceName - 服务名，例如 `subagents`。
 * @param {string | string[]} method - 用于兜底识别的方法名（0.2.1 起要能识别 startLocal / startExternal）。
 * @returns {object | undefined} 服务本体；取不到返回 undefined。
 */
function rawService(ctx, serviceName, method) {
	const reflect = ctx.reflect ?? (typeof ctx.get === 'function' ? ctx.get('reflect') : undefined)
	if (reflect === undefined || reflect === null) return undefined
	if (typeof reflect._getImpl === 'function') {
		const impl = reflect._getImpl(serviceName)
		if (impl !== undefined && impl !== null && impl.value !== undefined && impl.value !== null) return impl.value
	}
	const store = reflect.store
	if (store !== null && typeof store === 'object') {
		for (const key of Object.getOwnPropertySymbols(store)) {
			const value = store[key] === undefined || store[key] === null ? undefined : store[key].value
			if (value === null || typeof value !== 'object') continue
			const methods = Array.isArray(method) ? method : [method]
			if (methods.some((name) => typeof value[name] === 'function')) return value
		}
	}
	// 如果 reflect 存在但未注册进 store（测试桩未走 proxy 直接挂载）
	const direct = ctx[serviceName] ?? (typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined)
	if (direct !== undefined && direct !== null) {
		const probeKey = '__tmm_writable_probe__'
		try {
			direct[probeKey] = 1
			if (direct[probeKey] === 1) {
				delete direct[probeKey]
				const methods = Array.isArray(method) ? method : [method]
				if (methods.some((name) => typeof direct[name] === 'function')) return direct
			}
		} catch {}
	}
	return undefined
}

/** 读策略文件；不存在或损坏时返回「没有策略」而不是抛（首次启动是正常路径）。 */
async function readPolicyFile() {
	try {
		const raw = await readFile(policyPath(), 'utf8')
		const parsed = JSON.parse(raw)
		const normalized = normalizePolicy(parsed)
		return normalized.errors.length > 0 ? undefined : normalized.policy
	} catch {
		return undefined
	}
}

/** 写入策略文件：先建目录再整体覆盖，避免半份 JSON 被下次启动读到。 */
async function writePolicyFile(policy) {
	const path = policyPath()
	await mkdir(dirname(path), { recursive: true })
	// v4（0.6.0）：成员 = 名字 + 渠道绑定。落盘带上 version，读侧按形状兼容 v3。
	await writeFile(path, `${JSON.stringify({ version: 4, ...policy }, null, 2)}\n`, 'utf8')
}

/**
 * 写一份状态快照：诊断辅助，写不进去也不影响宿主。
 *
 * 成功与失败都写同一个文件，是为了回答一个只能靠它回答的问题：「Host 半侧到底加载了没有」。
 * 客户端半侧与 Host 半侧的加载是**相互独立**的——页面能打开不代表工具、路由、监听器已注册。
 *
 * @param {object} record - 至少含 mode；其余字段原样落盘。
 */
async function writeStatus(record) {
	try {
		const path = statusPath()
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...record }, null, 2)}\n`, 'utf8')
	} catch {
		/* 忽略：状态文件是诊断辅助，不是功能依赖 */
	}
}

/** 失败现场：保留 failed 状态所需的最小信息。 */
async function writeFailure(error) {
	await writeStatus({
		mode: 'error',
		error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
	})
}

/** 轻量 JSON 响应：设置页只认 `{ ok, ... }` 形状。 */
function sendJson(res, statusCode, payload) {
	const body = JSON.stringify(payload)
	res.statusCode = statusCode
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(body)
}

/** 读请求体并解析 JSON；超限或非法 JSON 直接抛，由调用方转成 4xx。 */
async function readJsonBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > BODY_LIMIT) throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
		chunks.push(chunk)
	}
	const text = Buffer.concat(chunks).toString('utf8').trim()
	if (text === '') return {}
	try {
		return JSON.parse(text)
	} catch {
		throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 })
	}
}

/**
 * 收集可选模型目录：provider 列表 + 各自公布的模型。
 * `ctx.get('llm')` 而不是 inject，是为了在 LLM 服务缺席时插件仍能加载。
 *
 * @param {object} ctx - 宿主上下文。
 * @returns {Promise<Array<{id: string, name: string, models: Array<{id: string, name: string}>}>>}
 */
async function collectCatalog(ctx) {
	const llm = ctx.get('llm')
	if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return []
	const providers = []
	for (const provider of llm.listProviders()) {
		const id = shortText(provider === null || provider === undefined ? undefined : provider.id)
		if (id === undefined) continue
		const models = []
		try {
			const advertised = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
			for (const model of Array.isArray(advertised) ? advertised : []) {
				const modelId = shortText(model === null || model === undefined ? undefined : model.id)
				if (modelId === undefined) continue
				models.push({ id: modelId, name: shortText(model.name) ?? modelId })
			}
		} catch {
			/* 单个 provider 的目录拉取失败不拖垮整页：留空让用户手工填 model */
		}
		providers.push({ id, name: shortText(provider.name) ?? id, models })
	}
	return providers
}

/**
 * 目录里的全部路由（扁平），用于 `policy.match` 扩充候选；带 TTL 缓存。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @returns {Promise<Array<{provider: string, model: string}>>}
 */
async function catalogRoutes(ctx, state) {
	const now = Date.now()
	if (now - state.catalog.at < CATALOG_TTL_MS) return state.catalog.routes
	const providers = await collectCatalog(ctx)
	const routes = []
	for (const provider of providers) {
		for (const model of provider.models) routes.push({ provider: provider.id, model: model.id })
	}
	state.catalog = { at: now, routes }
	return routes
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * 插件运行态。策略可热改（设置页写入即生效），其余都是内存态诊断/回退状态。
 *
 * @returns {object} 新状态对象。
 */
function createState() {
	return {
		teamStore: undefined,
		stagedInitials: new Map(),
		policy: emptyPolicy(),
		trace: [],
		/** memberKey -> { until, failures }：rest 阶梯。 */
		rests: new Map(),
		/** 被 429 挤到候选末尾的成员（内存态，重启清空，与 magpie 的 Sink 同）。 */
		sink: new Set(),
		/** 父会话 id -> memberKey：亲和（保 vendor 前缀 cache）。 */
		affinity: new Map(),
		/** 子会话 id -> 回退状态机。 */
		children: new Map(),
		/** 父会话 id -> (memberKey -> 候选表)：一次性子 agent 的创建期决策，等它的第一次请求来认领。 */
		plans: new Map(),
		/** childId -> ModelSelection: 捕获的初始继承基线，供 clearoverride 恢复，绝不向 agent.model.select 传 null。 */
		baselines: new Map(),
		/** childId -> autoChild: 备份规划的 auto 候选链，防止 manual override 覆盖后丢失。 */
		autoPlans: new Map(),
		/** childId -> number: 单轮幂等记录，隔离在插件 state，防止污染宿主 agent。 */
		lastRoutedTurns: new Map(),
		/** 创建序号：rotate / weight 策略的游标。 */
		cursor: 0,
		catalog: { at: 0, routes: [] },
		/** 分类器回答缓存：hash -> intent | null。 */
		intents: new Map(),
		/** 0.2.1 的显式路由暂存：成员名 -> route。 */
		staging: new Map(),
		/** `provider/model` → { at, value }：该模型公布的推理档，供设置页做下拉。 */
		efforts: new Map(),
		/** 用量统计（只统计子 agent；Lead 自己的消耗不在内）。 */
		usage: emptyUsage(),
		/** 用量落盘的定时器句柄（节流用）。 */
		usageTimer: undefined,
	}
}

/**
 * 读一个模型公布的推理档（`llm.resolveModelInfo().reasoning`）。
 *
 * 为什么需要它：推理档的取值是**适配器公布**的（真机实测 `zai-coding-cn/glm-5.3` 只认
 * `low` / `high` / `max`），让用户手填等于让人猜。官方 `list_subagent_models` 走的也是这条 API。
 *
 * 失败一律降级成「没有公布」：adapter 未声明、模型不存在、llm 服务缺席，都不该让设置页报错。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @param {string} provider - provider id。
 * @param {string} model - model id。
 * @returns {Promise<{efforts: Array<object>, supported: boolean, defaultEffort?: string, error?: string}>}
 *   supported=false 表示 llm 服务不可用（与「可用但没公布」是两回事，页面要分开说）。
 */
async function resolveEfforts(ctx, state, provider, model) {
	const key = `${provider}/${model}`
	const cached = state.efforts.get(key)
	if (cached !== undefined && Date.now() - cached.at < EFFORT_TTL_MS) return cached.value

	const llm = ctx.get === undefined ? undefined : ctx.get('llm')
	let value = { efforts: [], supported: false }
	if (llm !== undefined && llm !== null && typeof llm.resolveModelInfo === 'function') {
		try {
			const info = await llm.resolveModelInfo(provider, model)
			const reasoning = info === null || info === undefined ? undefined : info.reasoning
			const efforts = []
			for (const effort of Array.isArray(reasoning?.efforts) ? reasoning.efforts : []) {
				const id = shortText(effort === null || effort === undefined ? undefined : effort.id, 64)
				if (id === undefined) continue
				const description = shortText(effort.description, 300)
				efforts.push({ id, name: shortText(effort.name, 120) ?? id, ...(description === undefined ? {} : { description }) })
			}
			value = { efforts, supported: true }
			if (typeof reasoning?.defaultEffort === 'string') value.defaultEffort = reasoning.defaultEffort
		} catch (error) {
			// 模型不存在 / 适配器拒绝解析：当作「没公布」，但把原因带给页面。
			value = { efforts: [], supported: true, error: error instanceof Error ? error.message : String(error) }
		}
	}
	state.efforts.set(key, { at: Date.now(), value })
	return value
}

/**
 * 记一条 trace（环形缓冲）。
 *
 * 为什么一定要有：路由不可观测就等于没路由。用户看到「模型没换」时，第一件事是知道
 * 是规则没命中、成员被摘了、还是 provider 未注册。
 *
 * @param {object} state - 插件状态。
 * @param {object} record - 决策记录。
 */
function pushTrace(state, record) {
	state.trace.push({ at: new Date().toISOString(), ...record })
	if (state.trace.length > TRACE_LIMIT) state.trace.splice(0, state.trace.length - TRACE_LIMIT)
}

// ---------------------------------------------------------------------------
// 创建期：读上下文 → 决策 → 注入
// ---------------------------------------------------------------------------

/** 从 agent 上取会话 id（真宿主是 `agent.session.id`，假宿主/其它形状做兜底）。 */
function sessionIdOf(agent) {
	if (agent === null || agent === undefined) return undefined
	const session = agent.session
	if (session !== null && session !== undefined) {
		if (typeof session.id === 'string') return session.id
		const header = session.header
		if (header !== null && header !== undefined && typeof header.id === 'string') return header.id
	}
	return typeof agent.id === 'string' ? agent.id : undefined
}

/** 从 agent 上取会话 header（子 agent 判定的唯一依据）。 */
function headerOf(agent) {
	const header = agent === null || agent === undefined || agent.session === null || agent.session === undefined
		? undefined
		: agent.session.header
	return header !== null && typeof header === 'object' ? header : undefined
}

/**
 * 是不是「会创建子 agent 的那个调用」的父会话。
 *
 * 注意：这里判的是**父** agent（发起创建的一方，通常就是 Lead）。Lead 自己的模型请求
 * 不参与路由，但它的会话 header 是父会话 up 的来源，所以这个函数只用来读信息。
 */
function cwdOf(agent) {
	const header = headerOf(agent)
	return header === undefined ? undefined : header.cwd
}

/** 父会话当前推理档：优先读冻结的请求头，退回 agent 的创建选项（与官方同源）。 */
function effortOf(agent) {
	try {
		const config = agent?.session?.requestHeader?.()?.config
		if (config !== null && config !== undefined && typeof config.reasoningEffort === 'string') return config.reasoningEffort
	} catch {
		/* 兼容假宿主：requestHeader 缺失走下面 */
	}
	const effort = agent?.options?.reasoningEffort
	return typeof effort === 'string' ? effort : undefined
}

/** 创建请求里是否带图片块（magpie 的 `Rule.Images` 在 DSH 的对应物）。 */
function promptHasImages(prompt) {
	if (!Array.isArray(prompt)) return false
	return prompt.some((block) => block !== null && typeof block === 'object' && block.type === 'image')
}

/** 父会话当前 token 规模（`tokenMeter.measure`，缺席或抛错一律返回 undefined）。 */
function tokensOf(ctx, agent) {
	const meter = ctx.get === undefined ? undefined : ctx.get('tokenMeter')
	if (meter === undefined || meter === null || typeof meter.measure !== 'function') return undefined
	const session = agent?.session
	if (session === undefined || session === null) return undefined
	try {
		const measured = meter.measure(session)
		return measured !== null && typeof measured === 'object' && typeof measured.totalTokens === 'number'
			? measured.totalTokens
			: undefined
	} catch {
		return undefined
	}
}

/** 创建请求的可读文本（label + 提示文本），供分类器使用。 */
function contextText(label, prompt) {
	const parts = []
	if (typeof label === 'string' && label !== '') parts.push(label)
	if (Array.isArray(prompt)) {
		for (const block of prompt) {
			if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
		}
	}
	const text = parts.join('\n').trim()
	return text.length > 2000 ? text.slice(0, 2000) : text
}

/**
 * 调一次分类器模型，判断这次创建属于哪个意图（magpie 的 Classifier）。
 *
 * 默认关：开启后**每次创建**都会多打一次模型调用。回答说不清（没有、多个）一律视为不命中
 * —— magpie 也是「When the classifier can't say, it doesn't match」。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @param {object} policy - 策略。
 * @param {string} text - 待分类文本。
 * @param {AbortSignal} [signal] - 创建请求的取消信号。
 * @returns {Promise<string | null>} 意图 id，或 null。
 */
async function classifyIntent(ctx, state, policy, text, signal) {
	const classifier = policy.classifier ?? {}
	if (classifier.enabled !== true) return null
	const intents = collectIntents(policy)
	if (intents.length === 0 || text === '') return null
	const provider = shortText(classifier.provider)
	const model = shortText(classifier.model)
	if (provider === undefined || model === undefined) return null
	const llm = ctx.get === undefined ? undefined : ctx.get('llm')
	if (llm === undefined || llm === null || typeof llm.stream !== 'function') return null

	const key = createHash('sha256').update(`${provider}\u0000${model}\u0000${intents.join('\u0000')}\u0000${text}`).digest('hex')
	if (state.intents.has(key)) return state.intents.get(key)

	const question =
		'Classify the task below into exactly one of these categories. ' +
		`Reply with the category text only, nothing else.\n\nCategories:\n${intents.map((intent) => `- ${intent}`).join('\n')}\n\nTask:\n${text}`
	let answer = ''
	try {
		const stream = llm.stream({
			provider,
			model,
			maxTokens: 32,
			messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
			...(signal === undefined ? {} : { signal }),
		})
		for await (const chunk of stream) {
			if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
				answer += chunk.text
			}
		}
	} catch {
		// 分类器失败 = 说不清 = 不命中（绝不让它把创建搞失败）。
		answer = ''
	}
	const intent = parseIntent(answer, intents)
	if (state.intents.size >= INTENT_CACHE_LIMIT) state.intents.clear()
	state.intents.set(key, intent)
	return intent
}

/** provider 是否声明支持 `agentOptions`（与官方 `assertCapabilities` 同一判据）。 */
function providerTakesAgentOptions(service, channel) {
	if (service === undefined || service === null || typeof service.getProvider !== 'function') return true
	const provider = service.getProvider(channel)
	if (provider === null || provider === undefined) return true
	const capabilities = provider.capabilities
	if (capabilities === undefined || capabilities === null) return true
	return capabilities.agentOptions === true
}

/**
 * provider 是否已注册；llm 服务缺席时返回 undefined（= 不知道，放行而不是拦）。
 *
 * @returns {boolean | undefined}
 */
function providerRegistered(ctx, providerId) {
	const llm = ctx.get === undefined ? undefined : ctx.get('llm')
	if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return undefined
	return llm.listProviders().some((provider) => provider !== null && provider !== undefined && provider.id === providerId)
}

/** 当前处于 rest 的成员集合。 */
function restingSet(state) {
	const now = Date.now()
	const resting = new Set()
	for (const [key, entry] of state.rests) {
		if (entry.until > now) resting.add(key)
		else state.rests.delete(key)
	}
	return resting
}

/**
 * 创建期决策。
 *
 * 返回值三态：
 *   - `null`：不干预，原样放行（= 官方行为）；
 *   - `{ skip }`：该干预但放弃了，trace 记原因；
 *   - `{ route, candidates, reason, ruleIndex }`：注入。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @param {'continuable' | 'one-shot'} kind - 走的是哪条创建通道。
 * @param {object} payload - `startContinuable` 的 spec，或 `{ name, request }`。
 * @param {object} service - subagents 服务本体（查 provider 能力）。
 * @returns {Promise<object | null>}
 */
async function decide(ctx, state, kind, payload, service) {
	const policy = state.policy
	const spec = kind === 'continuable' ? payload : payload.request
	const request = spec === null || spec === undefined ? undefined : kind === 'continuable' ? spec.request : spec
	if (request === null || typeof request !== 'object') return null

	// 0) 显式优先：0.2.1 的 `spawn_modeled_teammate` 暂存路由。用户点名要的，规则让位。
	if (kind === 'continuable') {
		const staged = pickStagedRoute(spec, state.staging)
		if (staged !== null) {
			const route = routeToAgentOptions(staged)
			return { route, candidates: [route], reason: 'explicit', ruleIndex: null, channel: spec.provider, label: spec.label ?? '' }
		}
	}
	// 调用方自己给了 agentOptions（官方 subagent 工具的参数 / 工具实例配置）：不覆盖。
	if (request.agentOptions !== undefined) return null

	const channel = kind === 'continuable' ? spec.provider : payload.name
	if (typeof channel !== 'string' || channel === '') return null

	// 路由器没配置（没有显式成员也没有 match 模式）：等于关闭，别去动官方行为。
	if (policy.members.length === 0 && (policy.match ?? []).length === 0) return null

	// fork 默认不纳管：改了路由，被 fork 的父会话前缀就不能复用 KV cache
	// （官方 dsh-base/cordis.patch.yml:379-392 的注释就是这条取舍）。
	if (channel === 'fork' && policy.allowFork !== true) {
		return { skip: 'fork-disabled', channel, label: spec.label ?? '' }
	}

	const parent = request.parent
	const label = typeof spec.label === 'string' ? spec.label : ''
	const member = teammateNameFromPrompt(request.prompt)
	const text = contextText(label, request.prompt)
	const context = {
		channel,
		continuable: kind === 'continuable',
		label,
		member: member ?? '',
		cwd: cwdOf(parent),
		tokens: tokensOf(ctx, parent),
		effort: effortOf(parent),
		images: promptHasImages(request.prompt),
		intent: await classifyIntent(ctx, state, policy, text, spec.signal),
	}
	const catalog = await catalogRoutes(ctx, state)
	const parentId = sessionIdOf(parent)
	const decision = planRoute(policy, context, {
		catalog,
		cursor: state.cursor,
		resting: restingSet(state),
		sunk: state.sink,
		// 亲和只在「子会话真的共享父会话前缀」时才有意义——也就是 fork 通道（保 vendor 的
		// prompt cache 复用）。0.3.1 之前对所有创建通道都传亲和，结果是：同一 Lead 会话创建
		// 第一个子 agent 之后，后面每一个都粘在那个成员上，weight/rotate 永远轮不起来
		//（用户实报「weight 全部没生效」）。spawn 出来的子代理各自是独立会话，没有前缀
		// 可共享，必须交给排序策略去轮。
		affinity: channel === 'fork' && parentId !== undefined ? state.affinity.get(parentId) : undefined,
	})
	if (decision === null) return null

	// 注入前两道闸：provider 得支持 agentOptions，且得真的注册过。
	if (!providerTakesAgentOptions(service, channel)) {
		return { skip: 'provider-no-agent-options', channel, label, route: memberKey(decision.route) }
	}
	if (providerRegistered(ctx, decision.route.provider) === false) {
		return { skip: 'provider-unregistered', channel, label, route: memberKey(decision.route) }
	}
	return { ...decision, channel, label, context, parentId }
}

/**
 * 把创建期决策登记成「等子 agent 来认领」的计划。
 *
 * 为什么需要：`start(name, request)` 里子会话 id 是官方在内部铸的，创建前拿不到，
 * 也就无法提前按 id 登记回退状态。等到该子 agent 的第一次 `agent/request` 时，
 * 用「父会话 id + 当前路由」这对键认领——两个都在手上，且唯一。
 *
 * @param {object} state - 插件状态。
 * @param {string | undefined} parentId - 父会话 id。
 * @param {object} decision - 创建期决策。
 */
function rememberPlan(state, parentId, decision, source) {
	if (parentId === undefined || parentId === '') return
	const key = memberKey(decision.route)
	let plans = state.plans.get(parentId)
	if (plans === undefined) {
		plans = new Map()
		state.plans.set(parentId, plans)
	}
	// 存成对象：一次性子代理要等它的第一次请求来认领，届时用这里的来源记用量归属。
	plans.set(key, { candidates: decision.candidates, member: decision.member, source })
	// 父会话数量有限，但长时间跑下来也要收口：超过 200 个父会话就清最早的一半。
	if (state.plans.size > 200) {
		for (const id of state.plans.keys()) {
			state.plans.delete(id)
			if (state.plans.size <= 100) break
		}
	}
}

/**
 * 命中规则的展示标签（图 3 用）：`#3 *审查*` 这样一眼能认出是哪条。
 *
 * @param {object} policy - 当时的策略。
 * @param {object} decision - 创建期决策。
 * @returns {string | undefined} 非规则命中（权重轮转/显式/亲和）返回 undefined。
 */
function ruleTagOf(policy, decision) {
	if (decision.reason === 'pick') return '手动指定（pick）'
	if (decision.reason !== 'rule' || decision.ruleIndex === null || decision.ruleIndex === undefined) return undefined
	const rule = policy.rules[decision.ruleIndex]
	const label = rule === undefined
		? undefined
		: rule.label ?? (rule.images === true ? '带图' : rule.continuable !== undefined ? '兜底' : rule.pause === true ? '停用' : undefined)
	return `#${decision.ruleIndex + 1}${label === undefined ? '' : ' ' + label}`
}

/** 记录一次成功的注入（trace + 游标 + 计划登记）。 */
function noteInjection(state, decision, kind, stateful) {
	state.cursor += 1
	const parentId = decision.parentId
	if (decision.channel === 'fork' && parentId !== undefined) state.affinity.set(parentId, decision.member)
	const source = { reason: decision.reason, rule: ruleTagOf(state.policy, decision) }
	if (kind === 'continuable') {
		state.children.set(stateful.childId, {
			candidates: decision.candidates,
			index: 0,
			attempts: 0,
			pending: undefined,
			parentSessionId: parentId,
			source,
		})
		// continuable 子代理创建时就知道 childId，当场记归属。
		attributeChild(state.usage, stateful.childId, memberKey(decision.route), decision.member, source)
	} else {
		rememberPlan(state, parentId, decision, source)
	}
	pushTrace(state, {
		kind: 'create',
		outcome: 'injected',
		channel: decision.channel,
		continuable: kind === 'continuable',
		label: decision.label,
		reason: decision.reason,
		ruleIndex: decision.ruleIndex,
		member: decision.member,
		route: memberKey(decision.route),
		candidates: decision.candidates.map(memberKey),
		cwd: decision.context?.cwd,
		tokens: decision.context?.tokens,
		intent: decision.context?.intent ?? null,
	})
}

/** 记录一次「该管但没管」。 */
function noteSkip(state, skip) {
	pushTrace(state, {
		kind: 'create',
		outcome: 'skipped',
		channel: skip.channel,
		continuable: skip.continuable === true,
		label: skip.label,
		reason: skip.skip,
		route: skip.route,
		why: SKIP_TEXT[skip.skip] ?? skip.skip,
	})
}

/** 跳过原因的中文说明（设置页直接显示，不让用户去猜英文常量）。 */
const SKIP_TEXT = {
	'fork-disabled': 'fork 通道未纳管（默认关闭：改路由会失去父会话前缀的 KV 复用）',
	'provider-no-agent-options': '该 subagent provider 未声明 agentOptions 能力，未注入',
	'provider-unregistered': '目标 provider 未注册，未注入（子 agent 退回继承 Lead）',
	'no-candidate': '没有可用候选成员',
}

// ---------------------------------------------------------------------------
// 创建期：包装两条通道
// ---------------------------------------------------------------------------

/**
 * 0.2.1-rc.2 的 startActivation 是统一入口：provider 有 prepareContinuable 就是「团队成员」
 * （内部走 startLocal），否则是「一次性/外部」（走 startExternal）。规则里的 `continuable`
 * 条件与 fork 判定都依赖这个分类，所以必须和宿主用同一套依据。
 *
 * @param {object} service - subagents 服务本体。
 * @param {unknown} spec - startActivation 的入参。
 * @returns {'continuable' | 'one-shot'}
 */
function activationKind(service, spec) {
	try {
		const name = spec === null || typeof spec !== 'object' ? undefined : spec.provider
		const provider = typeof service.getProvider === 'function' ? service.getProvider(name) : undefined
		if (provider !== undefined && provider !== null) {
			if (typeof provider.prepareContinuable === 'function') return 'continuable'
			if ('prepareContinuable' in provider) return 'one-shot'
		}
		// 拿不到 provider 声明时退回保守判断：带了保留 childId 的一律当 continuable。
		if (spec !== null && typeof spec === 'object' && spec.childId !== undefined) return 'continuable'
		return 'one-shot'
	} catch {
		return 'one-shot'
	}
}

/**
 * 安装 `startContinuable` 与 `start` 的包装。
 *
 * 覆盖的是服务**本体**上的自有属性（遮蔽原型方法），因为 traceable 代理会吞掉对代理的写入。
 * 包装内部**不能用 `this`**：代理调用方法时会把 thisArg 换成 shadow（utils.ts:158-161），
 * 而原方法依赖内部状态，必须显式绑回本体。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @returns {{ wrapped: string[], service: object }} 覆盖层级标记与本体。
 * @throws 拿不到本体或两个方法都写不进去时抛出——宁可插件显示「启动失败」，也不要静默不生效。
 */
function installWrapper(ctx, state) {
	// 两代 API：0.2.0 = start / startContinuable；0.2.1-rc.2 起 = startExternal(spec) / startLocal(spec)。
	const WRAPPABLE = ['startContinuable', 'startLocal', 'startExternal', 'start']
	const service = rawService(ctx, 'subagents', WRAPPABLE)
	if (service === undefined) {
		throw new Error('取不到 ctx.subagents 的服务本体（ctx.reflect 不可用或 cordis 内部结构已变），无法包装 subagent 创建入口')
	}
	const wrapped = []

	/** 统一的「决策 → 注入 / 放行」流程（两条通道共用）。 */
	async function routeThrough(kind, payload, callOriginal, register) {
		const decision = await decide(ctx, state, kind, payload, service)
		if (decision === null) return await callOriginal()
		if (decision.skip !== undefined) {
			noteSkip(state, decision)
			return await callOriginal()
		}
		const result = await callOriginal(decision)
		noteInjection(state, { ...decision, ...register }, kind, register)
		return result
	}

	if (typeof service.startContinuable === 'function') {
		const original = service.startContinuable
		// 记住这个方法原本是不是本体的**自有属性**：真宿主里它在原型上，
		// 卸载时必须 delete 掉自有属性让原型方法重新生效；直接赋值回去会永久留下一个
		// 遮蔽原型的自有属性（函数相同、行为相同，但「完全还原」的契约就破了）。
		const hadOwn = Object.hasOwn(service, 'startContinuable')
		const wrappedContinuable = async function startContinuable(spec) {
			if (spec && typeof spec === 'object' && spec.childId) {
				if (spec.request && spec.request.agentOptions !== undefined) {
					const explicitRoute = extractExplicitRoute(spec.request.agentOptions)
					if (explicitRoute) {
						state.stagedInitials.set(spec.childId, { selection: explicitRoute, source: 'explicit' })
					}
				}
			}
			return await routeThrough('continuable', spec, async (decision) => {
				return await original.call(service, decision === undefined ? spec : withAgentOptions(spec, decision.route))
			}, { childId: spec === null || typeof spec !== 'object' ? undefined : spec.childId })
		}
		wrappedContinuable.__tmmOriginal = original
		service.startContinuable = wrappedContinuable
		if (service.startContinuable !== wrappedContinuable) throw new Error('包装 ctx.subagents.startContinuable 失败：服务本体拒绝写入')
		wrapped.push('startContinuable')
		ctx.effect(() => () => {
			if (service.startContinuable !== wrappedContinuable) return
			if (hadOwn) service.startContinuable = original
			else delete service.startContinuable
		}, 'team-member-model: startContinuable wrapper')
	}

	if (typeof service.start === 'function') {
		const original = service.start
		const hadOwn = Object.hasOwn(service, 'start')
		const wrappedStart = async function start(providerName, request) {
			return await routeThrough('one-shot', { name: providerName, request }, async (decision) => {
				return await original.call(service, providerName, decision === undefined ? request : withRequestAgentOptions(request, decision.route))
			}, {})
		}
		wrappedStart.__tmmOriginal = original
		service.start = wrappedStart
		if (service.start !== wrappedStart) throw new Error('包装 ctx.subagents.start 失败：服务本体拒绝写入')
		wrapped.push('start')
		ctx.effect(() => () => {
			if (service.start !== wrappedStart) return
			if (hadOwn) service.start = original
			else delete service.start
		}, 'team-member-model: start wrapper')
	}

	// ---- 0.2.1-rc.2 起：spec 形状的入口 ----
	// startLocal(spec) = 团队成员/后台子代理（continuable）；startExternal(spec) = 一次性 / 外部 provider。
	// 两者都把 agentOptions 放在 spec.request 里，注入方式与旧 startContinuable 完全一致。
	// 0.2.1-rc.2 的公开入口只有 startActivation(spec)：它按 provider 有没有 prepareContinuable
	// 分派到 startLocal（团队成员/后台）或 startExternal（一次性/外部 provider）。
	// 注入点两者一致：spec.request.agentOptions。
	const specEntries = [
		['startActivation', 'auto'],
		['startLocal', 'continuable'],
		['startExternal', 'one-shot'],
	]
	for (const [method, declaredKind] of specEntries) {
		if (typeof service[method] !== 'function') continue
		const original = service[method]
		const hadOwn = Object.hasOwn(service, method)
		// 注意别叫 wrapped：那是外层收集「已包装方法名」的数组，重名会被遮蔽。
		const wrappedSpec = async function (spec) {
			const kind = declaredKind === 'auto' ? activationKind(service, spec) : declaredKind
			if (method === 'startActivation' && spec && typeof spec === 'object' && !spec.request) {
				const originalSpec = spec
				let childId
				if (kind === 'continuable') {
					childId = spec.childId ?? randomUUID()
					spec = { ...spec, childId }
					const teamService = ctx.get ? ctx.get('agentTeams') : ctx.agentTeams
					if (teamService && typeof teamService.isEnabled === 'function' && typeof service.rootOf === 'function') {
						const root = service.rootOf(spec.parent)
						if (teamService.isEnabled(root)) {
							const explicit = extractExplicitRoute(spec.agentOptions)
							state.stagedInitials.set(childId, { root, selection: explicit ?? state.teamStore.getTeam(root.id).defaultModel, source: explicit ? 'explicit' : 'default' })
						}
					}
				}
				try {
					const adapted = { ...spec, request: spec }
					const result = await routeThrough(kind, kind === 'continuable' ? adapted : { name: spec.provider, request: spec }, async decision => {
						const request = decision === undefined ? spec : withRequestAgentOptions(spec, decision.route)
						return original.call(service, request)
					}, { childId })
					const explicit = extractExplicitRoute(originalSpec.agentOptions)
					if (explicit) pushTrace(state, { kind: 'create', outcome: 'explicit', reason: 'explicit', route: memberKey(explicit), channel: spec.provider })
					return result
				} finally {
					if (childId) state.stagedInitials.delete(childId)
				}
			}
			if (kind === 'continuable' && spec && typeof spec === 'object' && spec.childId) {
				if (spec.request && spec.request.agentOptions !== undefined) {
					const explicitRoute = extractExplicitRoute(spec.request.agentOptions)
					if (explicitRoute) {
						state.stagedInitials.set(spec.childId, { selection: explicitRoute, source: 'explicit' })
					}
				}
			}
			return await routeThrough(kind, kind === 'continuable' ? spec : { name: spec?.provider, request: spec?.request }, async (decision) => {
				return await original.call(service, decision === undefined ? spec : withAgentOptions(spec, decision.route))
			}, { childId: kind === 'continuable' && spec !== null && typeof spec === 'object' ? spec.childId : undefined })
		}
		wrappedSpec.__tmmOriginal = original
		service[method] = wrappedSpec
		if (service[method] !== wrappedSpec) throw new Error(`包装 ctx.subagents.${method} 失败：服务本体拒绝写入`)
		wrapped.push(method)
		ctx.effect(() => () => {
			if (service[method] !== wrappedSpec) return
			if (hadOwn) service[method] = original
			else delete service[method]
		}, `team-member-model: ${method} wrapper`)
	}

	if (wrapped.length === 0) {
		// 0.2.1-rc.2 的真实宿主里 `_getImpl` 拿到的可能不是类实例：把形状打进错误里，
		// 这样在 plugin_manager 的重载结果里就能看到到底拿到了什么（别再靠猜）。
		const names = (value) => {
			const set = new Set()
			for (let cursor = value; cursor !== null && cursor !== undefined; cursor = Object.getPrototypeOf(cursor)) {
				for (const key of Object.getOwnPropertyNames(cursor)) if (key !== 'constructor') set.add(key)
			}
			return [...set]
		}
		let impl
		try { impl = ctx.reflect?._getImpl?.('subagents')?.value } catch { impl = undefined }
		const probe = {
			implType: typeof impl,
			implCtor: impl === null || impl === undefined ? String(impl) : impl.constructor?.name,
			implMethods: names(impl).filter((key) => /start|spawn|fork|run|local|external/i.test(key)).slice(0, 20),
			proxyMethods: names(service).filter((key) => /start|spawn|fork|run|local|external/i.test(key)).slice(0, 20),
			subagentsServiceType: typeof ctx.get?.('subagents'),
		}
		throw new Error(`ctx.subagents 没有可包装的创建入口；诊断 ${JSON.stringify(probe)}`)
	}
	return { wrapped, service }
}

// ---------------------------------------------------------------------------
// 运行期：回退（magpie 的候选人循环）
// ---------------------------------------------------------------------------

/** 是不是子 agent（Lead 永不参与路由，这条是硬隔离）。 */
function isChildAgent(agent) {
	const header = headerOf(agent)
	if (header?.origin === 'subagent') return true
	if (typeof header?.delegationDepth === 'number' && header.delegationDepth >= 1) return true
	if (agent?.options?.origin === 'subagent') return true
	if (typeof agent?.options?.delegationDepth === 'number' && agent.options.delegationDepth >= 1) return true
	return false
}

/** 把子 agent 的当前请求配置替换成候选路由。 */
function replaceRoute(config, member) {
	if (config.provider === member.provider && config.model === member.model) {
		if (member.reasoningEffort === undefined) return config
		if (config.reasoningEffort === member.reasoningEffort) return config
		return { ...config, reasoningEffort: member.reasoningEffort }
	}
	// 换路由且没点名 effort 时清掉继承的 effort，交给所选模型的默认值
	// （官方 resolveChildAgentOptions 的文档化语义）。
	const { reasoningEffort: _inherited, ...rest } = config
	return { ...rest, provider: member.provider, model: member.model, ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }) }
}

/**
 * 认领一个子 agent 的回退状态：第一次 `agent/request` 时按「父会话 + 当前路由」找创建期计划。
 *
 * @param {object} state - 插件状态。
 * @param {object} agent - 发起请求的 agent。
 * @param {object} config - 官方给出的冻结配置。
 * @returns {object | null} 回退状态，或 null（不是我们路由过的子 agent）。
 */
function claimChild(state, agent, config) {
	const id = sessionIdOf(agent)
	if (id === undefined) return null
	const existing = state.children.get(id)
	if (existing !== undefined) return existing
	const header = headerOf(agent)
	const parentId = header === undefined ? undefined : header.parentSession
	if (parentId === undefined) return null
	const plans = state.plans.get(parentId)
	if (plans === undefined) return null
	// 计划按**成员身份**（provider/model[:effort]）记账，而子 agent 的冻结配置只有
	// provider/model/reasoningEffort 三个字段——先拼带档位的键，再退回不带档位的，
	// 否则档位成员（glm-5.3:low）创建的一次性子代理永远认领不到回退计划。
	const plain = `${config.provider}/${config.model}`
	const keys = config.reasoningEffort === undefined ? [plain] : [`${plain}:${config.reasoningEffort}`, plain]
	let plan
	for (const key of keys) {
		plan = plans.get(key)
		if (plan !== undefined) break
	}
	if (plan === undefined) return null
	const child = {
		candidates: plan.candidates,
		member: plan.member,
		index: 0,
		attempts: 0,
		pending: undefined,
		parentSessionId: parentId,
		source: plan.source,
	}
	state.children.set(id, child)
	return child
}

/** 读用量文件；不存在或损坏时返回空记录（首次启动是正常路径）。 */
async function readUsageFile() {
	try {
		const raw = await readFile(usagePath(), 'utf8')
		return loadUsage(JSON.parse(raw))
	} catch {
		return emptyUsage()
	}
}

/** 写用量文件（节流后调用）；失败只记日志，不影响路由。 */
async function writeUsageFile(state) {
	try {
		await mkdir(dirname(usagePath()), { recursive: true })
		await writeFile(usagePath(), `${JSON.stringify(serializeUsage(state.usage), null, 2)}\n`, 'utf8')
	} catch {
		/* 用量是观测数据，写不进去也不该影响路由 */
	}
}

/** 攒一会儿再落盘：会话事件可能每秒好几条。 */
function scheduleUsagePersist(state) {
	if (state.usageTimer !== undefined) return
	state.usageTimer = setTimeout(() => {
		state.usageTimer = undefined
		void writeUsageFile(state)
	}, USAGE_PERSIST_MS)
	if (typeof state.usageTimer.unref === 'function') state.usageTimer.unref()
}

/** 会话是不是子 agent（只统计子 agent，Lead 不算）。 */
function isChildSession(session) {
	const header = session === null || session === undefined ? undefined : session.header
	if (header === null || header === undefined || typeof header !== 'object') return false
	if (header.origin === 'subagent') return true
	return typeof header.delegationDepth === 'number' && header.delegationDepth >= 1
}

/** 会话当前跑的成员（兜底归属：插件重启后运行期映射丢了，但请求头里还有路由）。 */
function memberOfSession(session) {
	try {
		const config = session?.requestHeader?.()?.config
		if (config === null || config === undefined) return undefined
		if (typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
		return memberKey({ provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort })
	} catch {
		return undefined
	}
}

/** 会话的事件数组（官方两种形态：snapshotEvents() 或 events）。 */
function eventsOf(session) {
	if (session === null || session === undefined) return []
	if (typeof session.snapshotEvents === 'function') {
		const events = session.snapshotEvents()
		return Array.isArray(events) ? events : []
	}
	return Array.isArray(session.events) ? session.events : []
}

/**
 * 折一条事件进用量。
 *
 * 口径照官方 counter：只在 `assistant/message`（成功提交的锚点）计数，且必须有 usage ——
 * 适配器没报用量时**不算一次调用**，否则会把调用次数虚高。
 */
function foldUsageEvent(state, session, childId, event) {
	if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return
	const data = event.data
	if (data === null || typeof data !== 'object') return
	const counters = countersFromUsage(data.usage)
	if (counters === null) return
	if (!shouldCountCall(state.usage, childId, data.turn, data.step, counters.totalTokens)) return
	const member = state.usage.children[childId] ?? memberOfSession(session)
	foldTokenUsage(state.usage, member, counters, typeof event.time === 'number' ? event.time : Date.now())
}

/**
 * 安装用量统计：监听 `session/event`，按序号水位消费子会话的事件。
 *
 * 为什么用「读会话日志 + 水位」而不是直接折事件参数：官方那个 token-usage-counter
 * 也是这么做的——一个通知可能对应多条新事件，按水位扫描既不漏也不重。
 *
 * @returns {string[]} 已注册的监听器名（写进 status.json）。
 */
function installUsage(ctx, state) {
	if (typeof ctx.on !== 'function') return []
	ctx.on('session/event', (session) => {
		if (!isChildSession(session)) return
		const childId = sessionIdOf(session)
		if (typeof childId !== 'string' || childId === '') return
		const events = eventsOf(session)
		const from = state.usage.consumed[childId] ?? 0
		for (let index = from; index < events.length; index += 1) {
			if (events[index].type === 'assistant/message') {
				const served = state.children.get(childId)?.pending
				if (served !== undefined) state.rests.delete(served)
			}
			foldUsageEvent(state, session, childId, events[index])
		}
		state.usage.consumed[childId] = events.length
		scheduleUsagePersist(state)
	})
	return ['session/event']
}

/**
 * 安装运行期回退：换候选 + rest + sink + served 清 rest。
 *
 * 可重试错误只推进后续轮次候选并记录 rest/sink；当次错误继续交给官方处理。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @returns {string[]} 已注册的监听器名（写进 status.json 供诊断）。
 */

/** 安全获取 agentTeams membership */
function getTeamMembership(ctx, agent, state) {
	try {
		const staged = state?.stagedInitials.get(agent.id)
		const agents = ctx.get ? ctx.get('agents') : ctx.agents
		if (staged?.root && agents?.get(staged.root.id) === staged.root && agents.get(agent.id) === agent) {
			return { root: staged.root, id: staged.root.id, role: 'teammate' }
		}
		const subagents = ctx.get ? ctx.get('subagents') : ctx.subagents
		const teams = ctx.get ? ctx.get('agentTeams') : ctx.agentTeams
		if (!subagents || typeof subagents.rootOf !== 'function' || !teams || typeof teams.isEnabled !== 'function') return undefined
		const root = subagents.rootOf(agent)
		if (!teams.isEnabled(root)) return undefined
		return { root, id: root.id, role: root === agent ? 'lead' : 'teammate' }
	} catch {}
	return undefined
}

/**
 * 取 agent 自身的已完成/最后活跃 turn 数 (等价于 switchable lastOwnTurn)
 * 专供 PUT 写入 effectiveAfterTurn
 */
function lastOwnTurn(agent) {
	try {
		const events = typeof agent?.session?.ownEvents === 'function' ? agent.session.ownEvents() : []
		let turn = 0
		for (const ev of events) {
			if (ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') {
				turn = ev.data.turn
			}
		}
		return turn
	} catch {
		return 0
	}
}

/** 取 agent 自身的当前 turn 数 (运行中的当前轮次) */
function turnOf(agent) {
	try {
		if (typeof agent?._getTurn === 'function') {
			return agent._getTurn()
		}
		return lastOwnTurn(agent)
	} catch {
		return 0
	}
}

function sameModelSelection(a, b) {
	if (a === b) return true
	if (a === null || a === undefined || b === null || b === undefined) return false
	return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** 同步解析并应用当前 agent 的模型选择（早于 preStep 采样，保证工具/提示词/请求一致） */
function syncSelectTeamRoute(ctx, state, agent, turn) {
	if (!agent || !isChildAgent(agent)) return null
	const childId = sessionIdOf(agent)
	if (!childId) return null

	const teamMembership = getTeamMembership(ctx, agent, state)
	const isTeammate = Boolean(teamMembership && teamMembership.role === 'teammate')

		if (isTeammate) {
			const teamId = teamMembership.root ? sessionIdOf(teamMembership.root) : teamMembership.id
			const teamRecord = state.teamStore ? state.teamStore.getTeam(teamId) : null
			const agentOptions = agent.options?.agentOptions ?? agent.options


			const teamResolution = resolveTeamRoute({
				agentId: childId,
				turn,
				teamRecord,
				agentOptions,
			})

			if (teamResolution && isManualFixedRoute(teamResolution)) {
				let child = state.children.get(childId)
				if (child === undefined) {
					child = {
						candidates: [teamResolution.route],
						member: teamResolution.route.model,
						index: 0,
						attempts: 0,
						pending: undefined,
						parentSessionId: teamId,
						source: { reason: teamResolution.level, rule: teamResolution.level },
						isManualFixed: true,
					}
					state.children.set(childId, child)
				} else {
					// 若之前存在 auto 候选链，备份到 state.autoPlans，防止被 manual override 擦除
					if (!child.isManualFixed && child.candidates && !state.autoPlans.has(childId)) {
						state.autoPlans.set(childId, { ...child })
					}
					child.isManualFixed = true
					child.candidates = [teamResolution.route]
					child.index = 0
					child.attempts = 0
					child.pending = undefined
				}
				
				if (typeof agent.model?.select === 'function') {
					const current = agent.model.current()
					if (!sameModelSelection(current, teamResolution.route)) {
						agent.model.select(teamResolution.route)
					}
				}
				return teamResolution.route
			} else if (state.children.get(childId)?.isManualFixed) {
				// 手动覆盖已被清除或降级，移除旧的手动固定 child 对象
				state.children.delete(childId)
			}

		// 检查覆盖被清除恢复（choice 设为 null 且 turn > effectiveAfterTurn）
		const choice = teamRecord?.choices?.[childId]
		if (choice && choice.selection === null && turn > (choice.effectiveAfterTurn ?? 0)) {
			let fallbackRoute = null
			// 依次降级：Level 3 captureddefault -> Level 4 auto (已缓存) -> Level 5 inherit baseline
			const initial = teamRecord?.initials?.[childId]
			const initSelection = initial?.selection ?? (initial?.provider ? initial : null)
			if (initSelection !== null && initSelection !== undefined) {
				fallbackRoute = initSelection
			} else {
				const autoChild = state.autoPlans.get(childId)
				if (autoChild && autoChild.candidates && autoChild.candidates[autoChild.index]) {
					state.children.set(childId, { ...autoChild })
					fallbackRoute = autoChild.candidates[autoChild.index]
				} else {
					fallbackRoute = state.baselines.get(childId)
					if (!fallbackRoute && isTeammate) {
						const lead = teamMembership.root
						const leadOpts = lead?.options?.agentOptions ?? lead?.options
						fallbackRoute = (leadOpts?.provider && leadOpts?.model ? { provider: leadOpts.provider, model: leadOpts.model, reasoningEffort: leadOpts.reasoningEffort } : undefined)
							?? lead?.model?.current()
					}
					if (!fallbackRoute) {
						const agentOpts = agent.options?.agentOptions ?? agent.options
						if (agentOpts?.provider && agentOpts?.model) {
							fallbackRoute = { provider: agentOpts.provider, model: agentOpts.model, reasoningEffort: agentOpts.reasoningEffort }
						}
					}
				}
			}
			if (fallbackRoute && typeof agent.model?.select === 'function') {
				const current = agent.model.current()
				if (!sameModelSelection(current, fallbackRoute)) {
					agent.model.select(fallbackRoute)
				}
			}
			return fallbackRoute
		}
	}

	// 自动规划路由（包括 plain 子代理与未命中 manualFixed 的团队成员）
	let child = state.children.get(childId)
	if (!child && agent.model?.current) {
		const initialSelection = agent.model.current()
		if (initialSelection?.provider && initialSelection?.model) child = claimChild(state, agent, initialSelection)
	}
	if (!child && state.autoPlans.has(childId)) {
		child = { ...state.autoPlans.get(childId) }
		state.children.set(childId, child)
	}

	if (!child && state.policy && state.policy.members.length > 0) {
		const channel = isTeammate ? 'spawn' : (headerOf(agent)?.channel ?? 'spawn')
		const context = {
			channel,
			continuable: true,
			label: '',
			member: isTeammate ? (teamMembership?.name ?? '') : '',
			cwd: headerOf(agent)?.cwd,
			tokens: undefined,
			effort: undefined,
			images: false,
			intent: null,
		}
		const decision = planRoute(state.policy, context, {
			catalog: state.catalog?.routes ?? [],
			cursor: state.cursor,
			resting: restingSet(state),
			sunk: state.sink,
		})
		if (decision !== null && decision.route) {
			child = {
				candidates: decision.candidates,
				member: decision.member,
				index: 0,
				attempts: 0,
				pending: undefined,
				parentSessionId: isTeammate ? (teamMembership.root ? sessionIdOf(teamMembership.root) : teamMembership.id) : undefined,
				source: { reason: 'auto', rule: ruleTagOf(state.policy, decision) },
			}
			state.autoPlans.set(childId, child)
			state.children.set(childId, child)
		}
	}

	if (child && child.candidates && child.candidates[child.index]) {
		const targetRoute = child.candidates[child.index]
		if (typeof agent.model?.select === 'function') {
			const current = agent.model.current()
			if (!sameModelSelection(current, targetRoute)) {
				agent.model.select(targetRoute)
			}
		}
		return targetRoute
	}

	return null
}

/** 安装团队生命周期事件（预约与 agent/created 持久化） */
function installTeamLifecycle(ctx, state) {
	const registered = []
	if (typeof ctx.on !== 'function') return registered

	// 监听 session/event 的 team/member (v2 provisioning) 捕获当前默认快照
	ctx.on('session/event', (session, event) => {
		if (!event || event.type !== 'team/member') return
		const data = event.data
		if (!data || data.version !== 2 || data.member?.phase !== 'provisioning') return
		const teamId = typeof data.teamId === 'string' ? data.teamId : session?.id
		const memberId = data.member?.id
		const memberName = data.member?.name
		if (!teamId || !memberId || !state.teamStore) return

		// 如果已有显式创建暂存 (来自 spawn_modeled_teammate)，优先级高于 defaultModel
		let staged = null
		if (memberName && state.staging.has(memberName)) {
			const stagedEntry = state.staging.get(memberName)
			const explicit = extractExplicitRoute(stagedEntry)
			if (explicit) {
				staged = { selection: explicit, source: 'explicit' }
			}
		}
		// 否则若未在 startContinuable/startActivation 记录显式 options，按当前 team.defaultModel 快照记录 (source: 'default')
		if (!staged && !state.stagedInitials.has(memberId)) {
			const team = state.teamStore.getTeam(teamId)
			staged = {
				selection: team.defaultModel,
				source: 'default',
			}
		}
		if (staged) {
			state.stagedInitials.set(memberId, staged)
		}
	})
	registered.push('session/event(team/member)')

	// 挂载 agent/created 钩子持久化捕获快照并初始化模型选择
	ctx.on('agent/created', async ({ agent }) => {
		if (!agent || !isChildAgent(agent)) return
		const memberId = sessionIdOf(agent)
		if (!memberId) return
		const membership = getTeamMembership(ctx, agent, state)
		const isTeammate = Boolean(membership && membership.role === 'teammate')

		// 1. 记录继承基线 (Level 5 inherit 备份，优先取未受覆盖的初始 agentOpts 或 Lead 根配置，严禁取已被历史覆盖污染的 agent.model.current())
		if (!state.baselines.has(memberId)) {
			const lead = membership?.root
			const leadOpts = lead?.options?.agentOptions ?? lead?.options
			const leadModel = (leadOpts?.provider && leadOpts?.model ? { provider: leadOpts.provider, model: leadOpts.model, reasoningEffort: leadOpts.reasoningEffort } : undefined)
				?? lead?.model?.current()
			const agentOpts = agent.options?.agentOptions ?? agent.options
			const memberInitial = (typeof agentOpts?.provider === 'string' && agentOpts.provider.length > 0 && typeof agentOpts?.model === 'string' && agentOpts.model.length > 0)
				? { provider: agentOpts.provider, model: agentOpts.model, reasoningEffort: agentOpts.reasoningEffort }
				: undefined
			const base = memberInitial ?? leadModel
			if (base) {
				state.baselines.set(memberId, { provider: base.provider, model: base.model, reasoningEffort: base.reasoningEffort })
			}
		}

		// 2. 如果创建包装已登记过 plan，认领至 state.children
		const header = headerOf(agent)
		const parentId = header?.parentSession
		if (parentId && state.plans.has(parentId)) {
			const conf = agent.model?.current() ?? agent.options ?? {}
			claimChild(state, agent, conf)
		}

		// 3. 团队成员处理 initials 快照
		if (isTeammate && state.teamStore) {
			const teamId = membership.root ? sessionIdOf(membership.root) : membership.id
			if (teamId) {
				let staged = state.stagedInitials.get(memberId)
				// Only an explicit marker is authoritative; inherited or auto-injected
				// Agent.options must not override the creation reservation.
				const agentOpts = agent.options?.agentOptions ?? agent.options
				const explicit = agentOpts?.explicit === true ? extractExplicitRoute(agentOpts) : null
				if (explicit) staged = { selection: explicit, source: 'explicit' }
				await state.teamStore.updateTeam(teamId, (team) => {
					if (!Object.hasOwn(team.initials, memberId)) {
						team.initials[memberId] = staged ? { selection: staged.selection, source: staged.source } : { selection: null, source: 'default' }
					}
					return team
				})
			}
		}

		// 4. 异步预先规划 Level 4 auto 路由（如果启用策略且未被规划过，使用真实 catalogRoutes）
		if (state.policy && state.policy.members.length > 0 && !state.autoPlans.has(memberId)) {
			const channel = isTeammate ? 'spawn' : (header?.channel ?? 'spawn')
			const context = {
				channel,
				continuable: true,
				label: '',
				member: isTeammate ? (membership?.name ?? '') : '',
				cwd: header?.cwd,
				tokens: undefined,
				effort: undefined,
				images: false,
				intent: null,
			}
			const catalog = await catalogRoutes(ctx, state)
			const decision = planRoute(state.policy, context, {
				catalog,
				cursor: state.cursor,
				resting: restingSet(state),
				sunk: state.sink,
			})
			if (decision !== null && decision.route) {
				const autoChild = {
					candidates: decision.candidates,
					member: decision.member,
					index: 0,
					attempts: 0,
					pending: undefined,
					parentSessionId: isTeammate ? (membership.root ? sessionIdOf(membership.root) : membership.id) : parentId,
					source: { reason: 'auto', rule: ruleTagOf(state.policy, decision) },
				}
				state.autoPlans.set(memberId, autoChild)
				if (!state.children.has(memberId)) {
					state.children.set(memberId, autoChild)
				}
			}
		}

		// 5. 计算初始 turn（冷恢复到 turn 10 时为 11，避免硬编码 1 导致过期 held 生效）
		const initialTurn = Math.max(1, lastOwnTurn(agent) + 1)
		// Cold activations are not yet published at agent/created: do not bind or
		// mark a turn from an unauthenticated historical parent header.
		if (membership) {
			state.lastRoutedTurns.set(memberId, 0)
			syncSelectTeamRoute(ctx, state, agent, initialTurn)
		}
	})
	registered.push('agent/created')

	return registered
}

function installFailover(ctx, state) {
	const registered = []
	if (typeof ctx.on !== 'function') return registered

	// Activation is now published: rootOf can safely bind the exact live child,
	// including cold resumes. This synchronous listener must not await storage.
	ctx.on('subagent/start', (info) => {
		if (!info?.local || typeof info.id !== 'string') return
		const agents = ctx.get ? ctx.get('agents') : ctx.agents
		const agent = agents?.get(info.id)
		if (!agent || !isChildAgent(agent) || !getTeamMembership(ctx, agent, state)) return
		syncSelectTeamRoute(ctx, state, agent, Math.max(1, lastOwnTurn(agent) + 1))
	})
	registered.push('subagent/start')

	// 监听 agent/inbox/claimed：在 preStep 的 inbox.claim 期间同步选模，早于 L671 采样
	ctx.on('agent/inbox/claimed', (payload) => {
		const agent = payload?.agent
		if (!agent || !isChildAgent(agent)) return
		const childId = sessionIdOf(agent)
		if (!childId) return
		const turn = payload.turn ?? turnOf(agent)
		// 单轮幂等守卫：使用 state.lastRoutedTurns，避免污染宿主 agent
		if (state.lastRoutedTurns.get(childId) === turn) return
		state.lastRoutedTurns.set(childId, turn)

		syncSelectTeamRoute(ctx, state, agent, turn)
	})
	registered.push('agent/inbox/claimed')

	ctx.on('agent/request', async (payload, next) => {
		const config = await next()
		if (!isChildAgent(payload.agent)) return config
		const childId = sessionIdOf(payload.agent)

		// 准备阶段已经锁定模型；请求阶段只按实际配置记账，禁止重新解析或替换模型。
		const child = claimChild(state, payload.agent, config)
		const actualRoute = { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
		if (child === null) {
			attributeChild(state.usage, childId, memberKey(actualRoute), undefined, { reason: 'unmanaged' })
			return config
		}
		child.preparedRoute = actualRoute
		if (state.policy.failover?.enabled === true) child.pending = memberKey(actualRoute)
		attributeChild(state.usage, childId, memberKey(actualRoute), child.member, child.source)
		return config
	})
	registered.push('agent/request')

	ctx.on('agent/request-error', async (payload, next) => {
		if (!isChildAgent(payload.agent)) return await next()
		const child = state.children.get(sessionIdOf(payload.agent))
		if (child === undefined) return await next()
		if (child.isManualFixed === true) return await next()
		if (state.policy.failover?.enabled !== true) return await next()
		const failed = child.candidates[child.index]
		// 官方同一步重试仍使用旧模型，不能把尚未运行的下一候选当成失败。
		if (failed && child.preparedRoute && !sameModelSelection(failed, child.preparedRoute)) return await next()
		if (!isRetryableFailure(payload.failure)) {
			child.pending = undefined
			pushTrace(state, {
				kind: 'failover',
				outcome: 'gave-up',
				reason: 'not-retryable',
				route: failed === undefined ? undefined : memberKey(failed),
				status: payload.failure?.status,
				code: payload.failure?.code,
				message: payload.failure?.message,
			})
			return await next()
		}
		const patience = state.policy.failover?.patience ?? 2
		const nextIndex = child.index + 1
		if (child.attempts >= patience || nextIndex >= child.candidates.length) {
			child.pending = undefined
			pushTrace(state, {
				kind: 'failover',
				outcome: 'gave-up',
				reason: child.attempts >= patience ? 'patience-exhausted' : 'no-more-candidates',
				route: failed === undefined ? undefined : memberKey(failed),
				status: payload.failure?.status,
				code: payload.failure?.code,
			})
			return await next()
		}
		if (failed !== undefined) {
			const key = memberKey(failed)
			const previous = state.rests.get(key)
			const failures = (previous === undefined ? 0 : previous.failures) + 1
			state.rests.set(key, { until: Date.now() + restDelayMs(payload.failure, failures), failures })
			if (shouldSink(payload.failure)) state.sink.add(key)
		}
		child.index = nextIndex
		child.attempts += 1
		child.pending = undefined
		pushTrace(state, {
			kind: 'failover',
			outcome: 'deferred',
			from: failed === undefined ? undefined : memberKey(failed),
			to: memberKey(child.candidates[nextIndex]),
			status: payload.failure?.status,
			code: payload.failure?.code,
			attempt: child.attempts,
		})
		// 当次错误放行交官方循环处理，不伪造 { kind: 'retry' }；推进后的候选将在下一轮入口正式生效
		return await next()
	})
	registered.push('agent/request-error')
	return registered
}

// ---------------------------------------------------------------------------
// 工具 / 接口 / 装配
// ---------------------------------------------------------------------------

/**
 * 把随包分发的技能注册进 `ctx.skills`，让会话里的 Agent 能发现「怎么用 AI 配置路由」。
 *
 * 三条设计取舍：
 *   1. 用 `ctx.inject(['skills'], …)` 做**可选依赖**——技能服务缺席时插件照常工作，不写进 inject 数组；
 *   2. 技能内容从 `skills/model-routing/SKILL.md` 读，不在代码里复制一遍（一处维护）；
 *   3. 读不到文件就当没有技能（返回 undefined），绝不因此让插件启动失败。
 *
 * @param {object} ctx - 宿主上下文。
 * @returns {Promise<string | undefined>} 已注册的技能名；没装成返回 undefined。
 */
async function installSkill(ctx) {
	if (typeof ctx.inject !== 'function') return undefined
	const skill = await loadSkillFile(SKILL_URL)
	if (skill === undefined) return undefined
	ctx.inject(['skills'], (skillsCtx) => {
		const skills = skillsCtx.skills
		if (skills === undefined || skills === null || typeof skills.register !== 'function') return
		const dispose = skills.register({
			name: skill.name,
			description: skill.description,
			...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
			// 运行时技能必须带 source：dsh-agent-skills 适配层会校验它是字符串，
			// 缺失时整个会话启动报 "non-string source" 并中断。
			source: 'team-member-model',
			content: skill.content,
		})
		if (typeof dispose === 'function') skillsCtx.effect(() => () => dispose(), 'team-member-model: skill')
	})
	return skill.name
}

/**
 * 安装面向模型的创建工具。
 *
 * 省略 provider/model 时使用现有创建路由策略；提供完整路由时显式优先于规则。
 * 成员表非空时，它同时约束可显式指定的模型。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @param {{ routes: () => Array<object>, freshProvider: string, forkProvider: string }} policy - 成员表与 subagent provider 取值。
 * @returns {void}
 */
function installTool(ctx, state, policy) {
	const dispose = ctx.tools.register({
		name: TOOL_NAME,
		description:
			'Create one named, durable subagent in an enabled Team. Only the live Team root may call this tool. ' +
			'An explicit LLM route takes effect before the first step. The returned target is an addressable name or path for send_message.',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Unique lower-kebab-case teammate name.' },
				description: { type: 'string', description: 'Short description of the delegated responsibility.' },
				prompt: { type: 'string', description: 'Complete initial task for the teammate.' },
				context: {
					type: 'string',
					enum: ['fresh', 'fork'],
					description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
				},
				provider: {
					type: 'string',
					description: 'LLM provider id. Supply with model, or omit both to use existing creation routing policy. When member bindings are configured, choose one of them.',
				},
				model: {
					type: 'string',
					description: 'Model id interpreted by `provider`. Supply together with `provider`.',
				},
				reasoning_effort: {
					type: 'string',
					description: 'Adapter-owned reasoning effort; requires explicit provider and model. Omit to use the selected model\'s default.',
				},
			},
			required: ['name', 'description', 'prompt'],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				description: 'The created member row: addressable target, status, and the route it actually runs on.',
				properties: {
					target: { type: 'string', description: 'Addressable member target (its name).' },
					role: { type: 'string', enum: ['teammate'] },
					status: { type: 'string', description: 'Availability right after creation.' },
					description: { type: 'string' },
					provider: { type: 'string', description: 'Subagent provider that runs this member (spawn/fork).' },
					context: { type: 'string', enum: ['fresh', 'fork'] },
					model: { type: 'string', description: 'LLM model the member runs on.' },
					llmProvider: { type: 'string', description: 'LLM provider the member runs on.' },
					diagnostics: { type: 'array', items: { type: 'string' } },
				},
				required: ['target', 'role', 'status'],
				additionalProperties: false,
			},
			render: (_args, value) => {
				const member = value === null || typeof value !== 'object' ? {} : value
				const route = member.llmProvider === undefined ? '' : `，路由 ${member.llmProvider}/${member.model}`
				const notes = Array.isArray(member.diagnostics) && member.diagnostics.length > 0 ? `；注意：${member.diagnostics.join('；')}` : ''
				return [{ type: 'text', text: `成员已创建：${String(member.target)}（context=${String(member.context)}${route}）${notes}` }]
			},
		},
		async execute(args, exec) {
			const agent = exec === undefined || exec === null ? undefined : exec.agent
			if (agent === undefined || agent === null) throw new Error('工具执行上下文里拿不到发起 Agent，无法创建成员')

			// 工具框架理论上总传对象，这里仍归一化一次：任何参数读法抛 TypeError 都会让模型看到
			// 一段无意义的堆栈，而不是「哪个参数不对」。
			const input = args === null || args === undefined ? {} : args
			const memberName = shortText(input.name, MEMBER_NAME_LIMIT)
			if (memberName === undefined || !MEMBER_NAME.test(memberName) || memberName === 'lead') {
				throw new Error('name 必须是 lower-kebab-case、≤64 字符且不得为 "lead"')
			}
			const description = shortText(input.description)
			if (description === undefined) throw new Error('description 必须是非空字符串（≤200 字符）')
			const prompt = typeof input.prompt === 'string' ? input.prompt : ''
			if (prompt.trim() === '') throw new Error('prompt 必须是非空字符串')
			const context = input.context === 'fork' ? 'fork' : 'fresh'

			const hasProvider = input.provider !== undefined && input.provider !== null
			const hasModel = input.model !== undefined && input.model !== null
			if (hasProvider !== hasModel) throw new Error('provider 与 model 必须成对给出（只给一个会被拒绝，以免成员建出来却没有正确路由）')
			if (input.reasoning_effort !== undefined && !hasProvider) throw new Error('reasoning_effort 必须同时指定 provider 与 model')

			let route
			const diagnostics = []
			if (hasProvider) {
				const normalized = normalizeRoute({ provider: input.provider, model: input.model, reasoningEffort: input.reasoning_effort })
				if (normalized.route === undefined) throw new Error(`路由参数非法：${normalized.error}`)
				route = normalized.route
				const allowed = policy.routes()
				const allowedRoutes = allowed.flatMap((member) => member.bindings ?? [])
				if (allowedRoutes.length > 0 && !allowedRoutes.some((entry) => entry.provider === route.provider && entry.model === route.model)) {
					const list = allowedRoutes.map(memberKey).join('、')
					throw new Error(`路由 "${memberKey(route)}" 不在任何成员的绑定内。可用：${list}`)
				}
				const registered = providerRegistered(ctx, route.provider)
				if (registered === false) {
					const llm = ctx.get('llm')
					const available = typeof llm?.listProviders === 'function' ? llm.listProviders().map((provider) => provider.id).join('、') : ''
					throw new Error(`LLM provider "${route.provider}" 未注册。可用：${available}`)
				}
				if (registered === undefined) diagnostics.push('LLM 服务不可用，未校验 provider 是否已注册')
			}

			const agentTeams = ctx.get('agentTeams')
			const subagents = ctx.get('subagents')
			if (!agentTeams || typeof agentTeams.isEnabled !== 'function' || !subagents || typeof subagents.rootOf !== 'function' || typeof subagents.startActivation !== 'function') {
				throw new Error('Agent Teams 或 Subagent 服务未挂载，无法创建成员')
			}
			const root = subagents.rootOf(agent)
			if (root !== agent || !agentTeams.isEnabled(root)) throw new Error('只有启用团队模式的 Lead 可以创建成员')
			const created = await subagents.startActivation({
				name: memberName,
				label: description,
				prompt: [{ type: 'text', text: prompt }],
				parent: agent,
				provider: context === 'fork' ? policy.forkProvider : policy.freshProvider,
				delivery: 'parent',
				signal: exec.signal,
				...(route === undefined ? {} : { agentOptions: routeToAgentOptions(route) }),
			})
			return {
				target: String(created.name ?? memberName), role: 'teammate', status: 'active', description,
				context, ...(route === undefined ? {} : { model: route.model, llmProvider: route.provider }), diagnostics,
			}
		},
	})
	ctx.effect(() => () => {
		dispose()
	}, 'team-member-model: tool')
}

/**
 * 安装设置页读写接口。
 *
 * GET  /api/dsh-team-member-model/state    -> { ok, policy, catalog, trace, rests, sink }
 * GET  /api/dsh-team-member-model/efforts  -> { ok, provider, model, efforts, defaultEffort, supported }
 * GET  /api/dsh-team-member-model/usage    -> { ok, startedAt, totals, members, rules, sources, hours }
 * PUT  /api/dsh-team-member-model/usage/reset -> 清零（只统计子 agent）
 * PUT  /api/dsh-team-member-model/policy   -> { ok, policy }
 * PUT  /api/dsh-team-member-model/routes   -> { ok, policy }（0.2.1 兼容：只写成员表）
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @returns {void}
 */

/** 鉴权解析合法 Lead */
async function resolveAuthorizedLead(ctx, sessionId) {
	try {
		const sessionController = ctx.get ? ctx.get('sessionController') : ctx.sessionController
		let agent
		if (sessionController && typeof sessionController.resolveAgent === 'function') {
			const res = await sessionController.resolveAgent(sessionId)
			if (res && res.error) {
				return { error: res.error.message ?? '未授权访问该会话', status: res.error.status ?? 403 }
			}
			if (res && res.agent) agent = res.agent
		} else {
			return { error: 'sessionController 服务不可用', status: 503 }
		}
		if (!agent) return { error: '未找到会话对应的 Agent', status: 404 }

		const agentTeams = ctx.get ? ctx.get('agentTeams') : ctx.agentTeams
		const subagents = ctx.get ? ctx.get('subagents') : ctx.subagents
		if (!agentTeams || typeof agentTeams.isEnabled !== 'function' || !subagents || typeof subagents.rootOf !== 'function' || typeof subagents.listDescendants !== 'function') {
			return { error: '团队服务不可用', status: 503 }
		}
		let root
		try { root = subagents.rootOf(agent) } catch { return { error: '团队身份无法验证', status: 403 } }
		if (root !== agent || agent.id !== sessionId || !agentTeams.isEnabled(agent)) {
			return { error: '只有启用团队模式的有效 Team Lead 可以访问团队设置', status: 403 }
		}
		return { leadAgent: agent, teamId: agent.id }
	} catch (e) {
		return { error: String(e.message ?? e), status: 500 }
	}
}

/** 校验 selection 是否合法（在目录中） */
async function validateSelection(ctx, selection) {
	if (!selection || typeof selection !== 'object') return 'selection 格式非法'
	if (typeof selection.provider !== 'string' || !selection.provider) return '缺少 provider'
	if (typeof selection.model !== 'string' || !selection.model) return '缺少 model'
	const llm = ctx.get ? ctx.get('llm') : ctx.llm
	if (llm && typeof llm.listProviders === 'function') {
		const providers = llm.listProviders() || []
		if (!providers.some(p => p.id === selection.provider)) {
			return `选中的 provider ${selection.provider} 不在可用目录中`
		}
		if (typeof llm.listModels === 'function') {
			try {
				const models = await llm.listModels(selection.provider) || []
				if (!models.some(m => m.id === selection.model)) {
					return `选中的 model ${selection.model} 不在可用目录中`
				}
			} catch {}
		}
	}
	if (selection.reasoningEffort !== undefined) {
		if (typeof selection.reasoningEffort !== 'string' || !selection.reasoningEffort) return '推理档位无效'
		if (!llm || typeof llm.resolveModelInfo !== 'function') return '模型推理档目录不可用'
		try {
			const info = await llm.resolveModelInfo(selection.provider, selection.model)
			if (!info?.reasoning?.efforts?.some(item => item.id === selection.reasoningEffort)) return '选中的推理档位不可用'
		} catch { return '模型推理档目录不可用' }
	}
	return null
}

async function listTeamMembers(ctx, teamId) {
	const subagents = ctx.get ? ctx.get('subagents') : ctx.subagents
	if (!subagents || typeof subagents.listDescendants !== 'function') throw Object.assign(new Error('团队名单不可用'), { statusCode: 503 })
	const entries = await subagents.listDescendants(teamId)
	if (!Array.isArray(entries) || entries.some(row => row.kind === 'diagnostic')) throw Object.assign(new Error('团队名单不完整'), { statusCode: 503 })
	return entries.filter(row => row.kind === 'child' && row.mode === 'continuable').map(row => ({
		id: row.id, name: row.path ?? row.name ?? row.id, description: row.label,
		role: 'teammate', status: row.activity,
	}))
}

/** 构造团队视图结构 */
async function buildTeamView(ctx, state, leadAgent, teamId) {
	const teamRecord = state.teamStore ? state.teamStore.getTeam(teamId) : createEmptyTeam(teamId)
	const agents = ctx.get ? ctx.get('agents') : ctx.agents

	const rawMembers = await listTeamMembers(ctx, teamId)
	const subagents = ctx.get ? ctx.get('subagents') : ctx.subagents
	const members = rawMembers.map(m => {
		const memberAgent = agents && typeof agents.get === 'function' ? agents.get(m.id) : undefined
		let available = false
		try { available = !!memberAgent && subagents.rootOf(memberAgent) === leadAgent } catch {}
		// 当前真实请求模型 (currentModel)
		let currentModel = undefined
		if (available && typeof memberAgent.session?.requestHeader === 'function') {
			try {
				const header = memberAgent.session.requestHeader()
				if (header && header.config) {
					currentModel = {
						provider: header.config.provider,
						model: header.config.model,
						...(header.config.reasoningEffort ? { reasoningEffort: header.config.reasoningEffort } : {})
					}
				}
			} catch {}
		}
		// 下一轮生效的模型 (nextModel)
		const choice = teamRecord.choices[m.id]
		const initial = teamRecord.initials[m.id]
		let nextModel = undefined
		if (choice !== undefined && choice.selection !== undefined) {
			nextModel = (choice.selection && typeof choice.selection === 'object' && choice.selection.provider) ? choice.selection : undefined
		} else if (initial !== undefined) {
			const initSel = initial.selection !== undefined ? initial.selection : initial
			nextModel = (initSel && typeof initSel === 'object' && initSel.provider) ? initSel : undefined
		}

		return {
			id: m.id,
			name: m.name,
			description: m.description,
			phase: available ? 'active' : 'unavailable',
			status: m.status === 'running' ? 'running' : 'inactive',
			...(currentModel ? { currentModel } : {}),
			...(nextModel ? { nextModel } : {}),
		}
	})

	return {
		teamId,
		revision: teamRecord.revision,
		defaultModel: teamRecord.defaultModel,
		members,
	}
}

/**
 * 统一的业务派发：HTTP 设置页与官方 RPC 通道共用同一套动作、校验与响应体。
 *
 * 两个载体只在传输层不同（HTTP 头/体、RPC peer/signal），业务这里只认 `{ method, path, query, body }`，
 * 因此不会出现「HTTP 校验一套、RPC 放宽一套」的双实现。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} state - 插件状态。
 * @param {{ method: string, path: string, query?: URLSearchParams | object, body?: any, signal?: AbortSignal }} request
 * @returns {Promise<{ status: number, body: object }>} 与 HTTP 响应完全一致的 status + JSON body。
 */
async function executeApi(ctx, state, request) {
	const { method, path, body } = request
	try {
		if (method === 'GET' && path === `${API_BASE}/state`) {
			return {
				status: 200,
				body: {
					ok: true,
					policy: state.policy,
					catalog: await collectCatalog(ctx),
					trace: state.trace.slice().reverse(),
					rests: [...state.rests.entries()].map(([routeKey, entry]) => ({ route: routeKey, until: entry.until, failures: entry.failures })),
					sink: [...state.sink],
					children: state.children.size,
					status: await readStatus(),
				},
			}
		}
		if (method === 'GET' && path === `${API_BASE}/usage`) {
			return { status: 200, body: { ok: true, ...usageReport(state.usage) } }
		}
		if (method === 'GET' && path === `${API_BASE}/efforts`) {
			// 设置页的推理档下拉用：只解析被问到的这一个模型（懒加载，不给整页加载添堵）。
			const provider = shortText(queryValue(request.query, 'provider'))
			const model = shortText(queryValue(request.query, 'model'))
			if (provider === undefined || model === undefined) {
				return { status: 400, body: { ok: false, error: '需要 provider 与 model 两个查询参数' } }
			}
			return { status: 200, body: { ok: true, provider, model, ...(await resolveEfforts(ctx, state, provider, model)) } }
		}

		// -------------------------------------------------------------
		// 团队模型管理端点 GET / PUT /api/dsh-team-member-model/teams
		// -------------------------------------------------------------
		if (path === `${API_BASE}/teams`) {
			if (method === 'GET') {
				const sessionId = shortText(queryValue(request.query, 'sessionId'))
				if (!sessionId) {
					return { status: 400, body: { ok: false, error: '缺少 sessionId 查询参数' } }
				}
				const resolved = await resolveAuthorizedLead(ctx, sessionId)
				if (resolved.error) {
					return { status: resolved.status ?? 403, body: { ok: false, error: resolved.error } }
				}
				const { leadAgent, teamId } = resolved
				const view = await buildTeamView(ctx, state, leadAgent, teamId)
				return { status: 200, body: { ok: true, view } }
			}

			if (method === 'PUT') {
				const { sessionId, target, selection, revision } = body ?? {}
				if (!sessionId || typeof revision !== 'number') {
					return { status: 400, body: { ok: false, error: '缺少 sessionId 或 revision 字段' } }
				}
				const resolved = await resolveAuthorizedLead(ctx, sessionId)
				if (resolved.error) {
					return { status: resolved.status ?? 403, body: { ok: false, error: resolved.error } }
				}
				const { leadAgent, teamId } = resolved

				// 校验 selection
				if (selection !== null && selection !== undefined) {
					const validErr = await validateSelection(ctx, selection)
					if (validErr) {
						return { status: 400, body: { ok: false, error: validErr } }
					}
				}

				// 乐观锁校验
				const currentTeam = state.teamStore.getTeam(teamId)
				if (currentTeam.revision !== revision) {
					return { status: 409, body: { ok: false, code: 'stale-revision', error: '并发修改冲突：版本已滞后，请重新读取' } }
				}

				// target 为 null: 修改团队未来默认 / 恢复继承
				if (target === null || target === undefined) {
					await state.teamStore.updateTeam(teamId, async (team) => {
						const live = await resolveAuthorizedLead(ctx, sessionId)
						if (live.error || live.leadAgent !== leadAgent) throw Object.assign(new Error('团队身份已失效'), { statusCode: 403 })
						if (team.revision !== revision) throw Object.assign(new Error('并发修改冲突'), { statusCode: 409, code: 'stale-revision' })
						team.defaultModel = selection ?? null
						return team
					})
					const view = await buildTeamView(ctx, state, leadAgent, teamId)
					return { status: 200, body: { ok: true, view } }
				}

				// target 为成员 ID
				if (typeof target !== 'string' || target.length === 0) {
					return { status: 400, body: { ok: false, error: 'target 必须为成员 ID 或 null' } }
				}
				if (target === leadAgent.id || target === 'lead') {
					return { status: 400, body: { ok: false, error: 'Lead 不可作为队员修改模型' } }
				}

				// 校验成员是否存在
				const members = await listTeamMembers(ctx, teamId)
				// 严格禁止使用 name 代替 immutable memberId
				if (members.some(m => m.name === target && m.id !== target)) {
					return { status: 400, body: { ok: false, error: 'target 必须为成员的不可变 ID，禁止使用成员 name' } }
				}
				const member = members.find(m => m.id === target && m.role === 'teammate')
				if (!member) {
					return { status: 404, body: { ok: false, error: '目标队员不存在或不是活跃队员' } }
				}

				// 找到成员 agent
				const agents = ctx.get ? ctx.get('agents') : ctx.agents
				let memberAgent = agents && typeof agents.get === 'function' ? agents.get(target) : undefined
				if (!memberAgent && member.agent) memberAgent = member.agent

				await state.teamStore.updateTeam(teamId, async (team) => {
					const live = await resolveAuthorizedLead(ctx, sessionId)
					if (live.error || live.leadAgent !== leadAgent) throw Object.assign(new Error('团队身份已失效'), { statusCode: 403 })
					if (team.revision !== revision) throw Object.assign(new Error('并发修改冲突'), { statusCode: 409, code: 'stale-revision' })
					const currentMembers = await listTeamMembers(ctx, teamId)
					const current = currentMembers.find(row => row.id === target)
					const subagents = ctx.get ? ctx.get('subagents') : ctx.subagents
					const liveMember = agents?.get(target)
					if (!current || !liveMember || subagents.rootOf(liveMember) !== leadAgent) throw Object.assign(new Error('目标队员不在有效团队中'), { statusCode: 403 })
					const oldChoice = team.choices[target]
					// 当轮保护：如果此前已有生效的 choice，将其暂存到 heldSelection 维持当轮
					const priorSelection = (oldChoice && oldChoice.selection) ? oldChoice.selection : null
					team.choices[target] = {
						selection: selection ?? null,
						heldSelection: priorSelection,
						effectiveAfterTurn: lastOwnTurn(liveMember),
					}
					return team
				})

				const view = await buildTeamView(ctx, state, leadAgent, teamId)
				return { status: 200, body: { ok: true, view } }
			}
		}

		if (method !== 'PUT') {
			return { status: 405, body: { ok: false, error: `method not allowed: ${method}` } }
		}
		if (path === `${API_BASE}/policy`) {
			const normalized = normalizePolicy(body)
			if (normalized.errors.length > 0) {
				return { status: 400, body: { ok: false, error: normalized.errors.join('；') } }
			}
			await writePolicyFile(normalized.policy)
			state.policy = normalized.policy
			return { status: 200, body: { ok: true, policy: state.policy } }
		}
		if (path === `${API_BASE}/usage/reset`) {
			const fresh = emptyUsage()
			fresh.children = {}
			state.usage = fresh
			await writeUsageFile(state)
			return { status: 200, body: { ok: true, ...usageReport(state.usage) } }
		}
		if (path === `${API_BASE}/routes`) {
			// 0.2.1 兼容：老客户端（或被缓存的旧页面）只会写 routes。
			const members = normalizeMembers(body.routes)
			if (members.errors.length > 0) {
				return { status: 400, body: { ok: false, error: members.errors.join('；') } }
			}
			state.policy = { ...state.policy, members: members.members }
			await writePolicyFile(state.policy)
			return { status: 200, body: { ok: true, policy: state.policy, routes: state.policy.members } }
		}
		return { status: 404, body: { ok: false, error: `unknown action: ${path}` } }
	} catch (error) {
		const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500
		return { status: statusCode, body: { ok: false, ...(error?.code === 'stale-revision' ? { code: error.code } : {}), error: error instanceof Error ? error.message : String(error) } }
	}
}

/** 同时支持 URLSearchParams（HTTP）与普通对象（RPC 已校验 payload）的查询取值。 */
function queryValue(query, name) {
	if (query === null || query === undefined) return undefined
	if (typeof query.get === 'function') return query.get(name)
	const value = query[name]
	return Array.isArray(value) ? value[0] : value
}

/**
 * RPC 独立 namespace：**不能**与 HTTP prefix `/api/dsh-team-member-model` 重叠。
 * 官方 webServer 是「最长 prefix 优先」（dsh-host-webserver/lib/index.js:495-504），
 * 一旦 RPC endpoint 写成 `dsh-team-member-model/*`，它的 URL `/api/dsh-team-member-model/*`
 * 会先命中本插件自己注册的 HTTP prefix，POST 被 executeApi 判成 405，
 * 官方 /api shared carrier 永远轮不到 —— 0.7.6 的线上 405 就是这么来的。
 */
const RPC_NAMESPACE = 'team-member-model/'

/**
 * RPC 走**自己的**官方 channel，不去挤 `/api`。
 *
 * 为什么：官方 Connection 的 `/api` 是**单槽 interceptor**（`interceptors` Map，
 * dsh-client-connection/lib/index.js:700/873-886，重复注册直接 throw），而官方
 * api-gateway 已经在 `ctx.inject(['connection'], …)` 里占了这一槽。0.7.6/0.7.7 的
 * `rpc.intercept('/api', …)` 因此必然抛 "already has an interceptor"，被旧代码 warn 吞掉，
 * 于是 `/api` carrier 对我们的 endpoint 只回 404。
 *
 * 第三方业务应使用自己的 channel + 官方 `connection.admit()` 做鉴权，并自己在 webServer 上
 * 挂 `prefix:<channel>` 路由（官方 `rpc.handle` 在 0.2.1-rc.2 实测不可用：其 register() 的
 * `owner` 经 ctx shadow 落到 connection 自己的 fiber，缺 webServer inject，必抛
 * `cannot get property "webServer" without inject`）。独立 channel 与 gateway 的单槽互不争抢。
 */
const RPC_CHANNEL = '/dsh-team-member-model'

/**
 * 官方连接 RPC 暴露的精确端点：只有这 7 个名字会命中本插件，别的 endpoint 一律不 match。
 * 方法/路径对应原 HTTP 动作，业务细节全部交给 executeApi。
 */
const RPC_ENDPOINTS = new Map([
	[`${RPC_NAMESPACE}state`, { method: 'GET', path: `${API_BASE}/state` }],
	[`${RPC_NAMESPACE}efforts`, { method: 'GET', path: `${API_BASE}/efforts` }],
	[`${RPC_NAMESPACE}usage`, { method: 'GET', path: `${API_BASE}/usage` }],
	[`${RPC_NAMESPACE}teams`, { method: 'GET', path: `${API_BASE}/teams` }],
	[`${RPC_NAMESPACE}savePolicy`, { method: 'PUT', path: `${API_BASE}/policy` }],
	[`${RPC_NAMESPACE}saveTeam`, { method: 'PUT', path: `${API_BASE}/teams` }],
	[`${RPC_NAMESPACE}resetUsage`, { method: 'PUT', path: `${API_BASE}/usage/reset` }],
])

/** RPC 单字段上限与 HTTP 查询参数完全一致（FIELD_LIMIT，走 shortText 同规则）。 */
function rpcText(value) {
	return typeof value === 'string' && value.trim() !== '' && value.trim().length <= FIELD_LIMIT ? value : undefined
}

/** payload 里出现契约外字段即拒绝：不给「顺手多塞一个会被忽略的开关」留缝。 */
function unexpectedKey(payload, allowed) {
	for (const key of Object.keys(payload)) if (!allowed.includes(key)) return key
	return undefined
}

/** selection 只接受 provider/model/可选 reasoningEffort，放宽的部分仍由 validateSelection 复核目录。 */
function rpcSelection(value) {
	if (value === null) return null
	if (typeof value !== 'object' || Array.isArray(value)) return undefined
	const extra = unexpectedKey(value, ['provider', 'model', 'reasoningEffort'])
	if (extra !== undefined) return undefined
	const provider = rpcText(value.provider)
	const model = rpcText(value.model)
	if (provider === undefined || model === undefined) return undefined
	if (value.reasoningEffort !== undefined && rpcText(value.reasoningEffort) === undefined) return undefined
	return value.reasoningEffort === undefined
		? { provider, model }
		: { provider, model, reasoningEffort: value.reasoningEffort }
}

/**
 * 严格校验一个 RPC payload，并翻译成 executeApi 的请求形状。
 *
 * @param {string} endpoint - 已 match 白名单的 endpoint。
 * @param {unknown} payload - 客户端传入的 payload（不可信）。
 * @returns {{ request?: object, status?: number, error?: string }}
 */
function normalizeRpcRequest(endpoint, payload) {
	const op = RPC_ENDPOINTS.get(endpoint)
	if (op === undefined) return { status: 404, error: `unknown endpoint: ${endpoint}` }
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		return { status: 400, error: 'payload 必须是对象' }
	}
	let size
	try {
		size = JSON.stringify(payload).length
	} catch {
		return { status: 400, error: 'payload 不是可序列化的 JSON' }
	}
	if (size > BODY_LIMIT) return { status: 413, error: '请求体过大' }

	const empty = { method: op.method, path: op.path, query: {} }
	if (endpoint === `${RPC_NAMESPACE}state` || endpoint === `${RPC_NAMESPACE}usage` || endpoint === `${RPC_NAMESPACE}resetUsage`) {
		const extra = unexpectedKey(payload, [])
		return extra === undefined ? { request: empty } : { status: 400, error: `payload 不接受字段 ${extra}` }
	}
	if (endpoint === `${RPC_NAMESPACE}efforts`) {
		const extra = unexpectedKey(payload, ['provider', 'model'])
		if (extra !== undefined) return { status: 400, error: `payload 不接受字段 ${extra}` }
		const provider = rpcText(payload.provider)
		const model = rpcText(payload.model)
		if (provider === undefined || model === undefined) return { status: 400, error: '需要 provider 与 model 两个查询参数' }
		return { request: { method: op.method, path: op.path, query: { provider, model } } }
	}
	if (endpoint === `${RPC_NAMESPACE}teams`) {
		const extra = unexpectedKey(payload, ['sessionId'])
		if (extra !== undefined) return { status: 400, error: `payload 不接受字段 ${extra}` }
		const sessionId = rpcText(payload.sessionId)
		if (sessionId === undefined) return { status: 400, error: '缺少 sessionId 查询参数' }
		return { request: { method: op.method, path: op.path, query: { sessionId } } }
	}
	if (endpoint === `${RPC_NAMESPACE}savePolicy`) {
		const extra = unexpectedKey(payload, ['policy'])
		if (extra !== undefined) return { status: 400, error: `payload 不接受字段 ${extra}` }
		const policy = payload.policy
		if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
			return { status: 400, error: 'policy 必须是对象' }
		}
		return { request: { method: op.method, path: op.path, body: policy } }
	}
	// saveTeam：字段与 HTTP PUT /teams 的 JSON 体一一对应（含 target=null 的未来默认）。
	const extra = unexpectedKey(payload, ['sessionId', 'target', 'selection', 'revision'])
	if (extra !== undefined) return { status: 400, error: `payload 不接受字段 ${extra}` }
	for (const key of ['sessionId', 'target', 'selection', 'revision']) {
		if (!Object.hasOwn(payload, key)) return { status: 400, error: 'saveTeam payload 需要 sessionId/target/selection/revision 四个字段' }
	}
	const sessionId = rpcText(payload.sessionId)
	if (sessionId === undefined) return { status: 400, error: '缺少 sessionId 或 revision 字段' }
	if (typeof payload.revision !== 'number' || !Number.isFinite(payload.revision)) {
		return { status: 400, error: '缺少 sessionId 或 revision 字段' }
	}
	const target = payload.target === null ? null : rpcText(payload.target)
	if (target === undefined) return { status: 400, error: 'target 必须为成员 ID 或 null' }
	const selection = rpcSelection(payload.selection)
	if (selection === undefined) return { status: 400, error: 'selection 格式非法' }
	return {
		request: {
			method: op.method,
			path: op.path,
			body: { sessionId, target, selection, revision: payload.revision },
		},
	}
}

/**
 * RPC 处理器：peer 由官方传输层认证后传入，这里只接受 owner principal；
 * 业务错误仍以 `{ status, body }` 放在 outer ok 里（与 HTTP JSON 完全一致），
 * 只有传输/认证层面的拒绝才用官方 outer error。
 */
async function handleRpc(ctx, state, endpoint, payload, signal, peer) {
	if (peer === null || peer === undefined || peer.principal?.kind !== 'owner') {
		return { ok: false, error: { code: 'unauthorized', message: '远程连接未通过官方认证', details: { status: 403 } } }
	}
	if (signal !== undefined && signal !== null && signal.aborted === true) {
		return { ok: false, error: { code: 'aborted', message: '请求已取消', details: {} } }
	}
	const normalized = normalizeRpcRequest(endpoint, payload)
	if (normalized.error !== undefined) {
		return { ok: true, value: { status: normalized.status, body: { ok: false, error: normalized.error } } }
	}
	const result = await executeApi(ctx, state, { ...normalized.request, signal })
	return { ok: true, value: result }
}

/**
 * 独立 channel 的官方 RPC 外壳：不抢 `/api` 单槽 interceptor（网关占着），
 * 也**不使用** `rpc.handle()` —— 0.2.1-rc.2 的 `handle` 会在 `register()` 里
 * `owner.webServer.register(...)`，而 `owner` 经 traceable 的 ctx shadow 解析到
 * connection 服务自己的 fiber（只 inject 了 credentials），实测必抛
 * `cannot get property "webServer" without inject`（真实 SDK 复现见 test/rpc-lifecycle.mjs）。
 *
 * 这里改用官方公开能力自己挂 prefix 路由：
 *   - `connection.admit({ headers })`：官方 Host/Origin/凭据检查，返回真实 Peer（不伪造）；
 *   - 只接受 owner Peer、POST、application/json、官方 client-request envelope；
 *   - 成功后包装成官方 server-response envelope，客户端仍用标准 `rpc.call(channel, …)`。
 * 业务授权（CAS/role/session ownership/catalog）继续全部走 executeApi 同一份。
 */
const RPC_ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

/** channel 之后的 endpoint：段规则同 dsh-client-connection lib/index.js:926-931。 */
function rpcEndpointFromPath(pathname) {
	const prefix = `${RPC_CHANNEL}/`
	if (!pathname.startsWith(prefix)) return undefined
	const endpoint = pathname.slice(prefix.length)
	if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !RPC_ENDPOINT_SEGMENT.test(segment))) return undefined
	return endpoint
}

function sendPlain(res, statusCode, text) {
	res.statusCode = statusCode
	res.setHeader('content-type', 'text/plain; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(text)
}

function sendEnvelope(res, rpcId, result) {
	res.statusCode = 200
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

async function handleRpcHttp(ctx, state, connection, req, res) {
	const admission = connection.admit({ headers: req.headers })
	if (admission === null || admission === undefined || 'rejection' in admission) {
		const status = admission === null || admission === undefined ? 401 : admission.rejection
		sendPlain(res, status, status === 401 ? 'unauthorized' : 'forbidden')
		return
	}
	const peer = admission.peer
	if (peer?.principal?.kind !== 'owner') {
		sendPlain(res, 403, 'forbidden')
		return
	}
	const url = new URL(req.url, 'http://localhost')
	const endpoint = rpcEndpointFromPath(url.pathname)
	if (req.method !== 'POST' || endpoint === undefined) {
		sendPlain(res, 404, 'not found')
		return
	}
	if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
		sendPlain(res, 415, 'content type must be application/json')
		return
	}
	let envelope
	try {
		envelope = await readJsonBody(req)
	} catch (error) {
		const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400
		sendPlain(res, statusCode, error instanceof Error ? error.message : String(error))
		return
	}
	const valid = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope) &&
		envelope.type === 'client-request' && typeof envelope.rpcId === 'string' &&
		typeof envelope.method === 'string' && Object.hasOwn(envelope, 'payload')
	if (!valid) {
		sendPlain(res, 400, 'invalid client-request message')
		return
	}
	if (envelope.method !== endpoint) {
		sendEnvelope(res, envelope.rpcId, {
			ok: false,
			error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
		})
		return
	}
	const result = await handleRpc(ctx, state, endpoint, envelope.payload, peer?.signal, peer)
	sendEnvelope(res, envelope.rpcId, result)
}

/**
 * 注册独立 channel 的 RPC 路由。缺 connection/admit 时只关掉远程通道并说明原因：
 * HTTP 设置页照旧可用，绝不因为 SDK 少一个能力就让 apply 失败、整个会话挂掉。
 *
 * @returns {boolean} 是否真的注册上了。
 */
function installRpc(ctx, state, logger, resolved) {
	const connection = resolved ?? (ctx.get ? ctx.get('connection') : ctx.connection)
	if (connection === null || connection === undefined) return false
	const rpc = connection.rpc
	// 优先官方 handle（Lead/91 指定的公共入口）。0.2.1-rc.2 的实现在部分 fiber 下会抛
	// `cannot get property "webServer" without inject`（owner 经 ctx shadow 落到 connection
	// 自己的 fiber）；失败不算致命，退回「本插件路由 + connection.admit」同 channel 方案。
	if (rpc !== null && rpc !== undefined && typeof rpc.handle === 'function') {
		try {
			const dispose = rpc.handle(RPC_CHANNEL, (endpoint, payload, signal, peer) => handleRpc(ctx, state, endpoint, payload, signal, peer))
			ctx.effect(() => dispose, 'team-member-model: remote rpc channel (handle)')
			return true
		} catch (error) {
			logger.warn?.(`team-member-model: connection.rpc.handle 不可用（${error instanceof Error ? error.message : String(error)}），改用独立路由 + connection.admit`)
		}
	}
	if (typeof connection.admit !== 'function') return false
	let route
	try {
		route = ctx.webServer.register({
			kind: 'prefix',
			path: RPC_CHANNEL,
			handler: (req, res) => handleRpcHttp(ctx, state, connection, req, res).catch((error) => {
				logger.error?.(`team-member-model: RPC 请求处理失败（${error instanceof Error ? error.message : String(error)}）`)
				if (!res.headersSent) sendPlain(res, 500, 'internal error')
				else res.end()
			}),
		})
	} catch (error) {
		logger.error?.(`team-member-model: 远程 RPC 路由注册失败（${error instanceof Error ? error.message : String(error)}），远程模型设置保持关闭（HTTP 设置接口不受影响）`)
		return false
	}
	// 路由 disposer 交回 Cordis：connection 替换/插件热重载时先 await 注销，再注册新实例。
	ctx.effect(() => route, 'team-member-model: remote rpc channel (own route)')
	return true
}

/**
 * connection 是**可选**服务，不能放进插件顶层 inject：否则官方连接不可用时，
 * 连本插件的模型路由/用量/工具都会一起挂起。这里用 `ctx.inject(['connection', 'webServer'], …)`
 * 建一个只负责远程 RPC 的子 fiber：
 *   - 服务晚于本插件就绪（真实启动顺序 race）→ 子 fiber 等它到了再注册；
 *   - 服务被替换/插件热重载 → 子 fiber 重载，旧 disposer await 完成后在新实例上重注册。
 * 注册失败不再「warn 一次后静默 404」，而是写 Host error 日志（HTTP 设置页不受影响）。
 */
function installRpcWhenReady(ctx, state, logger) {
	if (typeof ctx.inject !== 'function') {
		if (installRpc(ctx, state, logger)) return
		logger.error?.('team-member-model: 官方连接 RPC 不可用，远程模型设置保持关闭（HTTP 设置接口不受影响）')
		return
	}
	ctx.inject(['connection', 'webServer'], (readyCtx) => {
		if (installRpc(readyCtx, state, logger)) return
		logger.error?.('team-member-model: 官方连接 RPC 不可用，远程模型设置保持关闭（HTTP 设置接口不受影响）')
	})
}

function installRoutes(ctx, state) {
	const route = ctx.webServer.register({
		kind: 'prefix',
		path: API_BASE,
		handler: async (req, res) => {
			try {
				const connection = ctx.get('connection')
				if (!connection || typeof connection.requestRejection !== 'function') {
					sendJson(res, 503, { ok: false, error: '连接鉴权服务不可用，请升级 DSH' })
					return
				}
				const rejection = connection.requestRejection({ headers: req.headers })
				if (rejection !== undefined) {
					sendJson(res, rejection, { ok: false, error: rejection === 401 ? '连接认证失败' : '连接访问被拒绝' })
					return
				}
				const url = new URL(req.url, 'http://localhost')
				const path = url.pathname.replace(/\/+$/, '')
				let body
				if (req.method === 'PUT') {
					// 写操作标记头是 HTTP 载体的 CSRF 防护；RPC 走官方 peer/凭据，不需要也不接受这个头。
					if (req.headers[MUTATION_HEADER] !== '1') {
						sendJson(res, 403, { ok: false, error: `写操作需要 ${MUTATION_HEADER}: 1 标记头` })
						return
					}
					body = await readJsonBody(req)
				}
				const result = await executeApi(ctx, state, { method: req.method, path, query: url.searchParams, body })
				sendJson(res, result.status, result.body)
			} catch (error) {
				const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500
				sendJson(res, statusCode, { ok: false, error: error instanceof Error ? error.message : String(error) })
			}
		},
	})
	ctx.effect(() => () => {
		if (typeof route === 'function') route()
		else if (route !== null && typeof route === 'object' && typeof route.dispose === 'function') route.dispose()
	}, 'team-member-model: settings routes')
}

/** 读回上次启动写下的 status.json（设置页展示「Host 半侧到底加载了没有」）。 */
async function readStatus() {
	try {
		return JSON.parse(await readFile(statusPath(), 'utf8'))
	} catch {
		return undefined
	}
}

/**
 * 安装插件。
 *
 * @param {object} ctx - 宿主上下文；tools/subagents/webServer 由 inject 保证已就绪。
 * @param {object} config - 组合行 config：`members`/`rules`/… 作为策略文件缺席时的种子，
 *   `allowedModels`（0.2.1 名字）亦兼容；`freshProvider`/`forkProvider` 与官方同名同默认。
 */
export async function apply(ctx, config) {
	const logger = ctx.logger === undefined ? console : ctx.logger
	const settings = config === null || config === undefined ? {} : config
	try {
		const seeded = normalizePolicySeed(settings)
		if (seeded.errors.length > 0) throw new Error(`组合行 config 非法：${seeded.errors.join('；')}`)
		const stored = await readPolicyFile()
		// 策略文件优先：设置页写过的值不能被组合行里的旧种子悄悄覆盖。
		const state = createState()
		state.policy = stored ?? seeded.policy
		if (stored === undefined && seeded.seeded) await writePolicyFile(state.policy)

		// 用量统计：先读回上次的累计（重启不清零），再装监听。
		state.usage = await readUsageFile()
		state.teamStore = new TeamStateStore(join(dshHome(), 'team-member-model'))
		await state.teamStore.init()
		const wrapper = installWrapper(ctx, state)
		const listeners = installFailover(ctx, state).concat(installUsage(ctx, state)).concat(installTeamLifecycle(ctx, state))
		const skill = await installSkill(ctx)
		ctx.effect(() => () => {
			if (state.usageTimer !== undefined) {
				clearTimeout(state.usageTimer)
				state.usageTimer = undefined
			}
			void writeUsageFile(state)
		}, 'team-member-model: usage flush')
		installTool(ctx, state, {
			routes: () => state.policy.members,
			freshProvider: shortText(settings.freshProvider) ?? 'spawn',
			forkProvider: shortText(settings.forkProvider) ?? 'fork',
		})
		installRoutes(ctx, state)
		// 官方远程连接 RPC：connection 可能晚于本插件就绪，交给子 fiber 等待/重装。
		installRpcWhenReady(ctx, state, logger)

		const summary = {
			members: state.policy.members.length,
			bindings: state.policy.members.reduce((sum, member) => sum + (member.bindings?.length ?? 0), 0),
			rules: state.policy.rules.length,
			routing: state.policy.routing,
			allowFork: state.policy.allowFork,
			failover: state.policy.failover,
			classifier: state.policy.classifier?.enabled === true,
		}
		logger.info(
			`team-member-model: 已启用（成员 ${summary.members} 条、规则 ${summary.rules} 条、排序 ${summary.routing}` +
				`、fork ${summary.allowFork ? '纳管' : '不纳管'}、回退 ${summary.failover?.enabled === true ? `${summary.failover.patience} 次` : '关闭'}`
				+ `、技能 ${skill === undefined ? '未注册' : skill}；策略 ${policyPath()}）`,
		)
		// 成功也留痕：这是唯一能区分「页面能开」与「工具/路由/监听器真的注册上了」的证据。
		await writeStatus({
			mode: 'ok',
			...summary,
			wrapped: wrapper.wrapped,
			listeners,
			skill,
			wrapper: 'service',
			seedFromConfig: stored === undefined && seeded.seeded,
			freshProvider: shortText(settings.freshProvider) ?? 'spawn',
			forkProvider: shortText(settings.forkProvider) ?? 'fork',
			policy: policyPath(),
		})
	} catch (error) {
		// 先留现场再原样抛出：保留 failed 状态，避免「插件显示正常但包装其实没生效」。
		await writeFailure(error)
		throw error
	}
}

/**
 * 组合行 config → 策略种子。
 *
 * 兼容 0.2.1 的 `allowedModels`（裸数组）与 0.3.0 的整套策略字段。
 *
 * @param {object} settings - 组合行 config。
 * @returns {{ policy: object, errors: string[], seeded: boolean }}
 */
export function normalizePolicySeed(settings) {
	const hasLegacy = settings.allowedModels !== undefined
	const hasV3 = ['members', 'rules', 'match', 'pick', 'off', 'routing', 'allowFork', 'failover', 'classifier'].some(
		(field) => settings[field] !== undefined,
	)
	if (!hasLegacy && !hasV3) return { policy: emptyPolicy(), errors: [], seeded: false }
	const source = hasLegacy && !hasV3 ? settings.allowedModels : settings
	const normalized = normalizePolicy(source)
	return { policy: normalized.policy, errors: normalized.errors, seeded: normalized.errors.length === 0 }
}

// 纯函数再导出：0.2.1 的调用方（与测试）从 `lib/index.js` 取这些名字，保持契约不变；
// 引擎的其余纯函数也一并在这一层露面，测试只需 import 一个入口。
export {
	describeRule,
	emptyPolicy,
	expandMembers,
	folderMatches,
	globMatches,
	inTimeWindow,
	isRetryableFailure,
	matchRule,
	memberKey,
	normalizeMembers,
	normalizePolicy,
	normalizeRoute,
	normalizeRoutes,
	normalizeRule,
	parseIntent,
	planRoute,
	restDelayMs,
	shouldSink,
	teammateNameFromPrompt,
} from './rules.js'
