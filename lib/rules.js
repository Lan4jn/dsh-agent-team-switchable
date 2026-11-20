/**
 * 路由引擎（纯函数，零宿主依赖）。
 *
 * 语义刻意对齐 magpie 的 Group/Rule（`internal/provider/group.go`、
 * `grouprule.go`、`internal/gateway/{routing,fallback,sink,affinity}.go`），
 * 并只保留「在 DSH 的创建时刻/运行期真的看得见」的那部分（不搬清单见 docs/spec.md §2）。
 *
 *   magpie                       本引擎
 *   ---------------------------  --------------------------------------------
 *   Group.Members                 policy.members（有序，第一项是默认首选）
 *   Group.Rules                   policy.rules（按序，首命中决定**首选**成员）
 *   Group.Pick / Off              policy.pick / policy.off
 *   Group.Routing                 policy.routing（order / rotate / weight）
 *   Group.Match（glob 收成员）     policy.match + expandMembers()
 *   Rule.Time / Folders / …       rule.time / folders / exceptFolders / …
 *   Rule.Pause                    先在候选里摘掉该成员
 *   failure() + rest 阶梯          restDelayMs() / isRetryableFailure()
 *
 * 「命中的边界」写在 docs/spec.md §5：路由点在服务缝隙上，拿不到工具名。
 *
 * 作者：hwj
 */

/** 单条路由字段上限：与官方 `requiredText(request.provider, "provider", 200)` 对齐。 */
export const FIELD_LIMIT = 200

/** 成员表规模上限：挡住误贴的巨大配置。 */
export const MEMBER_LIMIT = 200

/** 成员名长度上限。 */
export const MEMBER_NAME_LIMIT = 64

/** 规则条数上限。 */
export const RULE_LIMIT = 200

/** 合法星期名：与 magpie `Weekdays` 同一套（sun..sat）。 */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** 合法 channel：即 subagents 服务上注册的 provider 名（官方内置为 spawn / fork）。 */
export const CHANNELS = ['spawn', 'fork']

/** 合法排序策略：magpie 的 smart/usage/pace 依赖配额窗口数据，DSH 拿不到，故不提供。 */
export const ROUTINGS = ['order', 'rotate', 'weight']

/** 可重试失败的兜底特征（message/code 上匹配）：超时、过载、限流、额度、网络类。 */
const RETRYABLE_TEXT =
	/timeout|timed out|unavailable|overload|rate.?limit|too.?many|quota|capacity|network|econn|socket|reset|upstream|gateway|service|busy|temporar/i

/**
 * 非空短字符串规范化；非法返回 undefined 而不是抛，交由调用方决定语义。
 *
 * @param {unknown} value - 任意输入。
 * @param {number} [limit] - 上限字符数。
 * @returns {string | undefined} 去掉首尾空白后的值，或 undefined。
 */
export function shortText(value, limit = FIELD_LIMIT) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	if (trimmed === '' || trimmed.length > limit) return undefined
	return trimmed
}

/**
 * 规范一条**绑定**（渠道 × 模型 × 档位）。
 *
 * 绑定是 v4 里最底层的可执行路由：`provider` + `model` + 可选 `reasoningEffort`，
 * 外加渠道自身的可用性（`off`、`time`）。逻辑名、权重、规则都在它上面一层（成员）。
 *
 * @param {unknown} value - 期望 `{ provider, model, reasoningEffort?, off?, time? }`。
 * @returns {{ binding?: object, error?: string }} binding 与 error 必有其一。
 */
export function normalizeBinding(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { error: '绑定必须是 { provider, model } 对象' }
	}
	const provider = shortText(value.provider)
	const model = shortText(value.model)
	if (provider === undefined) return { error: '`provider` 必须是非空字符串（≤200 字符）' }
	if (model === undefined) return { error: '`model` 必须是非空字符串（≤200 字符）' }
	const binding = { provider, model }
	if (value.reasoningEffort !== undefined) {
		const effort = shortText(value.reasoningEffort)
		if (effort === undefined) return { error: '`reasoningEffort` 若给出必须是非空字符串（≤200 字符）' }
		binding.reasoningEffort = effort
	}
	if (value.off !== undefined) {
		if (typeof value.off !== 'boolean') return { error: '`off` 必须是布尔值' }
		if (value.off) binding.off = true
	}
	if (value.time !== undefined) {
		const time = normalizeTimeWindow(value.time)
		if (time.window === undefined) return { error: time.error }
		binding.time = time.window
	}
	// 同时给出 `route` 键：v3 的调用方（工具参数校验）读的是 `.route`。
	return { binding, route: binding }
}

/** 兼容别名：v3 的 `normalizeRoute` 就是 v4 的绑定规范化。 */
export const normalizeRoute = normalizeBinding

/**
 * 绑定的键：`provider/model[:effort]`。
 *
 * 这是**渠道级**身份，用于 rest / sink / 用量归属 / 旧引用兼容解析。
 * 成员是**逻辑级**身份（用户起的名字），规则与亲和只认成员。
 */
export function memberKey(binding) {
	const base = `${binding.provider}/${binding.model}`
	const effort = binding.reasoningEffort
	return typeof effort === 'string' && effort !== '' ? `${base}:${effort}` : base
}

/** 绑定键别名（v4 语义更清楚的名字，代码里两者等价）。 */
export const bindingKey = memberKey

/** 成员名规则：非空、≤64、不含空白与逗号（旧迁移名里有 `/` `:`，必须允许）。 */
const MEMBER_NAME_V4 = /^[^\s,]{1,64}$/

/**
 * 把一个 v3 的扁平路由（或 v4 的绑定）规范成绑定。
 *
 * @param {unknown} value - v3 route 或 v4 binding。
 * @returns {{ binding?: object, error?: string }}
 */
function bindingOf(value) {
	return normalizeBinding(value)
}

/**
 * 规范成员列表：v4 形状（`{name, weight?, off?, bindings:[…]}`），并**自动迁移** v3 的扁平路由。
 *
 * 迁移规则只有一条、且保证零行为变化：
 *   v3 `{provider, model, reasoningEffort, weight}` → v4
 *   `{name: "provider/model[:effort]", weight, bindings: [{provider, model, reasoningEffort}]}`
 * 于是 v3 规则里的 `use: "provider/model[:effort]"` 依旧命中（成员名就是那个字符串）。
 *
 * @param {unknown} value - 成员数组。
 * @param {number} [limit] - 成员条数上限。
 * @returns {{ members: Array<object>, errors: string[] }} errors 非空表示整份被拒。
 */
