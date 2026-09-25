### fix(front-door): re-check a building studio instead of telling you to leave

The building panel was a one-shot snapshot whose copy said to leave the
page. The poll is the engine. Stay here, re-check `/api/me` every 2.5s
on building/failed, refresh on tab focus. Leaving still works, slower.
