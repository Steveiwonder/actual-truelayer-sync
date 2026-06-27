#!/usr/bin/env tsx
/**
 * Interactive setup script for adding a new TrueLayer connection.
 *
 * Local:  npm run setup
 * Docker: docker compose run --rm actual-truelayer-sync npm run setup
 */

import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { exchangeCode, getMe, listAccounts, listCards } from '../src/truelayer/truelayer'
import { readJSON, writeJSON } from '../src/utils/file'
import type { Connection, FileConfig, State } from '../src/config/schema'

// Paths
const DATA_DIR = path.resolve(process.cwd(), 'data')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const STATE_PATH = path.join(DATA_DIR, 'state.json')

// TrueLayer OAuth constants
const TRUELAYER_AUTH_BASE = 'https://auth.truelayer.com'

const SCOPES = {
  // Most things use accounts
  accounts: 'accounts balance transactions offline_access',
  // My credit card needed cards instead
  cards: 'cards balance transactions offline_access',
} as const

type Scope = keyof typeof SCOPES
type SetupAction = 'add' | 'reauth'
type TextPrompt = (options: {
  message: string
  validate?: (value: string) => true | string
  default?: string
}) => Promise<string>

function buildAuthUrl(clientId: string, scope: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope,
    redirect_uri: redirectUri,
    providers: 'uk-ob-all uk-oauth-all',
  })
  return `${TRUELAYER_AUTH_BASE}/?${params}`
}

function getScopeForConnection(connection: Connection): Scope {
  return connection.isCard || connection.accounts.some((account) => account.isCard) ? 'cards' : 'accounts'
}

async function tryReadJSON<T>(filePath: string): Promise<T | null> {
  try {
    return await readJSON<T>(filePath)
  } catch {
    return null
  }
}