export function normalizeMembers(value, limit = MEMBER_LIMIT) {
	if (!Array.isArray(value)) return { members: [], errors: ['成员表必须是数组'] }
	if (value.length > limit) return { members: [], errors: [`成员表最多 ${limit} 条`] }
	const v4 = value.some((item) => item !== null && typeof item === 'object' && Array.isArray(item.bindings))
	const v3 = value.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item.bindings) && ('provider' in item || 'model' in item))
	if (v4 && v3) return { members: [], errors: ['成员表不能混用 v3 扁平路由与 v4 成员，请整份迁移'] }

	const members = []
	const errors = []
	const names = new Set()
	for (let index = 0; index < value.length; index += 1) {
		const raw = value[index]
		if (v3) {
			// —— v3 → v4 迁移：一个路由 = 一个同名成员 + 一个绑定 ——
			const result = bindingOf(raw)
			if (result.binding === undefined) {
				errors.push(`成员第 ${index + 1} 条：${result.error}`)
				continue
			}
			const name = memberKey(result.binding)
			if (names.has(name)) continue
			names.add(name)
			const member = { name, bindings: [result.binding] }
			if (typeof raw.weight === 'number' && Number.isInteger(raw.weight) && raw.weight >= 1 && raw.weight <= 1000) member.weight = raw.weight
			members.push(member)
			continue
		}
		const member = normalizeMemberV4(raw, index)
		if (member.member === undefined) {
			errors.push(member.error)
			continue
		}
		if (names.has(member.member.name)) {
			errors.push(`成员第 ${index + 1} 条：成员名 "${member.member.name}" 重复`)
			continue
		}
		names.add(member.member.name)
		members.push(member.member)
	}
	return errors.length > 0 ? { members: [], errors } : { members, errors: [] }
}

/**
 * 规范一个 v4 成员。
 *
 * @param {unknown} value - `{ name, weight?, off?, bindings }`。
 * @param {number} [index] - 仅用于错误定位。
 * @returns {{ member?: object, error?: string }}
 */
export function normalizeMemberV4(value, index = 0) {
	const at = `成员第 ${index + 1} 条`
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: `${at}：必须是对象` }
	const name = shortText(value.name, MEMBER_NAME_LIMIT)
	if (name === undefined || !MEMBER_NAME_V4.test(name)) {
		return { error: `${at}：\`name\` 必须是 1–64 字符、不含空白与逗号的固定名字` }
	}
	if (!Array.isArray(value.bindings) || value.bindings.length === 0) {
		return { error: `${at}：\`bindings\` 必须是非空数组（至少一个渠道×模型）` }
	}
	const bindings = []
	const seen = new Set()
	for (let i = 0; i < value.bindings.length; i += 1) {
		const result = bindingOf(value.bindings[i])
		if (result.binding === undefined) return { error: `${at} 的绑定第 ${i + 1} 条：${result.error}` }
		const key = memberKey(result.binding)
		if (seen.has(key)) continue
		seen.add(key)
		bindings.push(result.binding)
	}
	const member = { name, bindings }
	if (value.weight !== undefined) {
		const weight = Number(value.weight)
		if (!Number.isInteger(weight) || weight < 1 || weight > 1000) return { error: `${at}：\`weight\` 必须是 1–1000 的整数` }
		member.weight = weight
	}
	if (value.off !== undefined) {
		if (typeof value.off !== 'boolean') return { error: `${at}：\`off\` 必须是布尔值` }
		if (value.off) member.off = true
	}
	return { member }
}

/** 0.2.1 的白名单接口别名（历史调用方）。 */
export function normalizeRoutes(value, limit = MEMBER_LIMIT) {
	const result = normalizeMembers(value, limit)
	return { routes: result.members, errors: result.errors }
}

/**
 * 解析成员引用 `"provider/model[:effort]"`（规则 `use`、`pick`、`off` 共用这套语法）。
 *
 * 档位分隔符取模型段里**最后一个**冒号：模型 id 里带冒号的可能性远小于档位后置的写法，
 * magpie 也是这么取舍的。缺 provider 或 model、或冒号后为空，都判非法。
 *
 * @param {unknown} ref - 引用文本。
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null}
 */
export function parseMemberRef(ref) {
	const text = shortText(ref)
	if (text === undefined) return null
	const at = text.indexOf('/')
	if (at <= 0 || at === text.length - 1) return null
	const tail = text.slice(at + 1)
	const colon = tail.lastIndexOf(':')
	if (colon === -1) return { provider: text.slice(0, at), model: tail }
	const model = tail.slice(0, colon)
	const effort = tail.slice(colon + 1)
	if (model === '' || effort === '') return null
	return { provider: text.slice(0, at), model, reasoningEffort: effort }
}

/**
 * 解析 "HH:MM"。
 *
 * @param {unknown} value - 时间文本。
 * @returns {number | undefined} 自午夜起的分钟数，或 undefined。
 */
export function parseHM(value) {
	const text = shortText(value, 5)
	if (text === undefined) return undefined
	const matched = /^(\d{1,2}):(\d{2})$/.exec(text)
	if (matched === null) return undefined
	const hours = Number(matched[1])
	const minutes = Number(matched[2])
	if (hours > 23 || minutes > 59) return undefined
	return hours * 60 + minutes
}

/** 分钟数 → "HH:MM"（规范化存储，避免 "9:00" 与 "09:00" 两种写法在设置页里跳）。 */
function padHM(minutes) {
	return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * 规范时间窗。语义抄 magpie `TimeWindow`：起止相同 = 全天；`to` 早于 `from` = 跨午夜；
 * `days` 指窗口**开始**那一天（周五 22:00–08:00 也含周六凌晨）。
 *
 * @param {unknown} value - 期望 `{ from, to, days? }`。
 * @returns {{ window?: object, error?: string }}
 */
export function normalizeTimeWindow(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { error: '`time` 必须是 { from, to, days? } 对象' }
	}
	const from = parseHM(value.from)
	const to = parseHM(value.to)
	if (from === undefined) return { error: '`time.from` 必须是 "HH:MM"（00:00–23:59）' }
	if (to === undefined) return { error: '`time.to` 必须是 "HH:MM"（00:00–23:59）' }
	const window = { from: padHM(from), to: padHM(to) }
	if (value.days !== undefined) {
		if (!Array.isArray(value.days) || value.days.length === 0) return { error: '`time.days` 若给出必须是非空数组' }
		const days = []
		for (const day of value.days) {
			const name = shortText(day, 3)
			if (name === undefined || !WEEKDAYS.includes(name.toLowerCase())) {
				return { error: `\`time.days\` 只能是 ${WEEKDAYS.join('/')}` }
			}
			const lower = name.toLowerCase()
			if (!days.includes(lower)) days.push(lower)
		}
		window.days = days
	}
	return { window }
}

