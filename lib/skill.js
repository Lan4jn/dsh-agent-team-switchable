/**
 * 随插件分发的技能（skill）加载 —— 0.5.0 新增。
 *
 * 为什么把技能放进包里：让用户"通过 AI 配置路由"的前提是**会话里的 Agent 能发现这套接口**。
 * 把 SKILL.md 作为唯一事实源放 `skills/model-routing/SKILL.md`，Host 半侧启动时读它并注册进
 * `ctx.skills`——这样用户说一句「帮我配路由」，Agent 就能加载到这个技能，而不是靠人去翻 README。
 *
 * 同一份文件也可以直接复制到 `~/.agents/skills/model-routing/SKILL.md` 给没装插件的环境用。
 *
 * 作者：hwj
 */

import { readFile } from 'node:fs/promises'

/** 最小 frontmatter 解析：只认 `---` 包起来的 `key: value` 行，够 SKILL.md 用。 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * 解析一份 SKILL.md。
 *
 * 只支持单行标量（name / description / whenToUse）——多行 YAML、嵌套、列表一律不处理，
 * 因为这里的目的不是通用 YAML，而是「读回我们自己写的那份文件」。
 *
 * @param {unknown} text - 文件内容。
 * @returns {{name: string, description: string, whenToUse?: string, content: string} | undefined}
 *   frontmatter 缺失或缺 name/description 时返回 undefined（调用方按「没有技能」处理）。
 */
export function parseSkillMarkdown(text) {
	if (typeof text !== 'string') return undefined
	const matched = FRONTMATTER.exec(text)
	if (matched === null) return undefined
	const meta = {}
	for (const line of matched[1].split(/\r?\n/)) {
		const at = line.indexOf(':')
		if (at <= 0) continue
		const key = line.slice(0, at).trim()
		const value = line.slice(at + 1).trim()
		if (key !== '' && value !== '') meta[key] = value
	}
	const name = typeof meta.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) ? meta.name : undefined
	const description = typeof meta.description === 'string' && meta.description !== '' ? meta.description : undefined
	if (name === undefined || description === undefined) return undefined
	return {
		name,
		description,
		...(typeof meta.whenToUse === 'string' && meta.whenToUse !== '' ? { whenToUse: meta.whenToUse } : {}),
		content: text.slice(matched[0].length).replace(/^\s+/, ''),
	}
}

/**
 * 从文件读技能。
 *
 * 读不到一律返回 undefined：技能是**增强**，包被裁剪、文件缺失都不该让插件启动失败。
 *
 * @param {URL | string} url - SKILL.md 的位置。
 * @returns {Promise<object | undefined>} 解析结果，或 undefined。
 */
export async function loadSkillFile(url) {
	try {
		return parseSkillMarkdown(await readFile(url, 'utf8'))
	} catch {
		return undefined
	}
}
