/* Copyright (c) 2024 Seneca contributors, MIT License */

import Path from 'path'
import Fsp from 'fs/promises'

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

import { Gubu } from 'gubu'

const { Open, Any, Skip, Empty, Default, Exact, Child } = Gubu

type R2Config = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
}

type Options = {
  debug: boolean
  prefix: any
  suffix: any
  folder: any
  map?: any
  shared: any
  generate_id?: (ent: any) => string
  local: any
  ent: any
  r2: any
  s3: any
}

export type CloudflareR2StoreOptions = Partial<Options>

// Internal client abstraction — satisfied by S3Client wrapper,
// R2Bucket binding adapter, or local-folder implementation.
type StorageClient = {
  put(key: string, body: Buffer): Promise<void>
  get(key: string): Promise<Buffer | null>
  remove(key: string): Promise<void>
}

function CloudflareR2Store(this: any, options: Options) {
  const seneca: any = this

  const init = seneca.export('entity/init')
  const generate_id: (ent: any) => string =
    options.generate_id || seneca.export('entity/generate_id')

  let desc: any = 'CloudflareR2Store'
  let client: StorageClient

  let store = {
    name: 'CloudflareR2Store',

    save: async function (this: any, msg: any, reply: any) {
      const ent = msg.ent
      const canon = ent.entity$
      const id = '' + (ent.id || ent.id$ || generate_id(ent))
      const d = ent.data$()
      d.id = id

      const entSpec = options.ent[canon]
      const jsonl = entSpec?.jsonl || msg.jsonl$ || msg.q?.jsonl$
      const bin = entSpec?.bin || msg.bin$ || msg.q?.bin$
      const key = makeR2Key(id, ent, options, !!bin)

      let body: Buffer

      if ('string' === typeof jsonl && '' !== jsonl) {
        const arr = ent[jsonl]
        if (!Array.isArray(arr)) {
          return reply(
            new Error('CloudflareR2Store: jsonl field not an array: ' + jsonl),
          )
        }
        body = Buffer.from(
          arr.map((n: any) => JSON.stringify(n)).join('\n') + '\n',
        )
      } else if ('string' === typeof bin && '' !== bin) {
        let data = ent[bin]
        if (null == data) {
          return reply(
            new Error('CloudflareR2Store: bin field not found: ' + bin),
          )
        }
        if ('function' === typeof data) {
          data = data()
        }
        body = Buffer.from(data)
      } else {
        body = Buffer.from(JSON.stringify(d))
      }

      try {
        await client.put(key, body)
        const ento = ent.make$().data$(d)
        reply(null, ento)
      } catch (err: any) {
        reply(err)
      }
    },

    load: async function (this: any, msg: any, reply: any) {
      const qent = msg.qent
      const canon = qent.entity$
      const id = '' + msg.q.id
      const entSpec = options.ent[canon]
      const jsonl = entSpec?.jsonl || msg.jsonl$ || msg.q?.jsonl$
      const bin = entSpec?.bin || msg.bin$ || msg.q?.bin$
      const key = makeR2Key(id, qent, options, !!bin)

      const output: 'ent' | 'jsonl' | 'bin' =
        jsonl && '' !== jsonl ? 'jsonl' : bin && '' !== bin ? 'bin' : 'ent'

      try {
        const raw = await client.get(key)

        if (null == raw) {
          return reply(null)
        }

        let entdata: any = {}

        if ('jsonl' === output) {
          entdata[jsonl] = raw
            .toString('utf-8')
            .split('\n')
            .filter((n: string) => '' !== n)
            .map((n: string) => JSON.parse(n))
        } else if ('bin' === output) {
          entdata[bin] = raw
        } else {
          entdata = JSON.parse(raw.toString('utf-8'))
        }

        entdata.id = id
        const ento = qent.make$().data$(entdata)
        reply(null, ento)
      } catch (err: any) {
        reply(err)
      }
    },

    // NOTE: R2/S3 stores are id-addressed. Field-based querying is not
    // supported; use Cloudflare D1 if you need list$ with filtering.
    list: function (this: any, _msg: any, reply: any) {
      reply(null, [])
    },

    remove: async function (this: any, msg: any, reply: any) {
      const qent = msg.qent
      const canon = qent.entity$
      const id = '' + msg.q.id
      const entSpec = options.ent[canon]
      const bin = entSpec?.bin || msg.bin$ || msg.q?.bin$
      const key = makeR2Key(id, qent, options, !!bin)

      try {
        await client.remove(key)
        reply()
      } catch (err: any) {
        reply(err)
      }
    },

    close: function (this: any, _msg: any, reply: any) {
      this.log.debug('close', desc)
      reply()
    },

    native: function (this: any, _msg: any, reply: any) {
      reply(null, { client: () => client })
    },
  }

  let meta = init(seneca, options, store)

  desc = meta.desc

  seneca.add({ init: store.name, tag: meta.tag }, function (this: any, _msg: any, reply: any) {
    if (options.r2?.binding) {
      client = makeBindingClient(options.r2.binding)
    } else if (options.local?.active) {
      client = makeLocalClient(options.local.folder)
    } else {
      client = makeS3Client(options)
    }
    reply()
  })

  return {
    name: store.name,
    tag: meta.tag,
    exports: {
      native: () => ({ client }),
    },
  }
}

