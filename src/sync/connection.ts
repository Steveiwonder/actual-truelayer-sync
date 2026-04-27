import { refreshToken } from '../truelayer/truelayer'
import { syncAccount } from './account'
import { fetchAccountMap } from './accounts'
import { currentDate } from '../utils/date'
import type { Connection, Config } from '../config/schema'
import { logNetworkError } from '../utils/logging'
import type { TrueLayerAccount, TrueLayerCard } from '../truelayer/types'

export async function syncConnection(connection: Connection, config: Config): Promise<Connection | undefined> {
  const startedAt = Date.now()
  console.log(`\n[${connection.name}] --- Syncing @ ${new Date().toISOString()} ---`)
  console.log(`[${connection.name}] Authenticating with TrueLayer...`)

  let accessToken: string
  let newRefreshToken: string
  try {
    const { access_token, refresh_token } = await refreshToken(
      config.env.TRUELAYER_CLIENT_ID,
      config.env.TRUELAYER_CLIENT_SECRET,
      connection.refreshToken,
    )
    accessToken = access_token
    newRefreshToken = refresh_token
  } catch (err) {
    logNetworkError(`[${connection.name}] Authentication failed:`, err)
    return undefined
  }

  const tokenChanged = newRefreshToken !== connection.refreshToken
  console.log(`[${connection.name}] └ Refresh token ${tokenChanged ? 'CHANGED' : 'unchanged'}.`)

  let trueLayerAccountsById: Map<string, TrueLayerAccount | TrueLayerCard>
  try {
    trueLayerAccountsById = await fetchAccountMap(connection, accessToken)
  } catch (err) {
    logNetworkError(`[${connection.name}] Sync failed:`, err)
    return { ...connection, refreshToken: newRefreshToken }
  }

  try {
    const updatedAccounts = await Promise.all(
      connection.accounts.map(async (configAccount) => {
        const hadTransactions = await syncAccount(
          configAccount,
          connection,
          accessToken,
          trueLayerAccountsById,
          config.includeCategoryInNotes,
        )
        return hadTransactions ? { ...configAccount, lastSyncDate: currentDate() } : configAccount
      }),
    )

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[${connection.name}] Done in ${elapsed}s.`)

    return { ...connection, refreshToken: newRefreshToken, accounts: updatedAccounts }
  } catch (err) {
    logNetworkError(`[${connection.name}] Sync failed:`, err)
    return { ...connection, refreshToken: newRefreshToken }
  }
}
