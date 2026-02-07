import {
  type Address,
  erc20Abi,
  type Hex,
  hexToString,
  type PublicClient,
  trim,
} from 'viem'
import { erc20Abi_bytes32 } from '../lib/abi.js'
import { logger } from '../lib/logger.js'
import { Token } from '../lib/token.js'
import { PermanentCache } from './PermanentCache.js'

interface TokenCacheRecord {
  address: Address
  name: string
  symbol: string
  decimals: number
}

export class TokenManager {
  client: PublicClient
  tokens: Map<Address, Token> = new Map()
  tokenPermanentCache: PermanentCache<TokenCacheRecord>

  constructor(client: PublicClient, ...paths: string[]) {
    this.client = client
    this.tokenPermanentCache = new PermanentCache(...paths)
  }

  async addCachedTokens() {
    const cachedRecords = await this.tokenPermanentCache.getAllRecords()
    cachedRecords.forEach((r) => {
      this.addToken(
        new Token({
          ...r,
          chainId: this.client.chain?.id as number,
        }),
        false,
      )
    })
    logger.info('Loaded', cachedRecords.length, 'cached tokens')
  }

  addToken(token: Token, addToCache = true) {
    const addr = token.address.toLowerCase() as Address
    if (!this.tokens.has(addr)) {
      this.tokens.set(addr, token)

      if (addToCache) {
        this.tokenPermanentCache.add({
          address: token.address as Address,
          name: token.name as string,
          symbol: token.symbol as string,
          decimals: token.decimals,
        })
      }
    }
  }

  addTokens(tokens: Token[]) {
    tokens.forEach((t) => {
      this.addToken(t)
    })
  }

  async findToken(address: Address): Promise<Token | undefined> {
    const addr = address.toLowerCase() as Address
    const cached = this.tokens.get(addr)
    if (cached !== undefined) return cached

    try {
      const results = await this.client.multicall({
        contracts: [
          { address, abi: erc20Abi, functionName: 'decimals' },
          { address, abi: erc20Abi, functionName: 'symbol' },
          { address, abi: erc20Abi, functionName: 'name' },
        ],
        allowFailure: true,
      })

      const [decimalsR, symbolR, nameR] = results

      if (decimalsR.status === 'failure') {
        return
      }
      if (symbolR.status === 'failure' || nameR.status === 'failure') {
        // bytes32 fallback
        try {
          const b32Results = await this.client.multicall({
            contracts: [
              { address, abi: erc20Abi_bytes32, functionName: 'decimals' },
              { address, abi: erc20Abi_bytes32, functionName: 'symbol' },
              { address, abi: erc20Abi_bytes32, functionName: 'name' },
            ],
            allowFailure: false,
          })
          const [decimals, symbol, name] = b32Results

          const newToken = new Token({
            chainId: this.client.chain?.id as number,
            address: address,
            decimals: Number(decimals),
            name: hexToString(trim(name as Hex, { dir: 'right' })),
            symbol: hexToString(trim(symbol as Hex, { dir: 'right' })),
          })
          this.addToken(newToken)
          return newToken
        } catch (e) {
          logger.extractorError(`Token bytes32 downloading error ${address}`, e)
        }
        return
      }

      const newToken = new Token({
        chainId: this.client.chain?.id as number,
        address: address,
        decimals: Number(decimalsR.result as number),
        symbol: symbolR.result as string,
        name: nameR.result as string,
      })
      this.addToken(newToken)
      return newToken
    } catch (e) {
      logger.extractorError(`Token downloading error ${address}`, e)
    }
  }

  getKnownToken(addr: Address): Token | undefined {
    return this.tokens.get(addr.toLowerCase() as Address)
  }
}
