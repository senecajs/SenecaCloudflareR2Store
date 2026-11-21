/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import Os from 'os'
import Path from 'path'
import Fsp from 'fs/promises'

import Seneca from 'seneca'
import type {} from '@seneca/entity'
import { Miniflare } from 'miniflare'
import { build } from 'esbuild'

import CloudflareR2StoreDoc from '../src/CloudflareR2StoreDoc'
import CloudflareR2Store from '../src/CloudflareR2Store'

// The S3-compatible API path runs against a local S3 server, such as the
// s3mock service of the Seneca test harness (port 19100, bucket
// test-bucket). Set SENECA_TEST_S3_ENDPOINT to run it, for example
// SENECA_TEST_S3_ENDPOINT=http://127.0.0.1:19100. Without it the S3 tests
// are skipped.
const S3_ENDPOINT = process.env.SENECA_TEST_S3_ENDPOINT
const S3_BUCKET = process.env.SENECA_TEST_S3_BUCKET || 'test-bucket'

const describeS3 = S3_ENDPOINT ? describe : describe.skip

let mf: Miniflare
let folder: string

beforeAll(async () => {
  folder = await tmpFolder()
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    r2Buckets: ['TEST_R2'],
  })
})

afterAll(async () => {
  await mf.dispose()
  await Fsp.rm(folder, { recursive: true, force: true })
})

