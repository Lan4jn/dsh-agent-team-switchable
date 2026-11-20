/**
 * 用量统计（纯函数，零宿主依赖）—— 0.4.0 新增。
 *
 * 统计口径照官方 `dsh-token-usage-counter` 的做法（它在本机 DSH 版本上真跑过）：
 *   - 只在 `assistant/message` 这种**成功提交**的锚点上计数，失败/重试的尝试不计；
 *   - `TokenUsage` 的四个字段互不重叠：`inputTokens`（未命中缓存的输入）、
 *     `outputTokens`、`cacheReadTokens`、`cacheWriteTokens`；总 token = 四者之和；
 *   - 同一个 (turn, step) 只算一次（重复提交且数值相同则跳过）。
 *
 * 归属：每个子 agent 在创建/首次请求时被记到「它实际跑在哪个成员」上——
 * 键就是路由用的成员身份（`provider/model[:effort]`），所以用量和路由配置天然对得上。
 *
 * **只统计子 agent**（用户明确要求 Lead 先不管）：Lead 自己的消耗不在这里。
 *
 * 作者：hwj
 */

/** 小时桶保留多少个（图表画最近 24 小时，多留一档便于跨天观察）。 */
export const HOUR_BUCKETS = 48

/** 成员计数器：所有数字字段都从 0 起，缺字段一律按 0 处理。 */
function emptyMember() {
	return {
		/** v4：这个绑定当时属于哪个逻辑成员（报告按它聚合）。 */
		member: undefined,
		runs: 0,
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		/** 来源分布：rule / weight / explicit / affinity / unmanaged / unknown */
		sources: {},
	}
}

/** 渠道明细行：报告里成员聚合行内嵌的那一条（保留四项 token，界面要显示入/出/缓存）。 */
function bindingDetail(row) {
	return {
		binding: row.binding,
		runs: row.runs,
		calls: row.calls,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheReadTokens: row.cacheReadTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		totalTokens: row.totalTokens,
	}
}

/** 一份空的累计记录（也是状态文件的默认形状）。 */
export function emptyUsage() {
	return {
		startedAt: new Date().toISOString(),
		/** memberKey -> 计数器 */
		members: {},
		/** childId -> 成员身份（运行期映射，不落盘：重启后由 requestHeader 兜底） */
		children: {},
		/** childId -> 已消费的事件序号（避免同一条事件被折两次） */
		consumed: {},
		/** childId -> { turn, step, total }：同一 (turn, step) 去重 */
		last: {},
		/** 规则命中计数：`#N *关键词*` -> 次数（图 3 用） */
		rules: {},
		/** 'YYYY-MM-DDTHH' -> { calls, totalTokens }（图 2 用） */
		hours: {},
	}
}

/** 取成员的计数器，没有就建一个。 */
function memberOf(usage, member) {
	const key = member === undefined || member === null || member === '' ? 'unknown' : String(member)
	const existing = usage.members[key]
	if (existing !== undefined) return existing
	const created = emptyMember()
	usage.members[key] = created
	return created
}

/**
 * 折一次 token 用量。
 *
 * @param {object} usage - 累计记录。
 * @param {string} member - 成员身份（memberKey）。
 * @param {object} counters - `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`。
 * @param {number} timeMs - 事件时间（毫秒）。
 */
export function foldTokenUsage(usage, member, counters, timeMs) {
	const record = memberOf(usage, member)
	record.calls += 1
	record.inputTokens += counters.inputTokens
	record.outputTokens += counters.outputTokens
	record.cacheReadTokens += counters.cacheReadTokens
	record.cacheWriteTokens += counters.cacheWriteTokens
	record.totalTokens += counters.inputTokens + counters.outputTokens + counters.cacheReadTokens + counters.cacheWriteTokens
	const hour = hourKeyOf(timeMs)
	const bucket = usage.hours[hour]
	if (bucket === undefined) usage.hours[hour] = { calls: 1, totalTokens: counters.inputTokens + counters.outputTokens + counters.cacheReadTokens + counters.cacheWriteTokens }
	else {
		bucket.calls += 1
		bucket.totalTokens += counters.inputTokens + counters.outputTokens + counters.cacheReadTokens + counters.cacheWriteTokens
	}
	pruneHours(usage)
}

