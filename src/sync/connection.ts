import axios from 'axios'
import { refreshToken } from '../truelayer/truelayer'
import { syncAccount } from './account'
import { fetchAccountMap } from './accounts'
import type { Connection, Config } from '../config/schema'

export async function syncConnection(connection: Connection, config: Config): Promise<void> {
  const startedAt = Date.now()
  console.log(`\n[${connection.name}] --- Syncing @ ${new Date().toISOString()} ---`)
  console.log(`[${connection.name}] Authenticating with TrueLayer...`)
  try {
    const { access_token, refresh_token: newRefreshToken } = await refreshToken(
      config.env.TRUELAYER_CLIENT_ID,
      config.env.TRUELAYER_CLIENT_SECRET,
      connection.refreshToken,
    )

    const tokenChanged = newRefreshToken !== connection.refreshToken
    console.log(`[${connection.name}] └ Refresh token ${tokenChanged ? 'CHANGED' : 'unchanged'}.`)
    connection.refreshToken = newRefreshToken

    const trueLayerAccountsById = await fetchAccountMap(connection, access_token)

    for (const configAccount of connection.accounts) {
      const newLastSyncDate = await syncAccount(
        configAccount,
        connection,
        access_token,
        trueLayerAccountsById,
        config.includeCategoryInNotes,
      )
      if (newLastSyncDate) {
        configAccount.lastSyncDate = newLastSyncDate
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[${connection.name}] Done in ${elapsed}s.`)
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`[${connection.name}] Failed:`, err.response?.data ?? err.message)
    } else if (err instanceof Error) {
      console.error(`[${connection.name}] Failed:`, err.message)
    } else {
      console.error(`[${connection.name}] Failed:`, err)
    }
  }
}
