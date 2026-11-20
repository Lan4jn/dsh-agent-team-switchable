/**
 * test/ui-portal.mjs
 * 客户端模型设置弹窗 Portal 与事件穿透防护回归测试。
 *
 * 根因（Client Slots Inspector 证实）：
 * 新版 DSH 中 conversation.session.header.actions 的 ancestor (.kiGsTW_titleCluster)
 * 带有 overflow: clip 与 mask-image，要求覆盖层必须使用 Portal。旧 client.js 直接在
 * Slot 内部 inline 返回 `<div class="tmm-team-popup">`，导致弹窗虽然 open=true，但被
 * 祖先容器裁切而不可见。
 *
 * 修复验证：
 * 1. 使用 react-dom 的 createPortal 挂载到 document.body，彻底逃逸 header 的 clip 容器。
 * 2. handleClickOutside 必须判定并排除 anchorRef（trigger 按钮），防止点击齿轮触发 close 后又被 onClick 重新打开。
 * 3. 真实 DOM 模拟下触发 pointerdown 事件验证 outside click 行为。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

function loadClientInEnv(doc) {
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const sandbox = {
    console,
    document: doc,
    window: {
      location: { origin: 'http://127.0.0.1:49549', hostname: '127.0.0.1' },
      __ModuleLoader__: { load(def) { sandbox.window.__ModuleLoader__.loaded = def } },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' })
  const def = sandbox.window.__ModuleLoader__.loaded

  let capturedPortalTarget = null
  let capturedPortalChild = null
  const reactDom = {
    createPortal(child, target) {
      capturedPortalTarget = target
      capturedPortalChild = child
      return { $$typeof: Symbol.for('react.portal'), child, target }
    },
  }

  const effects = []
  const createdRefs = []
  const react = {
    createElement: (type, props, ...children) => {
      const el = {
        type,
        props: props || {},
        children: children.flat(),
      }
      // 模拟 React 赋值 ref
      if (props && props.ref && typeof props.ref === 'object') {
        props.ref.current = doc.createElement(typeof type === 'string' ? type : 'div')
      }
      return el
    },
    Fragment: Symbol.for('react.fragment'),
    useState: (init) => {
      let val = init
      return [val, (setter) => { val = typeof setter === 'function' ? setter(val) : setter }]
    },
    useEffect: (fn, deps) => { effects.push({ fn, deps }) },
    useRef: (init) => {
      const r = { current: init }
      createdRefs.push(r)
      return r
    },
  }

  const mod = def.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return reactDom
    throw new Error(`Unexpected require: ${name}`)
  })

  return {
    mod,
    reactDom,
    effects,
    getPortalTarget: () => capturedPortalTarget,
    getPortalChild: () => capturedPortalChild,
  }
}

function createDOM() {
  const listeners = new Map()
  const bodyChildren = []

  const doc = {
    body: {
      appendChild(node) {
        bodyChildren.push(node)
        node.parentElement = doc.body
        return node
      },
      removeChild(node) {
        const idx = bodyChildren.indexOf(node)
        if (idx !== -1) bodyChildren.splice(idx, 1)
        node.parentElement = null
        return node
      },
      get children() {
        return bodyChildren
      },
    },
    head: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      dataset: {},
      textContent: '',
      parentElement: null,
      children: [],
      appendChild(c) { this.children.push(c); c.parentElement = this; return c },
      setAttribute() {},
      style: {},
      contains(target) {
        if (target === this) return true
        return this.children.some(c => c.contains ? c.contains(target) : c === target)
      },
    }),
    addEventListener(event, fn, useCapture) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ fn, useCapture })
    },
    removeEventListener(event, fn, useCapture) {
      const arr = listeners.get(event) || []
      const idx = arr.findIndex(l => l.fn === fn && l.useCapture === useCapture)
      if (idx !== -1) arr.splice(idx, 1)
    },
    _dispatch(event, e) {
      const arr = listeners.get(event) || []
      for (const { fn } of arr) fn(e)
    },
    _listeners: listeners,
  }
  return doc
}

test('TeamPopup 必须使用 react-dom.createPortal 挂载到 document.body 逃逸 header clip 容器', () => {
  const doc = createDOM()
  const { mod, getPortalTarget } = loadClientInEnv(doc)

  const LocalPopup = mod._TeamPopup
  assert.ok(LocalPopup, 'lib/client.js 必须导出 _TeamPopup')

  const rendered = LocalPopup({
    sessionId: 'lead-1',
    activeNames: ['worker-1'],
    onClose: () => {},
  })

  const portalTarget = getPortalTarget()
  assert.equal(portalTarget, doc.body, '弹窗必须通过 createPortal 挂载到 document.body')
  assert.equal(rendered.$$typeof, Symbol.for('react.portal'), 'TeamPopup 返回值必须是 React Portal')
})

test('TeamPopup 可见矩形显式排除 macOS 窗口拖动区，且仍挂载到 body', () => {
  const doc = createDOM()
  const { mod, getPortalTarget, getPortalChild } = loadClientInEnv(doc)
  mod._TeamPopup({ sessionId: 'lead-1', activeNames: ['worker-1'], onClose: () => {} })
  const panel = getPortalChild()
  assert.equal(getPortalTarget(), doc.body)
  assert.equal(panel.props.className, 'tmm-team-popup')
  assert.equal(panel.props['data-window-drag-exclude'], '', '排除应声明在可见面板自身，而非不产生矩形的 body portal')
})

test('handleClickOutside 排除 anchorRef，点击 trigger 外部时正常关闭', () => {
  const doc = createDOM()
  const { mod, effects } = loadClientInEnv(doc)

  let closed = 0
  const triggerEl = doc.createElement('button')
  const anchorRef = { current: triggerEl }

  const LocalPopup = mod._TeamPopup
  LocalPopup({
    sessionId: 'lead-1',
    activeNames: ['worker-1'],
    anchorRef,
    onClose: () => { closed++ },
  })

  // 运行挂载副作用注册全局事件
  for (const { fn } of effects) fn()

  // 1. 点击 trigger 按钮（anchorRef）：必须被忽略，不触发 onClose
  doc._dispatch('pointerdown', { target: triggerEl })
  assert.equal(closed, 0, '点击 trigger 时不得调用 onClose')

  // 2. 点击外部区域（如 body 或其他元素）：必须触发 onClose
  const outsideEl = doc.createElement('div')
  doc._dispatch('pointerdown', { target: outsideEl })
  assert.equal(closed, 1, '点击外部区域必须触发 onClose')

  // 3. 点击 Escape 键：触发 onClose
  doc._dispatch('keydown', { key: 'Escape' })
  assert.equal(closed, 2, '按下 Escape 必须触发 onClose')
})
