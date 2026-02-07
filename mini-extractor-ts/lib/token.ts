import { type Address, getAddress } from 'viem'

/**
 * Minimal Token class
 */
export class Token {
  public readonly chainId: number
  public readonly decimals: number
  public readonly symbol?: string | undefined
  public readonly name?: string | undefined
  public readonly address: Address
  public readonly tokenURI?: string | undefined

  public constructor({
    chainId,
    address,
    decimals,
    symbol,
    name,
    tokenURI,
  }: {
    chainId: number | string
    address: string
    decimals: number | string
    symbol?: string | undefined
    name?: string | undefined
    tokenURI?: string | undefined
  }) {
    this.chainId = Number(chainId)
    this.decimals = Number(decimals)
    this.symbol = symbol
    this.name = name
    this.tokenURI = tokenURI
    this.address = getAddress(address)
  }

  public sortsBefore(other: Token): boolean {
    return this.address.toLowerCase() < other.address.toLowerCase()
  }
}
