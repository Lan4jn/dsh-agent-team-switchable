/** Execute published SDK code in the test realm, never the unit primitive stub. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsx from 'react/jsx-runtime'
import * as cordis from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import * as stores from '@deepseek-ai/dsh-client-store'

const resolve = createRequire(import.meta.url).resolve

/** Tree-select the real, exported icons used here without unrelated markdown deps. */
export function publishedIcons() {
  const source = readFileSync(resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8')
  const parsed = ts.createSourceFile('published-primitives.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const exports = new Set<string>()
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const entry of statement.exportClause.elements) exports.add(entry.name.text)
    }
  }
  const names = ['IconSettingsOutlineArtwork', 'IconSettingsOutlineRegular', 'IconCloseOutlineArtwork', 'IconCloseOutlineRegular']
  for (const name of ['IconSettingsOutlineRegular', 'IconCloseOutlineRegular']) {
    if (!exports.has(name)) throw new Error(`Published primitive missing export: ${name}`)
  }
  const declarations = parsed.statements.filter(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)))
  if (declarations.length !== names.length) throw new Error('Published icon declarations changed; review SDK test loader')
  return runInNewContext(`${declarations.map(item => item.getText(parsed)).join('\n')}\n({ IconSettingsOutlineRegular, IconCloseOutlineRegular })`, { ...jsx })
}

/** The SDK's ModuleLoader factory runs unchanged with its exact public deps. */
export function publishedClient(packageName: string) {
  const dependencies: Record<string, unknown> = {
    react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient, 'react/jsx-runtime': jsx,
    '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-ui-slots': slots,
    '@deepseek-ai/dsh-client-store': stores, '@deepseek-ai/dsh-client-ui-primitives': publishedIcons(),
  }
  let value: any
  const window = { __ModuleLoader__: { load: ({ factory }: { factory: (require: (id: string) => unknown) => unknown }) => {
    value = factory(id => {
      if (!(id in dependencies)) throw new Error(`Unexpected SDK dependency: ${id}`)
      return dependencies[id]
    })
  } } }
  runInNewContext(readFileSync(resolve(`${packageName}/client`), 'utf8'), { window, document, console, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval })
  if (value === undefined) throw new Error(`SDK bundle did not load: ${packageName}`)
  return value
}