async function authorizeTrueLayer(
  input: TextPrompt,
  clientId: string,
  clientSecret: string,
  scope: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const redirectUri = (
    await input({
      message: 'Redirect URI registered with TrueLayer:',
      validate: (v) => (v.trim().length > 0 ? true : 'Required'),
      default: 'https://console.truelayer.com/redirect-page',
    })
  ).trim()

  const authUrl = buildAuthUrl(clientId, scope, redirectUri)
  console.log('\nOpen this URL in your browser to authenticate:\n')
  console.log(`  ${authUrl}\n`)

  const pastedUrl = await input({
    message: 'Paste the full redirect URL after completing auth:',
    validate: (v) => {
      try {
        new URL(v)
        return true
      } catch {
        return 'Enter a valid URL'
      }
    },
  })

  const code = new URL(pastedUrl).searchParams.get('code')
  if (!code) {
    console.error('No "code" parameter found in the URL. Make sure you pasted the full redirect URL.')
    process.exit(1)
  }

  console.log('\nExchanging code for tokens...')
  try {
    const tokens = await exchangeCode(clientId, clientSecret, code, redirectUri)
    console.log('Authenticated successfully.\n')
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token }
  } catch (err) {
    console.error(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  console.log('\nactual-truelayer-sync — connection setup\n')

  // 1. Validate environment
  const SetupEnvSchema = z.object({
    TRUELAYER_CLIENT_ID: z.string().min(1),
    TRUELAYER_CLIENT_SECRET: z.string().min(1),
    ACTUAL_SERVER_URL: z.url(),
    ACTUAL_SERVER_PASSWORD: z.string().min(1),
    ACTUAL_SYNC_ID: z.uuid(),
  })

  const envResult = SetupEnvSchema.safeParse(process.env)
  if (!envResult.success) {
    const missing = envResult.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    console.error(`Missing or invalid environment variables:\n${missing}`)
    process.exit(1)
  }
  const env = envResult.data
  const { input, select, checkbox, confirm } = await import('@inquirer/prompts')

  // 2. Load existing config / state (may not exist on first run)
  const existingConfig = await tryReadJSON<FileConfig>(CONFIG_PATH)
  const existingState = await tryReadJSON<State>(STATE_PATH)
  const existingConnections = existingConfig?.connections ?? []

  const action: SetupAction =
    existingConnections.length > 0
      ? await select<SetupAction>({
          message: 'What do you want to do?',
          choices: [
            { name: 'Add a new TrueLayer connection', value: 'add' },
            { name: 'Re-authenticate an existing connection', value: 'reauth' },
          ],
        })
      : 'add'

  if (action === 'reauth') {
    const selectedConnectionName = await select<string>({
      message: 'Which connection do you want to re-authenticate?',
      choices: existingConnections.map((connection) => ({
        name: `${connection.name} (${getScopeForConnection(connection)}, ${connection.accounts.length} mapped account${
          connection.accounts.length === 1 ? '' : 's'
        })`,
        value: connection.name,
      })),
    })

    const connection = existingConnections.find((c) => c.name === selectedConnectionName)!
    const connectionType = getScopeForConnection(connection)
    const { refreshToken } = await authorizeTrueLayer(
      input,
      env.TRUELAYER_CLIENT_ID,
      env.TRUELAYER_CLIENT_SECRET,
      SCOPES[connectionType],
    )

    console.log('\n--- Summary ---')
    console.log(`Connection      : ${connection.name}`)
    console.log(`Type            : ${connectionType}`)
    console.log(`Mapped accounts : ${connection.accounts.length}`)
    console.log('Config changes  : none')
    console.log('State changes   : refresh token will be replaced')
    console.log('---------------\n')

    const ok = await confirm({ message: `Update refresh token for "${connection.name}"?`, default: true })
    if (!ok) {
      console.log('Aborted — no files written.')
      process.exit(0)
    }

    fs.mkdirSync(DATA_DIR, { recursive: true })

    const updatedState: State = {
      connections: {
        ...(existingState?.connections ?? {}),
        [connection.name]: {
          refreshToken,
          accounts: existingState?.connections[connection.name]?.accounts ?? {},
        },
      },
    }

    await writeJSON(STATE_PATH, updatedState)

    console.log(`\nDone! Re-authenticated "${connection.name}". Existing account mappings were preserved.`)
    return
  }

  const existingConnectionNames = new Set(existingConnections.map((c) => c.name))
  const mappedActualIds = new Set(existingConnections.flatMap((c) => c.accounts.map((a) => a.actualId)))

  // 3. Connection type — determines OAuth scope
  const connectionType = await select<Scope>({
    message: 'What type of connection is this?',
    choices: [
      { name: 'Bank accounts (current, savings, etc.) - use this if unsure', value: 'accounts' },
      { name: 'Credit / charge cards', value: 'cards' },
    ],
  })
  const scope = SCOPES[connectionType]

  const { accessToken, refreshToken: newRefreshToken } = await authorizeTrueLayer(
    input,
    env.TRUELAYER_CLIENT_ID,
    env.TRUELAYER_CLIENT_SECRET,
    scope,
  )

  // 8. Fetch provider name for connection name default
  let providerDisplayName: string | undefined
  try {
    const me = await getMe(accessToken)
    providerDisplayName = me.provider.display_name
  } catch {
    // Non-fatal — user can type the name manually
  }

  // 9. Connection name
  const connectionName = await input({
    message: 'Name for this connection:',
    default: providerDisplayName,
    validate: (v) => {
      if (!v.trim()) {
        return 'Required'
      }
      if (existingConnectionNames.has(v.trim())) {
        return `"${v.trim()}" is already in use`
      }
      return true
    },
  })

  // 10. Fetch TrueLayer accounts / cards
  console.log('\nFetching accounts from TrueLayer...')
  type TLAccount = { id: string; label: string; friendlyName?: string }
  let trueLayerAccounts: TLAccount[] = []

  try {
    if (connectionType === 'cards') {
      const cards = await listCards(accessToken)
      trueLayerAccounts = cards.map((c) => ({
        id: c.account_id,
        label: `${c.display_name}${c.partial_card_number ? ` (•••• ${c.partial_card_number.slice(-4)})` : ''}`,
      }))
    } else {
      const accounts = await listAccounts(accessToken)
      trueLayerAccounts = accounts.map((a) => ({
        id: a.account_id,
        label: `${a.display_name}${a.account_number.number ? ` (•••• ${a.account_number.number.slice(-4)})` : ''}`,
      }))
    }
  } catch (err) {
    console.error(`Failed to fetch accounts: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (trueLayerAccounts.length === 0) {
    console.log('No accounts found for this connection. Tokens will still be saved.\n')
  }

  // 10. Checkbox — select accounts to map
  const selectedIds: string[] =
    trueLayerAccounts.length > 0
      ? await checkbox({
          message: 'Which accounts do you want to add? (space to select, enter to confirm)',
          choices: trueLayerAccounts.map((a) => ({ name: a.label, value: a.id })),
        })
      : []

  // 11. Map each selected account to an Actual Budget account
  type MappedAccount = {
    trueLayerId: string
    actualId: string
    friendlyName: string
    isCard?: boolean
  }

  const mappedAccounts: MappedAccount[] = []
  const skippedAccounts: TLAccount[] = []

  if (selectedIds.length > 0) {
    console.log('\nConnecting to Actual Budget...')
    let actualAccounts: Array<{ id: string; name: string }> = []
    let shutdownActual: (() => Promise<void>) | undefined

    try {
      const actual = await import('../src/actual/actual.js')
      shutdownActual = actual.shutdownActual

      await actual.initActual({
        serverURL: env.ACTUAL_SERVER_URL,
        password: env.ACTUAL_SERVER_PASSWORD,
        syncId: env.ACTUAL_SYNC_ID,
        verbose: false,
      })
      const all = await actual.getAccounts()
      actualAccounts = all.filter((a) => !a.closed && !mappedActualIds.has(a.id))
    } catch (err) {
      console.error(`Could not connect to Actual Budget: ${err instanceof Error ? err.message : String(err)}`)
      console.log('Skipping account mapping — add actualId values to config.json manually.\n')
    } finally {
      try {
        await shutdownActual?.()
      } catch {
        // ignore shutdown errors
      }
    }

    for (const trueLayerId of selectedIds) {
      const tlAccount = trueLayerAccounts.find((a) => a.id === trueLayerId)!
      console.log('')

      if (actualAccounts.length === 0) {
        const friendlyName = await input({
          message: `No Actual Budget accounts available. Enter a name for "${tlAccount.label}" to use later:`,
          default: tlAccount.label,
        })
        skippedAccounts.push({ ...tlAccount, friendlyName: friendlyName.trim() || tlAccount.label })
        continue
      }

      const SKIP = '__skip__'
      const actualId = await select({
        message: `Map "${tlAccount.label}" to which Actual Budget account?`,
        choices: [
          ...actualAccounts.map((a) => ({ name: a.name, value: a.id })),
          { name: "I haven't created it yet — skip for now", value: SKIP },
        ],
      })

      if (actualId === SKIP) {
        const friendlyName = await input({
          message: `Enter a name for "${tlAccount.label}" to use when you add it later:`,
          default: tlAccount.label,
        })
        skippedAccounts.push({ ...tlAccount, friendlyName: friendlyName.trim() || tlAccount.label })
        console.log(`  Skipped. Add this manually to config.json: trueLayerId = "${trueLayerId}"`)
        continue
      }

      const abAccount = actualAccounts.find((a) => a.id === actualId)!
      const account: MappedAccount = {
        trueLayerId,
        actualId,
        friendlyName: abAccount.name,
      }
      if (connectionType === 'cards') account.isCard = true
      mappedAccounts.push(account)

      // Remove from available list so it can't be double-mapped
      const idx = actualAccounts.findIndex((a) => a.id === actualId)
      if (idx !== -1) actualAccounts.splice(idx, 1)
    }
  }

  // 12. Summary & confirmation
  console.log('\n--- Summary ---')
  console.log(`Connection name : ${connectionName.trim()}`)
  console.log(`Type            : ${connectionType}`)
  console.log(`Accounts to add : ${mappedAccounts.length}`)
  for (const a of mappedAccounts) {
    console.log(`  • ${a.friendlyName} (${a.trueLayerId} → ${a.actualId})`)
  }
  if (skippedAccounts.length > 0) {
    console.log(`Skipped         : ${skippedAccounts.map((a) => a.friendlyName ?? a.label).join(', ')}`)
  }
  console.log('---------------\n')

  const ok = await confirm({ message: 'Write to config.json and state.json?', default: true })
  if (!ok) {
    console.log('Aborted — no files written.')
    process.exit(0)
  }

  // 13. Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true })

  // 14. Build updated config
  const newConnection = {
    name: connectionName.trim(),
    ...(connectionType === 'cards' ? { isCard: true } : {}),
    accounts: mappedAccounts,
  }

  const updatedConfig: FileConfig = {
    version: 2,
    includeCategoryInNotes: existingConfig?.includeCategoryInNotes ?? false,
    lookbackDays: existingConfig?.lookbackDays ?? 14,
    connections: [...(existingConfig?.connections ?? []), newConnection],
  }

  // 15. Build updated state
  const updatedState: State = {
    connections: {
      ...(existingState?.connections ?? {}),
      [connectionName.trim()]: {
        refreshToken: newRefreshToken,
        accounts: {},
      },
    },
  }

  await writeJSON(CONFIG_PATH, updatedConfig)
  await writeJSON(STATE_PATH, updatedState)

  console.log('\nDone! config.json and state.json have been updated.')

  if (skippedAccounts.length > 0) {
    console.log('\nRemember to add these accounts to config.json once created in Actual Budget:')
    for (const a of skippedAccounts) {
      console.log(`  • ${a.friendlyName ?? a.label}  —  trueLayerId: "${a.id}"`)
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
