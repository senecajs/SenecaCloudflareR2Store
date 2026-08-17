/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import Os from 'os'
import Path from 'path'
import Fsp from 'fs/promises'

import Seneca from 'seneca'
import { Miniflare } from 'miniflare'

import CloudflareR2StoreDoc from '../src/CloudflareR2StoreDoc'
import CloudflareR2Store from '../src/CloudflareR2Store'

describe('CloudflareR2Store', () => {
  test('load-plugin', async () => {
    expect(CloudflareR2Store).toBeDefined()
    expect(CloudflareR2StoreDoc).toBeDefined()

    const folder = await tmpFolder()

    const seneca = Seneca({ legacy: false })
      .test()
      .use('promisify')
      .use('entity')
      .use(CloudflareR2Store, { local: { active: true, folder } })

    await seneca.ready()

    expect(seneca.export('CloudflareR2Store/native')).toBeDefined()

    await Fsp.rm(folder, { recursive: true, force: true })
  })

  test('utils.makeR2Key', () => {
    const { makeR2Key } = CloudflareR2Store['utils']

    const seneca = Seneca({ legacy: false }).test().use('entity')
    const ent0 = seneca.make('foo')
    const ent1 = seneca.make('foo/bar')

    expect(
      makeR2Key('i0', ent0, { prefix: 'seneca/r2/', suffix: '.json' }, false),
    ).toEqual('seneca/r2/-/-/foo/i0.json')

    expect(
      makeR2Key('i0', ent1, { prefix: 'seneca/r2/', suffix: '.json' }, false),
    ).toEqual('seneca/r2/-/foo/bar/i0.json')

    expect(
      makeR2Key('i0', ent1, { folder: 'mybucket', suffix: '.json' }, false),
    ).toEqual('mybucket/i0.json')

    expect(
      makeR2Key('i0', ent1, { prefix: 'seneca/r2/', suffix: '' }, true),
    ).toEqual('seneca/r2/-/foo/bar/i0')
  })

  describe('local-folder', () => {
    let folder: string
    let seneca: any

    beforeAll(async () => {
      folder = await tmpFolder()

      seneca = Seneca({ legacy: false })
        .test()
        .use('promisify')
        .use('entity')
        .use(CloudflareR2Store, { local: { active: true, folder } })

      await seneca.ready()
    })

    afterAll(async () => {
      await Fsp.rm(folder, { recursive: true, force: true })
    })

    test('save and load by id', async () => {
      const ent = await seneca
        .entity('foo/bar')
        .data$({ x: 1, y: 'hello' })
        .save$()

      expect(ent.id).toBeDefined()
      expect(ent).toMatchObject({ x: 1, y: 'hello' })

      const loaded = await seneca.entity('foo/bar').load$(ent.id)
      expect(loaded).toMatchObject({ id: ent.id, x: 1, y: 'hello' })
    })

    test('load missing returns null', async () => {
      const loaded = await seneca.entity('foo/bar').load$('not-an-id')
      expect(loaded).toEqual(null)
    })

    test('list returns empty array', async () => {
      const list = await seneca.entity('foo/bar').list$({})
      expect(list).toEqual([])
    })

    test('remove by id', async () => {
      const ent = await seneca
        .entity('foo/bar')
        .data$({ x: 99 })
        .save$()

      await seneca.entity('foo/bar').remove$(ent.id)

      const loaded = await seneca.entity('foo/bar').load$(ent.id)
      expect(loaded).toEqual(null)
    })

    test('save and load jsonl field', async () => {
      const ent = await seneca
        .entity('foo/chunk')
        .data$({
          chunks: [{ text: 'a' }, { text: 'b' }],
        })
        .save$({ jsonl$: 'chunks' })

      const loaded = await seneca
        .entity('foo/chunk')
        .load$({ id: ent.id, jsonl$: 'chunks' })

      expect(loaded.chunks).toEqual([{ text: 'a' }, { text: 'b' }])
    })

    test('save and load binary field', async () => {
      const buf = Buffer.from([0x01, 0x02, 0x03])

      const ent = await seneca
        .entity('foo/bin')
        .data$({ data: buf })
        .save$({ bin$: 'data' })

      const loaded = await seneca
        .entity('foo/bin')
        .load$({ id: ent.id, bin$: 'data' })

      expect(Buffer.from(loaded.data)).toEqual(buf)
    })
  })

  describe('r2-binding', () => {
    let mf: Miniflare
    let seneca: any

    beforeAll(async () => {
      mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        r2Buckets: ['TEST_R2'],
      })

      const binding = await mf.getR2Bucket('TEST_R2')

      seneca = Seneca({ legacy: false })
        .test()
        .use('promisify')
        .use('entity')
        .use(CloudflareR2Store, { r2: { binding } })

      await seneca.ready()
    })

    afterAll(async () => {
      await mf.dispose()
    })

    test('save and load by id', async () => {
      const ent = await seneca
        .entity('foo/bar')
        .data$({ x: 2, y: 'world' })
        .save$()

      expect(ent.id).toBeDefined()

      const loaded = await seneca.entity('foo/bar').load$(ent.id)
      expect(loaded).toMatchObject({ id: ent.id, x: 2, y: 'world' })
    })

    test('load missing returns null', async () => {
      const loaded = await seneca.entity('foo/bar').load$('no-such-id')
      expect(loaded).toEqual(null)
    })

    test('remove by id', async () => {
      const ent = await seneca
        .entity('foo/bar')
        .data$({ x: 42 })
        .save$()

      await seneca.entity('foo/bar').remove$(ent.id)

      const loaded = await seneca.entity('foo/bar').load$(ent.id)
      expect(loaded).toEqual(null)
    })
  })
})

async function tmpFolder() {
  return Fsp.mkdtemp(Path.join(Os.tmpdir(), 'seneca-r2-test-'))
}
