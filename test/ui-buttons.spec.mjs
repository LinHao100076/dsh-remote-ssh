import { test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
  launchOptions: process.env.DSH_CHROMIUM_PATH ? { executablePath: process.env.DSH_CHROMIUM_PATH } : {},
})
test('shipped UI buttons and async state transitions', async ({ page }) => {
  test.setTimeout(90000)
  const child = spawn(process.execPath, ['test/ui-harness.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = ''
      child.stdout.on('data', chunk => {
        output += chunk
        const match = /UI_HARNESS=(http:\/\/[^\s]+)/.exec(output)
        if (match) resolve(match[1])
      })
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`UI harness exited: ${code}`)))
    })
    await page.goto(origin)
    const source = await readFile(new URL('./ui-buttons.browser.js', import.meta.url), 'utf8')
    const run = new Function(`return (\n${source}\n)`)()
    const result = await run(page)
    console.log(JSON.stringify(result))
  } finally {
    child.kill()
  }
})
