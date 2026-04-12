const styles = `
  :root {
    --bg: #f6f4ee;
    --panel: rgba(255, 252, 245, 0.88);
    --text: #16110f;
    --muted: #6d625d;
    --accent: #db5c34;
    --accent-soft: #f6c7b8;
    --line: rgba(22, 17, 15, 0.12);
    --shadow: 0 30px 80px rgba(83, 54, 35, 0.14);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    font-family: "IBM Plex Sans", "Pretendard", sans-serif;
    color: var(--text);
    background:
      radial-gradient(circle at top left, rgba(248, 199, 164, 0.9), transparent 38%),
      radial-gradient(circle at bottom right, rgba(232, 111, 56, 0.22), transparent 30%),
      linear-gradient(180deg, #fffaf2 0%, #f6f4ee 100%);
  }

  .shell {
    width: min(1120px, calc(100vw - 32px));
    margin: 32px auto;
    display: grid;
    gap: 20px;
  }

  .hero {
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    border-radius: 28px;
    padding: 28px;
    display: grid;
    gap: 18px;
  }

  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 8px rgba(219, 92, 52, 0.12);
  }

  h1 {
    margin: 0;
    font-size: clamp(34px, 5vw, 68px);
    line-height: 0.92;
    max-width: 10ch;
    letter-spacing: -0.04em;
  }

  .lede {
    margin: 0;
    color: var(--muted);
    font-size: 18px;
    line-height: 1.6;
    max-width: 60ch;
  }

  .proofs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .proof {
    background: rgba(255, 255, 255, 0.75);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 18px;
  }

  .proof strong {
    display: block;
    font-size: 14px;
    margin-bottom: 6px;
  }

  .proof span {
    display: block;
    color: var(--muted);
    line-height: 1.5;
    font-size: 14px;
  }

  .grid {
    display: grid;
    grid-template-columns: 1.15fr 0.85fr;
    gap: 20px;
  }

  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    border-radius: 28px;
    padding: 24px;
    display: grid;
    gap: 18px;
  }

  .panel h2 {
    margin: 0;
    font-size: 24px;
    letter-spacing: -0.03em;
  }

  .panel p {
    margin: 0;
    color: var(--muted);
    line-height: 1.6;
  }

  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  button {
    border: 0;
    border-radius: 999px;
    background: var(--text);
    color: white;
    padding: 12px 18px;
    font: inherit;
    cursor: pointer;
    transition: transform 160ms ease, opacity 160ms ease, background 160ms ease;
  }

  button.secondary {
    background: rgba(22, 17, 15, 0.08);
    color: var(--text);
  }

  button:hover { transform: translateY(-1px); }
  button:disabled { opacity: 0.45; cursor: wait; transform: none; }

  .status {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 14px;
  }

  .status strong { color: var(--text); }

  .items {
    display: grid;
    gap: 10px;
  }

  .item {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 12px;
    align-items: center;
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 14px 16px;
  }

  .item-id {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: var(--accent-soft);
    display: grid;
    place-items: center;
    font-weight: 700;
    color: var(--accent);
  }

  .item-meta strong { display: block; }
  .item-meta span {
    color: var(--muted);
    font-size: 13px;
  }

  .feed {
    display: grid;
    gap: 10px;
    max-height: 460px;
    overflow: auto;
    padding-right: 4px;
  }

  .event {
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 14px 16px;
  }

  .event strong {
    display: block;
    font-size: 14px;
    margin-bottom: 4px;
  }

  .event span {
    display: block;
    color: var(--muted);
    line-height: 1.5;
    font-size: 13px;
    white-space: pre-wrap;
  }

  code {
    font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
    font-size: 13px;
    background: rgba(22, 17, 15, 0.06);
    padding: 3px 7px;
    border-radius: 999px;
  }

  @media (max-width: 920px) {
    .grid { grid-template-columns: 1fr; }
    .proofs { grid-template-columns: 1fr; }
  }
`