describe('CloudflareR2Store', () => {
  test('load-plugin', async () => {
    expect(CloudflareR2Store).toBeDefined()
    expect(CloudflareR2StoreDoc).toBeDefined()

    const seneca = await makeSeneca('local')

    expect(seneca.export('CloudflareR2Store/native')).toBeDefined()
    expect(seneca.export('CloudflareR2Store/native')().client).toBeDefined()
    await seneca.close()
  })

  test('utils.makeR2Key', async () => {
    const { makeR2Key } = CloudflareR2Store['utils']

    const seneca = Seneca({ legacy: false }).test().use('@seneca/entity')
    await seneca.ready()
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

  test('generate_id option', async () => {
    let n = 0
    const seneca = await makeSeneca('local', {
      generate_id: (ent: any) =>
        'item' === ent.canon$({ object: true }).name ? 'gen-' + ++n : undefined,
    })

    const a = await seneca.entity('gen/item').data$({ x: 1 }).save$()
    expect(a.id).toEqual('gen-1')

    // undefined from the option: the entity plugin generates the id.
    const b = await seneca.entity('gen/other').data$({ x: 2 }).save$()
    expect(typeof b.id).toEqual('string')
    expect(b.id.length).toBeGreaterThan(0)
    expect(b.id).not.toMatch(/^gen-/)
    await seneca.close()
  })

  test('ent option names the jsonl and bin fields', async () => {
    const seneca = await makeSeneca('local', {
      ent: {
        '-/doc/chunk': { jsonl: 'chunks' },
        '-/doc/file': { bin: 'data' },
      },
    })

    const chunk = await seneca
      .entity('doc/chunk')
      .data$({ chunks: [{ text: 'a' }] })
      .save$()
    const loadedChunk = await seneca.entity('doc/chunk').load$(chunk.id)
    expect(loadedChunk.chunks).toEqual([{ text: 'a' }])

    const buf = Buffer.from([0x0a, 0x0b])
    const file = await seneca.entity('doc/file').data$({ data: buf }).save$()
    const loadedFile = await seneca.entity('doc/file').load$(file.id)
    expect(Buffer.from(loadedFile.data)).toEqual(buf)

    // The bin key has no suffix.
    expect(
      await Fsp.readFile(Path.join(folder, 'seneca/r2/-/doc/file', file.id)),
    ).toEqual(buf)

    await seneca.close()
  })

  test('invalid options are rejected', async () => {
    for (const bad of [
      { generate_id: 'not-a-function' },
      { bad: 1 },
      { ent: { '-/doc/file': { bin: 1 } } },
    ]) {
      const errs: any[] = []
      const seneca = Seneca({ legacy: false, debug: { undead: true } })
        .test((err: any) => errs.push(err), 'silent')
        .use('@seneca/entity')
        .use(CloudflareR2Store, bad)
      await seneca.ready()
      expect(errs.map((err: any) => err.code)).toEqual([
        'invalid_plugin_option',
      ])
      await seneca.close()
    }
  })
})

// The same entity tests run through a local folder, through Miniflare's
// R2 bucket binding and, when SENECA_TEST_S3_ENDPOINT is set, through the
// S3-compatible API against a local S3 server.
describe.each(['local', 'binding'] as const)('crud (%s)', (mode) => {
  crudTests(mode)
})

describeS3('crud (s3) [needs SENECA_TEST_S3_ENDPOINT]', () => {
  crudTests('s3')

  test('error from the S3 endpoint', async () => {
    const s = await makeSeneca(
      's3',
      { shared: { Bucket: 'no-such-bucket-' + Date.now() } },
      'silent',
    )
    await expect(s.entity('foo/bar').data$({ x: 1 }).save$()).rejects.toThrow()
    await expect(s.entity('foo/bar').load$('i0')).rejects.toThrow()
    await expect(s.entity('foo/bar').remove$('i0')).rejects.toThrow()
    await s.close()
  })
})

function crudTests(mode: 'local' | 'binding' | 's3') {
  let seneca: any

  beforeAll(async () => {
    seneca = await makeSeneca(mode)
  })

  afterAll(async () => {
    await seneca.close()
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

  test('save with id$ and update', async () => {
    const ent = await seneca
      .entity('foo/bar')
      .data$({ id$: 'fixed-' + mode, x: 1 })
      .save$()
    expect(ent.id).toEqual('fixed-' + mode)

    ent.x = 2
    await ent.save$()

    const loaded = await seneca.entity('foo/bar').load$('fixed-' + mode)
    expect(loaded).toMatchObject({ id: 'fixed-' + mode, x: 2 })
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
    const ent = await seneca.entity('foo/bar').data$({ x: 99 }).save$()

    await seneca.entity('foo/bar').remove$(ent.id)

    const loaded = await seneca.entity('foo/bar').load$(ent.id)
    expect(loaded).toEqual(null)

    // Removing a missing object is not an error.
    await seneca.entity('foo/bar').remove$(ent.id)
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

  test('jsonl field must be an array', async () => {
    const s = await makeSeneca(mode, {}, 'silent')
    await expect(
      s.entity('foo/chunk').data$({ chunks: 'no' }).save$({ jsonl$: 'chunks' }),
    ).rejects.toThrow('jsonl field not an array: chunks')
    await s.close()
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

    // A function value is called for the bytes.
    const fent = await seneca
      .entity('foo/bin')
      .data$({ data: () => Buffer.from('xyz') })
      .save$({ bin$: 'data' })
    const floaded = await seneca
      .entity('foo/bin')
      .load$({ id: fent.id, bin$: 'data' })
    expect(Buffer.from(floaded.data).toString()).toEqual('xyz')
  })

  test('bin field must be present', async () => {
    const s = await makeSeneca(mode, {}, 'silent')
    await expect(
      s.entity('foo/bin').data$({ other: 1 }).save$({ bin$: 'data' }),
    ).rejects.toThrow('bin field not found: data')
    await s.close()
  })
}

// Seneca, @seneca/entity and this store run inside workerd, in a Worker
// that Miniflare starts, with the R2Bucket binding of the Worker's env
// passed as the r2.binding option. The bundle includes the S3 client,
// which the store loads but the binding mode does not call.
describe('inside workerd', () => {
  test('crud through env binding', async () => {
    const script = await bundleWorker(`
      import Seneca from 'seneca'
      import Entity from '@seneca/entity'
      import CloudflareR2Store from '../src/CloudflareR2Store'

      export default {
        async fetch(request, env) {
          const seneca = Seneca({ legacy: false, log: 'silent' })
            .use(Entity)
            .use(CloudflareR2Store, { r2: { binding: env.BUCKET } })
          await seneca.ready()

          const saved = await seneca.entity('w/item').data$({ n: 1 }).save$()
          const loaded = await seneca.entity('w/item').load$(saved.id)
          const bin = await seneca
            .entity('w/file')
            .data$({ data: new Uint8Array([1, 2, 3]) })
            .save$({ bin$: 'data' })
          const binLoaded = await seneca
            .entity('w/file')
            .load$({ id: bin.id, bin$: 'data' })
          const keys = (await env.BUCKET.list()).objects.map((o) => o.key)
          await seneca.entity('w/item').remove$(saved.id)
          const gone = await seneca.entity('w/item').load$(saved.id)
          await seneca.close()

          return Response.json({
            loaded: loaded.data$(false),
            bin: Array.from(binLoaded.data),
            keys,
            id: saved.id,
            gone,
          })
        },
      }
    `)

    const worker = new Miniflare({
      modules: true,
      script,
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      r2Buckets: ['BUCKET'],
    })

    try {
      const res = await worker.dispatchFetch('http://localhost/')
      const out: any = await res.json()
      expect(out.loaded).toMatchObject({ n: 1 })
      expect(out.bin).toEqual([1, 2, 3])
      expect(out.keys).toContain('seneca/r2/-/w/item/' + out.id + '.json')
      expect(out.gone).toEqual(null)
    } finally {
      await worker.dispose()
    }
  })
})

// Bundles a Worker module from source that imports seneca, @seneca/entity
// and the store. workerd provides the Node.js built-in modules that Seneca
// needs through the nodejs_compat flag.
async function bundleWorker(contents: string) {
  const out = await build({
    stdin: { contents, resolveDir: __dirname, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'error',
    banner: {
      js:
        "import { createRequire } from 'node:module';" +
        "const require = createRequire('/');",
    },
  })
  return out.outputFiles[0].text
}

async function makeSeneca(
  mode: 'local' | 'binding' | 's3',
  options: any = {},
  log?: string,
) {
  const conn =
    'local' === mode
      ? { local: { active: true, folder } }
      : 'binding' === mode
        ? { r2: { binding: await mf.getR2Bucket('TEST_R2') } }
        : {
            // The S3 client takes its endpoint, region and path style from
            // the s3 option; the local server accepts any credentials.
            r2: {
              accountId: 'local',
              accessKeyId: process.env.SENECA_TEST_S3_ACCESS_KEY || 'test',
              secretAccessKey: process.env.SENECA_TEST_S3_SECRET_KEY || 'test',
            },
            s3: {
              endpoint: S3_ENDPOINT,
              region: process.env.SENECA_TEST_S3_REGION || 'us-east-1',
              forcePathStyle: true,
            },
            shared: { Bucket: S3_BUCKET },
          }

  const seneca = Seneca({ legacy: false })
    .test(log)
    .use('@seneca/entity')
    .use(CloudflareR2Store, { ...conn, ...options })
  await seneca.ready()
  return seneca
}

async function tmpFolder() {
  return Fsp.mkdtemp(Path.join(Os.tmpdir(), 'seneca-r2-test-'))
}