/** 规则里的字符串列表字段（folders / exceptFolders）。 */
function normalizeTextList(value, field, at) {
	if (!Array.isArray(value)) return { error: `${at}：\`${field}\` 必须是数组` }
	// 空数组 = 「这一格是空的」，按「没给这个条件」处理。
	//
	// 2026-10-16 用户实报：设置页在「目录通配自动入候选」为空时也送了 match: []，
	// 而这里原来把「给了就必须非空」当规则 → 保存直接失败，用户看到一句
	// 「策略：match 若给出必须是非空数组」，完全对不上他填的界面。
	// 清空一格是正常操作，不该报错；非数组、含空串仍然拒绝。
	if (value.length === 0) return { list: [] }
	const list = []
	for (const item of value) {
		const text = shortText(item, 500)
		if (text === undefined) return { error: `${at}：\`${field}\` 每一项都必须是非空字符串（≤500 字符）` }
		list.push(text)
	}
	return { list }
}

/**
 * 规范一条规则。
 *
 * @param {unknown} value - 期望的规则对象。
 * @param {number} [index] - 仅用于错误文案定位（从 0 起）。
 * @returns {{ rule?: object, error?: string }}
 */
export function normalizeRule(value, index = 0) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { error: `规则第 ${index + 1} 条必须是对象` }
	}
	const at = `规则第 ${index + 1} 条`
	const rule = {}
	// pause 规则同样要 `use`：它的语义是「条件成立时把 use 这个成员摘出候选」
	// （magpie：`Pause: rather than sending to Use first, the rule leaves Use out of the group while it holds`）。
	// 2026-10-16 首版把 pause 的 use 丢了，于是它退化成「全停用」开关——被本文件的测试抓出来。
	const use = shortText(value.use, MEMBER_NAME_LIMIT)
	// v4：use 是**成员名**（用户起的固定名字）；v3 的 "provider/model[:effort]" 也是合法成员名（迁移约定）。
	if (use === undefined || !MEMBER_NAME_V4.test(use)) {
		return { error: `${at}：\`use\` 必须是成员名（1–64 字符、不含空白与逗号）` }
	}
	rule.use = use
	if (value.pause !== undefined) {
		if (typeof value.pause !== 'boolean') return { error: `${at}：\`pause\` 必须是布尔值` }
		if (value.pause) rule.pause = true
	}
	if (value.channel !== undefined) {
		const channel = shortText(value.channel, 32)
		if (channel === undefined || !CHANNELS.includes(channel)) {
			return { error: `${at}：\`channel\` 只能是 ${CHANNELS.join(' / ')}` }
		}
		rule.channel = channel
	}
	if (value.continuable !== undefined) {
		if (typeof value.continuable !== 'boolean') return { error: `${at}：\`continuable\` 必须是布尔值` }
		rule.continuable = value.continuable
	}
	for (const field of ['label', 'member', 'intent']) {
		if (value[field] === undefined) continue
		const text = shortText(value[field])
		if (text === undefined) return { error: `${at}：\`${field}\` 必须是非空字符串（通配符 * 可用）` }
		rule[field] = text
	}
	for (const field of ['folders', 'exceptFolders']) {
		if (value[field] === undefined) continue
		const list = normalizeTextList(value[field], field, at)
		if (list.list === undefined) return { error: list.error }
		if (list.list.length > 0) rule[field] = list.list
	}
	if (value.tokens !== undefined) {
		const tokens = Number(value.tokens)
		if (!Number.isFinite(tokens) || tokens < 0) return { error: `${at}：\`tokens\` 必须是非负数字` }
		rule.tokens = tokens
	}
	if (value.effort !== undefined) {
		const effort = shortText(value.effort, 32)
		if (effort === undefined) return { error: `${at}：\`effort\` 必须是非空字符串（如 high / on / none）` }
		rule.effort = effort
	}
	if (value.images !== undefined) {
		if (typeof value.images !== 'boolean') return { error: `${at}：\`images\` 必须是布尔值` }
		rule.images = value.images
	}
	if (value.time !== undefined) {
		const time = normalizeTimeWindow(value.time)
		if (time.window === undefined) return { error: `${at}：${time.error}` }
		rule.time = time.window
	}
	return { rule }
}

/**
 * 规范整份策略（policy v3），并兼容三种历史形状：
 *   1. 0.3.0：`{ version: 3, members, rules, match, pick, off, routing, allowFork, failover, classifier }`
 *   2. 0.2.1：`{ version: 1, routes: [...] }`（白名单）→ 迁移成成员表 + 空规则
 *   3. 组合行 config 的种子：直接是一个路由数组
 *
 * @param {unknown} value - 策略文件或 HTTP 入参。
 * @returns {{ policy: object, errors: string[] }} errors 非空表示整份输入被拒绝。
 */
