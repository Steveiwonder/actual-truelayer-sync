import cron from 'node-cron'
import { loadConfig, writeConfig } from './config/config'
import { initActual, shutdownActual } from './actual/actual'
import { syncConnection } from './sync/connection'
import type { Config } from './config/schema'

async function mainTask(config: Config): Promise<void> {
  try {
    await initActual({
      serverURL: config.env.ACTUAL_SERVER_URL,
      password: config.env.ACTUAL_SERVER_PASSWORD,
      syncId: config.env.ACTUAL_SYNC_ID,
      verbose: !!config.env.DEBUG,
    })

    for (let i = 0; i < config.connections.length; i++) {
      const updated = await syncConnection(config.connections[i], config)
      if (updated) {
        config.connections[i] = updated
        await writeConfig(config)
      }
    }
  } catch (e) {
    console.error('\nGlobal Sync Error:', String(e))
  } finally {
    await shutdownActual()
    console.log('\nSync cycle finished. Sleeping...')
  }
}

void (async () => {
  let config: Config
  try {
    config = await loadConfig()
  } catch (err) {
    console.error(String(err))
    process.exit(1)
  }

  await mainTask(config)

  if (config.env.CRON_SCHEDULE) {
    const timezone = config.env.TZ
    console.log(
      `Scheduler initialized with pattern: ${config.env.CRON_SCHEDULE}${timezone ? ` (timezone: ${timezone})` : ''}`,
    )
    cron.schedule(
      config.env.CRON_SCHEDULE,
      () => {
        mainTask(config).catch((err) => console.error('Unhandled task error:', err))
      },
      {
        noOverlap: true,
        ...(timezone ? { timezone } : {}),
      },
    )
  }
})()

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...')
  shutdownActual()
    .catch((err) => console.error('Error during shutdown:', err))
    .finally(() => process.exit(0))
})
