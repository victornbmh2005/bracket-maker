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
      'CRUD for **tournaments** and **participants**.\n\n' +
      'Typical flow: create a tournament → copy its `id` → create participants with that `tournament_id` → ' +
      'start the bracket by PATCHing `rounds` on the tournament.\n\n' +
      'Participants are locked (409) while a bracket is running. PATCH `rounds: null` to reset it.',
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Tournaments', description: 'The tournaments table' },
    { name: 'Participants', description: 'The participants table' },
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
          'Sending `participants` (and optionally `rounds` using their old ids) imports a whole tournament at once.',
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
        summary: 'Get a tournament with its participants',
        responses: { 200: { description: 'OK', ...json(ref('TournamentDetail')) }, 404: resp('NotFound') },
      },
      patch: {
        tags: ['Tournaments'],
        summary: 'Update name and/or rounds',
        description:
          '`rounds` must be a full, consistent bracket: round 1 holds every participant exactly once, ' +
          'and each later match holds the winners of the two matches before it. `rounds: null` resets the bracket.',
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
        summary: 'Delete a tournament (and its participants)',
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
        parameters: [{ name: 'tournament_id', in: 'query', required: true, schema: uuid }],
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
        responses: { 204: { description: 'Deleted' }, 404: resp('NotFound'), 409: resp('Conflict') },
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
          rounds: ref('Rounds'),
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      TournamentDetail: {
        allOf: [
          ref('Tournament'),
          { type: 'object', properties: { participants: { type: 'array', items: ref('Participant') } } },
        ],
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
            properties: { id: uuid, name: { type: 'string' }, image: { type: 'string' } },
          },
          status: { type: 'string', enum: ['setup', 'in_progress', 'finished'] },
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
        properties: {
          name: { type: 'string', maxLength: 80, example: 'Best movies ever' },
          rounds: ref('Rounds'),
        },
        example: { name: 'Best movies ever' },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
    responses: {
      BadRequest: { description: 'Invalid input', ...json(ref('Error')) },
      NotFound: { description: 'Not found', ...json(ref('Error')) },
      Conflict: { description: 'The bracket has already started', ...json(ref('Error')) },
    },
  },
};
