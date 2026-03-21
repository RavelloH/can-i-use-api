# can-i-use-api

Generate static JSON APIs from the [caniuse](https://github.com/Fyrd/caniuse) repository with `pnpm` and Node.js.

## Endpoints

- `data/index.json`: search index
- `data/feature/{feature}/index.json`: feature detail API
- `data/trending/index.json`: latest material feature events
- `data/hot/index.json`: hot ranking derived from support coverage and recent momentum

## Usage

```bash
pnpm install
pnpm generate
```

## Environment Variables

- `CANIUSE_REPO_PATH`: use an existing local caniuse repository
- `CANIUSE_HISTORY_DEPTH`: clone / pull depth, default `300`
- `HISTORY_SCAN_COMMITS`: how many feature-history commits to scan for trending, default `220`
- `TRENDING_LIMIT`: output size for `data/trending/index.json`, default `50`
- `HOT_LIMIT`: output size for `data/hot/index.json`, default `100`

## Hot Score

`data/hot/index.json` is heuristic, because caniuse does not expose a real traffic-based popularity metric.

The score combines:

- current support coverage
- current support breadth across major browsers
- freshness of the latest material event
- momentum from the latest support upgrade
