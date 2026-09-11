# Installing the adapter into a dockerized Paperclip

Verified on 2026-09-11 against the official image `ghcr.io/paperclipai/paperclip:latest`
(Node v24.20.0 inside the image, `PAPERCLIP_HOME=/paperclip`, `WORKDIR /app`).
Every command and every response below was run against that image.

## The rule that decides everything

Paperclip loads an external adapter with a dynamic `import()` **inside the server
process**, which lives inside the container:

```js
// server/src/adapters/plugin-loader.ts
const packageDir = localPath ? path.resolve(localPath) : path.resolve(getAdapterPluginsDir(), "node_modules", packageName);
const mod = await import(pathToFileURL(path.resolve(packageDir, entryPoint)).href);
```

So a path you type in the UI or send to the API is resolved **in the container's
filesystem**, not on your host. Two consequences:

1. The adapter directory must be mounted into the container, and the path you
   register must be the path *inside* it.
2. The registration is stored in `$PAPERCLIP_HOME/adapter-plugins.json`
   (`/paperclip/adapter-plugins.json` in the official image) and replayed on every
   start. `/paperclip` must therefore live on a named volume or bind mount, and the
   directory it points at must be mounted at every start.

If the mount goes missing, Paperclip does not fail to boot. It logs a warning and
the adapter silently disappears from `GET /api/adapters`:

```
"msg":"Failed to dynamically load external adapter; skipping"
"message":"ENOENT: no such file or directory, open '/opt/paperclip-adapters/deepseek/package.json'"
```

That log line is the first thing to look for if the agent's adapter type vanishes
after a `docker compose up -d`.

## Option A — bind-mount a built package (no npm registry needed)

### 1. Build a self-contained package directory on the host

```sh
git clone https://github.com/GoPro3400/paperclip_adapter_deepseek
cd paperclip_adapter_deepseek
npm install
npm run build
npm pack                       # -> paperclip-adapter-deepseek-0.1.0.tgz

sudo mkdir -p /opt/paperclip-adapters
sudo tar xzf paperclip-adapter-deepseek-0.1.0.tgz -C /opt/paperclip-adapters
sudo mv /opt/paperclip-adapters/package /opt/paperclip-adapters/deepseek
cd /opt/paperclip-adapters/deepseek
sudo npm install --omit=dev    # runtime deps next to the package
```

The last step is not optional. `dist/server/*.js` imports `@paperclipai/adapter-utils`
at runtime, and Node resolves it by walking up from the package directory.
`/app/node_modules` inside the image is not on that path, so the package needs its
own `node_modules`. The finished directory is about 42 MB.

Mounting the git checkout itself (after `npm install && npm run build`) works too.
`npm pack` only strips sources, tests and dev dependencies.

### 2. Mount it into the container

```yaml
services:
  server:
    volumes:
      - paperclip-data:/paperclip                                     # keep this
      - /opt/paperclip-adapters/deepseek:/opt/paperclip-adapters/deepseek:ro
```

Two details:

- **Mount it read-only.** The loader only reads; installing from a read-only mount
  was verified to work.
- **Mount it outside `/paperclip`.** The image entrypoint runs
  `chown -R node:node "$PAPERCLIP_HOME"` when it finds any file in the tree not
  owned by `node`. On a bind mount that rewrites the ownership of your host
  directory. Anywhere outside `/paperclip` (`/opt/...`, `/srv/...`) avoids it.

Then recreate the container so the mount applies:

```sh
docker compose up -d
```

### 3. Register the adapter

In the UI: **Settings → Adapters → Install**, local path
`/opt/paperclip-adapters/deepseek`. This is the simplest route, because adapter
installs require instance-admin access and the browser session already has it.

The same thing over the API (`POST /api/adapters/install`, instance admin required):

```sh
curl -X POST http://localhost:3100/api/adapters/install \
  -H "Content-Type: application/json" \
  -d '{"packageName": "/opt/paperclip-adapters/deepseek", "isLocalPath": true}'
```

Verified response:

