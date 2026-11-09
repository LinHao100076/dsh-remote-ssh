// Run with Playwright's browser_run_code_unsafe(filename), after opening ui-harness URL.
async (page) => {
  const base = new URL(page.url()).origin + '/'
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin })
  const calls = []
  const checked = []
  const errors = []
  const hosts = []
  const statuses = {}
  const mappings = []
  const conflicts = []
  const queue = []
  const rules = []
  const files = new Map([['/home/u/main.js', 'hello\n'], ['/home/u/slow.js', 'slow contents'], ['/home/u2/outside.js', 'outside']])
  const info = { kernel: 'Linux fixture', home: '/home/u', shell: '/bin/sh', tmux: true }
  let pendingAuth
  let challenge
  let forceAuth = false
  let slowSearch
  let slowRead
  let failPush = false
  let failFlush = false
  let failConnect = false
  let delayCwd = false
  let releaseCwd
  const assert = (ok, message) => { if (!ok) throw new Error(message) }
  const field = (label) => page.locator('.rs-field').filter({ has: page.locator('label').getByText(label, { exact: true }) }).locator('input,select').first()
  const click = async (name) => page.getByRole('button', { name, exact: true }).click()
  const wait = async (test, message) => {
    for (let i = 0; i < 100; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 50)) }
    throw new Error(message)
  }
  const count = (method) => calls.filter(c => c.method === method).length
  const last = (method) => calls.filter(c => c.method === method).at(-1)?.payload
  page.on('pageerror', e => errors.push(e.message))
  await page.unroute('**/remote/api/**')
  await page.route('**/remote/api/**', async route => {
    const method = route.request().url().split('/').pop()
    const p = route.request().postDataJSON()
    calls.push({ method, payload: p })
    let value = {}
    try {
      if (method === 'hosts.list') value = { hosts, statuses }
      else if (method === 'hosts.status') value = { statuses }
      else if (method === 'hosts.sshConfig') value = { hosts: [{ alias: 'fixture', host: 'fixture.internal', user: 'u', port: 22, identityFile: '~/.ssh/test' }] }
      else if (method === 'hosts.save') {
        if (p.host.port <= 0) throw new Error('端口必须是 1-65535')
        const host = { ...p.host, id: p.host.id || `h${hosts.length + 1}` }
        const index = hosts.findIndex(h => h.id === host.id)
        if (index >= 0) hosts[index] = host; else hosts.push(host)
        statuses[host.id] = { status: 'disconnected' }
        value = { host, hosts }
      } else if (method === 'hosts.connect') {
        if (failConnect) { failConnect = false; throw Object.assign(new Error('key rejected'), { code: 'auth-failed' }) }
        const id = p.hostId || p.draft?.id || `draft:${p.draft.user}@${p.draft.host}:${p.draft.port}`
        if (forceAuth) {
          challenge = { id: 'otp', host: 'fixture', user: 'u', port: 22, prompts: [{ prompt: 'OTP', echo: false }] }
          const cancelled = await new Promise(resolve => { pendingAuth = resolve })
          forceAuth = false
          if (cancelled) throw Object.assign(new Error('已取消'), { code: 'auth-cancelled' })
        }
        statuses[id] = { status: 'connected' }; value = { hostId: id, info }
      } else if (method === 'auth.challenge') value = { challenge }
      else if (method === 'auth.answer') { assert(p.answers[0] === '123456', 'OTP answer lost'); challenge = undefined; pendingAuth?.() }
      else if (method === 'hosts.info') value = { info }
      else if (method === 'hosts.disconnect') { statuses[p.hostId] = { status: 'disconnected' }; challenge = undefined; pendingAuth?.(true) }
      else if (method === 'hosts.delete') { hosts.splice(hosts.findIndex(h => h.id === p.hostId), 1); value = { hosts } }
      else if (method === 'session.cwd') {
        if (delayCwd) await new Promise(resolve => { releaseCwd = resolve })
        value = { cwd: 'C:/ui-workspace' }
      }
      else if (method === 'sync.list') value = { mappings, queue, conflicts, stats: {} }
      else if (method === 'sync.resolve') conflicts.splice(conflicts.findIndex(c => c.key === p.key), 1)
      else if (method === 'sync.flush') { if (failFlush) throw new Error('fixture flush failed') }
      else if (method === 'sync.save') {
        const row = { ...p.mapping, id: p.mapping.id || 'm1', watching: p.mapping.policy !== 'off', pending: 0 }
        const i = mappings.findIndex(m => m.id === row.id)
        if (i < 0) mappings.push(row); else mappings[i] = row
      } else if (method === 'sync.remove') mappings.splice(mappings.findIndex(m => m.id === p.mappingId), 1)
      else if (method === 'sync.pushAll') value = { files: 1, bytes: 6, failed: failPush ? [{ message: 'fixture upload failed' }] : [] }
      else if (method === 'sync.pull') value = { size: 6, mtimeMs: 1000 }
      else if (method === 'transfer.cleanParts') value = { removed: 1, bytes: 3 }
      else if (method === 'fs.list') {
        const path = p.path || '/home/u'
        const entries = new Map()
        for (const [key, text] of files) {
          if (!key.startsWith(path + '/')) continue
          const rest = key.slice(path.length + 1)
          const name = rest.split('/')[0]
          entries.set(name, { path: path + '/' + name, name, type: rest.includes('/') ? 'dir' : 'file', size: text.length })
        }
        value = { path, home: info.home, entries: [...entries.values()] }
      } else if (method === 'fs.read') {
        if (p.path.endsWith('slow.js')) await new Promise(resolve => { slowRead = resolve })
        value = { text: files.get(p.path) || '', size: 6, mtimeMs: 1000 }
      } else if (method === 'fs.write') { files.set(p.path, p.text); value = { size: p.text.length, mtimeMs: 2000 } }
      else if (method === 'fs.putBase64') files.set(p.path, Buffer.from(p.data, 'base64').toString())
      else if (method === 'fs.remove') files.delete(p.path)
      else if (method === 'fs.mkdir') value = { path: p.path }
      else if (method === 'fs.search') {
        if (p.query === 'slow') await new Promise(resolve => { slowSearch = resolve })
        value = { hits: [{ path: '/home/u/main.js', line: 1, column: 1, text: p.query }], files: 1, engine: 'fixture', durationMs: 1 }
      } else if (method === 'forward.list') value = { hosts: rules.length ? [{ hostId: hosts[0].id, hostName: 'fixture', rules }] : [] }
      else if (method === 'forward.save') {
        const r = { ...p.rule, id: p.rule.id || 'r1', state: 'stopped', link: `127.0.0.1:${p.rule.listen.port}`, to: p.rule.kind === 'dynamic' ? 'SOCKS5' : `${p.rule.target.host}:${p.rule.target.port}`, listenSide: p.rule.kind === 'remote' ? 'remote' : 'local' }
        const i = rules.findIndex(r => r.id === p.rule.id); if (i < 0) rules.push(r); else rules[i] = r
      } else if (method === 'forward.remove') rules.splice(rules.findIndex(r => r.id === p.ruleId), 1)
      else if (method === 'forward.start' || method === 'forward.startAll') rules.forEach(r => { r.state = 'listening' })
      else if (method === 'forward.stop' || method === 'forward.stopAll') rules.forEach(r => { r.state = 'stopped' })
      else throw new Error(`Uncovered UI API: ${method}`)
      await route.fulfill({ json: { ok: true, value } })
    } catch (e) { await route.fulfill({ json: { ok: false, error: { code: e.code || 'fixture-error', message: e.message } } }) }
  })
  await page.addInitScript(() => { window.confirm = () => window.__confirmAnswer ?? true; window.prompt = () => window.__promptAnswer ?? ''; })
  await page.goto(base)
  await click('新建 SSH 连接')
  await page.getByPlaceholder('10.0.3.21').waitFor()
  checked.push('空主机新建入口')
  await click('取消新建')
  await click('新建 SSH 连接')
  await page.locator('select').filter({ has: page.locator('option[value="fixture"]') }).selectOption('fixture')
  assert(await field('主机').inputValue() === 'fixture.internal', 'config import failed')
  await click('添加跳板')
  await page.getByPlaceholder('bastion.internal').fill('jump-a')
  await click('再加一跳')
  await page.getByPlaceholder('bastion.internal').nth(1).fill('jump-b')
  await page.getByTitle('上移', { exact: true }).nth(1).click()
  assert(await page.getByPlaceholder('bastion.internal').first().inputValue() === 'jump-b', 'reorder failed')
  await page.getByTitle('删除这一跳').first().click()
  await page.getByTitle('删除这一跳').first().click()
  checked.push('导入、添加/移动/删除跳板')
  await field('端口').fill('0')
  await click('仅保存')
  await page.getByText('端口必须是 1-65535', { exact: true }).waitFor()
  await field('端口').fill('22')
  await field('认证').selectOption('keyboard')
  forceAuth = true
  await click('测试连接')
  await field('OTP').waitFor()
  await field('OTP').fill('123456')
  await click('提交')
  await page.getByText(/连通 · Linux fixture/).waitFor()
  forceAuth = true
  await click('测试连接')
  await field('OTP').waitFor()
  await click('取消')
  await page.getByRole('button', { name: '测试连接', exact: true }).waitFor()
  checked.push('测试连接与 OTP 提交')
  await field('认证').selectOption('password')
  await page.getByPlaceholder('输入密码').fill('test-only')
  forceAuth = true
  await click('创建并连接')
  await field('OTP').waitFor()
  await field('OTP').fill('123456')
  await click('提交')
  await page.locator('.rs-row').filter({ hasText: 'main.js' }).waitFor()
  checked.push('创建并连接与 OTP、密码传参')
  await page.getByTitle('重新连接', { exact: true }).click()
  await page.locator('.rs-row').filter({ hasText: 'main.js' }).waitFor()
  await page.getByTitle('断开', { exact: true }).click()
  await page.getByPlaceholder('输入密码').fill('again')
  await page.getByRole('button', { name: '连接', exact: true }).last().click()
  await page.locator('.rs-row').filter({ hasText: 'main.js' }).waitFor()
  checked.push('连接、断开、重新连接')
  await page.getByTitle('新建目录', { exact: true }).click({ trial: true })
  await page.evaluate(() => { window.__promptAnswer = 'new-folder' })
  await page.getByTitle('新建目录', { exact: true }).click()
  await wait(() => count('fs.mkdir') > 0, 'mkdir not called')
  await page.locator('input[type=file]').setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('upload') })
  await page.locator('.rs-row').filter({ hasText: 'upload.txt' }).waitFor()
  await page.getByTitle('刷新', { exact: true }).click()
  await page.locator('.rs-row').filter({ hasText: 'main.js' }).click()
  await click('编辑')
  await page.locator('textarea.rs-code').fill('edited')
  await click('取消')
  await click('编辑')
  await page.locator('textarea.rs-code').fill('edited')
  await click('保存')
  await wait(() => files.get('/home/u/main.js') === 'edited', 'save did not reach API')
  await page.locator('.rs-row').filter({ hasText: 'slow.js' }).click()
  await wait(() => slowRead !== undefined, 'slow read not started')
  await page.locator('.rs-row').filter({ hasText: 'main.js' }).click()
  await page.locator('pre.rs-code').filter({ hasText: 'edited' }).waitFor()
  slowRead()
  await new Promise(r => setTimeout(r, 150))
  assert(await page.locator('.rs-peek-path').innerText() === 'main.js', 'stale read replaced selected preview')
  checked.push('新建目录、上传、刷新、编辑保存/取消')
  await page.getByRole('tab', { name: '同步', exact: true }).click()
  delayCwd = true
  await click('新建映射')
  await wait(() => releaseCwd !== undefined, 'cwd request did not start')
  await click('取消')
  releaseCwd()
  delayCwd = false
  await new Promise(r => setTimeout(r, 100))
  assert(await field('本地目录（工作区）').count() === 0, 'mapping cancel did not close form')
  await click('新建映射')
  await field('本地目录（工作区）').fill('C:/ui-workspace')
  await field('远端目录（绝对路径）').fill('/home/u')
  await click('保存')
  await page.getByTitle('删除映射').waitFor()
  for (const key of ['local', 'remote', 'skip']) conflicts.push({ key, mappingId: 'm1', rel: key + '.js', localMtimeMs: 1000, remoteMtimeMs: 2000 })
  queue.push({ id: 'q1', rel: 'done.js', state: 'done', size: 6 })
  await click('关闭')
  await wait(() => mappings[0].policy === 'off', 'policy not saved')
  await page.getByRole('button', { name: '保留本地', exact: true }).first().click()
  await wait(() => conflicts.length === 2, 'local conflict resolution failed')
  await page.getByRole('button', { name: '保留远端', exact: true }).first().click()
  await wait(() => conflicts.length === 1, 'remote conflict resolution failed')
  await wait(async () => await page.getByRole('button', { name: '忽略', exact: true }).count() === 1, 'conflict UI did not refresh')
  await click('忽略')
  await wait(() => conflicts.length === 0, 'ignore conflict failed')
  failFlush = true
  await click('刷新')
  await page.getByText('fixture flush failed', { exact: true }).waitFor()
  failFlush = false
  await click('刷新')
  await click('仅下载')
  await wait(() => mappings[0].direction === 'pull', 'direction not saved')

  await click('全量推送')
  await wait(() => count('sync.pushAll') > 0, 'push not called')
  failPush = true
  await click('全量推送')
  await page.getByText(/1 个失败：fixture upload failed/).waitFor()
  failPush = false
  await page.evaluate(() => { window.__promptAnswer = 'main.js' })
  await click('下载单个')
  await wait(() => count('sync.pull') > 0, 'pull not called')
  await click('清理残留')
  await wait(() => count('transfer.cleanParts') > 0, 'clean not called')
  checked.push('映射新建、策略/方向、推送、下载、清理')
  checked.push('三种冲突处理、队列刷新及部分推送失败反馈')
  // A new mapping must work immediately, without reconnecting or remounting files.
  await page.getByRole('tab', { name: '文件', exact: true }).click()
  await page.locator('.rs-row').filter({ hasText: 'main.js' }).click()
  await click('下载')
  await wait(() => count('sync.pull') === 2, 'file download must use bounded mapping API')
  assert(last('sync.pull').rel === 'main.js', 'wrong relative download path')
  await page.getByTitle('上一级', { exact: true }).click()
  await page.locator('.rs-row').filter({ hasText: /^u2/ }).click()
  const beforeOutside = count('sync.pull')
  await page.locator('.rs-row').filter({ hasText: 'outside.js' }).hover()
  await page.locator('.rs-row').filter({ hasText: 'outside.js' }).getByTitle('下载到本地映射目录').click()
  await page.getByText('先为该主机建立路径映射，才能下载到本地', { exact: true }).waitFor()
  assert(count('sync.pull') === beforeOutside, 'sibling prefix escaped mapping root')
  await page.locator('.rs-crumb button').first().click()
  checked.push('文件下载、上一级、面包屑')
  await page.getByTitle('在远端搜索内容').click()
  await page.locator('.rs-sinput').fill('hello')
  await page.locator('.rs-shit').waitFor()
  await page.getByTitle('区分大小写', { exact: true }).click()
  await page.getByTitle('按正则表达式解释', { exact: true }).click()
  await page.locator('.rs-sinput').press('Enter')
  await page.locator('.rs-shit').first().click()
  await page.locator('.rs-peek .rs-badge').filter({ hasText: '第 1 行' }).waitFor()
  await page.getByTitle('清空', { exact: true }).click()
  await page.locator('.rs-sinput').fill('slow')
  await page.locator('.rs-sinput').press('Enter')
  await wait(() => slowSearch !== undefined, 'slow search not started')
  await page.getByTitle('清空', { exact: true }).click()
  slowSearch()
  await new Promise(r => setTimeout(r, 150))
  assert(await page.locator('.rs-shit').count() === 0, 'cleared search was repopulated by stale results')
  await page.getByTitle('在远端搜索内容').click()
  await page.locator('.rs-row').filter({ hasText: 'upload.txt' }).click()
  await page.evaluate(() => { window.__confirmAnswer = false })
  await click('删除')
  assert(files.has('/home/u/upload.txt'), 'cancelled delete changed remote state')
  await page.evaluate(() => { window.__confirmAnswer = true })
  await click('删除')
  await wait(() => !files.has('/home/u/upload.txt'), 'file delete not called')
  checked.push('搜索、大小写/正则、回车、结果跳转、清空')
  await page.getByRole('tab', { name: '转发', exact: true }).click()
  await click('新建转发')
  await click('动态 -D')
  await field('SOCKS5 端口').fill('1080')
  await click('手动启动')
  await click('保存')
  await page.getByTitle('启动', { exact: true }).click()
  await page.getByTitle('复制监听地址').waitFor()
  await page.getByTitle('复制监听地址').click()
  assert((await page.evaluate(() => navigator.clipboard.readText())).includes('1080'), 'copy address did not write clipboard')
  await page.getByTitle('停止', { exact: true }).click()
  await click('全部启动')
  await page.getByTitle('复制监听地址').waitFor()
  await page.getByRole('button', { name: '停止', exact: true }).first().click()
  await page.getByTitle('编辑', { exact: true }).click()
  await click('反向 -R')
  await field('本机端口（转发目标）').fill('3000')
  await click('保存')
  await wait(() => rules[0].kind === 'remote', 'edit rule not saved')

  await page.getByTitle('删除', { exact: true }).click()
  await wait(() => rules.length === 0, 'rule not removed')
  await click('新建转发')
  await click('取消')
  checked.push('转发类型、保存、启动/停止、全部启动/停止、复制、编辑、删除')
  await page.getByRole('tab', { name: '终端', exact: true }).click()
  await page.locator('.xterm-screen').first().waitFor()
  await page.getByTitle('新建终端').click()
  assert(await page.getByTitle('关闭终端').count() === 2, 'new terminal failed')
  await wait(async () => {
    const urls = await (await page.request.get(base + '__term')).json()
    return urls.some(url => new URL(url, base).searchParams.get('terminalId') === 't1')
  }, 'terminal tabs do not carry independent ids')
  await page.getByTitle('关闭终端').last().click()
  await page.getByRole('button', { name: /清屏/ }).first().click()
  await page.evaluate(() => navigator.clipboard.writeText('PASTE_BUTTON_TEST'))
  await page.getByRole('button', { name: /粘贴/ }).first().click()
  await wait(async () => (await (await page.request.get(base + '__inputs')).json()).includes('PASTE_BUTTON_TEST'), 'paste did not reach terminal socket')
  await page.request.get(base + '__exit')
  await page.getByRole('button', { name: '重连', exact: true }).first().waitFor()
  await page.getByRole('button', { name: '重连', exact: true }).first().click()
  checked.push('终端新建/关闭、清屏、粘贴、退出后重连')
  await page.getByRole('tab', { name: '同步', exact: true }).click()

  await page.getByTitle('删除映射').click()
  await wait(() => mappings.length === 0, 'mapping not deleted')
  await page.getByRole('tab', { name: '设置', exact: true }).click()
  hosts[0].auth = { type: 'key', keyPath: '~/.ssh/test' }
  statuses[hosts[0].id] = { status: 'disconnected' }
  await page.reload()
  failConnect = true
  await page.getByRole('button', { name: '连接', exact: true }).last().click()
  await click('改用密码')
  await page.getByPlaceholder('输入密码').fill('recovery')
  await page.getByRole('button', { name: '连接', exact: true }).last().click()
  await page.locator('.rs-row').filter({ hasText: 'main.js' }).waitFor()
  checked.push('密钥认证失败后改用密码')
  hosts[0].fingerprint = 'SHA256:test-pin'
  hosts.push({ id: 'other-host', name: 'other-host', user: 'other', host: 'other.internal', port: 22, auth: { type: 'agent' } })
  // Reload settings from a fresh host list to check that edits retain trust.
  await page.reload()
  await page.getByTitle('切换远程主机').click()
  await page.getByRole('menuitem').filter({ hasText: 'other-host' }).click()
  await page.locator('.rs-hostname').filter({ hasText: 'other-host' }).waitFor()
  await page.getByTitle('切换远程主机').click()
  await page.getByRole('menuitem').filter({ hasText: 'fixture' }).click()
  await page.getByTitle('切换远程主机').click()
  await click('管理当前主机')
  await page.getByTitle('切换远程主机').click()
  await click('新建 SSH 连接')
  await click('取消新建')
  checked.push('主机切换、新建和管理菜单')
  await page.getByRole('tab', { name: '设置', exact: true }).click()
  await field('名称').fill('renamed')
  await click('仅保存')
  await wait(() => hosts[0].name === 'renamed', 'host edit not saved')
  assert(hosts[0].fingerprint === 'SHA256:test-pin', 'saving host discarded pinned fingerprint')
  await page.getByRole('tab', { name: '设置', exact: true }).click()

  await click('删除主机')
  // Remove the additional host too, restoring the empty-host entrance.
  await page.getByRole('tab', { name: '设置', exact: true }).click()
  await click('删除主机')
  await page.getByRole('button', { name: '新建 SSH 连接', exact: true }).waitFor()
  checked.push('删除映射、设置保存、保留指纹、删除主机')
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`)
  return { checked, requests: calls.length, methods: [...new Set(calls.map(c => c.method))], browserErrors: errors }
}

