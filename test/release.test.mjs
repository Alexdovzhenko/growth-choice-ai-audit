import test from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { spawnSync } from 'node:child_process'
import { runAudit } from '../dist/index.js'

const original4 = dns.resolve4, original6 = dns.resolve6, originalFetch = globalThis.fetch
const publicIP = '93.184.216.34'
function fixture() {
  dns.resolve4 = async () => [publicIP]
  dns.resolve6 = async () => []
}
test.afterEach(() => { dns.resolve4 = original4; dns.resolve6 = original6; globalThis.fetch = originalFetch })

for (const host of ['127.0.0.1','10.0.0.1','169.254.169.254','[::1]','[::ffff:7f00:1]','[fe91::1]','[fc00::1]','224.0.0.1','250.0.0.1']) {
  test(`blocks reserved destination ${host}`, async () => {
    globalThis.fetch = async () => { assert.fail('must not connect') }
    await assert.rejects(runAudit(`http://${host}`), { code: 'SSRF_BLOCKED' })
  })
}
test('rejects mixed public IPv4 and private IPv6 DNS answers', async () => {
  fixture(); dns.resolve6 = async () => ['::1']
  globalThis.fetch = async () => { assert.fail('must not connect') }
  await assert.rejects(runAudit('https://example.com'), { code: 'SSRF_BLOCKED' })
})
test('checks redirect destinations before connecting', async () => {
  fixture(); let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }) }
  await assert.rejects(runAudit('https://example.com'), { code: 'SSRF_BLOCKED' }); assert.equal(calls, 1)
})
test('limits redirect chains', async () => {
  fixture(); let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }) }
  await assert.rejects(runAudit('https://example.com'), { code: 'UNREACHABLE' }); assert.equal(calls, 6)
})
test('deadline includes a stalled response body', async () => {
  fixture()
  globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {once:true}) } }))
  await assert.rejects(runAudit('https://example.com', { timeoutMs: 20 }), { code: 'TIMEOUT' })
})
test('deadline includes stalled DNS', async () => {
  fixture(); dns.resolve4 = () => new Promise(() => {})
  await assert.rejects(runAudit('https://example.com', { timeoutMs: 20 }), { code: 'TIMEOUT' })
})
test('oversized HTML fails instead of scoring truncated content', async () => {
  fixture(); globalThis.fetch = async () => new Response('x'.repeat(512 * 1024 + 1))
  await assert.rejects(runAudit('https://example.com'), { code: 'RESPONSE_TOO_LARGE' })
})
test('sitemap alone passes discovery; null JSON-LD does not crash SDK', async () => {
  fixture()
  globalThis.fetch = async url => {
    const path = new URL(url).pathname
    if (path === '/') return new Response('<html><title>Example services</title><h1>Services</h1><script type="application/ld+json">null</script><p>Service provider</p></html>')
    if (path === '/sitemap.xml') return new Response('<urlset/>')
    if (path === '/robots.txt') return new Response('User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml')
    return new Response('', {status:404})
  }
  const result = await runAudit('https://example.com')
  assert.equal(result.categories.ai_discovery.score, 16); assert.equal(result.categories.ai_discovery.status, 'pass')
  assert.ok(result.score >= 0 && result.score <= 100)
})
test('SDK rejects invalid timeout and embedded credentials', async () => {
  await assert.rejects(runAudit('https://example.com', {timeoutMs:NaN}), {code:'INVALID_ARGUMENT'})
  await assert.rejects(runAudit('https://user:password@example.com'), {code:'INVALID_URL'})
  await assert.rejects(runAudit('file:///etc/passwd'), {code:'INVALID_URL'})
})
for (const args of [['--timeout','abc','https://example.com'],['https://example.com','--output'],['https://example.com','--unknown'],['--timeout','0','https://example.com']]) {
  test(`CLI usage validation ${args.join(' ')}`, () => { const r=spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8'}); assert.equal(r.status,2) })
}
test('CLI help and version', () => { for(const arg of ['--help','--version']) { const r=spawnSync(process.execPath,['dist/cli.js',arg],{encoding:'utf8'}); assert.equal(r.status,0); assert.match(r.stdout,/0\.1\.0/) } })

test('SDK recognizes organization and website nodes inside JSON-LD graphs', async () => {
  fixture()
  globalThis.fetch = async url => new URL(url).pathname === '/' ? new Response('<title>Example services</title><script type="application/ld+json">{"@graph":[null,{"@type":["Thing","Organization"],"name":"Example","url":"https://example.com","sameAs":["https://example.org"]},{"@type":"WebSite"}]}</script>') : new Response('',{status:404})
  const result = await runAudit('https://example.com')
  assert.equal(result.categories.structured_data.score,20)
})