const script = (transport: 'websocket' | 'sse') => `
  import { createClient } from '/demo-client.js'

  const qs = (selector) => document.querySelector(selector)
  const itemsEl = qs('#items')
  const feedEl = qs('#feed')
  const statusEl = qs('#status')
  const countEl = qs('#count')
  const modeHintEl = qs('#mode-hint')
  const snapshotBtn = qs('#snapshot')
  const createBtn = qs('#create')
  const toggleBtn = qs('#toggle')
  const transportSelect = qs('#transport-select')
  const transportEl = qs('#transport')

  let activeTransport = '${transport}'
  let client = null

  let subscribed = false
  let unsubscribe = null
  let createCount = 0

  function createRealtimeClient(transport) {
    if (client) client.destroy()
    client = createClient(window.location.origin, {
      transport,
      reconnect: { maxAttempts: 10, initialDelayMs: 500 },
      onError: (error) => pushEvent('client-error', error.message),
    })
  }

  function setStatus(label, tone = 'idle') {
    statusEl.textContent = label
    transportEl.textContent = activeTransport + ' / ' + tone
  }

  function renderItems(items) {
    countEl.textContent = String(items.length)
    itemsEl.innerHTML = items.map((item) => \`
      <div class="item">
        <div class="item-id">\${item.id}</div>
        <div class="item-meta">
          <strong>\${item.name}</strong>
          <span>\${new Date(item.createdAt).toLocaleString()}</span>
        </div>
        <code>/items/\${item.id}</code>
      </div>
    \`).join('')
  }

  function pushEvent(title, detail) {
    const row = document.createElement('div')
    row.className = 'event'
    row.innerHTML = \`<strong>\${title}</strong><span>\${detail}</span>\`
    feedEl.prepend(row)
    while (feedEl.children.length > 10) {
      feedEl.removeChild(feedEl.lastChild)
    }
  }

  async function loadSnapshot() {
    if (!client) createRealtimeClient(activeTransport)
    snapshotBtn.disabled = true
    try {
      const items = await client.get('/items')
      renderItems(items)
      setStatus('REST snapshot loaded')
      pushEvent('REST GET /items', JSON.stringify(items, null, 2))
    } catch (error) {
      pushEvent('snapshot-failed', error.message)
      setStatus('Snapshot failed', 'error')
    } finally {
      snapshotBtn.disabled = false
    }
  }

  async function createItem() {
    if (!client) createRealtimeClient(activeTransport)
    createBtn.disabled = true
    try {
      createCount += 1
      const item = await client.post('/items', { name: 'Browser item #' + createCount })
      pushEvent('REST POST /items', JSON.stringify(item, null, 2))
      setStatus('Created over REST, waiting for live push')
    } catch (error) {
      pushEvent('create-failed', error.message)
      setStatus('Create failed', 'error')
    } finally {
      createBtn.disabled = false
    }
  }

  function startSubscription() {
    if (subscribed) return
    if (!client) createRealtimeClient(activeTransport)
    unsubscribe = client.subscribe('/items/live', (items) => {
      renderItems(items)
      setStatus('Live subscription updated')
      pushEvent('LIVE /items/live', JSON.stringify(items, null, 2))
    })
    subscribed = true
    toggleBtn.textContent = 'Stop live subscription'
    setStatus('Subscribed to /items/live', 'live')
    pushEvent('subscribe', 'client.subscribe("/items/live") with transport="' + activeTransport + '"')
  }

  function stopSubscription() {
    if (!subscribed || !unsubscribe) return
    unsubscribe()
    unsubscribe = null
    subscribed = false
    toggleBtn.textContent = 'Start live subscription'
    setStatus('Subscription stopped')
    pushEvent('unsubscribe', 'subscription disposed')
  }

  function switchTransport(nextTransport) {
    const wasSubscribed = subscribed
    stopSubscription()
    activeTransport = nextTransport
    createRealtimeClient(activeTransport)
    modeHintEl.textContent = 'Server transport: ${transport}. Match this value for the live demo.'
    setStatus('Transport switched locally')
    pushEvent('transport', 'client transport switched to "' + activeTransport + '"')
    if (wasSubscribed) startSubscription()
  }

  snapshotBtn.addEventListener('click', loadSnapshot)
  createBtn.addEventListener('click', createItem)
  toggleBtn.addEventListener('click', () => {
    if (subscribed) stopSubscription()
      else startSubscription()
  })
  transportSelect.addEventListener('change', (event) => {
    switchTransport(event.target.value)
  })

  window.addEventListener('beforeunload', () => {
    stopSubscription()
    if (client) client.destroy()
  })

  transportSelect.value = activeTransport
  await loadSnapshot()
  startSubscription()
`

export function renderDemoHtml(
  title: string,
  subtitle: string,
  transport: 'websocket' | 'sse',
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${styles}</style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="eyebrow"><span class="dot"></span> RouteFlow MVP Demo</div>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">${escapeHtml(subtitle)}</p>
        <div class="proofs">
          <div class="proof">
            <strong>1. Live without new concepts</strong>
            <span><code>@Reactive</code> on <code>GET /items/live</code> turns a normal route into a pushed live endpoint.</span>
          </div>
          <div class="proof">
            <strong>2. Adapter swap</strong>
            <span>The route shape stays the same while the backing store changes from memory to PostgreSQL.</span>
          </div>
          <div class="proof">
            <strong>3. Low cognitive load</strong>
            <span>The browser only uses <code>client.get()</code>, <code>client.post()</code>, and <code>client.subscribe()</code>.</span>
          </div>
        </div>
      </section>

      <section class="grid">
        <article class="panel">
          <div>
            <h2>Current items</h2>
            <p>Use REST to load and mutate data. The page updates from the live endpoint automatically.</p>
          </div>
          <div class="actions">
            <button id="snapshot">Fetch /items</button>
            <button id="create">POST /items</button>
            <button id="toggle" class="secondary">Stop live subscription</button>
            <select id="transport-select" aria-label="Transport selector">
              <option value="websocket">websocket</option>
              <option value="sse">sse</option>
            </select>
          </div>
          <div class="status">
            <strong id="status">Connecting…</strong>
            <span>mode: <code id="transport">idle</code></span>
            <span>items: <code id="count">0</code></span>
          </div>
          <p id="mode-hint">Server transport: ${transport}. Match this value for the live demo.</p>
          <div class="items" id="items"></div>
        </article>

        <aside class="panel">
          <div>
            <h2>What just happened</h2>
            <p>The feed shows the high-level API calls, not raw websocket frames or custom event channels.</p>
          </div>
          <div class="feed" id="feed"></div>
        </aside>
      </section>
    </main>
    <script type="module">${script(transport)}</script>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
