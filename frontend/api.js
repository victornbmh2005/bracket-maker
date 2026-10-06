// Talks to the backend. One function per endpoint; each returns the parsed
// JSON or throws an Error whose message is safe to show to the user.
const api = (() => {
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(API_URL + '/api' + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("Can't reach the server. Is the backend running?");
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const enc = encodeURIComponent;

  return {
    health: () => request('GET', '/health'),

    // Tournaments
    createTournament: data => request('POST', '/tournaments', data),
    listTournaments: ids => request('GET', '/tournaments?ids=' + ids.map(enc).join(',')),
    getTournament: id => request('GET', `/tournaments/${enc(id)}`),
    updateTournament: (id, data) => request('PATCH', `/tournaments/${enc(id)}`, data),
    deleteTournament: id => request('DELETE', `/tournaments/${enc(id)}`),
    tournamentStats: id => request('GET', `/tournaments/${enc(id)}/stats`),

    // Runs (each run is one bracket of a tournament)
    runOptions: tournamentId => request('GET', '/runs/options?tournament_id=' + enc(tournamentId)),
    createRun: data => request('POST', '/runs', data),
    listRuns: tournamentId => request('GET', '/runs?tournament_id=' + enc(tournamentId)),
    getRun: id => request('GET', `/runs/${enc(id)}`),
    updateRun: (id, data) => request('PATCH', `/runs/${enc(id)}`, data),
    deleteRun: id => request('DELETE', `/runs/${enc(id)}`),

    // Participants
    createParticipant: data => request('POST', '/participants', data),
    listParticipants: (tournamentId, includeArchived = false) =>
      request('GET', '/participants?tournament_id=' + enc(tournamentId) + (includeArchived ? '&include_archived=true' : '')),
    getParticipant: id => request('GET', `/participants/${enc(id)}`),
    updateParticipant: (id, data) => request('PATCH', `/participants/${enc(id)}`, data),
    deleteParticipant: id => request('DELETE', `/participants/${enc(id)}`),
    importYoutube: data => request('POST', '/participants/import/youtube', data),
    importSpotify: data => request('POST', '/participants/import/spotify', data),

    // Ratings mode
    createRatingList: data => request('POST', '/rating-lists', data),
    listRatingLists: ids => request('GET', '/rating-lists?ids=' + ids.map(enc).join(',')),
    getRatingList: id => request('GET', `/rating-lists/${enc(id)}`),
    updateRatingList: (id, data) => request('PATCH', `/rating-lists/${enc(id)}`, data),
    deleteRatingList: id => request('DELETE', `/rating-lists/${enc(id)}`),

    createCriterion: data => request('POST', '/rating-criteria', data),
    listCriteria: listId => request('GET', '/rating-criteria?list_id=' + enc(listId)),
    getCriterion: id => request('GET', `/rating-criteria/${enc(id)}`),
    updateCriterion: (id, data) => request('PATCH', `/rating-criteria/${enc(id)}`, data),
    deleteCriterion: id => request('DELETE', `/rating-criteria/${enc(id)}`),

    createRatingItem: data => request('POST', '/rating-items', data),
    listRatingItems: listId => request('GET', '/rating-items?list_id=' + enc(listId)),
    getRatingItem: id => request('GET', `/rating-items/${enc(id)}`),
    updateRatingItem: (id, data) => request('PATCH', `/rating-items/${enc(id)}`, data),
    deleteRatingItem: id => request('DELETE', `/rating-items/${enc(id)}`),
    importRatingYoutube: data => request('POST', '/rating-items/import/youtube', data),
    importRatingSpotify: data => request('POST', '/rating-items/import/spotify', data),

    listScores: listId => request('GET', '/ratings?list_id=' + enc(listId)),
    setScore: data => request('PUT', '/ratings', data),
    clearScore: (itemId, criterionId) => request('DELETE', `/ratings?item_id=${enc(itemId)}&criterion_id=${enc(criterionId)}`),
  };
})();