export function normalizePolicy(value) {
	const empty = emptyPolicy()
	if (Array.isArray(value)) {
		const members = normalizeMembers(value)
		return { policy: { ...empty, members: members.members }, errors: members.errors }
	}
	if (value === null || typeof value !== 'object') return { policy: empty, errors: [] }

	const rawMembers = value.members !== undefined ? value.members : value.routes
	const members = normalizeMembers(rawMembers === undefined ? [] : rawMembers)
	if (members.errors.length > 0) return { policy: empty, errors: members.errors }

	const rawRules = value.rules === undefined ? [] : value.rules
	if (!Array.isArray(rawRules)) return { policy: empty, errors: ['`rules` 必须是数组'] }
	if (rawRules.length > RULE_LIMIT) return { policy: empty, errors: [`规则最多 ${RULE_LIMIT} 条`] }
	const rules = []
	const errors = []
	for (let index = 0; index < rawRules.length; index += 1) {
		const result = normalizeRule(rawRules[index], index)
		if (result.rule === undefined) errors.push(result.error)
		else rules.push(result.rule)
	}
	if (errors.length > 0) return { policy: empty, errors }

	const policy = { ...empty, members: members.members, rules }

	if (value.match !== undefined) {
		const list = normalizeTextList(value.match, 'match', '策略')
		if (list.list === undefined) return { policy: empty, errors: [list.error] }
		if (list.list.length > 0) policy.match = list.list
	}
	if (value.pick !== undefined && value.pick !== null) {
		const pick = normalizeMemberRef(value.pick)
		if (pick === undefined) return { policy: empty, errors: ['`pick` 必须是 "provider/model" 形状'] }
		policy.pick = pick
	}
	if (value.off !== undefined) {
		if (!Array.isArray(value.off)) return { policy: empty, errors: ['`off` 必须是数组'] }
		const off = []
		for (const item of value.off) {
			const ref = normalizeMemberRef(item)
			if (ref === undefined) return { policy: empty, errors: ['`off` 每一项都必须是 "provider/model" 形状'] }
			if (!off.includes(ref)) off.push(ref)
		}
		policy.off = off
	}
	if (value.routing !== undefined) {
		const routing = shortText(value.routing, 16)
		if (routing === undefined || !ROUTINGS.includes(routing)) {
			return { policy: empty, errors: [`\`routing\` 只能是 ${ROUTINGS.join(' / ')}`] }
		}
		policy.routing = routing
	}
	if (value.allowFork !== undefined) {
		if (typeof value.allowFork !== 'boolean') return { policy: empty, errors: ['`allowFork` 必须是布尔值'] }
		policy.allowFork = value.allowFork
	}
	// 档位进身份后的引用迁移：老写法 `use: "p/m"` 指的是「那个带档位的成员」。
	// 若表里已没有裸 p/m 成员、且同模型恰好只有一个档位变体，就把引用升级成 p/m:effort——
	// 不升级的话 resolveUse 会退回字面解析，静默丢掉成员配置的档位（用户重启后审查规则
	// 从 max 悄悄变默认档，正是这类坑）。同模型有两个变体时存在歧义，保持原样交给用户显式写。
	upgradeRefs(policy)
	if (value.failover !== undefined) {
		if (value.failover === null || typeof value.failover !== 'object' || Array.isArray(value.failover)) {
			return { policy: empty, errors: ['`failover` 必须是对象'] }
		}
		if (value.failover.enabled !== undefined) {
			if (typeof value.failover.enabled !== 'boolean') return { policy: empty, errors: ['`failover.enabled` 必须是布尔值'] }
			policy.failover.enabled = value.failover.enabled
		}
		if (value.failover.patience !== undefined) {
			const patience = Number(value.failover.patience)
			if (!Number.isInteger(patience) || patience < 0 || patience > 10) {
				return { policy: empty, errors: ['`failover.patience` 必须是 0–10 的整数'] }
			}
			policy.failover.patience = patience
		}
	}
	if (value.classifier !== undefined) {
		if (value.classifier === null || typeof value.classifier !== 'object' || Array.isArray(value.classifier)) {
			return { policy: empty, errors: ['`classifier` 必须是对象'] }
		}
		if (value.classifier.enabled !== undefined) {
			if (typeof value.classifier.enabled !== 'boolean') return { policy: empty, errors: ['`classifier.enabled` 必须是布尔值'] }
			policy.classifier.enabled = value.classifier.enabled
		}
		for (const field of ['provider', 'model']) {
			const raw = value.classifier[field]
			if (raw === undefined) continue
			// 空串 = 这一格没填（分类器关着时设置页就是这么送的），跳过而不是拒绝；
			// 非字符串仍然拒绝。与 match / folders 同一套口径：清空是正常操作。
			if (typeof raw === 'string' && raw.trim() === '') continue
			const text = shortText(raw)
			if (text === undefined) return { policy: empty, errors: [`\`classifier.${field}\` 必须是非空字符串`] }
			policy.classifier[field] = text
		}
	}
	return { policy, errors: [] }
}

/** 一份空策略（也是所有字段的默认值来源）。 */
export function emptyPolicy() {
	return {
		members: [],
		rules: [],
		match: [],
		pick: null,
		off: [],
		routing: 'order',
		allowFork: false,
		failover: { enabled: true, patience: 2 },
		classifier: { enabled: false, provider: '', model: '' },
	}
}

/**
 * 把「裸引用」升级成**成员名**（v4 版；仅当无歧义时）。
 *
 * 典型场景：用户写规则 `use: "zai-coding-cn/glm-5.3"`，但成员表里的成员叫
 * `glm-max`（或迁移名 `zai-coding-cn/glm-5.3:max`）——只要某个成员恰好只有一个绑定等于这个键，
 * 就把它改写成那个成员名。真人不会因为规则引用了「绑定键」而配置失效。
 *
 * 歧义（多个成员都含这个绑定）时不改：升级成哪个都是替用户做决定。
 * 已经有同名成员时也不改（引用本来就有效）。
 *
 * @param {object} policy - 已规范化的 v4 策略（原地修改）。
 */
function upgradeRefs(policy) {
	const names = new Set(policy.members.map((member) => member.name))
	const byBinding = new Map()
	for (const member of policy.members) {
		for (const binding of member.bindings) {
			const key = memberKey(binding)
			const owners = byBinding.get(key) ?? new Set()
			owners.add(member.name)
			byBinding.set(key, owners)
		}
	}
	const upgrade = new Map()
	for (const [key, owners] of byBinding) {
		if (names.has(key)) continue
		if (owners.size === 1) upgrade.set(key, [...owners][0])
	}
	// 带档位的成员还要额外登记它的「裸」写法：`zai/glm-5.3` → 唯一一个带档位的成员。
	// （不带档位的绑定，裸写法就是它自己的键，上面的循环已覆盖。）
	const bareOwners = new Map()
	for (const member of policy.members) {
		for (const binding of member.bindings) {
			if (binding.reasoningEffort === undefined) continue
			const bare = `${binding.provider}/${binding.model}`
			const owners = bareOwners.get(bare) ?? new Set()
			owners.add(member.name)
			bareOwners.set(bare, owners)
		}
	}
	for (const [bare, owners] of bareOwners) {
		if (names.has(bare)) continue
		if (owners.size === 1) upgrade.set(bare, [...owners][0])
	}
	if (upgrade.size === 0) return
	for (const rule of policy.rules) {
		if (rule.use === undefined) continue
		const to = upgrade.get(rule.use)
		if (to !== undefined) rule.use = to
	}
	if (policy.pick !== null && policy.pick !== undefined) {
		const to = upgrade.get(policy.pick)
		if (to !== undefined) policy.pick = to
	}
	policy.off = policy.off.map((ref) => upgrade.get(ref) ?? ref)
}

/**
 * 成员引用规范化（`pick` / `off` / `pause` 规则用）：v4 里就是**成员名**。
 *
 * 兼容 v3 写法的 `provider/model[:effort]`：迁移后的成员名恰好等于那个字符串，所以旧配置照旧命中。
 */
export function normalizeMemberRef(value) {
	const text = shortText(value, MEMBER_NAME_LIMIT)
	if (text === undefined || !MEMBER_NAME_V4.test(text)) return undefined
	return text
}