// Builds an R2/S3 object key from an entity canon and id.
function makeR2Key(
  id: string,
  ent: any,
  options: Options,
  bin: boolean,
): string {
  const suffix = bin ? '' : options.suffix

  if (null != options.folder && '' !== options.folder) {
    return options.folder + '/' + id + suffix
  }

  return options.prefix + ent.entity$ + '/' + id + suffix
}

// Adapter for a Cloudflare R2Bucket Workers binding.
function makeBindingClient(binding: any): StorageClient {
  return {
    async put(key, body) {
      await binding.put(key, body)
    },

    async get(key) {
      const obj = await binding.get(key)
      if (null == obj) {
        return null
      }
      return Buffer.from(await obj.arrayBuffer())
    },

    async remove(key) {
      await binding.delete(key)
    },
  }
}

// Client backed by the Cloudflare R2 S3-compatible API via AWS SDK.
function makeS3Client(options: Options): StorageClient {
  const r2 = (options.r2 || {}) as R2Config
  const endpoint = `https://${r2.accountId}.r2.cloudflarestorage.com`

  const s3 = new S3Client({
    endpoint,
    region: 'auto',
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
    ...options.s3,
  })

  const shared = { Bucket: '!not-a-bucket!', ...options.shared }

  return {
    async put(key, body) {
      await s3.send(
        new PutObjectCommand({ ...shared, Key: key, Body: body }),
      )
    },

    async get(key) {
      try {
        const res = await s3.send(
          new GetObjectCommand({ ...shared, Key: key }),
        )
        return destreamToBuffer(res.Body)
      } catch (err: any) {
        if ('NoSuchKey' === err.Code || 'NoSuchKey' === err.name) {
          return null
        }
        throw err
      }
    },

    async remove(key) {
      try {
        await s3.send(
          new DeleteObjectCommand({ ...shared, Key: key }),
        )
      } catch (err: any) {
        if ('NoSuchKey' === err.Code || 'NoSuchKey' === err.name) {
          return
        }
        throw err
      }
    },
  }
}

// Client backed by the local filesystem, for offline dev and testing.
function makeLocalClient(folder: string): StorageClient {
  return {
    async put(key, body) {
      const full = Path.join(folder, key)
      await Fsp.mkdir(Path.dirname(full), { recursive: true })
      await Fsp.writeFile(full, body)
    },

    async get(key) {
      const full = Path.join(folder, key)
      try {
        return await Fsp.readFile(full)
      } catch (err: any) {
        if ('ENOENT' === err.code) {
          return null
        }
        throw err
      }
    },

    async remove(key) {
      const full = Path.join(folder, key)
      try {
        await Fsp.unlink(full)
      } catch (err: any) {
        if ('ENOENT' === err.code) {
          return
        }
        throw err
      }
    },
  }
}

async function destreamToBuffer(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const defaults: Options = {
  debug: false,
  prefix: Empty('seneca/r2/'),
  suffix: Empty('.json'),
  folder: Any(),
  map: Any(),
  shared: Skip({}),

  local: Open({
    active: false,
    folder: '',
    suffixMode: Default('none', Exact('none', 'genid')),
  }),

  ent: Default({}, Child({ jsonl: Skip(String), bin: Skip(String) })),

  r2: Open({
    binding: Skip(Any()),
    accountId: '',
    accessKeyId: '',
    secretAccessKey: '',
  }),

  s3: Skip({}),
}

Object.assign(CloudflareR2Store, {
  defaults,
  utils: { makeR2Key, makeLocalClient, makeBindingClient },
})

export default CloudflareR2Store

if ('undefined' !== typeof module) {
  module.exports = CloudflareR2Store
}
