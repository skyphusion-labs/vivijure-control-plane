### fix(version): set the Workers build tag on deploy (cp#534)

`GET /api/platform/version` reported `build.tag` as null because deploy ran `wrangler deploy` with no tag. A release deploy now passes the git ref. A dispatch deploy passes `dispatch-<sha>`. An empty tag reads as unset.
