# can-i-use-api

Generate static JSON APIs from the [caniuse](https://github.com/Fyrd/caniuse) repository with `pnpm` and Node.js.

## Endpoints

- `data/index.json`: search index
- `data/feature/{feature}/index.json`: feature detail API
- `data/trending/index.json`: latest material feature events
- `data/hot/index.json`: hot ranking derived from support coverage and recent momentum

like: 

- https://caniuse.ravelloh.com : search index  
- https://caniuse.ravelloh.com/feature/aac/ : feature detail API  
- https://caniuse.ravelloh.com/trending/ : latest material feature events  
- https://caniuse.ravelloh.com/hot/ : hot ranking derived from support coverage and recent momentum   
