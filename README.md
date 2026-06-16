![Seneca](http://senecajs.org/files/assets/seneca-logo.png)
> A [Seneca.js][] data storage plugin.

# @seneca/cloudflare-r2-store

[![npm version][npm-badge]][npm-url]
[![Build](https://github.com/senecajs/SenecaCloudflareR2Store/actions/workflows/build.yml/badge.svg)](https://github.com/senecajs/SenecaCloudflareR2Store/actions/workflows/build.yml)

| ![Voxgig](https://www.voxgig.com/res/img/vgt01r.png) | This open source module is sponsored and supported by [Voxgig](https://www.voxgig.com). |
|---|---|

## Description

`@seneca/cloudflare-r2-store` is a [Seneca](http://senecajs.org) plugin that provides an entity data store backed by [Cloudflare R2](https://developers.cloudflare.com/r2/) object storage.

R2 is an S3-compatible object storage service. Each entity is stored as a single object keyed by its canon and id. Because R2 is id-addressed, `list$` always returns `[]` — use [@seneca/cloudflare-d1-store](https://github.com/senecajs/SenecaCloudflareD1Store) if you need field-based queries.

## Install

```sh
npm install @seneca/cloudflare-r2-store
```

## Usage

### Worker binding mode

Pass the `R2Bucket` binding from your Cloudflare Worker directly:

```js
import CloudflareR2Store from '@seneca/cloudflare-r2-store'

seneca
  .use('entity')
  .use(CloudflareR2Store, {
    r2: { binding: env.MY_BUCKET },
  })
```

### S3-compatible API mode (Node / CI)

Use R2's S3-compatible API with your R2 access key credentials:

```js
seneca
  .use('entity')
  .use(CloudflareR2Store, {
    shared: { Bucket: 'my-bucket' },
    r2: {
      accountId: 'your-account-id',
      accessKeyId: 'your-access-key-id',
      secretAccessKey: 'your-secret-access-key',
    },
  })
```

### Local folder mode (dev / testing)

```js
seneca
  .use('entity')
  .use(CloudflareR2Store, {
    local: { active: true, folder: '/tmp/r2-dev' },
  })
```

## Options

| Option | Default | Description |
|---|---|---|
| `prefix` | `'seneca/r2/'` | Key prefix prepended to every object key |
| `suffix` | `'.json'` | Key suffix appended to every object key |
| `folder` | — | If set, overrides prefix/suffix and uses `folder/<id>` as the key |
| `shared` | `{}` | Merged into every S3 command (e.g. `{ Bucket: 'my-bucket' }`) |
| `r2.binding` | — | `R2Bucket` Workers binding (takes priority over S3 client) |
| `r2.accountId` | `''` | Cloudflare account ID (for S3-compatible API) |
| `r2.accessKeyId` | `''` | R2 access key ID |
| `r2.secretAccessKey` | `''` | R2 secret access key |
| `local.active` | `false` | Use local filesystem instead of R2 |
| `local.folder` | `''` | Local folder path when `local.active` is true |
| `s3` | `{}` | Extra options merged into the `S3Client` constructor |

## Object key scheme

Keys follow the same convention as `@seneca/s3-store`:

```
<prefix><zone>/<base>/<name>/<id><suffix>
```

For example, `seneca.entity('foo/bar').save$()` with defaults produces:

```
seneca/r2/-/foo/bar/<id>.json
```

If `folder` is set, the key is simply `<folder>/<id><suffix>`.

For JSONL or binary fields, the suffix is omitted and the field content is stored as the raw object body.

## JSONL and binary fields

To store a large array field efficiently as newline-delimited JSON:

```js
// save
await seneca.entity('doc/chunk')
  .data$({ chunks: [{ text: 'a' }, { text: 'b' }] })
  .save$({ jsonl$: 'chunks' })

// load
const ent = await seneca.entity('doc/chunk')
  .load$({ id, jsonl$: 'chunks' })
// ent.chunks === [{ text: 'a' }, { text: 'b' }]
```

To store a raw binary buffer:

```js
await seneca.entity('doc/file')
  .data$({ data: buffer })
  .save$({ bin$: 'data' })

const ent = await seneca.entity('doc/file')
  .load$({ id, bin$: 'data' })
// ent.data === Buffer
```

## Query limitation

`list$` always returns `[]`. R2 is an object store addressed by key — there is no index to query against. Use [@seneca/cloudflare-d1-store](https://github.com/senecajs/SenecaCloudflareD1Store) for structured queries.

## Native driver

```js
const { client } = seneca.export('CloudflareR2Store/native')()
```

Returns the active `StorageClient` instance (S3Client wrapper, R2 binding adapter, or local-folder client).

## License

Copyright (c) 2024 the Seneca Project Contributors, MIT License.

[Seneca.js]: http://senecajs.org
[npm-badge]: https://img.shields.io/npm/v/@seneca/cloudflare-r2-store.svg
[npm-url]: https://npmjs.com/package/@seneca/cloudflare-r2-store