```json
{"type":"deepseek_api","packageName":"/opt/paperclip-adapters/deepseek","version":"0.1.0","installedAt":"2026-09-11T09:29:19.985Z","requiresRestart":false}
```

Note the field names: the request takes `packageName` + `isLocalPath`, not
`localPath`. The published Paperclip docs still show an older `POST /api/adapters`
shape with `{"localPath": ...}`; the route that exists in the server is the one
above.

For scripting, the Paperclip CLI wraps the same call and handles the admin login:

```sh
npx paperclipai@latest client adapter install \
  --api-base http://localhost:3100 \
  --payload-json '{"packageName":"/opt/paperclip-adapters/deepseek","isLocalPath":true}'
```

### 4. Check that it really loaded

```sh
curl -s http://localhost:3100/api/adapters | jq '.[] | select(.type=="deepseek_api")'
```

```json
{
  "type": "deepseek_api",
  "source": "external",
  "modelsCount": 3,
  "loaded": true,
  "disabled": false,
  "version": "0.1.0",
  "packageName": "/opt/paperclip-adapters/deepseek",
  "isLocalPath": true
}
```

`"loaded": true` means the module was imported successfully. Two more probes worth
running once, because they exercise code paths the install itself does not:

```sh
curl -s http://localhost:3100/api/adapters/deepseek_api/config-schema | jq '.fields | length'   # 16
curl -s http://localhost:3100/api/adapters/deepseek_api/ui-parser.js | head -c 60               # parser source
```

Finally `docker compose restart server` and list the adapters again. It must still
be there — that is what proves the volume and the mount are wired correctly and not
just the running process. Verified: after a restart the adapter comes back with
`"loaded": true` from this record:

```json
[{"packageName":"/opt/paperclip-adapters/deepseek","localPath":"/opt/paperclip-adapters/deepseek","version":"0.1.0","type":"deepseek_api","installedAt":"2026-09-11T09:29:19.985Z"}]
```

### 5. Updating after a code change

Rebuild on the host, then reload in place — no container restart:

```sh
cd /path/to/paperclip_adapter_deepseek && npm run build
# re-stage the package (repeat step 1) if you mounted a packed copy rather than the checkout

curl -X POST http://localhost:3100/api/adapters/deepseek_api/reload
# {"type":"deepseek_api","version":"0.1.1","reloaded":true}
```

Reload busts the ESM cache, re-imports the module and re-reads the version from
`package.json` on disk. `docker compose restart server` achieves the same thing more
bluntly. Do not use `POST /api/adapters/:type/reinstall` here: it is for
npm-sourced adapters and returns `400 Local-path adapters cannot be reinstalled`.

## Option B — install from an npm registry

If you publish the package (public npm or an internal registry the container can
reach), the container does the fetching itself:

```sh
curl -X POST http://localhost:3100/api/adapters/install \
  -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-adapter-deepseek"}'
```

The server runs `npm install --no-save <spec>` with the working directory set to
`/paperclip/adapter-plugins`, so this route needs:

- outbound access from the container to the registry (and a `.npmrc` for a private
  one — put it at `/paperclip/.npmrc`, since `HOME=/paperclip` in the image),
- `/paperclip` writable and persistent, which it already is if you kept the
  `paperclip-data` volume.

No bind mount is needed, and updates are one call:
`POST /api/adapters/deepseek_api/reinstall`.

Pass a registry package name, not a path or a `.tgz` file. The install route reuses
the same string to resolve `adapter-plugins/node_modules/<name>` afterwards, so a
path-shaped spec installs and then fails to load.

## Agent configuration specifics in Docker

- **`cwd` must exist inside the container.** Point it at a mounted project
  directory or at a Paperclip execution workspace. A host path that is not mounted
  fails the environment test.
- **`DEEPSEEK_API_KEY`** goes in the agent's environment section, preferably as a
  Paperclip secret binding. Alternatively pass it to the container
  (`-e DEEPSEEK_API_KEY=...`); the adapter falls back to the server process
  environment.
