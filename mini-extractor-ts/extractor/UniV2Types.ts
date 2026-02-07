import type { Address } from 'abitype'

export interface PoolCacheRecord {
  address: Address
  token0: Address
  token1: Address
  factory: Address
}

export interface TokenInfo {
  address: string
  symbol: string
  name: string
  decimals: number
}

export interface PoolState {
  address: string
  token0: TokenInfo
  token1: TokenInfo
  reserve0: bigint
  reserve1: bigint
  fee: number
  provider: string
}

export interface FactoryV2 {
  address: Address
  provider: string
  fee: number
  initCodeHash: string
}

export interface SyncState {
  [factoryAddress: string]: number
}
