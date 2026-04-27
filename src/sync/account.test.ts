import { describe, it, expect, vi, beforeEach } from 'vitest'
import { syncAccount } from './account'
import type { Account, Connection } from '../config/schema'
import type { TrueLayerAccount, TrueLayerCard, TrueLayerTransaction } from '../truelayer/types'

vi.mock('../actual/actual')
vi.mock('../truelayer/truelayer')

import * as actual from '../actual/actual'
import * as truelayer from '../truelayer/truelayer'

const baseConnection: Connection = {
  name: 'My Bank',
  refreshToken: 'token',
  accounts: [],
}

const baseAccount: Account = {
  trueLayerId: 'acc-1',
  actualId: 'actual-acc-1',
  friendlyName: 'Current Account',
}

const mockTrueLayerAccount: TrueLayerAccount = {
  account_id: 'acc-1',
  account_type: 'TRANSACTION',
  currency: 'GBP',
  display_name: 'Current Account',
  update_timestamp: '2026-04-24T00:00:00Z',
  account_number: {},
  provider: { provider_id: 'first-direct' },
}

const mockTransaction: TrueLayerTransaction = {
  transaction_id: 'txn-1',
  timestamp: '2026-04-20T10:00:00Z',
  description: 'Coffee Shop',
  amount: 3.5,
  currency: 'GBP',
  transaction_type: 'DEBIT',
  transaction_category: 'PURCHASE',
  transaction_classification: [],
}

const emptyAccountsById = new Map<string, TrueLayerAccount | TrueLayerCard>()
const accountsById = new Map<string, TrueLayerAccount | TrueLayerCard>([['acc-1', mockTrueLayerAccount]])

describe('syncAccount', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches account transactions and imports them', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-1'], updated: [] })

    await syncAccount({ ...baseAccount }, baseConnection, 'access-token', accountsById, false)

    expect(truelayer.getAccountTransactions).toHaveBeenCalledWith('access-token', 'acc-1', undefined)
    expect(actual.importTransactions).toHaveBeenCalledWith('actual-acc-1', expect.any(Array))
  })

  it('calls getCardTransactions when resolveIsCard returns true', async () => {
    vi.mocked(truelayer.getCardTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-1'], updated: [] })

    await syncAccount({ ...baseAccount, isCard: true }, baseConnection, 'access-token', accountsById, false)

    expect(truelayer.getCardTransactions).toHaveBeenCalledWith('access-token', 'acc-1', undefined)
    expect(truelayer.getAccountTransactions).not.toHaveBeenCalled()
  })

  it('passes fromDate based on lastSyncDate', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: [], updated: [] })

    await syncAccount(
      { ...baseAccount, lastSyncDate: '2026-04-24' },
      baseConnection,
      'access-token',
      accountsById,
      false,
    )

    expect(truelayer.getAccountTransactions).toHaveBeenCalledWith('access-token', 'acc-1', '2026-04-10')
  })

  it('does not call importTransactions when no transactions returned', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([])

    await syncAccount(baseAccount, baseConnection, 'access-token', emptyAccountsById, false)

    expect(actual.importTransactions).not.toHaveBeenCalled()
  })

  it('returns true after successful import', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-1'], updated: [] })

    const result = await syncAccount({ ...baseAccount }, baseConnection, 'access-token', accountsById, false)

    expect(result).toBe(true)
  })

  it('returns false when no transactions returned', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([])

    const result = await syncAccount({ ...baseAccount }, baseConnection, 'access-token', emptyAccountsById, false)

    expect(result).toBe(false)
  })
})