- **Egress to `https://api.deepseek.com`** must work from inside the container.
  When it does not, **Test environment** reports it as a warning, not a failure:

  ```
  warn  Could not list DeepSeek models: DeepSeek request failed: fetch failed
  warn  Chat completion probe failed: DeepSeek request failed: fetch failed
  ```

- **Behind a proxy, set both variables on the container:**

  ```yaml
  environment:
    HTTPS_PROXY: "http://proxy.internal:3128"
    NODE_USE_ENV_PROXY: "1"
  ```

  Node's `fetch` ignores `HTTPS_PROXY` unless that flag is set. Measured inside the
  image with an unreachable proxy address, which makes the difference visible:

  | Environment | Result |
  |---|---|
  | `HTTPS_PROXY` only | `UND_ERR_CONNECT_TIMEOUT` — went straight to DeepSeek |
  | `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` | `ECONNREFUSED` — went to the proxy |

- **Session transcripts** default to
  `/paperclip/instances/default/adapters/deepseek_api/sessions`, on the
  `paperclip-data` volume, so conversation continuity survives container
  recreation. Override with the `sessionsDir` config field if you want them
  elsewhere.

A healthy environment test on a container without a key looks like this — the
`error` line is the only thing missing before the agent can run:

```
error  DEEPSEEK_API_KEY is not set.
info   API base URL: https://api.deepseek.com
info   Model: deepseek-flash (DeepSeek Flash (V4.1, recommended)).
info   Reasoning effort: high.
info   Working directory exists: /paperclip
info   Session transcripts directory: /paperclip/instances/default/adapters/deepseek_api/sessions
info   Shell for run_shell: /bin/bash
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to install adapter: ENOENT ... package.json` | The path does not exist in the container | Register the container path, not the host path; check `docker exec <c> ls <path>` |
| Adapter disappears after `docker compose up -d` | The bind mount was dropped from the compose file | Re-add the mount; the record in `adapter-plugins.json` still points at it |
| Install succeeds, then `Cannot find package '@paperclipai/adapter-utils'` | The mounted directory has no `node_modules` | Run `npm install --omit=dev` inside the staged directory and remount |
| Everything gone after recreating the container | `/paperclip` was not on a volume | Mount `paperclip-data:/paperclip` (the stock compose files already do) |
| `403 Adapter installation is platform-managed` | Cloud-managed instance | Runtime adapter installs are disabled there by design |
| `400 Cannot reload built-in adapter` | Wrong type in the URL | The type is `deepseek_api` |
| Model list empty in the agent form, `fetch failed` in the test | No egress from the container | Open access to `api.deepseek.com`, or set `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` |

## Кратко (RU)

1. Соберите пакет на хосте: `npm install && npm run build && npm pack`, распакуйте
   архив в `/opt/paperclip-adapters/deepseek` и выполните там `npm install --omit=dev`
   (без этого Node не найдёт `@paperclipai/adapter-utils` внутри контейнера).
2. Пробросьте каталог в контейнер только на чтение и **вне** `/paperclip`:
   `- /opt/paperclip-adapters/deepseek:/opt/paperclip-adapters/deepseek:ro`.
   Том `paperclip-data:/paperclip` обязательно сохраните — в нём лежит
   `adapter-plugins.json`.
3. Пересоздайте контейнер (`docker compose up -d`) и установите адаптер:
   Settings → Adapters → Install, путь `/opt/paperclip-adapters/deepseek`
   (или `POST /api/adapters/install` с `{"packageName": "...", "isLocalPath": true}`).
4. Проверьте: `GET /api/adapters` должен показать `deepseek_api` с `"loaded": true`,
   затем перезапустите контейнер и проверьте ещё раз.
5. Агенту укажите `cwd`, существующий внутри контейнера, и `DEEPSEEK_API_KEY`
   (лучше через секрет Paperclip). За прокси добавьте контейнеру
   `HTTPS_PROXY` и `NODE_USE_ENV_PROXY=1`.
6. После изменений в коде: пересобрать на хосте и вызвать
   `POST /api/adapters/deepseek_api/reload`.