/**
 * 把目录路径规范化成**比较用**的规范形。
 *
 * 用户同时有 Windows 与 WSL（本机就是）：`D:\work\acme`、`/mnt/d/work/acme`、
 * `\\wsl$\Ubuntu\home\me\x` 指同一处地方，规则不该因为写法不同就失配
 * （magpie 的 `FolderUnder` 同样处理）。
 *
 * @param {unknown} value - 原始路径。
 * @param {string} [home] - `~` 展开成的家目录；缺省读环境变量。
 * @returns {string | undefined} 规范形（小写、正斜杠、无尾斜杠），或 undefined。
 */
export function normalizeFolderPath(value, home) {
	const text = shortText(value, 500)
	if (text === undefined) return undefined
	let path = text.replace(/\\/g, '/')
	const share = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i.exec(path)
	if (share !== null) path = share[1] === undefined ? '/' : share[1]
	else if (path.startsWith('~')) {
		// Windows 的 USERPROFILE 带反斜杠：拼接时一起归一化，否则 '~/proj' 会变成
		// 'c:\\users\\x/proj'，与 'c:/users/x/proj' 永远失配（2026-10-20 Windows 宿主暴露）。
		path = String(home ?? homeDirectory()).replace(/\\/g, '/') + path.slice(1)
	}
	const mount = /^\/mnt\/([a-z])(\/.*)?$/i.exec(path)
	if (mount !== null) path = `${mount[1].toLowerCase()}:${mount[2] === undefined ? '/' : mount[2]}`
	const drive = /^([a-z]):(\/.*)?$/i.exec(path)
	if (drive !== null) path = `${drive[1].toLowerCase()}:${drive[2] === undefined ? '/' : drive[2]}`
	path = path.replace(/\/{2,}/g, '/')
	if (path.length > 1) path = path.replace(/\/+$/, '')
	return path === '' ? '/' : path.toLowerCase()
}

/** 家目录：只为 `~` 展开服务，取不到退化成空串（`~` 规则失配而不是崩）。 */
function homeDirectory() {
	return process.env.HOME ?? process.env.USERPROFILE ?? ''
}

/**
 * 判断一个目录是否在给定目录之内（含相等），在**路径边界**上比较：
 * `/a/b` 不在 `/a/bc` 之内——magpie `TestFolderUnder` 钉住的正是这条。
 *
 * @param {string} cwd - 规范形目录。
 * @param {string} folder - 规范形目录。
 * @returns {boolean}
 */
export function folderUnder(cwd, folder) {
	if (folder === '/') return cwd.startsWith('/')
	if (cwd === folder) return true
	return cwd.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

/**
 * 规则的 folders 是否命中。
 *
 * @param {string[]} folders - 规则声明的目录（未规范化）。
 * @param {unknown} cwd - 创建时刻读到的父会话目录。
 * @returns {boolean} cwd 未知一律 false（「不知道」不等于「命中」）。
 */
export function folderMatches(folders, cwd) {
	const target = normalizeFolderPath(cwd)
	if (target === undefined) return false
	for (const folder of folders) {
		const base = normalizeFolderPath(folder)
		if (base !== undefined && folderUnder(target, base)) return true
	}
	return false
}

/**
 * 通配符匹配：`*` 匹配任意长度，其余按字面量，忽略大小写，整体锚定。
 * 只支持 `*`（不做 `?` / 字符类）——够用且一句话解释得清。
 *
 * @param {string} pattern - 含 `*` 的模式。
 * @param {string} text - 被匹配文本。
 * @returns {boolean}
 */
export function globMatches(pattern, text) {
	if (pattern === '*') return true
	const haystack = String(text).toLowerCase()
	const parts = String(pattern).toLowerCase().split('*')
	let cursor = 0
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]
		if (part === '') continue
		const found = haystack.indexOf(part, cursor)
		if (found === -1) return false
		if (index === 0 && !pattern.startsWith('*') && found !== 0) return false
		cursor = found + part.length
	}
	if (!pattern.endsWith('*')) {
		const last = parts[parts.length - 1]
		if (last !== '' && !haystack.endsWith(last)) return false
	}
	return true
}

/**
 * 时间窗是否命中当前时刻。
 *
 * @param {{from: string, to: string, days?: string[]}} window - 已规范化的窗口。
 * @param {Date} now - 判定时刻（本地时区）。
 * @returns {boolean}
 */
export function inTimeWindow(window, now) {
	const from = parseHM(window.from)
	const to = parseHM(window.to)
	if (from === undefined || to === undefined) return false
	const days = Array.isArray(window.days) && window.days.length > 0 ? new Set(window.days) : null
	/** 窗口某一天是否被 days 允许 */
	const dayAllowed = (name) => days === null || days.has(name)
	const today = WEEKDAYS[now.getDay()]
	const yesterday = WEEKDAYS[(now.getDay() + 6) % 7]
	const minutes = now.getHours() * 60 + now.getMinutes()
	if (from === to) return dayAllowed(today)
	if (from < to) return minutes >= from && minutes <= to && dayAllowed(today)
	// 跨午夜：窗口属于它开始的那一天。
	if (minutes >= from) return dayAllowed(today)
	if (minutes <= to) return dayAllowed(yesterday)
	return false
}

/**
 * 一次创建请求上真实可见的全部信号（规则条件的输入）。
 *
 * @typedef {object} RouteContext
 * @property {string} channel - subagents provider 名（spawn / fork）。
 * @property {boolean} continuable - 是否走 startContinuable。
 * @property {string} label - 创建请求的 label（团队成员时即 description）。
 * @property {string} member - 团队成员名；非团队成员为空串。
 * @property {string | undefined} cwd - 父会话工作目录。
 * @property {number | undefined} tokens - 父会话当前 token 规模。
 * @property {string | undefined} effort - 父会话当前推理档。
 * @property {boolean} images - 创建请求是否带图片块。
 * @property {string | null} intent - 分类器判定的意图；未开启时为 null。
 */

/**
 * 规则是否命中。
 *
 * @param {object} rule - 已规范化的规则。
 * @param {RouteContext} context - 创建时刻上下文。
 * @param {Date} now - 判定时刻。
 * @returns {boolean}
 */
