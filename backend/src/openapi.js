// OpenAPI description of the API, shown by Swagger UI at /api/docs.
// Keep this in sync when routes in src/routes/ change.

const uuid = { type: 'string', format: 'uuid' };
const idParam = description => ({ name: 'id', in: 'path', required: true, description, schema: uuid });
const json = schema => ({ content: { 'application/json': { schema } } });
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const resp = name => ({ $ref: `#/components/responses/${name}` });

export default {
  openapi: '3.0.3',
  info: {
    title: 'Bracket Maker API',
    version: '1.0.0',
    description:
      'CRUD for **tournaments**, **participants** and **runs**.\n\n' +
      'Typical flow: create a tournament → copy its `id` → add participants with that `tournament_id` → ' +
      'GET /api/runs/options to see the bracket sizes → POST /api/runs to start a run → PATCH the run with picks. ' +
      'When a run is finished you can start another; stats add up across runs (GET /api/tournaments/{id}/stats).\n\n' +
      'Participants are locked (409) while a run is in progress. Finish or delete the run to change them.',
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Tournaments', description: 'The tournaments table' },
    { name: 'Participants', description: 'The participants table' },
    { name: 'Runs', description: 'The runs table: each run is one bracket of a tournament' },
    { name: 'Rating lists', description: 'The rating_lists table (ratings mode)' },
    { name: 'Rating criteria', description: 'The rating_criteria table: what each item is rated on' },
    { name: 'Rating items', description: 'The rating_items table: the things being rated' },
    { name: 'Ratings', description: 'The ratings table: one 1–10 score per item per criterion' },
    { name: 'Health' },
  ],

  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Check that the API and database are up',
        responses: { 200: { description: 'OK', ...json({ type: 'object', properties: { ok: { type: 'boolean', example: true } } }) } },
      },
    },

    '/api/tournaments': {
      post: {
        tags: ['Tournaments'],
        summary: 'Create a tournament',
        description:
          'Send just `name` for an empty tournament. ' +
          'Sending `participants` (and optionally `rounds` using their old ids) imports a whole tournament at once; the bracket becomes run #1.',
        requestBody: {
          required: true,
          ...json(ref('TournamentCreate')),
        },
        responses: { 201: { description: 'Created', ...json(ref('TournamentDetail')) }, 400: resp('BadRequest') },
      },
      get: {
        tags: ['Tournaments'],
        summary: 'List tournaments by id',
        description: 'Returns summaries for the ids you ask for. There is no "list all": knowing the id is what gives access.',
        parameters: [{
          name: 'ids', in: 'query', required: true,
          description: 'Comma-separated tournament ids (max 100)',
          schema: { type: 'string' },
          example: '00000000-0000-4000-8000-000000000000',
        }],
        responses: { 200: { description: 'OK', ...json({ type: 'array', items: ref('TournamentSummary') }) } },
      },
    },

    '/api/tournaments/{id}': {
      parameters: [idParam('Tournament id')],
      get: {
        tags: ['Tournaments'],
        summary: 'Get a tournament with its participants and latest run',
        responses: { 200: { description: 'OK', ...json(ref('TournamentDetail')) }, 404: resp('NotFound') },
      },
      patch: {
        tags: ['Tournaments'],
        summary: 'Rename a tournament',
        description: 'Brackets are changed through /api/runs.',
        requestBody: {
          required: true,
          ...json(ref('TournamentUpdate')),
        },
        responses: {
          200: { description: 'Updated', ...json(ref('TournamentDetail')) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
        },
      },
      delete: {
        tags: ['Tournaments'],
        summary: 'Delete a tournament (and its participants and runs)',
        responses: { 204: { description: 'Deleted' }, 404: resp('NotFound') },
      },
    },

    '/api/tournaments/{id}/stats': {
      parameters: [idParam('Tournament id')],
      get: {
        tags: ['Tournaments'],
        summary: 'Participant stats over all runs',
        description:
          'Wins and losses count in every run (byes are not wins). Titles and finishes only count once a run is finished. ' +
          'A finish is measured from the final (Champion, Runner-up, Semifinals…), so runs of different sizes compare fairly. ' +
          'Sorted by titles, then best finish, then win rate.',
        responses: { 200: { description: 'OK', ...json(ref('Stats')) }, 404: resp('NotFound') },
      },
    },

    '/api/runs': {
      post: {
        tags: ['Runs'],
        summary: 'Start a run (the server builds the bracket)',
        description:
          '`size` must be one of the sizes from GET /api/runs/options. A size smaller than the number of participants is a **cut**: ' +
          'random participants sit out, but those who sat out more often get to play first. ' +
          'The largest size means **everyone plays**: if the count is not a power of two, round 1 is a play-in round and some go straight through. ' +
          'Only one run can be in progress at a time (409).',
        requestBody: { required: true, ...json(ref('RunCreate')) },
        responses: {
          201: { description: 'Created', ...json(ref('Run')) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
          409: resp('Conflict'),
        },
      },
      get: {
        tags: ['Runs'],
        summary: "List a tournament's runs (newest first, without brackets)",
        parameters: [{ name: 'tournament_id', in: 'query', required: true, schema: uuid }],
        responses: {
          200: { description: 'OK', ...json({ type: 'array', items: ref('RunSummary') }) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
        },
      },
    },

    '/api/runs/options': {
      get: {
        tags: ['Runs'],
        summary: 'Bracket sizes available for the current participants',
        parameters: [{ name: 'tournament_id', in: 'query', required: true, schema: uuid }],
        responses: {
          200: { description: 'OK, largest first', ...json({ type: 'array', items: ref('SizeOption') }) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
        },
      },
    },

    '/api/runs/{id}': {
      parameters: [idParam('Run id')],
      get: {
        tags: ['Runs'],
        summary: 'Get a run with its bracket',
        responses: { 200: { description: 'OK', ...json(ref('Run')) }, 404: resp('NotFound') },
      },
      patch: {
        tags: ['Runs'],
        summary: 'Save picks',
        description:
          'Send the whole `rounds` with winners filled in. The first round matchups must stay the same, and each later match ' +
          'must hold the winners of the two matches before it. Deciding the final finishes the run; clearing it reopens the run. ' +
          'Only the latest run can be changed (409).',
        requestBody: { required: true, ...json({ type: 'object', required: ['rounds'], properties: { rounds: ref('Rounds') } }) },
        responses: {
          200: { description: 'Updated', ...json(ref('Run')) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
          409: resp('Conflict'),
        },
      },
      delete: {
        tags: ['Runs'],
        summary: 'Delete a run (its results leave the stats)',
        responses: { 204: { description: 'Deleted' }, 404: resp('NotFound') },
      },
    },

    '/api/participants': {
      post: {
        tags: ['Participants'],
        summary: 'Add a participant to a tournament',
        requestBody: { required: true, ...json(ref('ParticipantCreate')) },
        responses: {
          201: { description: 'Created', ...json(ref('Participant')) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
          409: resp('Conflict'),
        },
      },
      get: {
        tags: ['Participants'],
        summary: "List a tournament's participants",
        parameters: [
          { name: 'tournament_id', in: 'query', required: true, schema: uuid },
          { name: 'include_archived', in: 'query', description: 'Also return archived participants', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          200: { description: 'OK, ordered by position', ...json({ type: 'array', items: ref('Participant') }) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
        },
      },
    },

    '/api/participants/import/spotify': {
      post: {
        tags: ['Participants'],
        summary: 'Import Spotify tracks from pasted links',
        description:
          "Spotify's API no longer lets new apps read playlists, so paste track links instead: in the Spotify desktop app, " +
          'open a playlist, click a song, press Ctrl+A then Ctrl+C, and paste. Any text works; every ' +
          '`open.spotify.com/track/…` link or `spotify:track:…` URI in it is used (duplicates once). ' +
          "Each track's name and cover come from Spotify's public oEmbed endpoint. Names are the song title only (no artist). " +
          'Stops at 256 participants.',
        requestBody: { required: true, ...json(ref('SpotifyImport')) },
        responses: {
          201: { description: 'Imported', ...json(ref('PlaylistImportResult')) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
          409: resp('Conflict'),
        },
      },
    },

    '/api/participants/import/youtube': {
      post: {
        tags: ['Participants'],
        summary: 'Import a YouTube playlist as participants',
        description:
          'Every available video becomes a participant (title, thumbnail, video link), added after the existing ones. ' +
          'Private and deleted videos are skipped. Stops at 256 participants. ' +
          'The playlist must be public or unlisted. Needs `YOUTUBE_API_KEY` on the server.',
        requestBody: { required: true, ...json(ref('PlaylistImport')) },
        responses: {
          201: { description: 'Imported', ...json(ref('PlaylistImportResult')) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
          409: resp('Conflict'),
          502: { description: 'YouTube could not be reached or refused the request', ...json(ref('Error')) },
          503: { description: 'Import not configured, or daily YouTube quota used up', ...json(ref('Error')) },
        },
      },
    },

    '/api/participants/{id}': {
      parameters: [idParam('Participant id')],
      get: {
        tags: ['Participants'],
        summary: 'Get a participant',
        responses: { 200: { description: 'OK', ...json(ref('Participant')) }, 404: resp('NotFound') },
      },
      patch: {
        tags: ['Participants'],
        summary: 'Update a participant',
        description: 'Send only the fields you want to change.',
        requestBody: { required: true, ...json(ref('ParticipantUpdate')) },
        responses: {
          200: { description: 'Updated', ...json(ref('Participant')) },
          400: resp('BadRequest'),
          404: resp('NotFound'),
          409: resp('Conflict'),
        },
      },
      delete: {
        tags: ['Participants'],
        summary: 'Delete a participant',
        description: 'Someone who played in (or sat out of) any run is archived instead, so history and stats keep them.',
        responses: { 204: { description: 'Deleted' }, 404: resp('NotFound'), 409: resp('Conflict') },
      },
    },

    // ---------- Ratings mode ----------
    '/api/rating-lists': {
      post: {
        tags: ['Rating lists'],
        summary: 'Create a rating list',
        description: 'Optionally with criteria names (max 20). The site sends a preset, e.g. Songs: Instruments, Vocals, Lyrics, Production, Replay value.',
        requestBody: { required: true, ...json(ref('RatingListCreate')) },
        responses: { 201: { description: 'Created', ...json(ref('RatingListDetail')) }, 400: resp('BadRequest') },
      },
      get: {
        tags: ['Rating lists'],
        summary: 'List rating lists by id (summaries with scores)',
        description: 'Like tournaments, there is no "list all": knowing the id is what gives access.',
        parameters: [{ name: 'ids', in: 'query', required: true, description: 'Comma-separated list ids (max 100)', schema: { type: 'string' } }],
        responses: { 200: { description: 'OK', ...json({ type: 'array', items: ref('RatingListSummary') }) } },
      },
    },
    '/api/rating-lists/{id}': {
      parameters: [idParam('Rating list id')],
      get: {
        tags: ['Rating lists'],
        summary: 'Get a list with its criteria, items, scores and averages',
        responses: { 200: { description: 'OK', ...json(ref('RatingListDetail')) }, 404: resp('NotFound') },
      },
      patch: {
        tags: ['Rating lists'],
        summary: 'Rename a list',
        requestBody: { required: true, ...json({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 80, example: 'Best songs of 2026' } } }) },
        responses: { 200: { description: 'Updated', ...json(ref('RatingListDetail')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
      delete: {
        tags: ['Rating lists'],
        summary: 'Delete a list (and its criteria, items and scores)',
        responses: { 204: { description: 'Deleted' }, 404: resp('NotFound') },
      },
    },

    '/api/rating-criteria': {
      post: {
        tags: ['Rating criteria'],
        summary: 'Add a criterion to a list',
        requestBody: { required: true, ...json({ type: 'object', required: ['list_id', 'name'], properties: { list_id: uuid, name: { type: 'string', maxLength: 40, example: 'Vocals' } } }) },
        responses: { 201: { description: 'Created', ...json(ref('RatingCriterion')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
      get: {
        tags: ['Rating criteria'],
        summary: "List a list's criteria",
        parameters: [{ name: 'list_id', in: 'query', required: true, schema: uuid }],
        responses: { 200: { description: 'OK, ordered by position', ...json({ type: 'array', items: ref('RatingCriterion') }) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
    },
    '/api/rating-criteria/{id}': {
      parameters: [idParam('Criterion id')],
      get: {
        tags: ['Rating criteria'],
        summary: 'Get a criterion',
        responses: { 200: { description: 'OK', ...json(ref('RatingCriterion')) }, 404: resp('NotFound') },
      },
      patch: {
        tags: ['Rating criteria'],
        summary: 'Rename and/or move a criterion',
        requestBody: { required: true, ...json({ type: 'object', properties: { name: { type: 'string', maxLength: 40, example: 'Production' }, position: { type: 'integer', minimum: 0 } } }) },
        responses: { 200: { description: 'Updated', ...json(ref('RatingCriterion')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
      delete: {
        tags: ['Rating criteria'],
        summary: 'Delete a criterion (its scores go with it)',
        responses: { 204: { description: 'Deleted' }, 404: resp('NotFound') },
      },
    },

    '/api/rating-items': {
      post: {
        tags: ['Rating items'],
        summary: 'Add an item to a list',
        requestBody: { required: true, ...json(ref('RatingItemCreate')) },
        responses: { 201: { description: 'Created', ...json(ref('RatingItem')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
      get: {
        tags: ['Rating items'],
        summary: "List a list's items (without scores)",
        parameters: [{ name: 'list_id', in: 'query', required: true, schema: uuid }],
        responses: { 200: { description: 'OK, ordered by position', ...json({ type: 'array', items: ref('RatingItem') }) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
    },
    '/api/rating-items/import/youtube': {
      post: {
        tags: ['Rating items'],
        summary: 'Import a YouTube playlist as items',
        description: 'Same as the participant import, but into a rating list. Max 256 items per list.',
        requestBody: { required: true, ...json({ type: 'object', required: ['list_id', 'url'], properties: { list_id: uuid, url: { type: 'string', example: 'https://www.youtube.com/playlist?list=PASTE_A_PLAYLIST_ID' } } }) },
        responses: { 201: { description: 'Imported', ...json(ref('PlaylistImportResult')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
    },
    '/api/rating-items/import/spotify': {
      post: {
        tags: ['Rating items'],
        summary: 'Import Spotify tracks from pasted links as items',
        requestBody: { required: true, ...json({ type: 'object', required: ['list_id', 'links'], properties: { list_id: uuid, links: { type: 'string', example: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' } } }) },
        responses: { 201: { description: 'Imported', ...json(ref('PlaylistImportResult')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
    },
    '/api/rating-items/{id}': {
      parameters: [idParam('Item id')],
      get: {
        tags: ['Rating items'],
        summary: 'Get an item with its scores and average',
        responses: { 200: { description: 'OK', ...json(ref('RatedItem')) }, 404: resp('NotFound') },
      },
      patch: {
        tags: ['Rating items'],
        summary: 'Update an item',
        requestBody: { required: true, ...json(ref('ParticipantUpdate')) },
        responses: { 200: { description: 'Updated', ...json(ref('RatingItem')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
      delete: {
        tags: ['Rating items'],
        summary: 'Delete an item (its scores go with it)',
        responses: { 204: { description: 'Deleted' }, 404: resp('NotFound') },
      },
    },

    '/api/ratings': {
      get: {
        tags: ['Ratings'],
        summary: 'Every score in a list',
        parameters: [{ name: 'list_id', in: 'query', required: true, schema: uuid }],
        responses: { 200: { description: 'OK', ...json({ type: 'array', items: ref('Rating') }) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
      put: {
        tags: ['Ratings'],
        summary: 'Set a score (creates it or replaces the old one)',
        description: 'The item and criterion must belong to the same list. Answers with the updated averages.',
        requestBody: { required: true, ...json({ type: 'object', required: ['item_id', 'criterion_id', 'score'], properties: { item_id: uuid, criterion_id: uuid, score: { type: 'integer', minimum: 1, maximum: 10, example: 8 } } }) },
        responses: { 200: { description: 'Saved', ...json(ref('RatingChange')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
      delete: {
        tags: ['Ratings'],
        summary: 'Clear a score',
        parameters: [
          { name: 'item_id', in: 'query', required: true, schema: uuid },
          { name: 'criterion_id', in: 'query', required: true, schema: uuid },
        ],
        responses: { 200: { description: 'Cleared; answers with the updated averages', ...json(ref('RatingChange')) }, 400: resp('BadRequest'), 404: resp('NotFound') },
      },
    },
  },

  components: {
    schemas: {
      Match: {
        type: 'object',
        description: 'One matchup. `null` means empty (a bye in round 1, or not decided yet later on).',
        properties: {
          a: { ...uuid, nullable: true },
          b: { ...uuid, nullable: true },
          winner: { ...uuid, nullable: true },
        },
      },
      Rounds: {
        type: 'array',
        nullable: true,
        description: 'Round 1 first, the final last. Each round has half the matches of the one before.',
        items: { type: 'array', items: ref('Match') },
      },
      Participant: {
        type: 'object',
        properties: {
          id: uuid,
          tournament_id: uuid,
          name: { type: 'string', example: 'Alien' },
          image: { type: 'string', description: 'https URL or data:image URL, or empty', example: 'https://picsum.photos/300' },
          link: { type: 'string', description: 'http(s) URL or empty', example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
          position: { type: 'integer', example: 0 },
          archived: { type: 'boolean', description: 'Deleted after being in a run; hidden from setup, kept in history' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ParticipantCreate: {
        type: 'object',
        required: ['tournament_id', 'name'],
        properties: {
          tournament_id: uuid,
          name: { type: 'string', maxLength: 80, example: 'Alien' },
          image: { type: 'string', example: 'https://picsum.photos/300' },
          link: { type: 'string', example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        },
      },
      ParticipantUpdate: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 80, example: 'Aliens' },
          image: { type: 'string', example: 'https://picsum.photos/300' },
          link: { type: 'string', example: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' },
          position: { type: 'integer', minimum: 0, example: 0 },
        },
      },
      PlaylistImport: {
        type: 'object',
        required: ['tournament_id', 'url'],
        properties: {
          tournament_id: uuid,
          url: {
            type: 'string',
            description: 'Playlist link (youtube.com or music.youtube.com, anything with list=…) or a playlist id',
            example: 'https://www.youtube.com/playlist?list=PASTE_A_PLAYLIST_ID',
          },
        },
      },
      SpotifyImport: {
        type: 'object',
        required: ['tournament_id', 'links'],
        properties: {
          tournament_id: uuid,
          links: {
            type: 'string',
            description: 'Text containing Spotify track links, e.g. one per line',
            example: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC\nhttps://open.spotify.com/track/7ouMYWpwJ422jRcDASZB7P',
          },
        },
      },
      PlaylistImportResult: {
        type: 'object',
        properties: {
          playlist_title: { type: 'string', description: 'YouTube playlist title (empty for Spotify)' },
          added: { type: 'array', items: ref('Participant') },
          skipped_unavailable: { type: 'integer', description: 'Videos/tracks that were private, deleted or not found' },
          truncated: { type: 'boolean', description: 'true if the playlist had more videos than room left (256 max)' },
        },
      },
      Tournament: {
        type: 'object',
        properties: {
          id: uuid,
          name: { type: 'string', example: 'Best movies of the 80s' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      TournamentDetail: {
        allOf: [
          ref('Tournament'),
          {
            type: 'object',
            properties: {
              participants: { type: 'array', description: 'Including archived ones', items: ref('Participant') },
              latest_run: { ...ref('Run'), nullable: true },
              run_count: { type: 'integer' },
            },
          },
        ],
      },
      Run: {
        type: 'object',
        properties: {
          id: uuid,
          tournament_id: uuid,
          number: { type: 'integer', example: 1 },
          mode: { type: 'string', enum: ['all', 'cut'], description: 'all = everyone plays, cut = some sat out' },
          rounds: ref('Rounds'),
          sat_out: { type: 'array', items: uuid },
          champion_id: { ...uuid, nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          finished_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      RunSummary: {
        type: 'object',
        properties: {
          id: uuid,
          number: { type: 'integer' },
          mode: { type: 'string', enum: ['all', 'cut'] },
          size: { type: 'integer' },
          sat_out_count: { type: 'integer' },
          champion: { type: 'object', nullable: true, properties: { id: uuid, name: { type: 'string' }, image: { type: 'string' } } },
          created_at: { type: 'string', format: 'date-time' },
          finished_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      RunCreate: {
        type: 'object',
        required: ['tournament_id', 'size'],
        properties: {
          tournament_id: uuid,
          size: { type: 'integer', example: 8 },
          shuffle: { type: 'boolean', default: true, description: 'Random seeding; false keeps participant order' },
        },
      },
      SizeOption: {
        type: 'object',
        properties: {
          size: { type: 'integer', example: 8 },
          mode: { type: 'string', enum: ['all', 'cut'] },
          sit_out: { type: 'integer', description: 'How many sit out with this size' },
          play_in: { type: 'boolean', description: 'Everyone plays, with a play-in round first' },
        },
      },
      Stats: {
        type: 'object',
        properties: {
          runs_total: { type: 'integer' },
          runs_finished: { type: 'integer' },
          participants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: uuid,
                name: { type: 'string' },
                image: { type: 'string' },
                archived: { type: 'boolean' },
                runs_played: { type: 'integer' },
                sat_out: { type: 'integer' },
                wins: { type: 'integer' },
                losses: { type: 'integer' },
                titles: { type: 'integer' },
                win_rate: { type: 'number', nullable: true, description: 'Percent, e.g. 66.7' },
                best_finish: { type: 'string', nullable: true, example: 'Semifinals' },
                best_finish_rank: { type: 'integer', nullable: true, description: '-1 champion, 0 runner-up, 1 semifinals… (lower is better)' },
                avg_wins: { type: 'number', description: 'Wins per run played' },
              },
            },
          },
        },
      },
      TournamentSummary: {
        type: 'object',
        properties: {
          id: uuid,
          name: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          participant_count: { type: 'integer' },
          preview: {
            type: 'array',
            description: 'First 4 participants',
            items: { type: 'object', properties: { id: uuid, name: { type: 'string' }, image: { type: 'string' } } },
          },
          champion: {
            type: 'object',
            nullable: true,
            description: 'Champion of the latest run',
            properties: { id: uuid, name: { type: 'string' }, image: { type: 'string' } },
          },
          status: { type: 'string', enum: ['setup', 'in_progress', 'finished'], description: 'Of the latest run' },
          run_count: { type: 'integer' },
          run_number: { type: 'integer', nullable: true, description: 'Number of the latest run' },
          matches_done: { type: 'integer' },
          matches_total: { type: 'integer' },
        },
      },
      TournamentCreate: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 80, example: 'Best movies of the 80s' },
          participants: {
            type: 'array',
            description: 'Import only. `id` can be any string; it is only used to match the ids inside `rounds`.',
            items: {
              type: 'object',
              required: ['name'],
              properties: { id: { type: 'string' }, name: { type: 'string' }, image: { type: 'string' }, link: { type: 'string' } },
            },
          },
          rounds: { ...ref('Rounds'), description: 'Import only' },
        },
        example: { name: 'Best movies of the 80s' },
      },
      TournamentUpdate: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 80, example: 'Best movies ever' },
        },
        example: { name: 'Best movies ever' },
      },
      RatingListCreate: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 80, example: 'My 2026 playlist' },
          criteria: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 }, example: ['Instruments', 'Vocals', 'Lyrics', 'Production', 'Replay value'] },
        },
      },
      RatingSummary: {
        type: 'object',
        properties: {
          score: { type: 'number', nullable: true, description: 'Average of the item scores, 1 decimal', example: 7.4 },
          item_count: { type: 'integer' },
          criteria_count: { type: 'integer' },
          rated_items: { type: 'integer', description: 'Items with at least one score' },
          complete_items: { type: 'integer', description: 'Items scored on every criterion' },
        },
      },
      RatingListSummary: {
        allOf: [
          { type: 'object', properties: { id: uuid, name: { type: 'string' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' } } },
          ref('RatingSummary'),
          { type: 'object', properties: { preview: { type: 'array', description: 'First 4 items', items: { type: 'object', properties: { id: uuid, name: { type: 'string' }, image: { type: 'string' } } } } } },
        ],
      },
      RatingListDetail: {
        type: 'object',
        properties: {
          id: uuid,
          name: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          criteria: {
            type: 'array',
            items: { allOf: [ref('RatingCriterion'), { type: 'object', properties: { average: { type: 'number', nullable: true }, rated: { type: 'integer' } } }] },
          },
          items: { type: 'array', items: ref('RatedItem') },
          summary: ref('RatingSummary'),
        },
      },
      RatingCriterion: {
        type: 'object',
        properties: { id: uuid, list_id: uuid, name: { type: 'string', example: 'Vocals' }, position: { type: 'integer' } },
      },
      RatingItem: {
        type: 'object',
        properties: {
          id: uuid,
          list_id: uuid,
          name: { type: 'string', example: 'Mr. Brightside' },
          image: { type: 'string' },
          link: { type: 'string', example: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp' },
          position: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      RatingItemCreate: {
        type: 'object',
        required: ['list_id', 'name'],
        properties: {
          list_id: uuid,
          name: { type: 'string', maxLength: 80, example: 'Mr. Brightside' },
          image: { type: 'string' },
          link: { type: 'string', example: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp' },
        },
      },
      RatedItem: {
        allOf: [
          ref('RatingItem'),
          {
            type: 'object',
            properties: {
              scores: { type: 'object', additionalProperties: { type: 'integer' }, description: '{criterion_id: score}' },
              score: { type: 'number', nullable: true, description: 'Average of this item’s scores' },
              rated: { type: 'integer', description: 'How many criteria have a score' },
              complete: { type: 'boolean', description: 'Scored on every criterion' },
            },
          },
        ],
      },
      Rating: {
        type: 'object',
        properties: { item_id: uuid, criterion_id: uuid, score: { type: 'integer', minimum: 1, maximum: 10 }, updated_at: { type: 'string', format: 'date-time' } },
      },
      RatingChange: {
        type: 'object',
        properties: {
          rating: ref('Rating'),
          item: { type: 'object', properties: { id: uuid, scores: { type: 'object' }, score: { type: 'number', nullable: true }, rated: { type: 'integer' }, complete: { type: 'boolean' } } },
          criterion: { type: 'object', properties: { id: uuid, average: { type: 'number', nullable: true }, rated: { type: 'integer' } } },
          summary: ref('RatingSummary'),
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
    responses: {
      BadRequest: { description: 'Invalid input', ...json(ref('Error')) },
      NotFound: { description: 'Not found', ...json(ref('Error')) },
      Conflict: { description: 'A run is in progress (or the run is not the latest)', ...json(ref('Error')) },
    },
  },
};