/** 只保留最近 HOUR_BUCKETS 个小时桶，避免状态文件无限增长。 */
function pruneHours(usage) {
	const keys = Object.keys(usage.hours).sort()
	if (keys.length <= HOUR_BUCKETS) return
	for (const key of keys.slice(0, keys.length - HOUR_BUCKETS)) delete usage.hours[key]
}

/** 本地时区的 `YYYY-MM-DDTHH`。 */
export function hourKeyOf(timeMs) {
	const date = new Date(timeMs)
	const pad = (n) => String(n).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}`
}

/**
 * 把一个子 agent 记到它实际跑在的成员上（**幂等**：同一个 childId 只算一次 run）。
 *
 * @param {object} usage - 累计记录。
 * @param {string} childId - 子会话 id。
 * @param {string} member - 成员身份。
 * @param {{reason?: string, ruleIndex?: number|null, rule?: string}} [source] - 驱动来源。
 * @returns {boolean} 这次是否真的记了一笔（首次为 true）。
 */
export function attributeChild(usage, childId, binding, member, source = {}) {
	if (typeof childId !== 'string' || childId === '') return false
	if (usage.children[childId] !== undefined) return false
	const key = binding === undefined || binding === null || binding === '' ? 'unknown' : String(binding)
	usage.children[childId] = key
	const record = memberOf(usage, key)
	// v4：计数器挂在**绑定**（渠道×模型）上，同时记下它当时属于哪个逻辑成员，
	// 这样报告既能看到渠道级明细，也能按逻辑模型聚合。
	if (typeof member === 'string' && member !== '') record.member = member
	record.runs += 1
	const reason = typeof source.reason === 'string' && source.reason !== '' ? source.reason : 'unmanaged'
	record.sources[reason] = (record.sources[reason] ?? 0) + 1
	if (typeof source.rule === 'string' && source.rule !== '') {
		usage.rules[source.rule] = (usage.rules[source.rule] ?? 0) + 1
	}
	return true
}

/**
 * 判断这次 (turn, step) 是否该计数（同一 (turn, step) 重复提交只算一次）。
 *
 * @param {object} usage - 累计记录。
 * @param {string} childId - 子会话 id。
 * @param {number} turn - 轮次。
 * @param {number} step - 步。
 * @param {number} total - 本次的总 token（用于判断「重复提交且数值相同」）。
 * @returns {boolean} true = 该计。
 */
export function shouldCountCall(usage, childId, turn, step, total) {
	const previous = usage.last[childId]
	if (previous !== undefined && previous.turn === turn && previous.step === step) return false
	usage.last[childId] = { turn, step, total }
	return true
}

/**
 * 从 `assistant/message` 事件里取出用量四元组。
 *
 * @param {unknown} value - `event.data.usage`。
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number} | null}
 *   usage 缺席或字段非法时返回 null（适配器没报用量是正常情况，不该算成 0 调用）。
 */
export function countersFromUsage(value) {
	if (value === null || typeof value !== 'object') return null
	const num = (field) => (typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0 ? value[field] : undefined)
	const inputTokens = num('inputTokens')
	const outputTokens = num('outputTokens')
	if (inputTokens === undefined || outputTokens === undefined) return null
	const cacheReadTokens = num('cacheReadTokens') ?? 0
	const cacheWriteTokens = num('cacheWriteTokens') ?? 0
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens }
}

/**
 * 落盘用的精简快照：只留计数器（children/consumed/last 是运行期状态，重启后由
 * `session.requestHeader()` 兜底归属，不需要持久化）。
 *
 * @param {object} usage - 累计记录。
 * @returns {object} 可 JSON 化的对象。
 */
export function serializeUsage(usage) {
	return {
		version: 1,
		startedAt: usage.startedAt,
		members: usage.members,
		rules: usage.rules,
		hours: usage.hours,
	}
}

/**
 * 读回落盘快照；形状不对时返回空记录（首次启动是正常路径，不该抛）。
 *
 * @param {unknown} raw - `usage.json` 解析结果。
 * @returns {object} 累计记录。
 */
export function loadUsage(raw) {
	const usage = emptyUsage()
	if (raw === null || typeof raw !== 'object') return usage
	if (typeof raw.startedAt === 'string') usage.startedAt = raw.startedAt
	if (raw.members !== null && typeof raw.members === 'object') {
		for (const [key, value] of Object.entries(raw.members)) {
			const record = emptyMember()
			if (value !== null && typeof value === 'object' && typeof value.member === 'string' && value.member !== '') record.member = value.member
			for (const field of ['runs', 'calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
				const n = value === null || typeof value !== 'object' ? undefined : value[field]
				if (typeof n === 'number' && Number.isFinite(n) && n >= 0) record[field] = n
			}
			if (value !== null && typeof value === 'object' && value.sources !== null && typeof value.sources === 'object') {
				for (const [reason, count] of Object.entries(value.sources)) {
					if (typeof count === 'number' && Number.isFinite(count) && count >= 0) record.sources[reason] = count
				}
			}
			usage.members[key] = record
		}
	}
	for (const [key, value] of Object.entries(raw.rules === null || typeof raw.rules !== 'object' ? {} : raw.rules)) {
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage.rules[key] = value
	}
	for (const [key, value] of Object.entries(raw.hours === null || typeof raw.hours !== 'object' ? {} : raw.hours)) {
		const calls = value === null || typeof value !== 'object' ? undefined : value.calls
		const totalTokens = value === null || typeof value !== 'object' ? undefined : value.totalTokens
		if (typeof calls === 'number' && typeof totalTokens === 'number') usage.hours[key] = { calls, totalTokens }
	}
	return usage
}

/**
 * 组装给设置页用的报告。
 *
 * @param {object} usage - 累计记录。
 * @param {number} [nowMs] - 当前时间（测试可注入）。
 * @returns {object} `{ startedAt, totals, members, sources, rules, hours }`，全部按用量降序。
 */
export function usageReport(usage, nowMs = Date.now()) {
	const bindings = Object.entries(usage.members).map(([binding, record]) => ({ binding, ...record }))
	bindings.sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs || (a.binding < b.binding ? -1 : 1))
	// 按逻辑成员聚合（v4）：一个成员的多个渠道合成一行，渠道明细挂在 bindings 里。
	const byMember = new Map()
	for (const row of bindings) {
		const name = typeof row.member === 'string' && row.member !== '' ? row.member : row.binding
		const existing = byMember.get(name)
		if (existing === undefined) {
			const created = { member: name, runs: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, bindings: [] }
			byMember.set(name, created)
			for (const field of ['runs', 'calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) created[field] += row[field]
			created.bindings.push(bindingDetail(row))
		} else {
			for (const field of ['runs', 'calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) existing[field] += row[field]
			existing.bindings.push(bindingDetail(row))
		}
	}
	const members = [...byMember.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs || (a.member < b.member ? -1 : 1))
	const totals = { runs: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
	for (const row of members) {
		for (const field of Object.keys(totals)) totals[field] += row[field]
	}
	const rules = Object.entries(usage.rules).map(([rule, hits]) => ({ rule, hits })).sort((a, b) => b.hits - a.hits)
	// 来源分布按**绑定**统计（成员聚合行没有 sources 字段）。
	const sources = {}
	for (const row of bindings) {
		for (const [reason, count] of Object.entries(row.sources ?? {})) sources[reason] = (sources[reason] ?? 0) + count
	}
	// 最近 24 个小时桶：缺的补 0，图表才有连续的横轴。
	const hours = []
	for (let offset = 23; offset >= 0; offset -= 1) {
		const key = hourKeyOf(nowMs - offset * 3600_000)
		const bucket = usage.hours[key]
		hours.push({ hour: key, calls: bucket === undefined ? 0 : bucket.calls, totalTokens: bucket === undefined ? 0 : bucket.totalTokens })
	}
	return {
		startedAt: usage.startedAt,
		totals,
		members,
		bindings,
		rules,
		sources: Object.entries(sources).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
		hours,
	}
}
