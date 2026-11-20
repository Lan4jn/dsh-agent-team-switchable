/**
 * lib/team-routing.js - 团队路由优先级判定与状态生命周期辅助
 *
 * 优先级链：
 * 1. memberoverride (choices[member.id], 仅当 turn > effectiveAfterTurn 生效)
 * 2. createexplicit (request.agentOptions 有具体非自注入的 model/provider 字段)
 * 3. captureddefault (initials[member.id].source === 'default')
 * 4. auto (由 lib/rules.js 规划)
 * 5. inherit (官方默认)
 *
 * 手动指定路由（前 3 级）标记 isManualFixed: true，在 request-error 中放行 next()，禁止 failover。
 * 当 choice 设为 null 时，在当前 turn 结束前继续保持原固定路由，下一轮 turn 降级回 initial。
 */

/**
 * 校验并提取显式创建路由。
 * 严禁将任意不包含 model 的 agentOptions（如 {}）或自注入标记误判为显式！
 * @param {any} agentOptions
 * @returns {object|null}
 */
export function extractExplicitRoute(agentOptions) {
	if (agentOptions === null || typeof agentOptions !== 'object') return null
	// 若标记为插件内部自注入，则非用户显式创建
	if (agentOptions.__tmmInjected === true) return null

	// 优先检查显式嵌套的 agentOptions
	const target = (agentOptions.agentOptions && typeof agentOptions.agentOptions === 'object')
		? agentOptions.agentOptions
		: agentOptions

	if (typeof target.model !== 'string' || target.model.trim().length === 0) return null
	const provider = typeof target.provider === 'string' && target.provider.trim().length > 0
		? target.provider.trim()
		: undefined
	if (provider === undefined) return null

	const result = {
		provider,
		model: target.model.trim(),
	}
	if (typeof target.reasoningEffort === 'string' && target.reasoningEffort.trim().length > 0) {
		result.reasoningEffort = target.reasoningEffort.trim()
	}
	return result
}

/**
 * 是否属于手动固定路由（无 failover 重试候选）。
 * @param {object|null} resolution
 * @returns {boolean}
 */
export function isManualFixedRoute(resolution) {
	if (resolution === null || typeof resolution !== 'object') return false
	return resolution.level === 'memberoverride'
		|| resolution.level === 'createexplicit'
		|| resolution.level === 'captureddefault'
}

/**
 * 解析团队子代理路由。
 * @param {object} params
 * @param {string} params.agentId
 * @param {number} [params.turn=0]
 * @param {object} [params.teamRecord]
 * @param {any} [params.agentOptions]
 * @returns {{ level: 'memberoverride'|'createexplicit'|'captureddefault', route: object, isManualFixed: true } | null}
 */
export function resolveTeamRoute({ agentId, turn = 0, teamRecord, agentOptions }) {
	if (teamRecord !== null && typeof teamRecord === 'object') {
		// 1. Level 1: memberoverride
		const choice = teamRecord.choices?.[agentId]
		if (choice !== undefined) {
			const effectiveAfterTurn = choice.effectiveAfterTurn ?? 0
			// 仅当 turn > effectiveAfterTurn 时生效新设置
			if (turn > effectiveAfterTurn) {
				if (choice.selection !== null && choice.selection !== undefined) {
					return {
						level: 'memberoverride',
						route: choice.selection,
						isManualFixed: true,
					}
				}
				// 若选择设为 null（清除覆盖恢复继承/创建），下轮 turn 降级继续检查 Level 2 / 3
			} else if (choice.heldSelection !== undefined && choice.heldSelection !== null) {
				// 当轮保护：仅当存在修改前已生效的覆盖路由 (heldSelection) 时才维持
				return {
					level: 'memberoverride',
					route: choice.heldSelection,
					isManualFixed: true,
				}
			}
		}

		// 检查 teamRecord.initials 是否记录了创建期显式指定 (source === 'explicit')
		const initial = teamRecord.initials?.[agentId]
		if (initial && initial.source === 'explicit' && initial.selection) {
			return {
				level: 'createexplicit',
				route: initial.selection,
				isManualFixed: true,
			}
		}
	}

	// 2. Level 2: createexplicit (当且仅当 initial 未锁定为 'default' 快照时，才由 agentOptions 判定 explicit)
	const initial = teamRecord?.initials?.[agentId]
	if (!initial || initial.source !== 'default') {
		const explicit = extractExplicitRoute(agentOptions)
		if (explicit !== null) {
			return {
				level: 'createexplicit',
				route: explicit,
				isManualFixed: true,
			}
		}
	}

	// 3. Level 3: captureddefault
	if (teamRecord !== null && typeof teamRecord === 'object') {
		if (initial !== undefined && initial !== null) {
			const selection = initial.selection ?? (initial.provider ? initial : null)
			if (selection !== null && initial.source !== 'explicit') {
				return {
					level: 'captureddefault',
					route: selection,
					source: initial.source ?? 'default',
					isManualFixed: true,
				}
			}
		}
	}

	// 未命中手动固定，交由后续 auto / inherit
	return null
}