export function matchRule(rule, context, now) {
	if (rule.channel !== undefined && rule.channel !== context.channel) return false
	if (rule.continuable !== undefined && rule.continuable !== context.continuable) return false
	if (rule.label !== undefined && !globMatches(rule.label, context.label ?? '')) return false
	if (rule.member !== undefined && !globMatches(rule.member, context.member ?? '')) return false
	if (rule.intent !== undefined && (context.intent === null || context.intent === undefined)) return false
	if (rule.intent !== undefined && rule.intent.toLowerCase() !== String(context.intent).toLowerCase()) return false
	if (rule.folders !== undefined && !folderMatches(rule.folders, context.cwd)) return false
	if (rule.exceptFolders !== undefined && folderMatches(rule.exceptFolders, context.cwd)) return false
	if (rule.tokens !== undefined && !(typeof context.tokens === 'number' && context.tokens >= rule.tokens)) return false
	if (rule.effort !== undefined && !effortMatches(rule.effort, context.effort)) return false
	if (rule.images !== undefined && rule.images !== context.images) return false
	if (rule.time !== undefined && !inTimeWindow(rule.time, now)) return false
	return true
}

/**
 * `effort` 条件：具体档位比字面量；`on` = 有任何推理档；`none` = 完全没有。
 *
 * @param {string} wanted - 规则里写的值。
 * @param {string | undefined} actual - 父会话当前档。
 * @returns {boolean}
 */
export function effortMatches(wanted, actual) {
	const want = wanted.toLowerCase()
	const has = actual !== undefined && actual !== null && String(actual) !== '' && String(actual) !== 'none'
	if (want === 'on') return has
	if (want === 'none') return !has
	return has && String(actual).toLowerCase() === want
}

/**
 * 把一个成员引用解析成成员对象。
 *
 * 先按**成员名**精确匹配；找不到且引用带 `/` 时，再按「某个成员的绑定恰好等于这个键」兜底——
 * 这样手写的 `use: "zai-coding-cn/glm-5.3:max"` 也能落到包含该绑定的成员上。
 *
 * @param {string} ref - 成员名或绑定键。
 * @param {Array<object>} members - v4 成员表。
 * @returns {object | null}
 */
export function resolveMember(ref, members) {
	const name = normalizeMemberRef(ref)
	if (name === undefined) return null
	const direct = members.find((member) => member.name === name)
	if (direct !== undefined) return direct
	if (name.indexOf('/') !== -1) {
		return members.find((member) => member.bindings.some((binding) => memberKey(binding) === name)) ?? null
	}
	return null
}

/**
 * 用 `policy.match` 的通配模式从目录里扩充候选（magpie 的 `Group.Match`）。
 *
 * v4 里匹配到的新路由会变成**单绑定成员**，成员名就是它的绑定键（`provider/model[:effort]`），
 * 这样它和迁移来的旧成员同一套寻址方式，也能被规则引用。
 *
 * @param {Array<object>} members - v4 成员表。
 * @param {string[]} patterns - 通配模式。
 * @param {Array<object>} catalog - 目录里的路由 `{provider, model}`。
 * @returns {Array<object>} 扩充后的成员表（新数组）。
 */
export function expandMembers(members, patterns, catalog) {
	if (patterns.length === 0 || catalog.length === 0) return members.slice()
	const known = new Set()
	for (const member of members) for (const binding of member.bindings) known.add(memberKey(binding))
	const expanded = members.slice()
	for (const route of catalog) {
		const key = memberKey(route)
		if (known.has(key)) continue
		if (!patterns.some((pattern) => globMatches(pattern, key))) continue
		known.add(key)
		expanded.push({ name: key, bindings: [{ provider: route.provider, model: route.model }] })
	}
	return expanded
}

/**
 * 成员排序（magpie 的 `plan`：rest 的排最后、sink 的退队尾、策略决定其余）。
 *
 * v4 里 **weight / rotate / order 作用于成员**；成员内部的渠道顺序由绑定数组顺序决定。
 *
 * @param {Array<object>} members - 候选成员。
 * @param {object} options - `{ routing, cursor }`。
 * @returns {Array<object>} 排序后的新数组。
 */
export function orderMembers(members, options) {
	const routing = options.routing ?? 'order'
	if (routing === 'rotate') return rotateMembers(members, options.cursor ?? 0)
	if (routing === 'weight') return weightedMembers(members, options.cursor ?? 0)
	return members.slice()
}

/** 轮转：从游标处切一刀（magpie 的 `rotate`）。 */
function rotateMembers(members, cursor) {
	if (members.length === 0) return []
	const at = ((cursor % members.length) + members.length) % members.length
	return [...members.slice(at), ...members.slice(0, at)]
}

/** 平滑加权轮转的降维：按 `cursor` 推出当前轮次选一个「权重大户」排最前。 */
function weightedMembers(members, cursor) {
	if (members.length < 2) return members.slice()
	const weights = members.map((member) => (Number.isInteger(member.weight) && member.weight > 0 ? member.weight : 1))
	const total = weights.reduce((sum, weight) => sum + weight, 0)
	let point = ((cursor % total) + total) % total
	let head = 0
	for (let index = 0; index < members.length; index += 1) {
		if (point < weights[index]) {
			head = index
			break
		}
		point -= weights[index]
	}
	return [members[head], ...members.slice(0, head), ...members.slice(head + 1)]
}

/**
 * 一个成员在某一时刻可用的绑定（按数组顺序 = 渠道优先级）。
 *
 * 过滤：绑定 `off`、命中自身 `time` 窗口（渠道在这个时段停用）、成员整体 `off`（由调用方先滤掉）。
 * resting / sunk 的绑定**保留但排到该成员最后**——全组都在休息时仍可最后一搏（magpie 的 restLast）。
 *
 * @param {object} member - v4 成员。
 * @param {Set<string>} resting - 休息中的绑定键。
 * @param {Set<string>} sunk - 被 429 沉底的绑定键。
 * @param {Date} now - 判定时刻。
 * @returns {Array<{member: string, binding: object}>} 可注入的候选，顺序即优先级。
 */
export function bindingsOf(member, now) {
	const entries = []
	for (const binding of member.bindings) {
		if (binding.off === true) continue
		if (binding.time !== undefined && inTimeWindow(binding.time, now)) continue
		entries.push({ member: member.name, binding })
	}
	return entries
}

/**
 * 组装最终计划：先目标成员的渠道，再按策略排其它成员的渠道（这就是运行期回退阶梯）。
 *
 * @param {object} target - 规则/pick/策略选中的成员。
 * @param {Array<object>} usableMembers - 可参与路由的成员（已去 off/pause）。
 * @param {object} options - `{ routing, cursor, resting, sunk, now }`。
 * @param {string} reason - 决策原因（trace 用）。
 * @param {number | null} ruleIndex - 命中的规则下标。
 * @returns {{ route: object, member: string, candidates: Array<object>, candidateMembers: string[], reason: string, ruleIndex: number | null } | null}
 */
