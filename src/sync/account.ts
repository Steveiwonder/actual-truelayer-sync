import { importTransactions } from '../actual/actual'
import { getAccountTransactions, getCardTransactions } from '../truelayer/truelayer'
import { transformTransactions } from '../transform/transform'
import { computeFromDate } from '../utils/date'
import { resolveIsCard } from '../utils/account'
import { buildImportSummary } from '../utils/logging'
import type { Account, Connection } from '../config/schema'
import type { TrueLayerAccount, TrueLayerCard } from '../truelayer/types'

export async function syncAccount(
  configAccount: Account,
  connection: Connection,
  accessToken: string,
  trueLayerAccountsById: Map<string, TrueLayerAccount | TrueLayerCard>,
  includeCategoryInNotes: boolean,
): Promise<boolean> {
  const prefix = `[${connection.name}][${configAccount.friendlyName}]`
  const fromDate = configAccount.lastSyncDate ? computeFromDate(configAccount.lastSyncDate) : undefined

  console.log(`${prefix} Fetching transactions${fromDate ? ` since ${fromDate}` : ''}...`)

  const isCard = resolveIsCard(configAccount, connection)
  const trueLayerTransactions = isCard
    ? await getCardTransactions(accessToken, configAccount.trueLayerId, fromDate)
    : await getAccountTransactions(accessToken, configAccount.trueLayerId, fromDate)

  const trueLayerAccount = trueLayerAccountsById.get(configAccount.trueLayerId)
  const transactions = transformTransactions(
    trueLayerTransactions,
    configAccount,
    trueLayerAccount,
    includeCategoryInNotes,
  )

  if (transactions.length === 0) {
    console.log(`${prefix} └ No transactions.`)
    return false
  }

  console.log(`${prefix} └ Found ${transactions.length} transactions.`)
  const dates = trueLayerTransactions.map((t) => t.timestamp).sort()
  const from = dates[0].slice(0, 10)
  const to = dates[dates.length - 1].slice(0, 10)
  const result = await importTransactions(configAccount.actualId, transactions)
  console.log(`${prefix} └ ${buildImportSummary(result.added.length, result.updated.length)} (${from} → ${to}).`)
  return true
}
