/**
 * lib/team-state.js - 团队设置持久化存储与全局原子并发队列
 *
 * 保证：
 * 1. 全局文件锁队列（单一 Promise 链），杜绝跨 team 并发读写覆盖；
 * 2. .tmp + rename 原子替换落盘；
 * 3. 内存深拷贝冻结（immutable），写失败不影响内存；
 * 4. initials 带 source ('creation' | 'default' | 'auto')；
 * 5. choices 记录 { selection, effectiveAfterTurn }。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 冻结纯数据对象，防止引用污染。
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
export function immutable(value) {
	if (value === null || typeof value !== 'object') return value
	const detached = structuredClone(value)
	const freeze = (item) => {
		if (item === null || typeof item !== 'object') return
		for (const child of Object.values(item)) freeze(child)
		Object.freeze(item)
	}
	freeze(detached)
	return detached
}

/**
 * 创建空白团队记录。
 * @param {string} teamId
 * @returns {object}
 */
export function createEmptyTeam(teamId) {
	return {
		teamId,
		revision: 0,
		defaultModel: null,
		initials: {}, // { [memberId]: { selection, source: 'creation'|'default'|'auto' } }
		choices: {},  // { [memberId]: { selection: object|null, effectiveAfterTurn: number } }
	}
}

export class TeamStateStore {
	/**
	 * @param {string} dirPath - 存放 teams.json 的目录
	 */
	constructor(dirPath) {
		this.dirPath = dirPath
		this.filePath = join(dirPath, 'teams.json')
		/** @type {Map<string, object>} */
		this.teams = new Map()
		/** 全局写文件串行链，防止跨 team 覆盖丢写 */
		this.writeTail = Promise.resolve()
		this.initialized = false
	}

	async init() {
		await mkdir(this.dirPath, { recursive: true })
		try {
			const raw = await readFile(this.filePath, 'utf8')
			const data = JSON.parse(raw)
			if (data !== null && typeof data === 'object') {
				for (const [id, record] of Object.entries(data)) {
					if (record !== null && typeof record === 'object') {
						this.teams.set(id, immutable(record))
					}
				}
			}
		} catch {
			// 文件不存在或格式损坏，从空白开始
		}
		this.initialized = true
	}

	/**
	 * 获取指定团队记录（不可变）。
	 * @param {string} teamId
	 * @returns {Readonly<object>}
	 */
	getTeam(teamId) {
		const team = this.teams.get(teamId)
		if (team !== undefined) return team
		return immutable(createEmptyTeam(teamId))
	}

	/**
	 * 全局原子排队更新团队数据。
	 * @param {string} teamId
	 * @param {(team: object) => object | Promise<object>} mutator
	 * @returns {Promise<Readonly<object>>}
	 */
	async updateTeam(teamId, mutator) {
		const prevOp = this.writeTail
		let resolveCurrent
		const currentOp = new Promise((resolve) => {
			resolveCurrent = resolve
		})
		this.writeTail = currentOp

		try {
			await prevOp.catch(() => {})

			// 获取当前未冻结草稿
			const current = structuredClone(this.getTeam(teamId))
			const draft = await mutator(current)
			if (draft === null || typeof draft !== 'object') {
				throw new Error('updateTeam mutator 必须返回有效的 team 对象')
			}
			draft.revision = (draft.revision ?? 0) + 1
			const frozen = immutable(draft)

			// 预先组装全部 team 内存字典
			const allTeams = {}
			for (const [id, team] of this.teams.entries()) {
				allTeams[id] = team
			}
			allTeams[teamId] = frozen

			// 原子落盘：先写入唯一命名 .tmp 文件，再 rename
			const tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
			await writeFile(tmpPath, JSON.stringify(allTeams, null, 2), 'utf8')
			await rename(tmpPath, this.filePath)

			// 写入成功后更新内存
			this.teams.set(teamId, frozen)
			return frozen
		} finally {
			resolveCurrent()
		}
	}
}