function buildPlan(target, usableMembers, options, reason, ruleIndex) {
	const others = orderMembers(usableMembers, options).filter((member) => member.name !== target.name)
	const orderedMembers = [target, ...others]
	const flat = []
	for (const member of orderedMembers) for (const entry of bindingsOf(member, options.now)) flat.push(entry)
	if (flat.length === 0) return null
	// magpie 的 restLast：休息中 / 被 sink 的候选整体排到最后，其余保持「目标成员优先」的顺序。
	const awake = flat.filter((entry) => !options.resting.has(memberKey(entry.binding)) && !options.sunk.has(memberKey(entry.binding)))
	const asleep = flat.filter((entry) => options.resting.has(memberKey(entry.binding)) || options.sunk.has(memberKey(entry.binding)))
	const candidates = awake.concat(asleep)
	const head = candidates[0]
	return {
		route: head.binding,
		member: head.member,
		candidates: candidates.map((entry) => entry.binding),
		candidateMembers: orderedMembers.map((member) => member.name),
		reason,
		ruleIndex,
	}
}

/**
 * 选出本次创建要用的路由，并给出**有序候选表**供运行期回退使用。
 *
 * v4 决策顺序：
 *   1. `pause` 规则命中的**成员**先摘出候选（不是「改发给别人」）；
 *   2. `pick`（手动指定成员）覆盖一切；
 *   3. 规则按序匹配，首条命中决定首选**成员**（找不到该成员就继续下一条）；
 *   4. 没命中规则时先看亲和（同父会话上次的成员名）；
 *   5. 再按 `routing` 策略在成员间排序。
 * 候选表 = 目标成员的绑定（按渠道优先级）→ 其余成员的绑定（按策略顺序）。
 *
 * @param {object} policy - 已规范化的 v4 策略。
 * @param {object} context - 创建时刻上下文。
 * @param {object} [options] - `{ now, catalog, cursor, resting, sunk, affinity }`。
 * @returns {object | null} 没有任何可用绑定时返回 null（= 路由器对该次创建关闭）。
 */
export function planRoute(policy, context, options = {}) {
	const now = options.now ?? new Date()
	const cursor = options.cursor ?? 0
	const resting = options.resting ?? new Set()
	const sunk = options.sunk ?? new Set()
	const planOptions = { routing: policy.routing, cursor, resting, sunk, now }

	const expanded = expandMembers(policy.members, policy.match ?? [], options.catalog ?? [])

	// 1) pause：条件成立的规则把**它命名的成员**摘出候选。
	const paused = new Set()
	for (const rule of policy.rules) {
		if (rule.pause !== true) continue
		if (!matchRule(rule, context, now)) continue
		const target = resolveMember(rule.use, expanded)
		if (target !== null) paused.add(target.name)
	}
	// policy.off 是「临时摘除的成员名单」（成员级）；member.off 是成员自身的开关。
	const offMembers = new Set(policy.off ?? [])
	const usable = expanded.filter((member) => member.off !== true
		&& !offMembers.has(member.name)
		&& !paused.has(member.name)
		&& bindingsOf(member, now).length > 0)

	// 2) pick：手动指定成员，规则全部让位。
	if (policy.pick !== null && policy.pick !== undefined) {
		const picked = resolveMember(policy.pick, usable)
		if (picked !== null) return buildPlan(picked, usable, planOptions, 'pick', null)
	}

	// 3) 规则：首条命中决定首选成员。
	for (let index = 0; index < policy.rules.length; index += 1) {
		const rule = policy.rules[index]
		if (rule.pause === true) continue
		if (!matchRule(rule, context, now)) continue
		const target = resolveMember(rule.use, usable)
		if (target === null) continue
		const plan = buildPlan(target, usable, planOptions, 'rule', index)
		if (plan !== null) return plan
	}

	// 4) 亲和：同一父会话上次跑过的成员优先（保 vendor 前缀 cache）。
	if (typeof options.affinity === 'string' && options.affinity !== '') {
		const kept = usable.find((member) => member.name === options.affinity)
		if (kept !== undefined) {
			const plan = buildPlan(kept, usable, planOptions, 'affinity', null)
			if (plan !== null) return plan
		}
	}

	// 5) 策略排序后的第一个成员。
	const ordered = orderMembers(usable, planOptions)
	if (ordered.length === 0) return null
	const plan = buildPlan(ordered[0], usable, planOptions, policy.routing ?? 'order', null)
	return plan
}

/**
 * 失败是否值得换成员重试（magpie 的 `retryable`）。
 *
 * **请求本身的拒绝**（400/401/403/404/413/422）一律不回退：换模型也答不对，
 * 只会把错误掩盖成「另一个模型也不行」。magpie 的原话是
 * 「never for a refusal of the request itself」。
 *
 * @param {unknown} failure - `LlmFailure`（`{message, code, status?, providerRetryAfterMs?}`）。
 * @returns {boolean}
 */
export function isRetryableFailure(failure) {
	if (failure === null || typeof failure !== 'object') return false
	const status = failure.status
	if (typeof status === 'number') {
		if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false
		if (status === 408 || status === 429 || status >= 500) return true
	}
	const code = typeof failure.code === 'string' ? failure.code : ''
	if (code !== '' && RETRYABLE_TEXT.test(code)) return true
	const message = typeof failure.message === 'string' ? failure.message : ''
	return message !== '' && RETRYABLE_TEXT.test(message)
}

/** 普通失败的 rest 上限：magpie 的 `longestRetry`（10 分钟）。 */
const FAIL_REST_CAP = 10 * 60_000

/** 限流 / 额度类失败的 rest 上限：magpie 的 `longestRateRest`（30 分钟）。 */
const RATE_REST_CAP = 30 * 60_000

/** 额度/余额用尽（magpie 是「rest 到重置时刻」，DSH 拿不到重置时刻 → 用 30 分钟代替）。 */
const QUOTA_TEXT = /quota|credit|balance|insufficient|exhaust/i

/** 限流类特征（含 magpie 归到「等一会儿会好」的那几种）。 */
const RATE_TEXT = /rate.?limit|too.?many|busy|capacity|overload|throttl/i

/**
 * rest 时长（照 magpie `failure()` 的阶梯，2026-10-16 按用户要求对齐）：
 *
 *   vendor 给了 Retry-After      → 用它（封顶 30 分钟）
 *   额度/余额用尽                 → 30 分钟（magpie 是「rest 到重置时刻」，这里拿不到重置时刻）
 *   限流 / 过载 / busy（429 等）  → 60 秒起、每次翻倍、封顶 30 分钟
 *   其余失败（5xx / 网络 / 超时） → 60 秒起、每次翻倍、封顶 10 分钟
 *
 * 与 magpie 的差别只剩一处：它按 key/account 记账，本插件按 provider/model 成员记账
 * （DSH 没有账号池这一层）。
 *
 * @param {unknown} failure - `LlmFailure`。
 * @param {number} consecutive - 该成员连续失败次数（含本次，从 1 起）。
 * @returns {number} 毫秒。
 */
