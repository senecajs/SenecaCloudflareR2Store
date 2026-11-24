# Changes

## 0.1.0 2026-11-21

* First release. A Seneca entity store backed by Cloudflare R2, through a Workers binding, the S3-compatible API, or a local folder.
* Seneca 4: the peer dependencies are `seneca` `^4.0.0` and `@seneca/entity` `^29.0.0`. Node.js 24 or later (`engines.node` `>=24`).
* The option defaults are built with the validator that Seneca passes to the plugin: `defaults` is a function of `{ valid }`. Seneca 4 rejects defaults built with Gubu (`plugin_gubu_shape`), and gubu was never a declared dependency. `local` and `r2` stay open. Unknown top-level options are rejected with `invalid_plugin_option`.
* The option `generate_id` must be a function when given. The default returns `undefined`, which means that the entity plugin generates the id, as before.
* The store connects in the plugin's `init` task (`seneca.init`), not in a raw `init:CloudflareR2Store` action.
* No dependency on `seneca-promisify`, `seneca-entity` or `@seneca/entity-util`. Load the entity plugin as `@seneca/entity`.
* `npm pack` and `npm publish` build `dist/` first (`prepack`).
* Releases are published from GitHub Actions with npm trusted publishing and provenance. The local `repo-tag` and `repo-publish` scripts are removed.
* Tested with a local folder, with Miniflare's local R2 bucket (workerd) through the Workers binding from Node and inside a Miniflare Worker (`nodejs_compat`), and through the S3-compatible API against a local S3 server (S3Mock). A deployed Cloudflare Worker and the real R2 S3 endpoint were not tested on Seneca 4.
