# Upstream image cache for open-balena-builder (Harbor investigation)

**Status:** investigation, no changes applied · **Date:** 2026-08-16

## 1. What actually pulls from upstream

Tracing the build flow in `src/index.ts`:

| Consumer | Registry | Direction |
|---|---|---|
| Builder daemons (`DOCKER_HOST_AMD64` / `DOCKER_HOST_ARM64`) | docker.io (`library/*`, `balenalib/*`), occasionally ghcr.io / quay.io / others in user `FROM` lines | **pull (upstream)** ← the only internet-facing flow |
| `balena deploy` | openBalena registry (local) | push (local) |
| Delta service (`DELTA_HOST`) | openBalena registry (local) | pull (local) |
| Devices | openBalena registry (local) | pull (local) |

So "make upstream images available near us" means: **cache docker.io (and optionally other public registries) for the two builder daemons.** Everything else is already local.

Notes that constrain the design:

- Builds run with `DOCKER_BUILDKIT=0` (classic builder) on the remote daemons → pulls are performed by **dockerd**, honoring its `daemon.json`.
- Balena base images (`balenalib/…`) live on Docker Hub, so docker.io covers ~95% of fleet `FROM` lines.

## 2. The two mechanics available

### 2.1 Transparent daemon mirror (`registry-mirrors`)

dockerd can be pointed at a pull-through mirror for **docker.io only**:

```json
{ "registry-mirrors": ["https://registry-mirror.lan"] }
```

Hard constraints (verified against docker docs + moby issues):

