import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

export const packageName = 'dsh-remote-team-bridge'
export const namespace = 'remote-team-bridge'

export interface BridgeStatusView {
  enabled: boolean
  port: number
  host: string
  activeConnections: number
  pairedDevicesCount: number
}

export interface PairingCodeView {
  code: string
  expiresAt: number
}

export interface PairedDeviceEntry {
  hostId: string
  pairedAt: number
  lastActiveAt: number
  fingerprint: string
}

export interface PairedDevicesListView {
  devices: PairedDeviceEntry[]
}

export interface RevokeDeviceRequest {
  hostId: string
}

export interface SimpleActionResult {
  success: boolean
}

const statusView = () => z.object({
  enabled: z.boolean(),
  port: z.number().int().nonnegative(),
  host: z.string(),
  activeConnections: z.number().int().nonnegative(),
  pairedDevicesCount: z.number().int().nonnegative(),
})

const pairingCodeView = () => z.object({
  code: z.string(),
  expiresAt: z.number(),
})

const pairedDevicesView = () => z.object({
  devices: z.array(z.object({
    hostId: z.string(),
    pairedAt: z.number(),
    lastActiveAt: z.number(),
    fingerprint: z.string(),
  })),
})

const revokeRequest = () => z.object({
  hostId: z.string(),
})

const simpleResult = () => z.object({
  success: z.boolean(),
})

const empty = () => z.object({})

const lazy = <T>(fn: () => T): (() => T) => {
  let val: T | undefined
  return () => (val ??= fn())
}

const requests = {
  getStatus: {
    type: 'EmptyRequest',
    create: lazy(empty),
    result: lazy(statusView),
    resultSymbol: `${packageName}/types#BridgeStatusView`,
  },
  createPairingCode: {
    type: 'EmptyRequest',
    create: lazy(empty),
    result: lazy(pairingCodeView),
    resultSymbol: `${packageName}/types#PairingCodeView`,
  },
  listPairedDevices: {
    type: 'EmptyRequest',
    create: lazy(empty),
    result: lazy(pairedDevicesView),
    resultSymbol: `${packageName}/types#PairedDevicesListView`,
  },
  revokePairedDevice: {
    type: 'RevokeDeviceRequest',
    create: lazy(revokeRequest),
    result: lazy(simpleResult),
    resultSymbol: `${packageName}/types#SimpleActionResult`,
  },
}

export const descriptors: readonly InvocationDescriptor[] = Object.entries(requests).map(([method, req]) => ({
  id: `${packageName}#${namespace}/${method}`,
  service: 'remoteTeamBridge',
  namespace,
  method,
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: {
      mode: 'strict',
      typeSymbol: `${packageName}/types#${req.type}`,
      create: req.create,
    },
  }],
  result: {
    mode: 'strict',
    typeSymbol: req.resultSymbol,
    create: req.result,
  },
}))

export const TYPERT_REMOTE: TypertRemoteContribution = { package: packageName, descriptors }
export default TYPERT_REMOTE