export function restDelayMs(failure, consecutive) {
	const record = failure !== null && typeof failure === 'object' ? failure : {}
	const after = record.providerRetryAfterMs
	if (typeof after === 'number' && Number.isFinite(after) && after > 0) return Math.min(after, RATE_REST_CAP)
	const text = `${typeof record.code === 'string' ? record.code : ''} ${typeof record.message === 'string' ? record.message : ''}`
	if (QUOTA_TEXT.test(text)) return RATE_REST_CAP
	const step = Math.max(0, (Number.isFinite(consecutive) ? consecutive : 1) - 1)
	const rate = record.status === 429 || RATE_TEXT.test(text)
	return Math.min(60_000 * 2 ** step, rate ? RATE_REST_CAP : FAIL_REST_CAP)
}

/**
 * 429/额度类失败是否该把成员 sink 到候选末尾（magpie 的 `Sink`：内存态，重启清空）。
 *
 * @param {unknown} failure - `LlmFailure`。
 * @returns {boolean}
 */
export function shouldSink(failure) {
	if (failure === null || typeof failure !== 'object') return false
	if (failure.status === 429) return true
	const text = `${typeof failure.code === 'string' ? failure.code : ''} ${typeof failure.message === 'string' ? failure.message : ''}`
	return /rate.?limit|too.?many|quota|capacity/i.test(text)
}

/**
 * 分类器回答 → 意图 id。
 *
 * 只在**完全说清**时命中：回答里唯一出现的那个意图（大小写不敏感的子串）。
 * 说不清（没有、多个、空的）一律返回 null —— magpie 也是
 * 「When the classifier can't say, it doesn't match」。
 *
 * @param {unknown} answer - 模型回答文本。
 * @param {string[]} intents - 规则里声明过的全部意图。
 * @returns {string | null}
 */
export function parseIntent(answer, intents) {
	const text = typeof answer === 'string' ? answer.trim().toLowerCase() : ''
	if (text === '') return null
	if (intents.includes('*')) return text
	const hits = intents.filter((intent) => text.includes(intent.toLowerCase()))
	if (hits.length === 1) return hits[0]
	if (hits.length > 1) {
		// 多个命中时取最长的那个（"写作或修改测试" 与 "测试" 同时命中时选前者）。
		const longest = hits.slice().sort((a, b) => b.length - a.length)[0]
		const alsoLongest = hits.filter((intent) => intent.length === longest.length)
		return alsoLongest.length === 1 ? longest : null
	}
	return null
}

/**
 * 从初始消息里取出成员名（身份前缀由 index.js 的 identityPrefix 生成，
 * 0.2.1 就靠这一对函数把「暂存路由」与「这次 spawn」对上）。
 *
 * 为什么用名字：官方运行时给 `startContinuable` 的 `label` 是 description（不唯一），
 * 而成员名在整支团队里永不复用——名字是官方侧唯一稳定的匹配信号。
 *
 * @param {unknown} prompt - 初始消息内容块数组。
 * @returns {string | null} 成员名；取不到返回 null（此时一律不注入，退回官方行为）。
 */
export function teammateNameFromPrompt(prompt) {
	if (!Array.isArray(prompt)) return null
	for (const block of prompt) {
		if (block === null || typeof block !== 'object') continue
		if (block.type !== 'text' || typeof block.text !== 'string') continue
		const matched = /You are teammate "([^"]+)"/.exec(block.text)
		if (matched !== null) return matched[1]
	}
	return null
}

/**
 * 从策略里收集分类器该问的全部意图（规则里写过的，pause 规则不算）。
 *
 * @param {object} policy - 策略。
 * @returns {string[]} 去重后的意图列表（保持首次出现顺序）。
 */
export function collectIntents(policy) {
	const intents = []
	for (const rule of policy.rules) {
		if (rule.pause === true) continue
		if (rule.intent === undefined) continue
		if (!intents.includes(rule.intent)) intents.push(rule.intent)
	}
	return intents
}

/**
 * 生成一句中文摘要，设置页列表与 trace 都用它——用户不该为了看懂一条规则去读 JSON。
 *
 * @param {object} rule - 已规范化的规则。
 * @returns {string}
 */
export function describeRule(rule) {
	if (rule.pause === true) {
		const parts = [`停用 ${rule.use}`]
		if (rule.channel !== undefined) parts.push(`通道 ${rule.channel}`)
		if (rule.continuable !== undefined) parts.push(rule.continuable ? '仅团队成员/后台' : '仅一次性子代理')
		if (rule.folders !== undefined) parts.push(`目录 ${rule.folders.join(' , ')}`)
		if (rule.exceptFolders !== undefined) parts.push(`目录不含 ${rule.exceptFolders.join(' , ')}`)
		if (rule.time !== undefined) parts.push(timeText(rule.time))
		return parts.length === 1 ? `${parts[0]}（无条件）` : parts.join(' · ')
	}
	const parts = [`→ ${rule.use}`]
	if (rule.channel !== undefined) parts.push(`通道 ${rule.channel}`)
	if (rule.continuable === true) parts.push('仅团队成员/后台')
	if (rule.continuable === false) parts.push('仅一次性子代理')
	if (rule.label !== undefined) parts.push(`标签 ${rule.label}`)
	if (rule.member !== undefined) parts.push(`成员名 ${rule.member}`)
	if (rule.intent !== undefined) parts.push(`意图 ${rule.intent}`)
	if (rule.folders !== undefined) parts.push(`目录 ${rule.folders.join(' , ')}`)
	if (rule.exceptFolders !== undefined) parts.push(`目录不含 ${rule.exceptFolders.join(' , ')}`)
	if (rule.tokens !== undefined) parts.push(`父会话 ≥${rule.tokens} tokens`)
	if (rule.effort !== undefined) parts.push(`推理档 ${rule.effort}`)
	if (rule.images !== undefined) parts.push(rule.images ? '带图' : '不带图')
	if (rule.time !== undefined) parts.push(timeText(rule.time))
	return parts.join(' · ')
}

/** 时间窗的中文摘要。 */
function timeText(time) {
	const days = time.days === undefined ? '' : ` ${time.days.join('/')}`
	return `时段 ${time.from}–${time.to}${days}`
}