- **No path prefix allowed** in the mirror URL (moby/moby#47144). The mirror must serve the Docker Hub API at the **root path**. This is why **Harbor cannot be used directly as a `registry-mirror`** — Harbor namespaces everything under `/project/…`.
- **No authentication** between dockerd and the mirror → the mirror must allow anonymous pulls.
- Mirrors are still subject to Docker fair-use upstream; the fallback on mirror failure is Docker Hub itself.

The CNCF `registry:2` image supports exactly this root-path pull-through mode (`proxy.remoteurl: https://registry-1.docker.io`, optional upstream `username`/`password` to pull under a paid account's rate limits).

### 2.2 Harbor proxy-cache projects

Harbor's proxy cache (per official docs) creates a **project-prefixed** pull-through cache:

- Supported upstreams: Docker Hub, Harbor, generic Docker registry, AWS ECR, Azure ACR, Google GCR, Quay, **GitHub GHCR**, JFrog.
- Pull as `harbor.lan/<project>/<namespace>/<repo>:<tag>` (e.g. `harbor.lan/dockerhub/balenalib/raspberrypi4-64-node:24-bookworm`).
- Freshness via **HEAD requests** → does not consume Docker Hub rate-limit budget; full pull only when a layer actually changed.
- **Serves the cached image when the upstream is unreachable** (offline resilience registry:2 does not offer).
- Proxy projects are pull-only (no push), can't have retention policies (they mirror upstream), support quota + "clear cache", optional per-project bandwidth limit.
- Upstream credentials (e.g. Docker Hub PAT) are stored in a *registry endpoint* shared by the project.

## 3. Options

| | A. `registry:2` mirror | B. Harbor + FROM-rewrite | **C. Hybrid (recommended)** |
|---|---|---|---|
| Transparency | full (zero code/build changes) | none — rewrite `FROM` lines in builder before `balena deploy` | docker.io transparent; others explicit |
| Coverage | docker.io only | any upstream (per project) | all |
| Offline builds | partial (tag revalidation still hits upstream) | yes (serves cached when upstream down) | best of both |
| UI / scanning / quota / audit | none | yes | yes |
| Effort | ~1 pod + `daemon.json` on 2 hosts | Harbor + small code change in `src/index.ts` | both, but each piece is small |

### Why not Harbor alone

Harbor's project-prefixed paths are incompatible with dockerd `registry-mirrors` (§2.1), so Harbor-only means **rewriting every `FROM`** in user tarballs — doable (we control the code path) but invasive: multi-stage `FROM … AS builder` clauses must be preserved, and dynamic `FROM ${ARG}` can't be rewritten statically.

## 4. Recommended rollout (Option C)

### 4.1 Harbor (helm, on the existing k8s cluster)

```yaml
# values sketch
expose:
  type: ingress            # or loadBalancer for a dedicated LAN IP
  tls:
    certSource: secret     # cert-manager / internal CA
persistence:
  enabled: true
  imageChartStorage:
    type: filesystem       # or s3 if a bucket is available
registry:  { replicas: 1 } # registry cache is node-local storage
trivy: { enabled: false }  # optional later
```

- PVC sizing: balenalib images run 50–300 MB compressed × arch; **100 Gi** is comfortable for a whole fleet's base images.
- Create **registry endpoints**: `docker-hub` (type Docker Hub, with a PAT), `ghcr` (type GHCR) if needed.
- Create **public** proxy-cache projects: `dockerhub`, `ghcr` (public = anonymous pulls, required for any daemon-level use; restrict at the network layer instead).
- Pre-warm (optional): pull the fleet's common `balenalib/*` bases once, or a scheduled replication/cron job.

### 4.2 Transparent docker.io layer (registry:2 mirror)

One small deployment next to Harbor (single replica, its own PVC):

```yaml
# config.yml
version: 0.1
storage: { filesystem: { rootdirectory: /var/lib/registry }, delete: { enabled: true } }
http:  { addr: :5000, tls: { certificate: /certs/tls.crt, key: /certs/tls.key } }
proxy:
  remoteurl: https://registry-1.docker.io
  username: <hub-user>      # optional: pull under account rate limits
  password: <hub-pat>
```

Then on **both builder hosts**:

```json
// /etc/docker/daemon.json
{ "registry-mirrors": ["https://registry-mirror.lan"] }
```

`systemctl restart docker` → `docker info` should list the mirror.

### 4.3 Explicit non-docker.io caching (optional, later)

Either pull explicitly (`harbor.lan/dockerhub/…` replaces `docker.io` refs) or add a FROM-rewrite step in `src/index.ts` after tar extraction: map `FROM <ref>` → `FROM harbor.lan/<project>/<ref-with-registry-stripped>`, preserving `AS <stage>` and skipping `FROM ${var}` / `FROM scratch`.

## 5. Trust & network

- dockerd validates the mirror/Harbor cert against the **system trust store** → distribute the internal CA to both builder hosts (`update-ca-trust` / `update-ca-certificates`), or use cert-manager + public DNS + Let's Encrypt.
- Harbor proxy project being public means anyone on the LAN can pull through your endpoint credentials' quota — acceptable in the homelab; otherwise VLAN/ACL it.

## 6. Verification checklist (after rollout)

1. `docker info | grep -A2 -i mirror` on both builders.
2. `docker pull balenalib/raspberrypi4-64-node:24-bookworm` → artifact appears in Harbor `dockerhub` project / mirror fills its PVC.
3. Re-pull after `docker rmi` → served from cache (watch Harbor access log / upstream HEAD only).
4. Block egress to docker.io → cached digest pull still succeeds (Harbor path).
5. Run a real fleet build through `POST /v3/build` and confirm the daemon logs show mirror usage.

## 7. Limitations & gotchas

- dockerd `registry-mirrors`: docker.io only, no prefix, no auth (§2.1). Podman *can* do prefixed mirrors; our builder path is dockerd.
- No pushes into proxy-cache projects; tag retention rules don't apply (upstream is the source of truth) — use "clear cache" + storage quota instead.
- Dynamic `FROM ${ARG}` cannot be statically rewritten (rare in balena Dockerfiles).
- Mirror fallback: if the mirror errors, dockerd silently goes straight to Docker Hub — watch the cache hit rate in Harbor metrics rather than trusting absence of errors.
- The openBalena registry itself (deploy pushes, device pulls) must stay **direct** — registry2 uses token auth minted by the openBalena API per-device; fronting it with Harbor would break that flow and gains nothing (it's already local).
